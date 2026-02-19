---
name: hmem-read
description: Humanlike Memory lesen — Lazy Loading Protocol fuer read_memory und search_memory.
  Verwende diesen Skill wann immer du read_memory oder search_memory aufrufst.
---

# Skill: hmem-read — Speicher lesen

## Was beim Start injiziert wird

```
## Your Memory (Level 1 — use read_memory for details)
[E0042] SQLite-Datei nicht gefunden beim MCP-Start
[L0003] Schema-Migrationen immer mit IF NOT EXISTS absichern

## Company Knowledge (FIRMENWISSEN — use read_memory with store: "company")
[S0001] Company Philosophy: Quality Over Speed — read before write, test before done
```

L1-Summaries aller Eintraege — direkt nutzbar. Fuer Details gezielt aufklappen.

---

## Lazy Loading Protocol

```
# Schritt 1 — Ueberblick (bereits in deinem Kontext — nur noetig bei Kontext-Reset)
read_memory()

# Schritt 2 — Kategorie filtern
read_memory(prefix="E")          # nur Fehler
read_memory(store="company")     # nur Firmenwissen

# Schritt 3 — Root-Eintrag aufklappen → zeigt L2-Kinder
read_memory(id="E0042")

# Schritt 4 — L2-Knoten aufklappen → zeigt L3-Kinder
read_memory(id="E0042.2")

# Schritt 5 — L3-Knoten aufklappen → zeigt L4-Kinder (selten noetig)
read_memory(id="E0042.2.1")
```

**Regel: depth-Parameter ist nur fuer Listings sinnvoll (max 3), nicht fuer ID-Queries.**

```
read_memory(depth=2)             # alle Eintraege mit L2-Kindern — kompakter Ueberblick
read_memory(prefix="L", depth=2) # alle Lessons mit Details
```

---

## Suche

```
search_memory(query="Node.js startup crash")
search_memory(query="auth token", scope="memories")   # nur .hmem Stores
search_memory(query="delegation", scope="skills")      # nur Skill-Dateien
```

---

## Anti-Patterns

| Falsch | Richtig |
|--------|---------|
| `read_memory(id="E0042", depth=3)` | `read_memory(id="E0042.2")` — branch by branch |
| Alle Eintraege laden ohne Ziel | Erst L1 pruefen, dann gezielt aufklappen |
| .hmem-Datei direkt lesen | Immer ueber MCP-Tools — SQLite-Binaerdatei |
