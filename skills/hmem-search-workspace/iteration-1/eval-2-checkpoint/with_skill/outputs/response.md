# Suche: Checkpoint-Strategie (automatisch vs. manuell)

## Suchanfrage

"Was hatten wir nochmal zur Checkpoint-Strategie beschlossen? Irgendwas mit automatisch vs. manuell."

---

## Suchverlauf

### Versuch 1: Direkter Begriff aus der Frage
`search: "Checkpoint-Strategie automatisch manuell"` → **kein Treffer**

### Versuch 2: Englische Variante
`search: "checkpoint strategy automatic manual"` → **kein Treffer**

### Versuch 3: Compound-Split + breitere Suche
`search: "checkpoint"` → **40 Treffer** — sehr relevant!

Gefundene Einträge mit direktem Bezug:
- **D0129** — "Auto-checkpoint mode set to 20-exchange threshold with background Haiku subagent"
- **D0134** — "Rolling Compression: Last 5 Exchanges Verbatim, 6-10 Summarized"
- **L0131** — "Haiku als Checkpoint-Agent mit MCP-Zugang"
- **L0128** — "Background checkpoint spawning with Haiku subagent avoids blocking main agent"
- **P0048.4.6.1.14** — "Checkpoint: automatisch nach N Exchanges (konfigurierbarer Interval in hmem.config.json)"
- **P0048.1.3.3.2** — "Stop hook → log-exchange appends to O-entry → every N exchanges triggers checkpoint or remind nudge"

### Versuch 4: Drill-down in relevante Einträge
- `id=D0134` + Kinder gelesen → Bestätigung: `checkpointInterval = 5 (Stop Hook), not 20` (D0134.2)
- `id=P0048.1.3.2.4` → `cli-checkpoint.ts: Spawns Haiku with MCP config → reads 20 exchanges → extracts L/D/E + handoff`
- `id=P0048.1.3.3.2` → Zwei Modi sichtbar: automatisch (nach N) ODER "remind nudge"
- `find_related(D0129)` → Cluster bestätigt: D0128, D0129, D0130 entstanden am 2026-03-28, alle mit Tag `#auto-checkpoint`

### Weitere Versuche (null Treffer)
- `"checkpoint automatisch manuell Entscheidung"` → kein Treffer
- `"checkpoint trigger manual automatic decision"` → kein Treffer
- `"checkpoint remind nudge user"` → kein Treffer
- `"flush_context manuell automatisch"` → kein Treffer

---

## Ergebnis

Die Checkpoint-Strategie ist dokumentiert — verteilt über mehrere Einträge, kein einziger dedizierter "Entscheidungs-Eintrag":

### Was entschieden wurde

**Automatisch (primär):** Der Checkpoint feuert automatisch nach jedem N-ten Exchange via Stop Hook. Der aktuelle Wert ist **checkpointInterval = 5** (D0134.2 — korrigiert gegenüber einem früheren Wert von 20). Das bedeutet: alle 5 Exchanges läuft Haiku als Subagent im Hintergrund, extrahiert L/D/E-Einträge und schreibt ein Handoff in P.7.

**Manuell / "remind nudge" (Fallback):** Wenn kein automatischer Checkpoint gefeuert hat, kann ein "remind nudge" ausgelöst werden (P0048.1.3.3.2). Das entspricht dem manuellen Modus — der User oder das System erinnert daran, einen Checkpoint zu machen.

**Hintergrund-Spawning (nicht-blockierend):** Die Entscheidung war, Haiku als *Background Subagent* zu spawnen (L0128), damit der Hauptagent nicht blockiert wird. Das war die Kern-Architekturentscheidung rund um 2026-03-28.

### Kurzzusammenfassung

| Aspekt | Entscheidung |
|--------|-------------|
| Primärmodus | **Automatisch** — nach jedem 5. Exchange via Stop Hook |
| Frühere Schwelle | 20 Exchanges (D0129, später auf 5 geändert, D0134.2) |
| Ausführung | Haiku-Subagent im Hintergrund (nicht-blockierend) |
| Fallback | "remind nudge" bei ausbleibendem Auto-Checkpoint |
| Konfigurierbar | Ja — `checkpointInterval` in `hmem.config.json` |

### Relevanteste Einträge

- **D0134** · 2026-03-30 · Rolling Compression: checkpointInterval = 5, Haiku-Checkpoint feuert alle 5 Exchanges
- **D0129** · 2026-03-28 · Frühere Version: 20-Exchange-Threshold mit Background-Haiku — später geändert
- **L0128** · 2026-03-28 · Background-Spawning vermeidet Blockierung des Hauptagenten
- **L0131** · 2026-03-28 · Haiku als Checkpoint-Agent (Guards nötig: kein --bare, flush_context explizit)
- **P0048.4.6.1.14** · Requirement: Checkpoint automatisch nach N Exchanges, konfigurierbar
