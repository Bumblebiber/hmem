# pi-hmem Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Pi coding agent extension inside hmem-mcp that replicates all Claude Code hmem hooks (session-start injection, .hmem read blocking, and log-exchange checkpointing after every agent response).

**Architecture:** Single TypeScript extension file `src/extensions/pi-hmem.ts`, compiled by the existing tsc pipeline to `dist/extensions/pi-hmem.js`. Registered via a `"pi"` key in `package.json`. The existing `cli-log-exchange.ts` `last_user_message` direct-mode already handles Pi's message format — no CLI changes needed.

**Tech Stack:** TypeScript, Node.js `child_process.execFile`, `@earendil-works/pi-coding-agent` (devDep for types, optionalPeer at runtime), existing `hmem` CLI

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/extensions/pi-hmem.ts` | CREATE | Pi extension — all hook logic |
| `package.json` | MODIFY | Add `"pi"` key, devDep + optionalPeerDep for Pi types |
| `test/pi-hmem-extension.test.ts` | CREATE | Unit tests for `extractText` helper |

---

### Task 1: Add Pi type dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install Pi coding agent as devDependency**

```bash
cd /home/bbbee/projects/hmem
npm install -D @earendil-works/pi-coding-agent@0.74.0
```

Expected: package-lock.json updated, `@earendil-works/pi-coding-agent` appears under devDependencies.

- [ ] **Step 2: Verify import resolves**

```bash
node -e "import('@earendil-works/pi-coding-agent').then(m => console.log('ok', Object.keys(m))).catch(e => console.error(e))"
```

Expected: prints `ok [...]` with some keys (or type-only — no runtime error).

- [ ] **Step 3: Add optionalPeerDependency to package.json**

Open `package.json`. After the existing `"peerDependencies"` section (or after `"devDependencies"` if none), add:

```json
"peerDependenciesMeta": {
  "@earendil-works/pi-coding-agent": {
    "optional": true
  }
},
```

And in `"peerDependencies"` (create the section if it doesn't exist):

```json
"peerDependencies": {
  "@earendil-works/pi-coding-agent": ">=0.74.0"
}
```

- [ ] **Step 4: Commit**

```bash
cd /home/bbbee/projects/hmem
git add package.json package-lock.json
git commit -m "feat: add @earendil-works/pi-coding-agent devDep for Pi extension types"
```

---

### Task 2: Write unit test for extractText helper

**Files:**
- Create: `test/pi-hmem-extension.test.ts`

The only standalone-testable logic in the extension is `extractText(content)` — the function that extracts a plain string from a Pi message content value (which can be a string or ContentBlock array).

- [ ] **Step 1: Write the failing test**

Create `test/pi-hmem-extension.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractText } from "../src/extensions/pi-hmem.js";

describe("extractText", () => {
  it("returns a plain string unchanged", () => {
    expect(extractText("hello world")).toBe("hello world");
  });

  it("joins text blocks from a ContentBlock array", () => {
    expect(extractText([
      { type: "text", text: "Hello " },
      { type: "tool_use", id: "t1", name: "bash", input: {} },
      { type: "text", text: "world" },
    ])).toBe("Hello world");
  });

  it("returns empty string for array with no text blocks", () => {
    expect(extractText([
      { type: "tool_use", id: "t1", name: "bash", input: {} },
    ])).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(extractText([])).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/bbbee/projects/hmem
npx vitest run test/pi-hmem-extension.test.ts
```

Expected: FAIL — `Cannot find module '../src/extensions/pi-hmem.js'`

---

### Task 3: Create the Pi extension

**Files:**
- Create: `src/extensions/pi-hmem.ts`

- [ ] **Step 1: Create `src/extensions/pi-hmem.ts`**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/extensions/ → ../../skills/hmem-using-hmem/SKILL.md
const SKILL_PATH = join(__dirname, "../../skills/hmem-using-hmem/SKILL.md");

/** Extract plain text from a Pi message content value. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text as string)
    .join("");
}

/** Run an hmem CLI subcommand, piping `input` to stdin. Resolves with stdout. */
function runHmem(args: string[], input = "{}", timeout = 10_000): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile("hmem", args, { timeout, env: process.env }, (_err, stdout) => {
      resolve(stdout ?? "");
    });
    if (child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

export default async function (pi: ExtensionAPI) {
  let startupContext = "";
  let injected = false;
  let lastLogTime = 0;

  // ── 1. Session start: run hook-startup once to get memory context ──────────
  pi.on("session_start", async (event) => {
    if (event.reason !== "startup") return;
    try {
      const raw = await runHmem(["hook-startup"], "{}", 5_000);
      const parsed = JSON.parse(raw);
      startupContext = parsed?.hookSpecificOutput?.additionalContext ?? "";
    } catch {
      // hmem not available or errored — skip silently
    }
  });

  // ── 2. before_agent_start: inject skill + startup context (first turn only) ─
  pi.on("before_agent_start", async (event) => {
    if (injected) return;
    injected = true;

    let addition = "";

    // Inject hmem-using-hmem skill as <important-reminder>
    try {
      const skill = readFileSync(SKILL_PATH, "utf8");
      addition += `\n\n<important-reminder>\n${skill}\n</important-reminder>`;
    } catch {
      // Skill file not found — skip
    }

    if (startupContext) {
      addition += `\n\n${startupContext}`;
    }

    if (!addition) return;
    return { systemPrompt: (event as any).systemPrompt + addition };
  });

  // ── 3. tool_call: block direct .hmem file reads ───────────────────────────
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "read") return;
    const filePath = (event.input as { file_path?: string }).file_path ?? "";
    if (!filePath.endsWith(".hmem")) return;
    return {
      block: true,
      reason:
        "Direct .hmem file access is blocked. Use hmem MCP tools instead: " +
        "read_memory(), search_memory(), load_project(), or the /hmem-read skill. " +
        "Raw .hmem files are SQLite databases — reading them directly bypasses filtering, FTS5 search, and sync.",
    };
  });

  // ── 4. session_before_compact: checkpoint + context-inject + deactivate ────
  pi.on("session_before_compact", async () => {
    lastLogTime = Date.now();
    await runHmem(["log-exchange"], "{}", 10_000).catch(() => {});
    await runHmem(["context-inject"], "{}", 10_000).catch(() => {});
    await runHmem(["deactivate"], "{}", 5_000).catch(() => {});
  });

  // ── 5. agent_end: checkpoint after every agent response ───────────────────
  pi.on("agent_end", async (event) => {
    // Debounce: skip if session_before_compact just ran
    if (Date.now() - lastLogTime < 5_000) return;
    lastLogTime = Date.now();

    const messages: any[] = (event as any).messages ?? [];

    const lastUser = [...messages].reverse().find((m: any) => m.role === "user");
    const lastAssistant = [...messages].reverse().find((m: any) => m.role === "assistant");

    const userText = extractText(lastUser?.content ?? "");
    const assistantText = extractText(lastAssistant?.content ?? "");

    if (!userText || !assistantText) return;

    await runHmem(
      ["log-exchange"],
      JSON.stringify({ last_user_message: userText, last_assistant_message: assistantText }),
      10_000
    ).catch(() => {});
  });
}
```

- [ ] **Step 2: Run the unit test to verify it passes now**

```bash
cd /home/bbbee/projects/hmem
npx vitest run test/pi-hmem-extension.test.ts
```

Expected: PASS — 4 tests pass.

- [ ] **Step 3: Typecheck**

```bash
cd /home/bbbee/projects/hmem
npx tsc --noEmit
```

Expected: no errors. If `ExtensionAPI` has type errors on event shapes, add targeted `// @ts-ignore` on that line only.

- [ ] **Step 4: Build**

```bash
cd /home/bbbee/projects/hmem
npx tsc
```

Expected: `dist/extensions/pi-hmem.js` created, no errors.

- [ ] **Step 5: Verify dist file exists**

```bash
ls -la /home/bbbee/projects/hmem/dist/extensions/pi-hmem.js
```

Expected: file exists with non-zero size.

- [ ] **Step 6: Commit**

```bash
cd /home/bbbee/projects/hmem
git add src/extensions/pi-hmem.ts test/pi-hmem-extension.test.ts
git commit -m "feat: add Pi coding agent extension with all hmem hooks"
```

---

### Task 4: Update package.json with Pi extension registration

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add `"pi"` key to package.json**

In `package.json`, add after the `"exports"` section:

```json
"pi": {
  "extensions": ["./dist/extensions/pi-hmem"]
},
```

- [ ] **Step 2: Verify `"dist"` covers the extension in `"files"`**

The `"files"` array already contains `"dist"` — this covers `dist/extensions/pi-hmem.js` automatically. No change needed.

- [ ] **Step 3: Run full test suite**

```bash
cd /home/bbbee/projects/hmem
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
cd /home/bbbee/projects/hmem
git add package.json
git commit -m "feat: register pi-hmem as Pi coding agent extension in package.json"
```

---

### Task 5: Local install and smoke test

**Files:** none — verification only

- [ ] **Step 1: Install locally in Pi**

```bash
pi install path:/home/bbbee/projects/hmem
```

Expected: Pi prints `Installed path:/home/bbbee/projects/hmem` with no errors.

- [ ] **Step 2: Verify extension is loaded**

```bash
pi --list-extensions 2>/dev/null || pi extensions 2>/dev/null || echo "check pi --help for extension list command"
```

Expected: `pi-hmem` or `hmem-mcp` appears in the extension list.

- [ ] **Step 3: Smoke test — .hmem block**

Start `pi` and try to read a `.hmem` file:

```
read ~/.hmem/personal.hmem
```

Expected: Pi shows the block message: `Direct .hmem file access is blocked. Use hmem MCP tools instead...`

- [ ] **Step 4: Smoke test — session start injection**

Start a fresh `pi` session and check if the first system prompt contains the hmem-using-hmem skill content. You can check this by asking Pi:

```
What hmem skills and dispatch rules do you know about?
```

Expected: Pi responds with knowledge of `hmem-dispatch`, `hmem-recall`, etc. — proving the skill was injected.

- [ ] **Step 5: Commit final state (if any files changed during testing)**

```bash
cd /home/bbbee/projects/hmem
git status
# commit any fixups
```
