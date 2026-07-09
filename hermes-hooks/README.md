# Hermes Agent Hooks (hmem)

Hook-Scripts für Hermes Agent, die hmem-Integration bereitstellen:

| Script | Zweck |
|--------|-------|
| `hmem-startup.sh` | pre_llm_call — Sync-Status, Projekt-Liste, session_id-Cache |
| `hmem-log-exchange.sh` | post_llm_call — Exchange-Logging an hmem |
| `hmem-statusline.sh` | Statusbar — Device | Projekt → O-Node | Checkpoint-Counter |

## Deployment

```bash
cp hermes-hooks/*.sh ~/.hermes/agent-hooks/
chmod +x ~/.hermes/agent-hooks/*.sh
```

## Hermes CLI Patch

`hermes-cli-hmem-statusline.patch` — fügt hmem-Status in die Hermes Statusbar ein.
Anwenden:
```bash
cd ~/.hermes/hermes-agent
git apply ~/projects/hmem/hermes-hooks/hermes-cli-hmem-statusline.patch
```

## Konfiguration (config.yaml)

```yaml
hooks:
  pre_llm_call:
    - command: "~/.hermes/agent-hooks/hmem-startup.sh"
      timeout: 10
  post_llm_call:
    - command: "~/.hermes/agent-hooks/hmem-log-exchange.sh"
      timeout: 10
  on_session_end:
    - command: "/bin/bash -c 'exec hmem checkpoint'"
      timeout: 120
```
