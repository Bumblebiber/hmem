# hermes-hmem

[its-over-9k](https://github.com/Bumblebiber/its-over-9k) (hmem) integration for the Hermes agent.

Logs every (user, assistant) exchange to the active hmem O-entry and fires
the `hmem checkpoint` background agent when a batch fills up or the session ends.

Shell hooks alone can't do this — Hermes' `post_llm_call` Python hook is the
only call site that exposes the assistant response payload. This plugin is
the Python equivalent of `src/extensions/pi-hmem.ts` in the hmem repo.

## Requirements

- Hermes agent installed (any version exposing `register_hook`)
- `hmem` CLI on `PATH` — install with `npm install -g its-over-9k`
- A checkpoint provider configured: see hmem's [Checkpoint setup per harness](../../README.md#checkpoint-setup-per-harness)

## Install

```bash
mkdir -p ~/.hermes/plugins
ln -s "$(npm root -g)/its-over-9k/plugins/hermes-hmem" ~/.hermes/plugins/hermes-hmem
hermes plugins enable hermes-hmem
```

(For local development from a cloned repo, point the symlink at `~/projects/hmem/plugins/hermes-hmem` instead.)

Restart Hermes. Verify:

```bash
hermes plugins list | grep hermes-hmem
```

## What it does

| Hook | Action |
|------|--------|
| `on_session_start` | Initializes per-session buffer keyed by Hermes' `session_id` |
| `pre_llm_call` | Captures the latest user turn (only when `turn_type == "user"`) |
| `post_llm_call` | Pairs user + assistant text, pipes JSON to `hmem log-exchange`. Spawns `hmem checkpoint` (detached) when the response signals a full batch |

We deliberately do **not** register `on_session_end` — in Hermes that hook fires once per `run_conversation` call (per turn), not at true process exit. Spawning a checkpoint there would fire on every turn. Checkpoints fire instead from the batch-full signal returned by `hmem log-exchange`. To force a final summary, run `hmem checkpoint` manually on shutdown (e.g. from a shell alias).

Session keys are prefixed with `hermes:` so O-entries can be traced back to
this harness.

Exchange logging is debounced (5s) to avoid double-logging when other hooks
also write to hmem.

## Disable / uninstall

```bash
rm ~/.hermes/plugins/hermes-hmem
```

Or `hermes plugins disable hermes-hmem` if your Hermes version supports it.
