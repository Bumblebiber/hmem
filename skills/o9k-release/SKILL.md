---
name: o9k-release
description: >
  Pre-publish checklist for o9k-mcp releases. Ensures all skills are updated,
  version is bumped, tests pass, and nothing is forgotten. Use before every
  npm publish of o9k-mcp — when the user says "publish", "release", "publishen",
  "neue Version", or when you're about to run npm publish on the hmem repo.
---

# /o9k-release — Release Checklist

Run this checklist before every `npm publish` of o9k-mcp. Every release touches code, skills, config, and documentation — this skill ensures nothing falls through the cracks.

---

## Step 1: Version Bump

```bash
npm version patch --no-git-tag-version  # or minor/major as appropriate
```

Decide the version type based on what changed:
- **patch**: bugfixes, skill text updates, small improvements
- **minor**: new features (new tools, new prefix, new config options, new skills)
- **major**: breaking changes (schema changes, removed tools, API changes)

---

## Step 2: Build & Type Check

```bash
npx tsc --noEmit   # type check first (fast)
npx tsc             # full build
```

Fix any errors before proceeding.

---

## Step 3: Skill Audit

Every code change can affect skill documentation. Check each skill against the current code:

| Skill | Check for | Common triggers |
|-------|-----------|-----------------|
| **o9k-write** | write_memory format, body syntax (`>`), char limits, tag rules | Changes to `parseTree`, `write()`, validation logic |
| **o9k-read** | read_memory output format, load_project display, O-entry format | Changes to `formatBulkRead`, `formatRecentOEntries`, `load_project` rendering |
| **o9k-config** | New config parameters, changed defaults, removed options | Changes to `HmemConfig` interface, `DEFAULT_CONFIG`, `loadHmemConfig` |
| **o9k-update** | **All user-facing changes**: new MCP tools, removed tools, new CLI commands, statusline changes, new config options, behavior changes, setup steps. This is the changelog users read when upgrading. | **Every release** — if a user upgrading needs to know about it, it goes here. |
| **o9k-curate** | Curation rules (self + foreign-file), hmem_path param, new node types, new tags | New tagged node types (#checkpoint-summary, #skill-dialog), schema changes, hmem_path-capable tool changes |
| **o9k-new-project** | P-entry schema (R0009), write_memory format | Changes to P-entry structure or write format |
| **o9k-setup** | Hook scripts, init flow, MCP config format | Changes to hooks, CLI commands, environment variables |
| **o9k-wipe** | Checkpoint references, context threshold | Changes to checkpointMode, contextTokenThreshold |
| **o9k-sync-setup** | Sync config format, sync commands | Changes to sync parsing, o9k-sync integration |

**How to check:** For each skill, grep for key terms from the code change:
```bash
grep -l "relevant_term" skills/*/SKILL.md
```

If a skill references something you changed, read and update it.

---

## Step 4: Config Schema Check

If you added new config parameters:
1. Added to `HmemConfig` interface? (o9k-config.ts)
2. Added to `DEFAULT_CONFIG`? (o9k-config.ts)
3. Parsing logic in `loadHmemConfig`? (o9k-config.ts)
4. Added to `MEMORY_KEYS` set? (o9k-config.ts)
5. Included in `saveHmemConfig` output? (o9k-config.ts)
6. Documented in **o9k-config** skill?

---

## Step 5: Prefix Check

If you added or changed prefixes:
1. Added to `DEFAULT_PREFIXES`? (o9k-config.ts)
2. Added to `DEFAULT_PREFIX_DESCRIPTIONS`? (o9k-config.ts)
3. Documented in **o9k-write** skill (prefix list)?
4. Documented in **o9k-read** skill?

---

## Step 6: Tool Parameter Check

If you changed MCP tool parameters (added, removed, changed types):
1. Zod schema updated in mcp-server.ts?
2. Using `z.coerce.boolean()` for booleans (not `z.boolean()`)?
3. Tool description updated?
4. Affected skills updated?

---

## Step 7: Migration Check

If the release introduces schema changes:
1. `MIGRATIONS` array updated in o9k-store.ts? (ALTER TABLE for new columns)
2. **o9k-update** skill documents the migration step?
3. Auto-migration tested with an old DB?

---

## Step 8: Commit & Publish

```bash
git add src/ skills/ package.json package-lock.json
git commit -m "feat/fix: description

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
npm publish
git push
```

---

## Step 9: Post-Publish

1. Verify on npm: `npm view o9k-mcp version`
2. Update Overview version node: `update_memory(id="P0048.1.1", content="vX.Y.Z released (YYYY-MM-DD)")`. If no version node exists yet, create one: `append_memory(id="P0048.1", title="vX.Y.Z released (YYYY-MM-DD)")`
3. Sync to devices: `o9k-sync push` (if applicable)
4. Update hmem P-entry protocol: `append_memory(id="P0048.7", content="\tHandoff: vX.Y.Z released...")`
5. Notify user via Telegram if relevant

---

## Quick Reference: What changed → What to check

| Code area | Skills to check |
|-----------|----------------|
| o9k-store.ts (write/read) | o9k-write, o9k-read, o9k-curate |
| o9k-store.ts (O-entries) | o9k-read, o9k-curate |
| o9k-config.ts | o9k-config, o9k-update, o9k-setup |
| mcp-server.ts (new/removed tools) | o9k-write, o9k-read (tool params), **o9k-update** |
| mcp-server.ts (load_project) | o9k-read, o9k-new-project |
| cli-statusline.ts | **o9k-update** (statusline changes users see) |
| cli.ts (new commands) | **o9k-update** (new CLI commands for users), o9k-setup |
| cli-checkpoint.ts | o9k-config (checkpoint docs), o9k-read (summary docs) |
| cli-log-exchange.ts | o9k-setup (hook docs) |
| cli-context-inject.ts | o9k-wipe, **o9k-setup**, **o9k-update** |
| cli-hook-startup.ts | **o9k-setup** (first-message context docs), **o9k-update** (user-visible behavior) |
| Any new skill added | **o9k-update** (list of skills to sync) |
| Any new user-visible behavior | **o9k-update** — always |
