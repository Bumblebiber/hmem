# Simulation: Switching from P0054 back to P0048

## Task
User wants to switch from P0054 (currently active) back to P0048 (hmem project).

## What Would Happen (WITHOUT the skill)

The user would need to manually execute:

```
load_project({ id: 'P0048', store: 'personal' })
```

### Expected Behavior

When `load_project(id='P0048')` is called:

1. **Load Project Context**: Read the P0048 entry from hmem with depth=3
   - Returns Overview, Codebase, Usage, Context, Deployment, Bugs, Protocol, Open tasks, Ideas
   - Shows L2 content and L3 subcategory titles

2. **Mark as Active**: Set P0048 as the active project in the P-prefix
   - Updates active flag: `[*] P0048`
   - Deactivates P0054 (previous active project)

3. **Return to User**: Display the full project briefing (~700 tokens including):
   - Project title and metadata
   - Overview section
   - Codebase layout
   - Usage instructions
   - Current context and status
   - Deployment info
   - Known bugs
   - Protocol/conventions
   - Open tasks
   - Ideas/brainstorm items

## What the Skill Would Do

A skill for "activate workspace" would:

1. **Parse Intent**: Detect "zurück zu hmem (P0048)" → extract project ID P0048
2. **Validate Project**: Check P0048 exists and is valid
3. **Call load_project**: Execute `load_project(id='P0048')`
4. **Return Context**: Display the full briefing to user

## Current State

- **Active Project**: P0054
- **Target Project**: P0048 (hmem)
- **Action**: Single function call to switch

## No Issues Expected

- The call is straightforward: load_project handles both loading context AND marking as active
- User gets immediate feedback with full project briefing
- P0054 is automatically deactivated when P0048 becomes active
