# Search: O-Entry Kollisionen beim Multi-Agent-Betrieb

## Task
Finde den Eintrag über O-Entry Kollisionen beim Multi-Agent-Betrieb. Da gab's eine Entscheidung wie wir das lösen.

## Search Attempts

### Attempt 1 — Direct keywords (German)
`read_memory({ search: "O-Entry Kollision Multi-Agent" })`
→ No results.

### Attempt 2 — English translation
`read_memory({ search: "O-Entry collision multi-agent" })`
→ 1 result: O0048 (v6.0.0 HMEM_PATH Redesign) — off-topic.

### Attempt 3 — Synonyms: conflict, concurrent
`read_memory({ search: "O-Entry conflict concurrent agent" })`
→ No results.

`read_memory({ search: "collision conflict O-entry write parallel" })`
→ No results.

### Attempt 4 — Broader multi-agent terms
`read_memory({ search: "multi-agent concurrent write conflict" })`
→ No results.

`read_memory({ search: "multi agent session collision resolution" })`
→ O0048 again (off-topic).

### Attempt 5 — Broad `multi-agent` search (breakthrough)
`read_memory({ search: "multi-agent" })`
→ 19 results, including:
- **P0048.4.6.3.7** — "Multi-Agent: ID-Kollisionsvermeidung bei parallelen Agents auf gleicher .hmem-Datei"
- **P0048.8.9.x** nodes — multi-agent + optimistic-locking tags

### Attempt 6 — Drill into P0048.8.9 and sub-nodes
`read_memory({ id: "P0048.8.9" })` — Full decision entry found.
`read_memory({ id: "P0048.8.9.2" })` — Auto-retry loop details.
`read_memory({ id: "P0048.8.9.3" })` — Coverage extension details.
`read_memory({ id: "P0048.8.9.4" })` — Sub-node reservation (Option β).

---

## Result

**Gefunden in: P0048.8.9 — "Multi-agent ID-collision prototype (2026-04-08)"**

### Die Entscheidung: Zweischichtiges Kollisionsvermeidungs-System

**Layer 1 — Root-ID Reservation:**
- Neue Tabelle `id_reservations` im hmem-sync Server
- Vor dem Schreiben: `write_memory` und andere ID-allokierende Operationen reservieren die nächste ID per `POST /reservations`
- Bei Kollision (HTTP 409) → automatischer Retry (max 5×)
- Commits: hmem-sync `1e2fce6` + hmem `bd64c28`

**Layer 2 — Optimistic Locking für Append/Update:**
- `version_hash`-Spalte auf blobs (SHA256 des Dateninhalts)
- `POST /blobs` akzeptiert `expected_version` pro Blob, gibt `conflicts[]` zurück
- Backward-compatible: `undefined expected_version` → Last-Write-Wins Fallback
- Retry-Schleife: push → bei Exit 3 (Konflikt) → pull → neu versuchen (max 3×)

**Option β (Sub-node IDs):**
- `peekAppendTopLevelIds` + `reserveNextSubIds`-Loop in hmem-mcp
- `append_memory` reserviert vor `appendChildren` alle direct-child IDs
- Race-Test 5× parallel: 1× OK, 4× Fehler → korrekt
- Schließt letzte Silent-Data-Loss-Lücke

### Abdeckung nach Implementierung
Alle kritischen Pfade wrappen die Reserve+Retry-Mechanik:
- `write_memory`, `create_project`, `append_memory`, `update_memory`, `move_nodes`, `import_memory`

### Verbleibende TODOs (Stand 2026-04-08)
- Live-Race-Test mit zwei echten Claude-Code-Instanzen
- Token-Rotation nach TLS-Setup für Strato

---

## Key Entry IDs
- **P0048.8.9** — Haupt-Entscheidungseintrag (Multi-agent ID-collision prototype)
- **P0048.8.9.2** — Auto-retry loop
- **P0048.8.9.3** — Coverage-Erweiterung
- **P0048.8.9.4** — Sub-node ID reservation (Option β)
- **P0048.4.6.3.7** — Stub-Verweis auf das Thema (nur Titel)
