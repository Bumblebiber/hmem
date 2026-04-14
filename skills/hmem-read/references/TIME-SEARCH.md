# Time-Based Search Reference

Find entries created around a specific time or near another entry.

## Basic Time Queries

```
read_memory(time="14:30")                        # +/-2h window around 14:30 today
read_memory(time="14:30", date="2026-02-20")     # specific date + time
```

## Custom Windows

```
read_memory(time="14:30", period="-1h")           # only 1h before 14:30
```

## Relative to Another Entry

```
read_memory(time_around="P0001")                  # entries created near P0001
read_memory(time_around="P0001", period="+2h")    # only entries after P0001
```
