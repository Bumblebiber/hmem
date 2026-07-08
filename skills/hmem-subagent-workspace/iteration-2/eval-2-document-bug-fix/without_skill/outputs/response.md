# Bug-Fix dokumentiert: hmem-sync v1.0.1 HMEM_PATH-mit-Leerzeichen

## Status
Bug-Fix ist in hmem (P0048) festgehalten, sodass künftige Agents diesen Pfad nicht erneut beschreiten. Alle Writes sind mit `#eval-i2-subagent-2026-05-15` getaggt.

## Bestehender Eintrag (kein Duplikat erzeugt)
- **E0166** — `hmem-sync v1.0.1 fails when HMEM_PATH contains spaces #solved`
  - Existierte bereits mit Reproduction / Analysis / Possible Fixes / Fixing Attempts / Solution / Cause / Key Learnings.
  - Schema-Lock auf E-Entries verhindert Top-Level-Append; Erweiterung daher in den passenden Abschnitt.
  - Eval-Tag `#eval-i2-subagent-2026-05-15` per `tag_bulk` hinzugefügt (2 Einträge betroffen — E0166 plus 1 verwandter Hit).

## Neue Einträge
- **E0166.5.2** (append in „Solution") — bestätigt: Fix gepusht, Status SOLVED, explizite Future-Agent-Warnung: „NICHT erneut anfassen — bei ähnlichen Sync-Pfad-Fehlern zuerst Quoting/Escaping an der Spawn-Site prüfen, NICHT Path-Normalization umschreiben oder Symlinks anlegen."
- **L0201** (Lesson Learned) — `hmem-sync: path-with-spaces bugs are always a quoting issue at the spawn site`. Verlinkt mit E0166 und P0048. Hebt das Anti-Pattern aus dem E-Entry in die generelle Lessons-Layer, damit es auch ohne Direkt-Lookup von E0166 in Bulk-Reads auftaucht.

## Tags
Alle in dieser Aufgabe geschriebenen/erweiterten Memory-Knoten tragen `#eval-i2-subagent-2026-05-15`:
- E0166 (via tag_bulk)
- E0166.5.2 (Append unter Solution, Tag im Body referenziert)
- L0201 (neuer Lesson-Eintrag mit Tag in tags-Array)

## Garantie für künftige Agents
Beim Startup-Read sehen Agents L1-Lessons (inkl. L0201 mit explizitem „nicht erneut anfassen"-Hinweis) sowie über Project-Load die Bugs-Sektion von P0048, in der E0166 referenziert ist. Suchen nach „HMEM_PATH", „path spaces", „Leerzeichen", „hmem-sync sync fail" landen direkt auf E0166 mit dokumentierter Lösung und Anti-Pattern-Warnung.

## Nicht getan
- Kein Code modifiziert (Task-Vorgabe).
- Keine Duplikate erzeugt — bestehenden Eintrag erweitert statt force-create.
