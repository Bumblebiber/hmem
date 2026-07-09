---
name: hmem-release
description: "Pre-publish checklist for hmem: skills synced, version bumped, tests green, nothing forgotten. Use before npm publish or when the user says 'release', 'publish', 'push a release', or 'neue Version'."
---

# /hmem-release — Release Checklist

Run this checklist before every `npm publish` of hmem. Every release touches code, skills, config, and documentation — this skill ensures nothing falls through the cracks.

---

## Step 0: Get Explicit Permission (R0027)

**Always pause before proceeding.** Even when the user invoked this skill, get explicit go-ahead for *this specific release*. Don't infer approval from prior context — "apply the changes" is not "publish".

Show the user:
- Current version → target version
- Bump type (patch / minor / major) and the reason
- Short summary of what's changing (1-3 bullets)

Then ask: "Soll ich publishen?" / "OK to release?" — wait for an explicit yes. If the user pauses, defers, or says "noch nicht", stop and do not run any further steps. The fact that the user asked you to *prepare* a release is not permission to *ship* it.

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
| **hmem-update** | **All user-facing changes**: new MCP tools, removed tools, new CLI commands, statusline changes, new config options, behavior changes, setup steps. This is the changelog users read when upgrading. | **Every release** — if a user upgrading needs to know about it, it goes here. |
| **hmem-curate** | Curation rules (self + foreign-file), hmem_path param, new node types, new tags | New tagged node types (#checkpoint-summary, #skill-dialog), schema changes, hmem_path-capable tool changes |
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

## Step 7b: Hook Artifact Audit

The npm package ships hook scripts that end users must redeploy after every update — and on this dev device (Strato), Hermes itself runs against the same hooks. If any of these files moved, changed args, or got new dependencies, the release skill is the last line of defence before users hit broken hooks.

Files to audit on every release:

| Path | Used by | Deployed via |
|------|---------|--------------|
| `hermes-hooks/hmem-startup.sh` | Hermes Agent (pre_llm_call) | manual `cp` to `~/.hermes/agent-hooks/` |
| `hermes-hooks/hmem-log-exchange.sh` | Hermes Agent (post_llm_call) | manual `cp` to `~/.hermes/agent-hooks/` |
| `hermes-hooks/hmem-statusline.sh` | Hermes Agent statusline | manual `cp` to `~/.hermes/agent-hooks/` |
| `hermes-hooks/hermes-cli-hmem-statusline.patch` | Hermes CLI statusbar injection | `git apply` in `~/.hermes/hermes-agent` |
| `plugins/hermes-hmem/` | Hermes hmem plugin (Python) | manual symlink + enable |
| `scripts/hmem-session-inject.sh` | Claude Code SessionStart | `hmem init` / `hmem setup-hook` |
| `scripts/hmem-statusline.sh` | Claude Code statusline | `hmem init` |

For each file changed in this release:
1. **Run it locally** if it's a shell script — syntax errors only surface at runtime
2. **Confirm the deployment instruction in hmem-update is still accurate** — if a path moved or a flag changed, hmem-update is the user's only signal
3. **Apply the patch dry-run** if `hermes-cli-hmem-statusline.patch` changed: `cd ~/.hermes/hermes-agent && git apply --check ~/projects/hmem/hermes-hooks/hermes-cli-hmem-statusline.patch`
4. **Mention hook changes in release notes** — users won't re-run the deployment steps unless prompted

**Important:** hook BEHAVIOR can change even if the `.sh` files don't, because the scripts call `hmem hook-startup` / `hmem log-exchange` / `hmem statusline` — and any change to `cli-hook-startup.ts`, `cli-context-inject.ts`, or `cli-log-exchange.ts` shifts what those scripts produce. Audit by **behavior**, not just file mtime: if you touched any `cli-*hook*` / `cli-context-inject` / `cli-log-exchange` / `cli-statusline` source file, the Hermes hooks effectively changed.

**Before publish — divergence check:** Compare deployed vs repo to catch local edits that never made it back:
```bash
for f in hmem-startup.sh hmem-log-exchange.sh hmem-statusline.sh; do
  diff -q ~/projects/hmem/hermes-hooks/$f ~/.hermes/agent-hooks/$f
done
```
If anything differs, decide: improvement (copy to repo before release) or accidental edit (restore from repo). Never publish with a known divergence — the npm version will overwrite Hermes-side improvements on other devices.

**Deployment options on this dev device (Hermes host):**

Option A — Symlink (recommended for dev devices): `~/.hermes/agent-hooks/*.sh` symlinked to `~/projects/hmem/hermes-hooks/*.sh`. Any repo change is instantly live; no redeploy step needed.
```bash
for f in hmem-startup.sh hmem-log-exchange.sh hmem-statusline.sh; do
  ln -sf ~/projects/hmem/hermes-hooks/$f ~/.hermes/agent-hooks/$f
done
```

Option B — Copy (default for end users, isolates deployment): explicit `cp` and chmod each time.
```bash
cp ~/projects/hmem/hermes-hooks/*.sh ~/.hermes/agent-hooks/ && chmod +x ~/.hermes/agent-hooks/*.sh
```

If the CLI patch changed: `cd ~/.hermes/hermes-agent && git apply ~/projects/hmem/hermes-hooks/hermes-cli-hmem-statusline.patch`

There is no `hmem deploy-hermes-hooks` command yet — if you find yourself doing this manually for the Nth time, consider adding one with a `--symlink` flag (would also satisfy P0048.16.1 — no manual steps for end users).

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

## Step 8b: Release Notes (always — including patches)

**Every release gets release notes — no exceptions for "trivial" patches.** The GitHub release page is the canonical "what changed in vX.Y.Z" that users check when something behaves differently after an update.

```bash
cd ~/projects/hmem
VERSION=$(node -p "require('./package.json').version")
gh release create "v$VERSION" \
  --title "v$VERSION — <short summary>" \
  --notes "$(cat <<'EOF'
## Changes
- <bullet 1>
- <bullet 2>

## Impact / Migration
<paragraph — or omit if obvious>
EOF
)"
```

Sizing:
- **Patch**: 1–3 bullets, no migration section needed if behavior is purely additive
- **Minor**: bullets per feature, brief migration paragraph if any config touched
- **Major**: full breaking-changes list, before/after examples, migration steps

Never skip with "it's just a tiny patch" — undocumented patches are exactly the ones that surprise users later.

---

## Step 9: Post-Publish

1. Verify on npm: `npm view hmem version`
2. Update Overview version node: `update_memory(id="P0048.1.1", content="vX.Y.Z released (YYYY-MM-DD)")`. If no version node exists yet, create one: `append_memory(id="P0048.1", title="vX.Y.Z released (YYYY-MM-DD)")`
3. Sync to devices: `hmem-sync push` (if applicable)
4. **Redeploy hooks on this Hermes host** (if hook files changed in this release):
   ```bash
   cp ~/projects/hmem/hermes-hooks/*.sh ~/.hermes/agent-hooks/ && chmod +x ~/.hermes/agent-hooks/*.sh
   # If hermes-cli patch changed: cd ~/.hermes/hermes-agent && git apply ~/projects/hmem/hermes-hooks/hermes-cli-hmem-statusline.patch
   # If Claude Code hooks changed: hmem setup-hook  (re-installs ~/.claude/hooks/hmem-session-inject.sh)
   ```
5. Update hmem P-entry protocol: `append_memory(id="P0048.7", content="\tHandoff: vX.Y.Z released...")`
6. Notify user via Telegram if relevant

---

## Quick Reference: What changed → What to check

| Code area | Skills to check |
|-----------|----------------|
| hmem-store.ts (write/read) | hmem-write, hmem-read, hmem-curate |
| hmem-store.ts (O-entries) | hmem-read, hmem-curate |
| hmem-config.ts | hmem-config, hmem-update, hmem-setup |
| mcp-server.ts (new/removed tools) | hmem-write, hmem-read (tool params), **hmem-update** |
| mcp-server.ts (load_project) | hmem-read, hmem-new-project |
| cli-statusline.ts | **hmem-update** (statusline changes users see) |
| cli.ts (new commands) | **hmem-update** (new CLI commands for users), hmem-setup |
| cli-checkpoint.ts | hmem-config (checkpoint docs), hmem-read (summary docs) |
| cli-log-exchange.ts | hmem-setup (hook docs) |
| `hermes-hooks/*` | **Step 7b** + hmem-update (deployment instructions) |
| `plugins/hermes-hmem/*` | **Step 7b** + hmem-update |
| `scripts/hmem-session-inject.sh`, `scripts/hmem-statusline.sh` | **Step 7b** + hmem-setup |
| cli-context-inject.ts | hmem-wipe, **hmem-setup**, **hmem-update** |
| cli-hook-startup.ts | **hmem-setup** (first-message context docs), **hmem-update** (user-visible behavior) |
| Any new skill added | **hmem-update** (list of skills to sync) |
| Any new user-visible behavior | **hmem-update** — always |
