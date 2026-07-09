# EasySAP Project Load Simulation

## Task
User requested to temporarily load EasySAP project (P0043) for reference, then switch back to hmem (P0048).

## Simulated Actions

### Step 1: Load EasySAP Project
```
load_project({ id: 'P0043', store: 'personal' })
```

**Expected Response:**
The system would return the EasySAP project briefing containing:
- **L1 (Title):** EasySAP — Brief project description
- **L2 Sections:**
  - Overview: Main purpose and status
  - Codebase: Tech stack, file structure, key components
  - Usage: How to run, common workflows
  - Context: Related projects, dependencies, historical notes
  - Deployment: How/where it's deployed
  - Bugs: Known issues, quirks
  - Protocol: Team conventions, naming standards
  - Open tasks: What needs doing
  - Ideas: Future improvements

**What the User Sees:**
- Full project context (~700 tokens) loaded into the active session
- P0043 marked as active in the system
- Ready to inspect code, check status, or work on issues

### Step 2: User Reviews EasySAP
User can now:
- Read the project briefing
- Check open tasks or recent bugs
- Review codebase structure from the L2 summary
- Understand deployment status
- See related projects and context

### Step 3: Switch Back to hmem
```
load_project({ id: 'P0048', store: 'personal' })
```

**Expected Response:**
- P0048 (hmem) becomes active again
- Full hmem project context loads
- Session context restored to hmem project

## Summary

This is a **non-destructive context switch**:
- No changes to code or memory
- No commits or modifications
- Simply activates a different project's briefing
- Previous active project (hmem/P0048) can be restored immediately
- User retains full project knowledge while reviewing EasySAP

The load_project tool is designed exactly for this use case — temporary context switching without losing state or requiring explicit "restore" logic.
