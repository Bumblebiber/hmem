# P-Entry Schema (R0009)

All P-entries (projects) must follow the standard L2 structure:

```
.1 Overview
.2 Codebase
.3 Usage
.4 Context
.5 Deployment
.6 Bugs
.7 Protocol
.8 Open tasks
.9 Ideas
```

## Enforcement procedure

For each active P-entry:

1. `read_memory(id="P00XX", depth=2)` — check L2 structure
2. Compare against the schema above
3. Add missing sections: `append_memory(id="P00XX", content="\tOverview\n\t\tCurrent state: ...")`
4. L1 body should be: `Name | Status | Stack | Description`

Do not restructure entries that already follow the schema. Only fix what is missing or wrong.
