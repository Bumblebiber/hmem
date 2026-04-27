# hmem-activate Skill Simulation: Load EasySAP (P0043)

## Current State
- **Active project**: P0048 (hmem)
- **Active O-entry**: O0048
- **User request**: Load P0043 (EasySAP) temporarily to check something

## STEP 1: Note the currently active project

Before activation:
- **OLD_PROJECT**: P0048 (hmem)
- **OLD_O**: O0048
- **TARGET_PROJECT**: P0043 (EasySAP)
- **TARGET_O**: O0043

## STEP 2: Activate the target project

Would call:
```
load_project(id="P0043")
```

This returns the EasySAP project briefing (~700 tokens) with all L2-L3 context (Overview, Codebase, Usage, Context, etc.).

## STEP 3: Check for misrouted exchanges

Since OLD_PROJECT (P0048) ≠ TARGET_PROJECT (P0043), need to check if any exchanges from this session were logged to OLD_O (O0048) but actually belong to EasySAP context.

Would call:
```
read_memory(id="O0048")
```

**Misrouting check applies here:** User switched projects mid-session. If there are today-stamped exchanges in O0048 that discuss EasySAP topics (not hmem topics), they should be moved to O0043.

However, since this is described as a **temporary load** ("danach wechsel ich wieder zurück"), the user is not doing sustained work on EasySAP — just a brief lookup. In practice, any new interactions during the EasySAP load would go to O0043 automatically (because P0043 would be the active project). So misrouting is only a concern if we find pre-existing exchanges that got routed to the wrong O-entry earlier.

**Expected result for this scenario**: Likely "none" — this is a fresh switch, not a return to a previously mixed session.

## STEP 4: Confirm

Output would be:
```
Activated: P0043 (EasySAP)
O-entry routing: O0043
Misrouted exchanges moved: none
```

---

## User Re-activation Warning

**IMPORTANT NOTE FOR USER:**

After you finish checking EasySAP, you said you want to switch back to hmem. The skill will handle that, but here's what happens:

1. You'll say "wechsel zurück zu hmem" or "aktiviere P0048"
2. hmem-activate skill will load P0048 again
3. It will **check O0043 for today's exchanges** that might have been logged there during your EasySAP lookup
4. If you created any new session/batch nodes while viewing EasySAP (e.g., notes, findings), those will be offered to move back to O0048 if they belong to hmem context

**Bottom line:** You'll need to re-invoke the skill to switch back. It's not automatic. Just let me know when you're ready to return to hmem, and I'll run the same flow in reverse.

---

## Summary

- **Misrouting check needed**: YES (switched projects mid-session)
- **Warn user about re-activation**: YES (user must explicitly request return to P0048; it won't happen automatically)
