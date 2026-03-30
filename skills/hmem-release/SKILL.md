---
name: hmem-release
description: >
  Pre-publish checklist for hmem-mcp releases. Ensures all skills are updated,
  version is bumped, tests pass, and nothing is forgotten. Use before every
  npm publish of hmem-mcp — when the user says "publish", "release", "publishen",
  "neue Version", or when you're about to run npm publish on the hmem repo.
---

# /hmem-release — Release Checklist

Run this checklist before every `npm publish` of hmem-mcp. Every release touches code, skills, config, and documentation — this skill ensures nothing falls through the cracks.

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
| **hmem-write** | write_memory format, body syntax (`>`), char limits, tag rules | Changes to `parseTree`, `write()`, validation logic |
| **hmem-read** | read_memory output format, load_project display, O-entry format | Changes to `formatBulkRead`, `formatRecentOEntries`, `load_project` rendering |
| **hmem-config** | New config parameters, changed defaults, removed options | Changes to `HmemConfig` interface, `DEFAULT_CONFIG`, `loadHmemConfig` |
| **hmem-update** | New migration steps, new post-update checks | Any schema change, new features that need post-update setup |
| **hmem-curate** | Curation rules, new node types, new tags | New tagged node types (#checkpoint-summary, #skill-dialog), schema changes |
| **hmem-self-curate** | Same as curate but for agent self-curation | Same triggers as hmem-curate |
| **hmem-new-project** | P-entry schema (R0009), write_memory format | Changes to P-entry structure or write format |
| **hmem-setup** | Hook scripts, init flow, MCP config format | Changes to hooks, CLI commands, environment variables |
| **hmem-wipe** | Checkpoint references, context threshold | Changes to checkpointMode, contextTokenThreshold |
| **hmem-sync-setup** | Sync config format, sync commands | Changes to sync parsing, hmem-sync integration |

**How to check:** For each skill, grep for key terms from the code change:
```bash
grep -l "relevant_term" skills/*/SKILL.md
```

If a skill references something you changed, read and update it.

---

## Step 4: Config Schema Check

If you added new config parameters:
1. Added to `HmemConfig` interface? (hmem-config.ts)
2. Added to `DEFAULT_CONFIG`? (hmem-config.ts)
3. Parsing logic in `loadHmemConfig`? (hmem-config.ts)
4. Added to `MEMORY_KEYS` set? (hmem-config.ts)
5. Included in `saveHmemConfig` output? (hmem-config.ts)
6. Documented in **hmem-config** skill?

---

## Step 5: Prefix Check

If you added or changed prefixes:
1. Added to `DEFAULT_PREFIXES`? (hmem-config.ts)
2. Added to `DEFAULT_PREFIX_DESCRIPTIONS`? (hmem-config.ts)
3. Documented in **hmem-write** skill (prefix list)?
4. Documented in **hmem-read** skill?

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
1. `MIGRATIONS` array updated in hmem-store.ts? (ALTER TABLE for new columns)
2. **hmem-update** skill documents the migration step?
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

1. Verify on npm: `npm view hmem-mcp version`
2. Sync to devices: `hmem-sync push` (if applicable)
3. Update hmem P-entry protocol: `append_memory(id="P0048.7", content="\tHandoff: v5.x.x released...")`
4. Notify user via Telegram if relevant

---

## Quick Reference: What changed → What to check

| Code area | Skills to check |
|-----------|----------------|
| hmem-store.ts (write/read) | hmem-write, hmem-read, hmem-curate |
| hmem-store.ts (O-entries) | hmem-read, hmem-self-curate, hmem-curate |
| hmem-config.ts | hmem-config, hmem-update, hmem-setup |
| mcp-server.ts (tools) | hmem-write, hmem-read (tool params) |
| mcp-server.ts (load_project) | hmem-read, hmem-new-project |
| cli-checkpoint.ts | hmem-config (checkpoint docs), hmem-read (summary docs) |
| cli-log-exchange.ts | hmem-setup (hook docs) |
| cli-context-inject.ts | hmem-wipe, hmem-setup |
| Any new skill added | hmem-update (list of skills to sync) |
