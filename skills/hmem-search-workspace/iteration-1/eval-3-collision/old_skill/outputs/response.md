# O-Entry Kollisionen beim Multi-Agent-Betrieb — Suchergebnisse

## Suchversuche

1. `search_memory("O-Entry Kollision Multi-Agent", scope=all)` → keine Ergebnisse
2. `search_memory("O-Entry collision multi-agent concurrent writes", scope=all)` → keine Ergebnisse
3. `search_memory("O-Entry conflict parallel agents", scope=memories)` → keine Ergebnisse
4. `read_memory(search="O-Entry Kollision")` → trifft O0048 (irrelevant)
5. `read_memory(search="O-Entry collision")` → trifft O0048 (irrelevant)
6. `read_memory(search="multi-agent O-Entry")` → trifft O0054, O0048 (irrelevant)
7. `read_memory(search="O-Entry ID collision duplicate parallel")` → keine Ergebnisse
8. `read_memory(search="append_memory collision concurrent")` → keine Ergebnisse
9. `read_memory(search="write_memory race condition")` → trifft P0048.6 (Bugs) — Treffer!
10. `read_memory(id="P0048", expand=true)` → P0048.8.9 "Multi-agent ID-collision prototype" gefunden
11. `read_memory(id="P0048.8.9")` → vollständiges Detail gelesen
12. `read_memory(id="P0048.8.9.2/3/4")` + `read_memory(id="T0049")` → komplettes Bild

---

## Gefundener Eintrag

### T0049 — ID-Konflikt-Prävention & -Auflösung in hmem + hmem-sync (✓ erledigt)

**Problem:** Wenn mehrere Agenten gleichzeitig offline arbeiten und beide lokal dieselbe nächste freie ID vergeben (z.B. beide erstellen P0048), korrumpiert der Sync die Datenbank.

**Entschiedene Lösung (3-Phasen-Ansatz):**

- **Phase 1:** `rename_id` Tool (rein lokal, sofort nützlich) — benennt eine ID und alle Verweise atomar um
- **Phase 2:** Konflikt-Erkennung beim sync-push (Server-seitig) — Server meldet konfliktbehaftete IDs + nächste freie ID als Vorschlag
- **Phase 3:** Server-seitige ID-Vergabe via POST `/reserve-id` — MCP ruft Server auf *vor* dem lokalen Schreiben

**Typischer Ablauf nach Konflikt:**
1. Agent pushed → Server meldet Konflikt: P0048 belegt, nächste freie: P0052
2. Agent ruft `rename_id("P0048", "P0052")` auf
3. Agent pushed erneut → Erfolg

---

### P0048.8.9 — Multi-agent ID-collision prototype (2026-04-08)

**Implementiert als 2-Layer-System:**

**Layer 1 (Root IDs):**
- `id_reservations` Tabelle + `POST /reservations` auf hmem-sync
- `write_memory` pulled, peekNextId, reserviert via `hmem-sync reserve`
- Retry bei 409 (max 5×)
- End-to-end getestet

**Layer 2 (append/update — Optimistic Locking):**
- `version_hash` Spalte auf blobs (sha256 der Daten)
- `POST /blobs` akzeptiert `expected_version` pro Blob, gibt `conflicts[]` zurück
- Rückwärtskompatibel: `undefined expected_version` → LWW-Fallback
- Detection end-to-end via curl validiert

**Implementierungsdetails (Commit-Historie):**

- **Commits 08c46f5 + 6ae0fd2:** Auto-retry loop — `syncPushSync()` + `syncPushWithRetry()`. `append_memory` und `update_memory` nutzen Retry-Wrapper statt fire-and-forget. Loop: push → exit 3 bei conflict → pull (auto-updates `state.versions`) → retry, max 3 Versuche. Fail-open bei Transport-Fehler.
- **Commit 82d9780:** Coverage erweitert — `create_project`, `import_memory`, `move_nodes` wrappen jetzt ebenfalls Reserve+Retry. Race-Test (curl, 10× parallel reservation + 5× parallel optimistic push) hat beide Layer als robust validiert.
- **Commit ebf86f3:** Sub-Node ID Reservation — Option β. `peekAppendTopLevelIds` in hmem-store + `reserveNextSubIds` Loop in mcp-server. `append_memory` reserviert vor `appendChildren` alle direct-child IDs. Race-test 5× parallel CLI reserve auf dieselbe sub-id: 1× exit 0, 4× exit 1. Bestanden.

**Abgedeckte Tools:** `write_memory`, `create_project`, `append_memory`, `update_memory`, `move_nodes`, `import_memory`

**Letzter offener Punkt:** Live-Race mit zwei Claude-Code Instanzen die echte hmem-Inhalte schreiben (als Akzeptanz-Test)

**Tags:** #hmem-sync #multi-agent #optimistic-locking #prototype #sub-node-reservation #complete

---

## Zusammenfassung der Entscheidung

Die Lösung für O-Entry Kollisionen beim Multi-Agent-Betrieb basiert auf einem **Zwei-Layer-Ansatz mit Server-seitiger ID-Reservierung**:

1. **Für Root-IDs** (z.B. O0048, P0001): Atomare Reservierung beim Sync-Server *vor* dem Schreiben — verhindert Kollisionen präventiv
2. **Für Sub-Nodes und Inhalt** (append/update): Optimistic Locking mit version_hash — erkennt Konflikte beim Push und löst sie per Auto-Retry (pull → re-apply → push)
3. **Offline-Fallback**: Wenn Sync-Server nicht erreichbar → lokale ID-Vergabe wie bisher + Warning

Die Implementierung gilt als **abgeschlossen** (T0049 ✓), alle relevanten MCP-Tool-Pfade sind abgedeckt.
