# Antwort: H-Standardschema in hmem

## Suchanfrage
"Gibt es irgendwo in hmem ein definiertes H-Standardschema?"

---

## Suchverlauf

### Versuch 1: Direkte Suche nach "H-Standardschema"
- `search_memory("H-Standardschema H-Entry Schema")` → Keine Ergebnisse
- `read_memory(prefix="H", titles_only=true)` → Zeigt H-Entries (H0002–H0007), aber kein Schema-Eintrag

### Versuch 2: Breitere Suche
- `search_memory("Schema Dokumentation Entry-Format Standardschema")` → Keine Ergebnisse
- `read_memory(search="H-Schema Standardschema")` → Keine Ergebnisse

### Versuch 3: Suche nach verwandten Begriffen
- `read_memory(search="Entry Schema Format Felder")` → Trifft L0194 (P-Schema Curation), enthält Verweis auf **R0009**
- `search_memory("H-Entry Human Schema Struktur")` → 1 irrelevanter Treffer (O0048)

### Versuch 4: R-Entries durchsuchen (Rules)
- `read_memory(prefix="R", titles_only=true)` → **R0025** gefunden: "H-Entry Schema: Standard-Struktur für Human-Context-Einträge"
- `read_memory(id="R0025", expand=true)` → Vollständiges Schema gelesen

---

## Ergebnis: JA — R0025 definiert das H-Standardschema

**Entry:** R0025  
**Titel:** H-Entry Schema: Standard-Struktur für Human-Context-Einträge

### Kernprinzip
H-Entries sind **separate Root-Einträge pro Kategorie** (kein einzelner Monolith). Jeder Eintrag hat Sub-Nodes mit konsistenter Struktur.

### Definierte Kategorien (mit zugehörigen H-Entries)

| Kategorie | Entry | Inhalt |
|-----------|-------|--------|
| Identity/Contact | H0002 | GitHub, E-Mail, Repos |
| Context/Background | H0006 | Rolle, Unternehmen, Geräte, Ziele |
| Work Style | H0005 | Kommunikation, Sprache, Entscheidungsstil, YAGNI-Prinzip |
| Preferences | H0007 | Mag/nervt, Ton, Detailgrad |
| Skills: Tech & Domain | H0003 | IT-Skills mit 1–9 Skala |
| Skills: Business | H0004 | PM, Strategie, Marketing mit 1–9 Skala |

### Skill-Skala (H0003/H0004)
- **1–3** = Basics (mit Beispielen erklären)
- **4–6** = Proficient
- **7–9** = Expert

### Agent-Direktive
Vor technischen Erklärungen H0003 prüfen. Expert → direkt. Basics → Beispiele.

### Schema-Enforcement
Kein Enforcement nötig — Einträge bleiben eigenständig, Schema dient als Orientierung.

---

## Verwandte Entries
- **R0009** — P-Entry Standard-Schema (9 Sektionen: Overview, Codebase, Usage, Context, Deployment, Bugs, History, Roadmap, Ideas)
- **R0012** — E-Entry Schema (Error/Bug Tracking)
- **L0194** — P-Schema Curation Session (2026-05-11), enthält auch E-Entry Schema-Felder
