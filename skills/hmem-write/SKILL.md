---
name: hmem-write
description: Humanlike Memory schreiben — write_memory Syntax, Praefixe, Qualitaetsregeln.
  Verwende diesen Skill wann immer du write_memory aufrufst.
---

# Skill: hmem-write — Speicher schreiben

## Syntax

```
write_memory(
  prefix: "E",
  content: "L1-Satz — praegnant, ohne Kontext verstaendlich
	L2-Detail (1 Tab oder 2 Spaces)
		L3-Detail (2 Tabs oder 4 Spaces)
			L4-Rohdaten, Stack Traces (3 Tabs — selten)"
)
```

**Einrueckung:** 1 Tab = 1 Ebene. Alternativ: 2 Spaces oder 4 Spaces pro Ebene — auto-erkannt.
**IDs und Timestamps** werden automatisch vergeben — nie selbst schreiben.

---

## Praefixe

| Praefix | Kategorie | Wann |
|---------|-----------|------|
| **P** | Project | Projekterfahrungen, Zusammenfassungen |
| **L** | Lesson | Lessons Learned, Best Practices |
| **E** | Error | Fehler, Bugs + Loesung |
| **D** | Decision | Architektur-Entscheidungen mit Begruendung |
| **T** | Task | Aufgaben-Notizen, Arbeitsfortschritt |
| **M** | Model Insights | Erkenntnisse ueber KI-Modelle, Tools, Infrastruktur |
| **S** | Skill | Skills, Prozesse, Anleitungen |
| **F** | Favorite | Haeufig benoetigte Referenz-Infos |
| **H** | Human | User-/Entwickler-Profil (company store) |
| **C** | Collaboration | Interaktionen mit anderen Agenten |

---

## L1-Qualitaetsregel

- **Ein vollstaendiger, informativer Satz** — ~15–20 Tokens
- Muss ohne jeden Kontext verstaendlich sein
- Kein "Fixed a bug" → stattdessen "SQLite-Verbindung schlug fehl wegen falschem Pfad in .mcp.json"

---

## Firmenwissen schreiben (AL+)

```
write_memory(
  prefix: "S",
  store: "company",
  min_role: "worker",   # worker=alle, al=AL+, pl=PL+, ceo=nur CEO
  content: "..."
)
```

---

## Wann speichern?

**Pflicht vor dem Terminieren.** Nur was in 6 Monaten noch wertvoll ist.

| Speichern ✓ | Nicht speichern ✗ |
|-------------|------------------|
| Neue Fehlerursache + Fix | Routine-Aktionen ohne Lernwert |
| Erkenntnis die kuenftige Arbeit veraendert | Was schon in der Codebasis steht |
| Architektur-Entscheidung mit Begruendung | Temporaere Debugging-Notizen |
| Unerwartetes Tool/API-Verhalten | Was in der Dokumentation steht |

Ein `write_memory`-Aufruf pro Kategorie — gesamte Hierarchie in einem `content`-String.

---

## Anti-Patterns

| Falsch | Richtig |
|--------|---------|
| L1 zu kurz: "Fixed bug" | Vollstaendiger Satz mit Ursache |
| Spaces gemischt mit Tabs | Konsistent bleiben — entweder Tabs oder Spaces |
| Alles flach ohne Einrueckung | Hierarchie nutzen — L2/L3 fuer Details |
| Triviales speichern | Qualitaet vor Quantitaet |
| write_memory vergessen | Immer VOR Status: Completed aufrufen |
