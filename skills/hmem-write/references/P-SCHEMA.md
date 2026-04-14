# P-Entry Standard Schema

Every project entry MUST follow this structure. The MCP server validates L2 nodes
against the standard categories when `prefix="P"`.

## L1 Format

**L1 Title:** `Name | Status | Tech Stack | GH: owner/repo | Short description`
The GH field is optional — include it when a GitHub repo exists, omit otherwise.
**L1 Body:** (same line or next non-indented line) One-sentence project summary.

## Status Values

| Status | Meaning |
|--------|---------|
| New | Just started, concept phase |
| Active | In active development |
| Mature | Feature-complete, only bugfixes |
| Paused | On hold, will resume later |
| Archived | Done or abandoned |

## L2 Categories (fixed order, skip empty sections)

The MCP server validates that L2 nodes start with one of these names. Minimum for a new project: Overview + Codebase (or Usage).

| L2 Category | What goes here | L3 children |
|-------------|---------------|-------------|
| **Overview** | First thing an agent reads (like CLAUDE.md /init) | Current state, Goals, Architecture, Environment |
| **Codebase** | Code structure — NO code, only names + signatures | Entry point, Core modules (each module = L4 node with signature + purpose + return), Helpers, Config, Tests |
| **Usage** | How the project is used | Installation/Setup, CLI/API commands, Common workflows |
| **Context** | Background and motivation | Initiator, Target audience, Business context, Dependencies (links) |
| **Deployment** | Build/CI/CD/publish process | (flat or with L3 sub-steps) |
| **Bugs** | Active bugs + known limitations | L3: inline report (symptom + cause) OR pointer to E-entry (`-> E0097`). L4: reproduction steps |
| **Protocol** | Session log, chronological | One-liner per session + links to O-entries |
| **Open tasks** | Project-specific TODOs | One per L3 node. Cross-project tasks -> T-prefix with links |
| **Ideas** | Feature ideas, brainstorming | L3: short description, L4: implementation details |

## load_project Tool

Use `load_project(id="P0048")` to activate a project and get the full briefing (L2 content + L3 titles) in one call. This is the recommended way to start working on a project — it combines read + activate.

## Complete P-Entry Example (WeatherBot)

```
write_memory(
  prefix="P",
  content="WeatherBot | New | Python/Discord.py | GH: user/weatherbot\n\nDiscord bot for weather forecasts — slash commands for current weather and multi-day forecasts\n\tOverview\n\t\tCurrent state\n\n\t\tScaffolding done, no commands yet. Bot connects to Discord but has no slash commands registered.\n\t\tGoals\n\n\t\tDaily/hourly forecasts via slash commands, multi-city support, embed formatting\n\t\tArchitecture\n\n\t\tDiscord slash command -> OpenWeatherMap API -> formatted embed. Single-file cog pattern.\n\t\tEnvironment\n\n\t\t/home/user/weatherbot, python bot.py, needs DISCORD_TOKEN + WEATHER_API_KEY in .env\n\tCodebase\n\t\tEntry point — bot.py, start: python bot.py\n\t\tCore modules\n\t\t\tweather_cog.py — WeatherCog(Cog); fetch_forecast(city: str) -> discord.Embed\n\t\t\tformatter.py — format_embed(data: dict) -> discord.Embed\n\t\tHelpers / Utilities\n\t\t\tapi_client.py — get_weather(city: str) -> dict; wraps HTTP to OpenWeatherMap\n\t\tConfig / Constants — .env: DISCORD_TOKEN, WEATHER_API_KEY, DEFAULT_CITY\n\t\tTests — pytest, test_weather_cog.py (3 tests)\n\tUsage\n\t\tInstallation / Setup — pip install -r requirements.txt, cp .env.example .env\n\t\tCLI / API — /weather <city>, /forecast <city> (planned)\n\tContext\n\t\tInitiator — personal project, Mar 2026\n\t\tTarget audience — personal Discord server\n\t\tDependencies — discord.py, OpenWeatherMap API, aiohttp\n\tOpen tasks\n\t\tImplement /forecast command\n\n\t\tMulti-day view with daily highs/lows and weather icons per day\n\t\tAdd city autocomplete",
  tags=["#discord", "#python", "#weather", "#bot"],
  links=[]
)
```

Note: L2 nodes use 1 tab, L3 uses 2 tabs, L4 uses 3 tabs. Separate title from body with a blank line at the same indent level. Skip empty sections — no need for placeholder text.
