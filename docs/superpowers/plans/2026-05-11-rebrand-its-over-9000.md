# Rebrand: hmem-mcp → its-over-9000 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the npm package from `hmem-mcp` to `its-over-9000`, update all references across code, config, skills, and memory, then publish the new package and deprecate the old one.

**Architecture:** Package rename only — no logic changes. The CLI binary name (`hmem`, `hmem-curate`), internal module structure, and local repo path (`~/projects/hmem`) stay unchanged. GitHub repo renames from `Bumblebiber/hmem` → `Bumblebiber/its-over-9000` (auto-redirect preserves stars/issues/history). Old `hmem-mcp` gets deprecated on npm pointing to `its-over-9000`.

**Tech Stack:** TypeScript, npm, GitHub CLI (`gh`), hmem MCP tools

---

## Files Modified

| File | What changes |
|------|-------------|
| `package.json` | name, repository.url, homepage, bugs.url, mcpName |
| `server.json` | name, websiteUrl, url, identifier |
| `src/mcp-server.ts` | 4 "hmem-mcp" string literals (update messages, npm check) |
| `README.md` | All install/path references to hmem-mcp |
| `CHANGELOG.md` | New 8.0.0 entry |
| `~/.claude/.mcp.json` | Global npm path: hmem-mcp → its-over-9000 |
| `~/.claude/skills/hmem-release/SKILL.md` | Package name references |
| `~/.claude/skills/hmem-setup/SKILL.md` | Install command + GitHub URL |
| `~/.claude/skills/hmem-update/SKILL.md` | Multiple references |
| `~/.claude/skills/hmem-config/SKILL.md` | Windows paths |
| `~/.claude/skills/hmem-migrate-o/SKILL.md` | One reference |
| hmem memory (MCP) | P0048 body, P0048.1.4 Environment, I0008 |

---

## Task 1: Update package.json

**Files:**
- Modify: `~/projects/hmem/package.json`

- [ ] **Step 1: Apply changes**

  Replace these 5 values:

  ```json
  "name": "its-over-9000",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/Bumblebiber/its-over-9000.git"
  },
  "homepage": "https://github.com/Bumblebiber/its-over-9000#readme",
  "bugs": {
    "url": "https://github.com/Bumblebiber/its-over-9000/issues"
  },
  "mcpName": "io.github.Bumblebiber/its-over-9000",
  ```

  Also bump version:
  ```json
  "version": "8.0.0",
  ```

---

## Task 2: Update server.json

**Files:**
- Modify: `~/projects/hmem/server.json`

- [ ] **Step 1: Apply changes** — replace all 4 occurrences:

  ```json
  "name": "io.github.Bumblebiber/its-over-9000",
  "websiteUrl": "https://github.com/Bumblebiber/its-over-9000#readme",
  "url": "https://github.com/Bumblebiber/its-over-9000",
  "identifier": "its-over-9000",
  ```

---

## Task 3: Update src/mcp-server.ts

**Files:**
- Modify: `~/projects/hmem/src/mcp-server.ts` (4 occurrences)

- [ ] **Step 1: Replace all 4 string literals**

  | Line | Old | New |
  |------|-----|-----|
  | 88 | `hmem-mcp updated: v...` | `its-over-9000 updated: v...` |
  | 2588 | `state["hmem-mcp"]` | `state["its-over-9000"]` |
  | 2593 | `["show", "hmem-mcp", "version"]` | `["show", "its-over-9000", "version"]` |
  | 2616 | `npm install -g hmem-mcp@latest` | `npm install -g its-over-9000@latest` |

  Run: `grep -n "hmem-mcp" src/mcp-server.ts` — must return 0 results after.

---

## Task 4: Update README.md

**Files:**
- Modify: `~/projects/hmem/README.md`

- [ ] **Step 1: Replace all npm install references**

  ```
  npm install -g hmem-mcp  →  npm install -g its-over-9000
  npm update -g hmem-mcp   →  npm update -g its-over-9000
  ```

- [ ] **Step 2: Replace all Windows path references** (lines ~155, 168, 180, 199, 292, 299)

  ```
  node_modules/hmem-mcp/dist/  →  node_modules/its-over-9000/dist/
  ```

- [ ] **Step 3: Replace example P-entry line** (line ~99)

  ```
  hmem-mcp | Active | TS/SQLite/npm  →  its-over-9000 | Active | TS/SQLite/npm
  ```

- [ ] **Step 4: Verify — no "hmem-mcp" left**

  ```bash
  grep -n "hmem-mcp" README.md
  ```

  Expected: 0 results.

---

## Task 5: Update CHANGELOG.md

**Files:**
- Modify: `~/projects/hmem/CHANGELOG.md`

- [ ] **Step 1: Add entry at top**

  ```markdown
  ## [8.0.0] — 2026-05-XX

  ### Breaking Changes
  - Package renamed from `hmem-mcp` to `its-over-9000` on npm
  - GitHub repo renamed from `Bumblebiber/hmem` to `Bumblebiber/its-over-9000`
  - `hmem-mcp` is now deprecated — migrate: `npm uninstall -g hmem-mcp && npm install -g its-over-9000`
  - MCP config path update required (see README)

  ### What stays the same
  - CLI binary names: `hmem`, `hmem-curate`
  - All MCP tool names and signatures
  - All existing memory files — no migration needed
  ```

---

## Task 6: Build, Test, Commit

**Files:**
- Modify: `~/projects/hmem/dist/` (build output)

- [ ] **Step 1: Build**

  ```bash
  cd ~/projects/hmem && npm run build
  ```
  Expected: no TypeScript errors.

- [ ] **Step 2: Run tests**

  ```bash
  npm test
  ```
  Expected: `89 passed`.

- [ ] **Step 3: Commit**

  ```bash
  git add package.json server.json src/mcp-server.ts README.md CHANGELOG.md
  git commit -m "feat: rebrand hmem-mcp → its-over-9000 (v8.0.0)"
  ```

---

## Task 7: Rename GitHub Repo

- [ ] **Step 1: Rename via gh CLI**

  ```bash
  gh repo rename its-over-9000 --repo Bumblebiber/hmem
  ```
  GitHub automatically creates a redirect: `Bumblebiber/hmem` → `Bumblebiber/its-over-9000`.

- [ ] **Step 2: Update local remote**

  ```bash
  git remote set-url origin https://github.com/Bumblebiber/its-over-9000.git
  ```

- [ ] **Step 3: Verify**

  ```bash
  git remote -v
  ```
  Expected: shows `Bumblebiber/its-over-9000`.

- [ ] **Step 4: Push**

  ```bash
  git push
  ```

---

## Task 8: Update ~/.claude/.mcp.json

**Files:**
- Modify: `~/.claude/.mcp.json`

The file currently uses the global npm path:
```
/home/bbbee/.nvm/versions/node/v24.14.0/lib/node_modules/hmem-mcp/dist/mcp-server.js
```

- [ ] **Step 1: Install new package globally** (do this AFTER publish in Task 10, or use local path)

  Option A — switch to local dev path (no npm dependency):
  ```json
  "args": ["/home/bbbee/projects/hmem/dist/mcp-server.js"]
  ```

  Option B — after `npm install -g its-over-9000`:
  ```bash
  echo $(npm root -g)/its-over-9000/dist/mcp-server.js
  ```
  Use that path in `.mcp.json`.

  **Recommended:** Option A (already in `~/.mcp.json`, no npm dependency).

- [ ] **Step 2: Restart Claude Code** to reload MCP tool list.

---

## Task 9: Update Skills

**Files:**
- Modify: `~/.claude/skills/hmem-release/SKILL.md`
- Modify: `~/.claude/skills/hmem-setup/SKILL.md`
- Modify: `~/.claude/skills/hmem-update/SKILL.md`
- Modify: `~/.claude/skills/hmem-config/SKILL.md`
- Modify: `~/.claude/skills/hmem-migrate-o/SKILL.md`

- [ ] **Step 1: Global replace in each skill file**

  In every file, replace:
  - `hmem-mcp` → `its-over-9000`
  - `Bumblebiber/hmem` → `Bumblebiber/its-over-9000` (where it's a GitHub URL, not the P-entry title)

  Note: `hmem-migrate-o/SKILL.md` has `"O0001 -> O0048 (P0048 hmem-mcp)"` — this is a P-entry title reference, leave it.

- [ ] **Step 2: Update description in hmem-release**

  Current: `"Pre-publish checklist for hmem-mcp releases"`
  New: `"Pre-publish checklist for its-over-9000 releases"`

- [ ] **Step 3: Verify no stale references**

  ```bash
  grep -rn "hmem-mcp" ~/.claude/skills/ | grep -v "P0048 hmem-mcp"
  ```
  Expected: 0 results (the P-entry title references are fine to keep).

---

## Task 10: Update hmem Memory

- [ ] **Step 1: Update P0048 root body**

  ```
  update_memory(id="P0048", content="its-over-9000 | Active | TS/SQLite/npm | GH: Bumblebiber/its-over-9000")
  ```

- [ ] **Step 2: Update P0048.1.4 Environment node**

  ```
  update_memory(id="P0048.1.4", content="Environment: Repo /home/bbbee/projects/hmem, GH Bumblebiber/its-over-9000")
  ```

- [ ] **Step 3: Update I0008 npm Registry entry**

  ```
  update_memory(id="I0008", content="npm Registry | Account: bumblebiber | its-over-9000 publisher")
  ```

---

## Task 11: Publish + Deprecate

- [ ] **Step 1: Publish its-over-9000**

  ```bash
  cd ~/projects/hmem && npm publish
  ```
  Expected: `+ its-over-9000@8.0.0`

- [ ] **Step 2: Verify on npm**

  ```bash
  npm view its-over-9000 version
  ```
  Expected: `8.0.0`

- [ ] **Step 3: Deprecate hmem-mcp**

  ```bash
  npm deprecate hmem-mcp "Renamed to its-over-9000. Migrate: npm uninstall -g hmem-mcp && npm install -g its-over-9000"
  ```

- [ ] **Step 4: Install new package globally on Strato**

  ```bash
  npm install -g its-over-9000
  ```

- [ ] **Step 5: Smoke test**

  ```bash
  hmem --version
  ```
  Expected: `8.0.0`

- [ ] **Step 6: Update P0048 History**

  ```
  append_memory(id="P0048.7", content="v8.0.0 rebrand: hmem-mcp → its-over-9000")
  ```
