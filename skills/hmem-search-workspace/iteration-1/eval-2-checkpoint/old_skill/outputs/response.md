# Suchergebnis: Checkpoint-Strategie automatisch vs. manuell

## Suchanfrage
"Was hatten wir nochmal zur Checkpoint-Strategie beschlossen? Irgendwas mit automatisch vs. manuell."

---

## Suchverlauf

### Versuch 1: search_memory
- Query: `"Checkpoint-Strategie automatisch manuell"` → Keine Ergebnisse
- Query: `"checkpoint strategy automatic manual"` → Keine Ergebnisse

### Versuch 2: read_memory (Volltext-Suche)
- `search="Checkpoint Strategie"` → Keine Ergebnisse
- `search="checkpoint"` → **40 Treffer** – mehrere relevante Einträge gefunden

### Versuch 3: Gezielte ID-Abfragen
- D0127, D0129, D0134, L0131 und P0048.4.6.1 gelesen
- D0127.3 lieferte den Kerntreffer zur auto/manuell-Unterscheidung

---

## Gefundene Einträge

### D0127 — Strato Telegram-Manager (Kernentscheidung)
**checkpointMode: "remind" (Hinweis) oder "auto" (Haiku-Subagent speichert direkt)**

Entschieden wurde:
- `checkpointMode=auto` auf dem Strato-Server aktiv
- Zwei Modi existieren:
  - **`remind`**: Checkpoint gibt nur einen Hinweis an den Hauptagenten, der dann selbst speichert
  - **`auto`**: Ein Haiku-Subagent wird im Hintergrund gespawnt und speichert direkt (kein Eingriff des Hauptagenten nötig)
- Strato läuft im `auto`-Modus

### D0129 — Auto-checkpoint threshold
**Auto-checkpoint mode set to 20-exchange threshold with background Haiku subagent**

Initial auf 20 Exchanges eingestellt, später angepasst.

### D0134 — Rolling Compression (Checkpoint-Intervall)
**checkpointInterval = 5 (Stop Hook), nicht 20**

Konkrete Architektur:
- Checkpoint feuert **alle 5 Exchanges** (via Stop Hook)
- Die letzten 5 Exchanges bleiben **verbatim** (O-Ton)
- Ältere Exchanges werden **komprimiert** (Rolling Compression)
- Bei 10 Exchanges: 1–5 werden zusammengefasst, 6–10 bleiben verbatim
- Alle 5 neuen Exchanges: letzten 5 immer verbatim, Rest zunehmend komprimiert

### L0131 — Haiku als Checkpoint-Agent
**`claude -p --model haiku --mcp-config ... --dangerously-skip-permissions`**

Guards notwendig:
- kein `--bare` (kein OAuth)
- `flush_context` via `--disallowedTools` blocken
- `HMEM_NO_SESSION=1` in MCP-ENV gegen spurious O-Entries
- Ohne Guards: 158 Ghost-O-Entries beim ersten Test erzeugt

### P0048.4.6.1.14 — Functional Requirement
**Checkpoint: automatisch nach N Exchanges (konfigurierbarer Interval in hmem.config.json)**

### P0048.1.3.3.2 — Architektur-Datenfluss
**Stop hook → log-exchange appends to O-entry → every N exchanges triggers checkpoint or remind nudge**

---

## Antwort (zusammengefasst)

Zur **Checkpoint-Strategie** wurde folgendes beschlossen:

**Zwei Modi:**
1. **`remind`** (manuell): Der Checkpoint gibt dem Hauptagenten nur einen Hinweis, selbst zu speichern.
2. **`auto`** (automatisch): Ein Haiku-Subagent wird im Hintergrund gespawnt und schreibt die Lessons/Decisions/Errors selbst in hmem – ohne dass der Hauptagent eingreifen muss.

**Entschieden: `auto`-Modus** (insbesondere auf dem Strato-Server, D0127).

**Trigger:** Alle **5 Exchanges** feuert der Stop Hook → Checkpoint-Logik prüft, ob Haiku-Subagent nötig ist.

**Rolling Compression:** Letzte 5 Exchanges immer verbatim, ältere progressiv komprimiert (D0134).

Quellen: D0127, D0127.3, D0129, D0134, L0131, P0048.1.3.3.2, P0048.4.6.1.14
