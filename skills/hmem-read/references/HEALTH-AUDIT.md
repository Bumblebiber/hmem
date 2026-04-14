# Memory Health, Stats & Related Entries Reference

## Memory Health Audit

Check memory for structural issues before/after curation:

```
memory_health()                    # personal store
memory_health(store="company")
```

Checks: broken links, orphaned entries, stale favorites/pinned, broken obsolete chains, tag orphans.

## Memory Stats

Quick overview of memory health:

```
memory_stats()                    # personal store
memory_stats(store="company")     # company store
```

Output includes: total entries by prefix, total nodes, favorites count, pinned count, unique hashtags, stale count (>30d), oldest entry, and top 5 most-accessed entries.

## Find Related

Find entries similar to a given entry via FTS5 keyword matching — spots potential duplicates or thematic connections:

```
find_related(id="P0029")            # up to 5 similar entries
find_related(id="L0042", limit=10)
```

Returns title-only list with overlapping keywords (different from `relatedEntries` in ID reads which uses shared tags).

## Stale Detection

Find entries not accessed in a while — useful for curation:

```
read_memory(stale_days=30)                # sorted oldest-access first
read_memory(stale_days=60, prefix="L")    # only stale lessons
```

## Show All Obsolete Entries

By default, bulk reads hide most obsolete entries (top 3 by access count shown). To see all:

```
read_memory(show_obsolete=true)
```
