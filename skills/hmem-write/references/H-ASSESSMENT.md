# H-Prefix: User Skill Assessment

Actively track the user's expertise level across topics. This drives how the agent communicates —
a coding expert does not need variable explanations, a beginner does not need jargon.

## Structure

One H-entry per main topic, with sub-nodes per subtopic:

```
write_memory(prefix="H", content="User Skill: IT
	Coding — Advanced: writes TypeScript fluently, debugs SQLite schemas, understands async/MCP
	Terminal/CLI — Advanced: bash, git, systemctl, nvm, sqlite3 comfortable
	Networking — Intermediate: HTTP/DNS solid, asked about WebSocket details
	DevOps — Intermediate: systemd + nvm yes, Docker unfamiliar",
  tags=["#skill-assessment", "#it"])
```

Levels: **1-10 scale** (see user-assessment skill for full details).
1-2 = no experience, 5-6 = intermediate, 9-10 = expert. Half-points allowed.

Always include evidence (observed behavior, not assumptions).

## When to Assess

- **First interaction**: Make initial assessment from vocabulary, questions, and tool usage
- **Ongoing (every few exchanges)**: Watch for signals:
  - **Upgrade signals**: uses domain-specific terms correctly, solves problems independently, corrects the agent
  - **Downgrade signals**: "das verstehe ich nicht", "explain that", asks about basic concepts, misuses terms
- **On /save**: Review and update assessments if evidence accumulated

## How to Update

Reference the O-entry (automatic session log) where the skill change was observed:

```
# User demonstrated new skill — link to the exchange that proves it
append_memory(id="H0010", content="Docker — Intermediate: configured docker-compose independently (see O0042.15)")

# User's skill improved
update_memory(id="H0010.3", content="Networking — Advanced: configures DNS, TLS, reverse proxies (see O0042.23)")

# User struggled — downgrade with evidence
update_memory(id="H0010.4", content="DevOps — Beginner: asked what systemd is, needed step-by-step (see O0042.8)")
```

The O-entry reference lets future agents verify the assessment by reading the original conversation.

## How to USE Assessments

Before explaining anything technical, check the relevant H-entry:

- **Beginner**: Explain concepts, use analogies, avoid jargon, step-by-step
- **Intermediate**: Brief explanations, some jargon OK, link to docs for details
- **Advanced**: Direct technical language, skip basics, focus on trade-offs
- **Expert**: Peer-level discussion, challenge assumptions, discuss edge cases

Example: If H0010.1 says "Coding — Advanced", do not explain what a Map is.
If H0010.4 says "DevOps — Beginner", explain what a systemd service does before configuring one.

## Topics Are Open-Ended

Not just IT — any domain the user works in:
- Music (theory, instruments, production)
- Mechanical (bikes, cars, tools)
- Business (accounting, marketing, management)
- Languages (German, English proficiency)

Create new H-entries as topics emerge naturally from conversation.
