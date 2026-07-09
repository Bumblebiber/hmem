# Suchanfrage: H-Standardschema in hmem

**Frage:** Gibt es irgendwo in hmem ein definiertes H-Standardschema?

---

## Suchdurchlauf

### Versuch 1 — Direkte Keywords
```
read_memory({ search: "H-Standardschema H-Schema Standard" })
```
**Ergebnis:** Keine Treffer.

### Versuch 2 — Englische Variation
```
read_memory({ search: "H-entry schema" })
```
**Ergebnis:** 3 Treffer, darunter D0263, das einen Hinweis auf ein "H-schema standard" enthält. Der verlinkte Node O0048.71.1.5 lautet: "Evaluate H/I-entry feature quality, propose H-schema standard".

### Versuch 3 — R-Entries durchsuchen
```
read_memory({ prefix: "R", search: "H" })
```
**Ergebnis:** Zu groß fur direktes Lesen, in Datei gespeichert. Grep auf diese Datei ergab direkten Treffer:
```
R0025 ✓  H-Entry Schema: Standard-Struktur für Human-Context-Einträge
```

### Versuch 4 — R0025 vollständig lesen
```
read_memory({ id: "R0025" })
```
**Ergebnis:** Vollständiges Schema gefunden (siehe unten).

---

## Ergebnis

**Ja, es gibt ein definiertes H-Standardschema: R0025**

### R0025 — H-Entry Schema: Standard-Struktur für Human-Context-Einträge

H-Entries sind separate Root-Einträge pro Kategorie (kein einzelner Monolith). Jeder Eintrag hat Sub-Nodes mit konsistenter Struktur:

- **H0002** — Identity/Contact: GitHub, E-Mail, Repos
  - `.1` Context/Background
  - `.2` Work Style
  - `.3` Preferences
  - `.4` Skills: Tech & Domain
  - `.5` Skills: Business
  - `.6` Agent-Direktive: Vor technischen Erklärungen H0003 prüfen
  - `.7` Kein Schema-Enforcement nötig

Links: H0002, H0003, H0004, H0005, H0006, H0007

### Aktuelle H-Entries
| ID | Inhalt |
|----|--------|
| H0002 | Identity/Contact (GitHub: Bumblebiber) |
| H0003 | User Skill Assessment: IT |
| H0004 | User Skill Assessment: Business |
| H0005 | User Arbeitsstil und Kommunikation |
| H0006 | User Kontext: Solo-Entwickler, Gründer, 6 Geräte |
| H0007 | User Präferenzen |

### Verwandte Einträge (aus R0025-Relation)
- **R0012** — E-Entry Schema (Error/Bug Tracking)
- **D0263** — Output structure: code-level Rules filtering (erwähnt H-schema als offene Idee)

---

## Zusammenfassung

Das H-Standardschema ist in **R0025** dokumentiert. Es definiert H-Entries als separate Root-Einträge pro Kategorie (Identity, Work Style, Preferences, Skills Tech, Skills Business) — kein einzelner Monolith. Das Schema wurde im Kontext der hmem v6-Redesign-Session (O0048) etabliert, nachdem in D0263 die Idee eines H-schema-Standards ("Identity, Work Style, Priorities, Preferences") erstmals vorgeschlagen wurde.
