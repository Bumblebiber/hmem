export class SyncApiError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'SyncApiError'
  }
}

type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string }

interface PushBlob {
  proposed_id: string
  data: string
  device_id: string
  updated_at: string
}

interface PushRequest {
  file_id: string
  idempotency_key: string
  blobs: PushBlob[]
}

interface PushResponse {
  mappings: { proposed_id: string; final_id: number }[]
}

interface PullBlob {
  id: number
  client_proposed_id?: string
  data: string
  deleted_at?: string | null
  updated_at: string
}

interface PullResponse {
  blobs: PullBlob[]
  server_time: string
  salt?: string
}

export interface HmemFile {
  id: string
  salt?: string
}

export class HmemSyncClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...(init.headers as Record<string, string> ?? {}),
        },
      })
      const data = await res.json()
      if (!res.ok) {
        const d = data as { error?: string; details?: unknown }
        const detail = d.details ? ` | ${JSON.stringify(d.details).slice(0, 200)}` : ''
        return { ok: false, status: res.status, error: (d.error ?? 'Unknown error') + detail }
      }
      return { ok: true, data: data as T }
    } catch (e) {
      return { ok: false, status: 0, error: (e as Error).message }
    }
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) })
      return res.ok
    } catch { return false }
  }

  async listFiles(): Promise<HmemFile[]> {
    const r = await this.request<{ files: HmemFile[] }>('/files')
    if (!r.ok) {
      if (r.status === 402) throw new SyncApiError('Subscription required', 'PAYMENT_REQUIRED')
      throw new Error(r.error)
    }
    return r.data.files
  }

  async createFile(id: string, salt: string): Promise<HmemFile> {
    const r = await this.request<HmemFile>('/files', {
      method: 'POST',
      body: JSON.stringify({ id, owner_type: 'personal', salt }),
    })
    if (!r.ok) {
      if (r.status === 409) throw new SyncApiError('File already exists', 'CONFLICT')
      if (r.status === 402) throw new SyncApiError('Subscription required', 'PAYMENT_REQUIRED')
      throw new Error(r.error)
    }
    return r.data
  }

  async push(req: PushRequest): Promise<PushResponse> {
    const r = await this.request<PushResponse>('/sync/push', {
      method: 'POST',
      body: JSON.stringify(req),
    })
    if (!r.ok) {
      if (r.status === 403) throw new SyncApiError('Access revoked', 'REVOKED')
      if (r.status === 402) throw new SyncApiError('Subscription required', 'PAYMENT_REQUIRED')
      throw new Error(r.error)
    }
    return r.data
  }

  async pull(fileId: string, since?: string): Promise<PullResponse> {
    const qs = since
      ? `?file_id=${encodeURIComponent(fileId)}&since=${encodeURIComponent(since)}`
      : `?file_id=${encodeURIComponent(fileId)}`
    const r = await this.request<PullResponse>(`/sync/pull${qs}`)
    if (!r.ok) {
      if (r.status === 403) throw new SyncApiError('Access revoked', 'REVOKED')
      if (r.status === 402) throw new SyncApiError('Subscription required', 'PAYMENT_REQUIRED')
      throw new Error(r.error)
    }
    return r.data
  }
}
