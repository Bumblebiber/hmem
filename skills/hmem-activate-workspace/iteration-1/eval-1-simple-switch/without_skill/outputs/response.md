# Aktiviere Projekt hmem — Simulation ohne Skill

## Aufgabe
Benutzer sagt: "aktiviere projekt hmem"
Aktuell aktives Projekt: P0043 (EasySAP)

## Schritte, die ich durchführen würde (ohne mcp__hmem__load_project zu VERWENDEN)

### Schritt 1: Projekt identifizieren
- Benutzer sagt "aktiviere projekt hmem"
- Ich weiß aus dem Kontext, dass ich in `/home/bbbee/projects/hmem` bin
- Das Projekt "hmem" ist wahrscheinlich eine der P-Einträge in meinem hmem-Speicher
- Normalerweise würde ich `list_projects()` aufrufen, aber ich kann hier keine MCP-Tools aufrufen
- Im Standard-Workflow: Ich würde das hmem-Projekt in der P-Liste suchen (vermutlich P00XX für "hmem")

### Schritt 2: Das hmem-Projekt laden
Normalerweise würde ich aufrufen:
```
mcp__hmem__load_project({
  "id": "P00XX",  // Die echte ID des hmem-Projekts
  "store": "personal"
})
```

Dies würde:
- Die L2-Inhalte des Projekts (Overview, Codebase, Usage, Context, Deployment, Bugs, Protocol, Open tasks, Ideas) laden
- Die L3-Untertitel anzeigen (die Subcategory-Titel unter jedem L2)
- Das Projekt als aktiv markieren [*]
- Das vorherige Projekt (P0043 EasySAP) deaktivieren

### Schritt 3: Projekt-Status aktualisieren
Im hmem-System:
- Das neue Projekt hmem wird mit [*] aktiv markiert
- Das alte Projekt P0043 (EasySAP) wird auf inaktiv gesetzt
- Der nächste Bulk-Read würde nur Einträge mit [*] zeigen (statt alle Einträge)

### Schritt 4: Benutzer-Feedback
Nach erfolgreicher Aktivierung würde ich dem User zeigen:
```
✓ Projekt "hmem" ist jetzt aktiv
```

Und dann würde ich die Projekt-Briefing anzeigen:
```
P00XX: hmem — [*]

L2.1 Overview: ...
L2.2 Codebase: ...
L2.3 Usage: ...
... etc
```

## Warum das der richtige Weg ist

1. **Einfach und klar**: Der Benutzer sagt "aktiviere", das System führt aus
2. **Kontextbewusstsein**: `load_project()` kombiniert Read + Update in einem Aufruf
3. **Automatische Deaktivierung**: Das alte Projekt wird automatisch inaktiviert
4. **Briefing**: Der User bekommt sofort die vollständige Projekt-Übersicht (~700 Tokens)
5. **Speicher**: Künftige Sessions sehen, dass hmem das aktive Projekt ist

## Was würde NICHT passieren

- ❌ Ich würde das Projekt NICHT einfach nur lesen (ohne zu aktivieren)
- ❌ Ich würde das Projekt NICHT aus der Liste suchen und dann separat aufrufen
- ❌ Ich würde das vorherige Projekt NICHT manuell deaktivieren
- ❌ Ich würde den Benutzer NICHT fragen, welches Projekt gemeint ist (es ist klar: "hmem")

## Zusammenfassung

Der Workflow für "aktiviere projekt hmem":

1. **Identifizieren**: Das hmem-Projekt in der Memory finden (P00XX)
2. **Laden**: `load_project(id="P00XX")` aufrufen
3. **Update**: Projekt wird [*] aktiv, vorheriges wird inaktiv
4. **Feedback**: Vollständige Briefing dem User zeigen
5. **Speichern**: Status in hmem persistiert automatisch

Dies ist ein **Single-Step-Dialog**, kein mehrstufiger Prozess.
