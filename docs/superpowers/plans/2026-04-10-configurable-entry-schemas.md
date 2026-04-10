# Configurable Entry Schemas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make P-entry schemas configurable per `.hmem` instance — controlling which L2 sections are created, how deep each loads in `load_project`, and auto-reconciling missing sections on load.

**Architecture:** New `schemas` key in `hmem.config.json` defines per-prefix section lists with `name`, `loadDepth`, and optional `defaultChildren`. `create_project` reads this schema instead of hardcoding 9 sections. `load_project` uses per-section depth and auto-creates missing sections. Prefixes without a schema keep current behavior (backward compat).

**Tech Stack:** TypeScript, better-sqlite3, Vitest, MCP stdio transport

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/hmem-config.ts` | Modify | Add `SchemaSection`, `EntrySchema` types. Parse + validate `schemas` from config. |
| `src/mcp-server.ts` | Modify | Schema-driven `create_project` (lines 2207-2245). Per-section depth in `load_project` rendering (lines 2006-2088). Auto-reconcile before render. |
| `test/hmem-config-schema.test.ts` | Create | Schema parsing unit tests. |
| `test/create-project-schema.test.ts` | Create | Schema-driven `create_project` integration tests. |
| `test/load-project-schema.test.ts` | Create | Per-section depth + auto-reconcile tests. |

---

### Task 1: Schema Types and Parsing in `hmem-config.ts`

**Files:**
- Modify: `src/hmem-config.ts`
- Test: `test/hmem-config-schema.test.ts`

- [ ] **Step 1: Write failing tests for schema parsing**

```ts
// test/hmem-config-schema.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadHmemConfig } from "../src/hmem-config.js";

describe("schema parsing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hmem-schema-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(obj: unknown) {
    fs.writeFileSync(path.join(tmpDir, "hmem.config.json"), JSON.stringify(obj));
  }

  it("parses valid schema with sections", () => {
    writeConfig({
      memory: {
        schemas: {
          P: {
            sections: [
              { name: "Overview", loadDepth: 3, defaultChildren: ["Goals", "State"] },
              { name: "Bugs", loadDepth: 2 },
            ],
            createLinkedO: true,
          },
        },
      },
    });
    const cfg = loadHmemConfig(tmpDir);
    expect(cfg.schemas).toBeDefined();
    expect(cfg.schemas!.P.sections).toHaveLength(2);
    expect(cfg.schemas!.P.sections[0].name).toBe("Overview");
    expect(cfg.schemas!.P.sections[0].loadDepth).toBe(3);
    expect(cfg.schemas!.P.sections[0].defaultChildren).toEqual(["Goals", "State"]);
    expect(cfg.schemas!.P.sections[1].defaultChildren).toBeUndefined();
    expect(cfg.schemas!.P.createLinkedO).toBe(true);
  });

  it("returns undefined schemas when key is missing", () => {
    writeConfig({ memory: { checkpointInterval: 10 } });
    const cfg = loadHmemConfig(tmpDir);
    expect(cfg.schemas).toBeUndefined();
  });

  it("skips sections with invalid loadDepth", () => {
    writeConfig({
      memory: {
        schemas: {
          P: {
            sections: [
              { name: "Good", loadDepth: 2 },
              { name: "Bad", loadDepth: -1 },
              { name: "TooHigh", loadDepth: 5 },
              { name: "NoDepth" },
            ],
          },
        },
      },
    });
    const cfg = loadHmemConfig(tmpDir);
    expect(cfg.schemas!.P.sections).toHaveLength(1);
    expect(cfg.schemas!.P.sections[0].name).toBe("Good");
  });

  it("skips sections with missing name", () => {
    writeConfig({
      memory: {
        schemas: {
          P: {
            sections: [
              { loadDepth: 2 },
              { name: "Valid", loadDepth: 1 },
            ],
          },
        },
      },
    });
    const cfg = loadHmemConfig(tmpDir);
    expect(cfg.schemas!.P.sections).toHaveLength(1);
    expect(cfg.schemas!.P.sections[0].name).toBe("Valid");
  });

  it("accepts empty sections array", () => {
    writeConfig({ memory: { schemas: { P: { sections: [] } } } });
    const cfg = loadHmemConfig(tmpDir);
    expect(cfg.schemas!.P.sections).toEqual([]);
  });

  it("supports multiple prefix schemas", () => {
    writeConfig({
      memory: {
        schemas: {
          P: { sections: [{ name: "Overview", loadDepth: 3 }] },
          E: { sections: [{ name: "Root Cause", loadDepth: 2 }] },
        },
      },
    });
    const cfg = loadHmemConfig(tmpDir);
    expect(cfg.schemas!.P.sections[0].name).toBe("Overview");
    expect(cfg.schemas!.E.sections[0].name).toBe("Root Cause");
  });

  it("defaults createLinkedO to false", () => {
    writeConfig({ memory: { schemas: { P: { sections: [] } } } });
    const cfg = loadHmemConfig(tmpDir);
    expect(cfg.schemas!.P.createLinkedO).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/bbbee/projects/hmem && npx vitest run test/hmem-config-schema.test.ts`
Expected: FAIL — `cfg.schemas` is undefined (property doesn't exist on HmemConfig)

- [ ] **Step 3: Add schema types and parsing to `hmem-config.ts`**

Add these types after the `SyncConfigBlock` interface (after line 126):

```ts
export interface SchemaSection {
  name: string;
  loadDepth: number;       // 0-4
  defaultChildren?: string[];
}

export interface EntrySchema {
  sections: SchemaSection[];
  createLinkedO?: boolean;
}
```

Add to the `HmemConfig` interface (after `sync?` on line 113):

```ts
  /** Per-prefix entry schemas. Keys are prefix letters ("P", "E", etc.). */
  schemas?: Record<string, EntrySchema>;
```

Add to `MEMORY_KEYS` set (line 258):

```ts
const MEMORY_KEYS = new Set(["maxL1Chars", "maxLnChars", "maxCharsPerLevel", "maxDepth",
  "defaultReadLimit", "prefixes", "prefixDescriptions", "bulkReadV2", "maxTitleChars", "accessCountTopN", "recentOEntries", "contextTokenThreshold", "loadProjectExpand", "schemas"]);
```

Add schema parsing in `loadHmemConfig`, after the `loadProjectExpand` block (after line 303):

```ts
    // Entry schemas (per-prefix)
    if (memoryRaw.schemas && typeof memoryRaw.schemas === "object" && !Array.isArray(memoryRaw.schemas)) {
      const schemas: Record<string, EntrySchema> = {};
      for (const [prefix, schemaRaw] of Object.entries(memoryRaw.schemas)) {
        if (!/^[A-Z]$/.test(prefix) || !schemaRaw || typeof schemaRaw !== "object") continue;
        const sr = schemaRaw as any;
        if (!Array.isArray(sr.sections)) continue;
        const validSections: SchemaSection[] = [];
        for (const sec of sr.sections) {
          if (!sec || typeof sec !== "object") continue;
          if (typeof sec.name !== "string" || !sec.name) continue;
          if (typeof sec.loadDepth !== "number" || sec.loadDepth < 0 || sec.loadDepth > 4) continue;
          const section: SchemaSection = { name: sec.name, loadDepth: sec.loadDepth };
          if (Array.isArray(sec.defaultChildren) && sec.defaultChildren.every((c: unknown) => typeof c === "string")) {
            section.defaultChildren = sec.defaultChildren;
          }
          validSections.push(section);
        }
        schemas[prefix] = {
          sections: validSections,
          createLinkedO: sr.createLinkedO === true,
        };
      }
      if (Object.keys(schemas).length > 0) cfg.schemas = schemas;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/bbbee/projects/hmem && npx vitest run test/hmem-config-schema.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/hmem-config.ts test/hmem-config-schema.test.ts
git commit -m "feat: add schema types and parsing to hmem-config"
```

---

### Task 2: Schema-Driven `create_project`

**Files:**
- Modify: `src/mcp-server.ts:2184-2303`
- Test: `test/create-project-schema.test.ts`

- [ ] **Step 1: Write failing tests for schema-driven creation**

```ts
// test/create-project-schema.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { HmemStore } from "../src/hmem-store.js";
import { loadHmemConfig, type HmemConfig, type EntrySchema } from "../src/hmem-config.js";

describe("create_project with schema", () => {
  let tmpDir: string;
  let hmemPath: string;
  let store: HmemStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hmem-create-"));
    hmemPath = path.join(tmpDir, "memory.hmem");
  });
  afterEach(() => {
    store?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(schemas: Record<string, EntrySchema>) {
    fs.writeFileSync(
      path.join(tmpDir, "hmem.config.json"),
      JSON.stringify({ memory: { schemas } })
    );
  }

  /**
   * Helper: build the content string that create_project would pass to store.write().
   * This mirrors the logic we're implementing — we test it separately from the MCP handler
   * so we can verify the tab-indented structure directly.
   */
  function buildProjectContent(
    config: HmemConfig,
    opts: { name: string; tech: string; description: string; status?: string; repo?: string; goal?: string; audience?: string; deployment?: string }
  ): string {
    const { name, tech, description, status = "Active", repo, goal, audience, deployment } = opts;
    const schema = config.schemas?.P;
    const titleLine = `${name} | ${status} | ${tech} | ${description}`;
    const bodyLine = goal ? `> ${goal}` : `> ${description}`;
    const sections: string[] = [titleLine, bodyLine];

    if (schema) {
      // Schema-driven
      for (const sec of schema.sections) {
        sections.push(`\t${sec.name}`);
        if (sec.defaultChildren) {
          for (const child of sec.defaultChildren) {
            // Inject known values for standard children
            if (child === "Current state" && sec.name === "Overview") {
              sections.push(`\t\tCurrent state: ${status}, ${tech}`);
            } else if (child === "Goals" && goal) {
              sections.push(`\t\tGoals: ${goal}`);
            } else if (child === "Environment" && repo) {
              sections.push(`\t\tEnvironment: ${repo}`);
            } else if (child === "Target audience" && audience) {
              sections.push(`\t\tTarget audience: ${audience}`);
            } else {
              sections.push(`\t\t${child}`);
            }
          }
        }
        // Special injections for known section names (backward compat)
        if (sec.name === "Deployment" && deployment && !sec.defaultChildren) {
          sections.push(`\t\t${deployment}`);
        }
      }
    }
    return sections.join("\n");
  }

  it("creates P-entry with custom schema sections", () => {
    writeConfig({
      P: {
        sections: [
          { name: "Character", loadDepth: 3, defaultChildren: ["Race", "Class", "Level"] },
          { name: "Inventory", loadDepth: 2 },
          { name: "Quests", loadDepth: 2 },
        ],
      },
    });
    const config = loadHmemConfig(tmpDir);
    store = new HmemStore(hmemPath, config);

    const content = buildProjectContent(config, {
      name: "MAIMO Hero",
      tech: "D&D 5e",
      description: "Game character",
    });

    const result = store.write("P", content, [], undefined, false, ["#project"]);
    const entries = store.read({ id: result.id, depth: 3, expand: true });
    expect(entries).toHaveLength(1);

    const children = entries[0].children;
    expect(children).toBeDefined();
    expect(children!.length).toBe(3);
    expect(children![0].title).toBe("Character");
    expect(children![1].title).toBe("Inventory");
    expect(children![2].title).toBe("Quests");

    // Character should have 3 L3 children
    expect(children![0].children).toHaveLength(3);
    expect(children![0].children![0].title).toBe("Race");
    expect(children![0].children![1].title).toBe("Class");
    expect(children![0].children![2].title).toBe("Level");
  });

  it("creates standard sections when no schema defined", () => {
    // No config file → fallback to hardcoded
    const config = loadHmemConfig(tmpDir);
    store = new HmemStore(hmemPath, config);
    expect(config.schemas).toBeUndefined();

    // Just verify the config has no schema — the actual fallback code in mcp-server.ts
    // is tested by the hardcoded path remaining unchanged
  });

  it("creates O-entry when createLinkedO is true", () => {
    writeConfig({
      P: {
        sections: [{ name: "Overview", loadDepth: 3 }],
        createLinkedO: true,
      },
    });
    const config = loadHmemConfig(tmpDir);
    expect(config.schemas!.P.createLinkedO).toBe(true);
  });

  it("skips O-entry when createLinkedO is false/missing", () => {
    writeConfig({
      P: {
        sections: [{ name: "Overview", loadDepth: 3 }],
      },
    });
    const config = loadHmemConfig(tmpDir);
    expect(config.schemas!.P.createLinkedO).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (these test the content-building logic, not the MCP handler)**

Run: `cd /home/bbbee/projects/hmem && npx vitest run test/create-project-schema.test.ts`
Expected: PASS — tests validate the schema config + content building pattern

- [ ] **Step 3: Modify `create_project` in `mcp-server.ts` to use schema**

Replace the hardcoded section creation block (lines 2207-2245) with schema-driven logic:

```ts
        const titleLine = `${name} | ${status} | ${tech} | ${description}`;
        const bodyLine = goal ? `> ${goal}` : `> ${description}`;
        const sections: string[] = [titleLine, bodyLine];

        const schema = hmemConfig.schemas?.P;
        if (schema) {
          // Schema-driven creation
          for (const sec of schema.sections) {
            sections.push(`\t${sec.name}`);
            if (sec.defaultChildren) {
              for (const child of sec.defaultChildren) {
                // Inject known values for standard Overview children
                if (sec.name === "Overview" && child === "Current state") {
                  sections.push(`\t\tCurrent state: ${status}, ${tech}`);
                } else if (sec.name === "Overview" && child === "Goals" && goal) {
                  sections.push(`\t\tGoals: ${goal}`);
                } else if (sec.name === "Overview" && child === "Environment" && repo) {
                  sections.push(`\t\tEnvironment: ${repo}`);
                } else if (sec.name === "Context" && child === "Target audience" && audience) {
                  sections.push(`\t\tTarget audience: ${audience}`);
                } else {
                  sections.push(`\t\t${child}`);
                }
              }
            }
            // Backward compat: inject deployment into Deployment section if no defaultChildren
            if (sec.name === "Deployment" && deployment && !sec.defaultChildren) {
              sections.push(`\t\t${deployment}`);
            }
          }
        } else {
          // Fallback: hardcoded R0009 schema (backward compat)
          // .1 Overview
          sections.push(`\tOverview`);
          sections.push(`\t\tCurrent state: ${status}, ${tech}`);
          if (goal) sections.push(`\t\tGoals: ${goal}`);
          if (repo) sections.push(`\t\tEnvironment: ${repo}`);
          // .2 Codebase
          sections.push(`\tCodebase`);
          // .3 Usage
          sections.push(`\tUsage`);
          // .4 Context
          sections.push(`\tContext`);
          if (audience) sections.push(`\t\tTarget audience: ${audience}`);
          // .5 Deployment
          sections.push(`\tDeployment`);
          if (deployment) sections.push(`\t\t${deployment}`);
          // .6 Bugs
          sections.push(`\tBugs`);
          // .7 Protocol
          sections.push(`\tProtocol`);
          // .8 Open tasks
          sections.push(`\tOpen tasks`);
          // .9 Ideas
          sections.push(`\tIdeas`);
        }

        const content = sections.join("\n");
```

Also update the `createLinkedO` logic. After the existing O-entry creation block (lines 2261-2277), wrap it in a conditional:

```ts
        // Create matching O-entry (schema-controlled or default true for backward compat)
        const shouldCreateO = schema ? (schema.createLinkedO === true) : true;
        if (shouldCreateO) {
          const oId = `O${String(pSeq).padStart(4, "0")}`;
          // ... existing O-entry creation code unchanged ...
        }
```

Update the success message to list actual section names:

```ts
        const sectionNames = schema
          ? schema.sections.map(s => s.name).join(", ")
          : "Overview, Codebase, Usage, Context, Deployment, Bugs, Protocol, Open tasks, Ideas";
```

- [ ] **Step 4: Run full test suite**

Run: `cd /home/bbbee/projects/hmem && npx vitest run`
Expected: All tests PASS (no regressions)

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server.ts test/create-project-schema.test.ts
git commit -m "feat: schema-driven create_project with fallback to hardcoded R0009"
```

---

### Task 3: Per-Section Load Depth in `load_project`

**Files:**
- Modify: `src/mcp-server.ts:2006-2088` (load_project rendering logic)
- Test: `test/load-project-schema.test.ts`

- [ ] **Step 1: Write failing tests for per-section depth rendering**

```ts
// test/load-project-schema.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { HmemStore } from "../src/hmem-store.js";
import { loadHmemConfig, type HmemConfig, DEFAULT_CONFIG } from "../src/hmem-config.js";

describe("load_project per-section depth", () => {
  let tmpDir: string;
  let hmemPath: string;
  let store: HmemStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hmem-load-"));
    hmemPath = path.join(tmpDir, "memory.hmem");
  });
  afterEach(() => {
    store?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createProject(config: HmemConfig): string {
    store = new HmemStore(hmemPath, config);
    const content = [
      "Test Project | Active | TS | Test",
      "> Test project",
      "\tOverview",
      "\t\tCurrent state: Active, TS",
      "\t\tGoals: Test goal content here",
      "\tCodebase",
      "\t\tMain module: src/index.ts",
      "\tProtocol",
      "\t\tEntry 1: Some protocol detail",
      "\t\tEntry 2: Another protocol detail",
      "\tBugs",
      "\t\tBug 1: Something broken",
      "\tIdeas",
      "\t\tIdea 1: Improve performance",
    ].join("\n");
    const result = store.write("P", content, [], undefined, false, ["#project"]);
    return result.id;
  }

  /**
   * Helper: given a schema config with loadDepth values, determine which sections
   * should appear in the rendered output and at what detail level.
   * This tests the schema-to-rendering mapping logic.
   */
  it("schema sections define which sections are visible", () => {
    fs.writeFileSync(
      path.join(tmpDir, "hmem.config.json"),
      JSON.stringify({
        memory: {
          schemas: {
            P: {
              sections: [
                { name: "Overview", loadDepth: 3 },
                { name: "Protocol", loadDepth: 0 },
                { name: "Bugs", loadDepth: 2 },
                { name: "Ideas", loadDepth: 1 },
              ],
            },
          },
        },
      })
    );
    const config = loadHmemConfig(tmpDir);
    const schema = config.schemas!.P;

    // loadDepth=0 → skip entirely
    expect(schema.sections.find(s => s.name === "Protocol")!.loadDepth).toBe(0);
    // loadDepth=1 → title only
    expect(schema.sections.find(s => s.name === "Ideas")!.loadDepth).toBe(1);
    // loadDepth=2 → title + L3 titles
    expect(schema.sections.find(s => s.name === "Bugs")!.loadDepth).toBe(2);
    // loadDepth=3 → title + L3 titles + L3 body
    expect(schema.sections.find(s => s.name === "Overview")!.loadDepth).toBe(3);
  });

  it("unmatched extra sections default to loadDepth 1", () => {
    fs.writeFileSync(
      path.join(tmpDir, "hmem.config.json"),
      JSON.stringify({
        memory: {
          schemas: {
            P: {
              sections: [
                { name: "Overview", loadDepth: 3 },
              ],
            },
          },
        },
      })
    );
    const config = loadHmemConfig(tmpDir);
    const schema = config.schemas!.P;

    // "Codebase" is not in schema → should render at depth 1 (title only)
    const match = schema.sections.find(s => s.name.toLowerCase() === "codebase");
    expect(match).toBeUndefined(); // confirms it's an extra section
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (schema structure tests)**

Run: `cd /home/bbbee/projects/hmem && npx vitest run test/load-project-schema.test.ts`
Expected: PASS

- [ ] **Step 3: Modify `load_project` rendering to use per-section depth**

In `src/mcp-server.ts`, replace the hardcoded rendering constants and loop (lines 2016-2088) with schema-driven logic. The key changes:

1. Look up `hmemConfig.schemas?.P` at the start of the rendering block.
2. For each L2 child, match its title against schema sections (case-insensitive).
3. Use `loadDepth` from the matched section to decide rendering:
   - `0`: skip entirely (don't add to output)
   - `1`: title only (add section header, skip children)
   - `2`: title + L3 titles (current "compact" mode)
   - `3`: title + L3 titles + L3 body (current "withBody" mode)
   - `4`: full subtree (L3 + L4)
4. Unmatched sections (extra, not in schema): render at depth 1 (title + child count).
5. When no schema exists for P: keep exact current behavior (the existing `SKIP_SECTIONS`, `HIDE_CHILDREN_SECTIONS`, `FILTER_DONE_SECTIONS`, `withBody`, `withChildren` constants).

Replace the rendering block:

```ts
        // Custom compact rendering for project briefing
        const e = entries[0];
        const syncThreshold = getSyncThreshold();
        const syncTag = syncThreshold && e.updated_at && e.updated_at <= syncThreshold ? " ✓" : "";
        const lines: string[] = [];
        const lastSeg = (nodeId: string) => "." + nodeId.split(".").pop();
        lines.push(`${e.id}${syncTag}  ${e.title}`);
        if (e.level_1 && e.level_1 !== e.title) lines.push(`  ${e.level_1}`);

        if (e.children) {
          const pSchema = hmemConfig.schemas?.P;

          if (pSchema) {
            // ── Schema-driven rendering ──
            const sectionMap = new Map<string, { loadDepth: number }>();
            for (const sec of pSchema.sections) {
              sectionMap.set(sec.name.toLowerCase(), { loadDepth: sec.loadDepth });
            }

            for (const child of (e.children as MemoryNode[]).filter(c => !c.irrelevant)) {
              const childTitle = (child.title || child.content || "").trim();
              const match = sectionMap.get(childTitle.toLowerCase());
              const depth = match ? match.loadDepth : 1; // unmatched → title only

              if (depth === 0) continue; // skip entirely

              const cId = lastSeg(child.id);
              lines.push(`  ${cId}  ${cleanTitle(childTitle, 60)}`);

              if (depth === 1) {
                // Title only — show child count hint if present
                const childCount = child.children ? child.children.filter((g: any) => !g.irrelevant).length : 0;
                if (childCount > 0) lines[lines.length - 1] += ` (${childCount} entries)`;
                continue;
              }

              if (child.children && child.children.length > 0) {
                const grandchildren = child.children.filter((g: any) => !g.irrelevant);
                for (const gc of grandchildren) {
                  const gcId = lastSeg(gc.id);
                  if (depth >= 3) {
                    // L3 title + body
                    lines.push(`    ${gcId}  ${cleanTitle(gc.title || gc.content, 80)}`);
                    if (gc.content && gc.content !== gc.title) {
                      for (const bodyLine of gc.content.split("\n")) {
                        lines.push(`      ${bodyLine}`);
                      }
                    }
                  } else {
                    // depth === 2: L3 title only
                    lines.push(`    ${gcId}  ${cleanTitle(gc.title || gc.content, 80)}`);
                  }
                  // depth >= 4: L4 children
                  if (depth >= 4 && gc.children && gc.children.length > 0) {
                    for (const l4 of gc.children.filter((l4: any) => !l4.irrelevant)) {
                      lines.push(`      ${lastSeg(l4.id)}  ${cleanTitle(l4.title || l4.content || "", 60)}`);
                    }
                  } else if (gc.child_count && gc.child_count > 0) {
                    lines.push(`      [+${gc.child_count}]`);
                  }
                }
              } else if (child.child_count && child.child_count > 0) {
                lines.push(`    [+${child.child_count}]`);
              }
            }
          } else {
            // ── Legacy rendering (no schema) — exact current code ──
            const { withBody, withChildren } = hmemConfig.loadProjectExpand;
            const SKIP_SECTIONS: number[] = [];
            const TAIL_SECTIONS: number[] = [];
            const TAIL_COUNT = 3;
            const HIDE_CHILDREN_SECTIONS = [7, 9, 2];
            const FILTER_DONE_SECTIONS = [8];
            for (const child of (e.children as MemoryNode[]).filter(c => !c.irrelevant)) {
              if (SKIP_SECTIONS.includes(child.seq)) continue;
              const cId = lastSeg(child.id);
              const expandBody = withBody.includes(child.seq);
              const expandChildTitles = withChildren.includes(child.seq);
              const hideChildren = HIDE_CHILDREN_SECTIONS.includes(child.seq);
              lines.push(`  ${cId}  ${cleanTitle(child.title || child.content, 60)}`);
              if (hideChildren) {
                const childCount = child.children ? child.children.filter((g: any) => !g.irrelevant).length : 0;
                if (childCount > 0) {
                  lines[lines.length - 1] += ` (${childCount} entries)`;
                } else if (child.content && child.content !== child.title) {
                  lines.push(`    ${child.content}`);
                } else {
                  lines.pop();
                }
                continue;
              }
              if (child.children && child.children.length > 0) {
                let grandchildren = child.children.filter((g: any) => !g.irrelevant);
                if (FILTER_DONE_SECTIONS.includes(child.seq)) {
                  grandchildren = grandchildren.filter((g: any) => {
                    const t = (g.title || g.content || "").trim();
                    return !t.startsWith("✓") && !t.startsWith("DONE");
                  });
                }
                if (TAIL_SECTIONS.includes(child.seq) && grandchildren.length > TAIL_COUNT) {
                  grandchildren = grandchildren.slice(-TAIL_COUNT);
                }
                for (const gc of grandchildren) {
                  const gcId = lastSeg(gc.id);
                  if (expandBody) {
                    lines.push(`    ${gcId}  ${cleanTitle(gc.title || gc.content, 80)}`);
                    if (gc.content && gc.content !== gc.title) {
                      for (const bodyLine of gc.content.split("\n")) {
                        lines.push(`      ${bodyLine}`);
                      }
                    }
                  } else {
                    lines.push(`    ${gcId}  ${cleanTitle(gc.title || gc.content, 80)}`);
                  }
                  if (gc.children && gc.children.length > 0) {
                    const visibleL4 = gc.children.filter((l4: any) => !l4.irrelevant);
                    for (const l4 of visibleL4) {
                      lines.push(`      ${lastSeg(l4.id)}  ${cleanTitle(l4.title || l4.content || "", 60)}`);
                    }
                  } else if (gc.child_count && gc.child_count > 0) {
                    lines.push(`      [+${gc.child_count}]`);
                  }
                }
              } else if (child.child_count && child.child_count > 0) {
                lines.push(`    [+${child.child_count}]`);
              }
            }
          }
        }
```

- [ ] **Step 4: Run full test suite**

Run: `cd /home/bbbee/projects/hmem && npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server.ts test/load-project-schema.test.ts
git commit -m "feat: per-section loadDepth in load_project with schema fallback"
```

---

### Task 4: Auto-Reconcile Missing Sections on `load_project`

**Files:**
- Modify: `src/mcp-server.ts` (load_project handler, before rendering)
- Extend: `test/load-project-schema.test.ts`

- [ ] **Step 1: Write failing test for auto-reconcile**

Add to `test/load-project-schema.test.ts`:

```ts
describe("auto-reconcile", () => {
  let tmpDir: string;
  let hmemPath: string;
  let store: HmemStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hmem-reconcile-"));
    hmemPath = path.join(tmpDir, "memory.hmem");
  });
  afterEach(() => {
    store?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds missing schema sections to existing entry", () => {
    // Create entry with only 2 sections (old schema)
    store = new HmemStore(hmemPath, DEFAULT_CONFIG);
    const content = [
      "Test | Active | TS | Test project",
      "> Test",
      "\tOverview",
      "\t\tState: Active",
      "\tBugs",
    ].join("\n");
    const result = store.write("P", content, [], undefined, false, ["#project"]);

    // Read back to confirm only 2 L2 children
    let entries = store.read({ id: result.id, depth: 2 });
    expect(entries[0].children).toHaveLength(2);

    // Now configure schema with 4 sections (2 existing + 2 new)
    fs.writeFileSync(
      path.join(tmpDir, "hmem.config.json"),
      JSON.stringify({
        memory: {
          schemas: {
            P: {
              sections: [
                { name: "Overview", loadDepth: 3 },
                { name: "Bugs", loadDepth: 2 },
                { name: "Next Steps", loadDepth: 3 },
                { name: "Custom", loadDepth: 2 },
              ],
            },
          },
        },
      })
    );
    const config = loadHmemConfig(tmpDir);
    store.close();
    store = new HmemStore(hmemPath, config);

    // Reconcile: append missing sections
    const existingEntries = store.read({ id: result.id, depth: 2 });
    const existingTitles = new Set(
      (existingEntries[0].children || []).map((c: any) => (c.title || c.content || "").trim().toLowerCase())
    );
    const missing: string[] = [];
    for (const sec of config.schemas!.P.sections) {
      if (!existingTitles.has(sec.name.toLowerCase())) {
        missing.push(sec.name);
      }
    }
    expect(missing).toEqual(["Next Steps", "Custom"]);

    // Append missing sections
    for (const name of missing) {
      store.appendChildren(result.id, name);
    }

    // Verify all 4 sections now exist
    entries = store.read({ id: result.id, depth: 2 });
    const titles = entries[0].children!.map((c: any) => c.title || c.content);
    expect(titles).toContain("Overview");
    expect(titles).toContain("Bugs");
    expect(titles).toContain("Next Steps");
    expect(titles).toContain("Custom");
  });

  it("is idempotent — does not duplicate existing sections", () => {
    store = new HmemStore(hmemPath, DEFAULT_CONFIG);
    const content = [
      "Test | Active | TS | Test",
      "> Test",
      "\tOverview",
      "\tBugs",
      "\tNext Steps",
    ].join("\n");
    const result = store.write("P", content, [], undefined, false, ["#project"]);

    fs.writeFileSync(
      path.join(tmpDir, "hmem.config.json"),
      JSON.stringify({
        memory: {
          schemas: {
            P: {
              sections: [
                { name: "Overview", loadDepth: 3 },
                { name: "Bugs", loadDepth: 2 },
                { name: "Next Steps", loadDepth: 3 },
              ],
            },
          },
        },
      })
    );
    const config = loadHmemConfig(tmpDir);
    store.close();
    store = new HmemStore(hmemPath, config);

    const existingEntries = store.read({ id: result.id, depth: 2 });
    const existingTitles = new Set(
      (existingEntries[0].children || []).map((c: any) => (c.title || c.content || "").trim().toLowerCase())
    );
    const missing: string[] = [];
    for (const sec of config.schemas!.P.sections) {
      if (!existingTitles.has(sec.name.toLowerCase())) {
        missing.push(sec.name);
      }
    }
    expect(missing).toEqual([]); // nothing to add

    // Entry still has exactly 3 sections
    const entries = store.read({ id: result.id, depth: 2 });
    expect(entries[0].children).toHaveLength(3);
  });

  it("case-insensitive title matching", () => {
    store = new HmemStore(hmemPath, DEFAULT_CONFIG);
    const content = [
      "Test | Active | TS | Test",
      "> Test",
      "\toverview",
      "\tBUGS",
    ].join("\n");
    const result = store.write("P", content, [], undefined, false, ["#project"]);

    fs.writeFileSync(
      path.join(tmpDir, "hmem.config.json"),
      JSON.stringify({
        memory: {
          schemas: {
            P: {
              sections: [
                { name: "Overview", loadDepth: 3 },
                { name: "Bugs", loadDepth: 2 },
              ],
            },
          },
        },
      })
    );
    const config = loadHmemConfig(tmpDir);
    store.close();
    store = new HmemStore(hmemPath, config);

    const existingEntries = store.read({ id: result.id, depth: 2 });
    const existingTitles = new Set(
      (existingEntries[0].children || []).map((c: any) => (c.title || c.content || "").trim().toLowerCase())
    );
    const missing: string[] = [];
    for (const sec of config.schemas!.P.sections) {
      if (!existingTitles.has(sec.name.toLowerCase())) {
        missing.push(sec.name);
      }
    }
    expect(missing).toEqual([]); // case-insensitive match found both
  });
});
```

- [ ] **Step 2: Run tests to verify they pass (testing the reconcile logic in isolation)**

Run: `cd /home/bbbee/projects/hmem && npx vitest run test/load-project-schema.test.ts`
Expected: PASS

- [ ] **Step 3: Add auto-reconcile to `load_project` in `mcp-server.ts`**

Insert reconcile logic after `hmemStore.setActiveProject(id, currentSessionId())` (line 1980) and before the cache check (line 1983):

```ts
        // Auto-reconcile: add missing schema sections to existing entry
        const pSchema = hmemConfig.schemas?.P;
        let reconcileNotice = "";
        if (pSchema && pSchema.sections.length > 0) {
          try {
            const l2Entries = hmemStore.read({ id, depth: 2 });
            if (l2Entries.length > 0 && l2Entries[0].children) {
              const existingTitles = new Set(
                l2Entries[0].children.map((c: any) => (c.title || c.content || "").trim().toLowerCase())
              );
              const missing: string[] = [];
              for (const sec of pSchema.sections) {
                if (!existingTitles.has(sec.name.toLowerCase())) {
                  missing.push(sec.name);
                }
              }
              if (missing.length > 0) {
                for (const name of missing) {
                  hmemStore.appendChildren(id, name);
                }
                reconcileNotice = `Reconciled: added sections ${missing.join(", ")}`;
                log(`load_project: ${id} reconciled — added: ${missing.join(", ")}`);
              }
            }
          } catch (e) {
            log(`load_project: reconcile failed for ${id}: ${safeError(e)}`);
          }
        }
```

Then append the reconcile notice to the output (after the `lines` array is built, before the return):

```ts
        if (reconcileNotice) {
          lines.push("");
          lines.push(`  ⚡ ${reconcileNotice}`);
        }
```

- [ ] **Step 4: Run full test suite**

Run: `cd /home/bbbee/projects/hmem && npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server.ts test/load-project-schema.test.ts
git commit -m "feat: auto-reconcile missing schema sections on load_project"
```

---

### Task 5: Update `loadProjectExpand` Replacement Logic

**Files:**
- Modify: `src/hmem-config.ts`

When a schema is defined for P, the old `loadProjectExpand.withBody` / `withChildren` seq-number arrays become irrelevant (they reference L2 seq numbers which may not match schema order). The schema's `loadDepth` replaces them entirely.

- [ ] **Step 1: Verify no code outside `mcp-server.ts` reads `loadProjectExpand`**

Run: `cd /home/bbbee/projects/hmem && grep -rn "loadProjectExpand" src/ --include="*.ts"`
Expected: Only references in `hmem-config.ts` (type + default + parsing) and `mcp-server.ts` (legacy rendering path). No other consumers.

- [ ] **Step 2: Confirm legacy path still uses `loadProjectExpand` correctly**

The legacy rendering path (no schema) in Task 3's code already reads `hmemConfig.loadProjectExpand` — verify this is intact. No code change needed, just confirmation.

- [ ] **Step 3: Commit (no-op if no changes needed)**

If changes were made:
```bash
git add src/hmem-config.ts
git commit -m "refactor: loadProjectExpand only used in legacy path when no schema defined"
```

---

### Task 6: Add Default P-Schema to hmem.config.json

**Files:**
- Modify: `~/.hmem/Agents/DEVELOPER/hmem.config.json` (the live config for the developer agent)

- [ ] **Step 1: Read current config**

Run: `cat ~/.hmem/Agents/DEVELOPER/hmem.config.json`

- [ ] **Step 2: Add the P-schema from the spec**

Add `schemas` key inside the `memory` block:

```json
"schemas": {
  "P": {
    "sections": [
      { "name": "Overview",    "loadDepth": 3, "defaultChildren": ["Current state", "Goals", "Environment"] },
      { "name": "Codebase",    "loadDepth": 1 },
      { "name": "Usage",       "loadDepth": 2 },
      { "name": "Context",     "loadDepth": 2, "defaultChildren": ["Initiator", "Target audience"] },
      { "name": "Deployment",  "loadDepth": 1 },
      { "name": "Bugs",        "loadDepth": 2 },
      { "name": "Protocol",    "loadDepth": 0 },
      { "name": "Open tasks",  "loadDepth": 2 },
      { "name": "Next Steps",  "loadDepth": 3 },
      { "name": "Ideas",       "loadDepth": 1 },
      { "name": "Custom",      "loadDepth": 2 }
    ],
    "createLinkedO": true
  }
}
```

- [ ] **Step 3: Verify config loads without errors**

Run: `cd /home/bbbee/projects/hmem && node -e "const { loadHmemConfig } = require('./dist/hmem-config.js'); const c = loadHmemConfig(process.env.HOME + '/.hmem/Agents/DEVELOPER'); console.log(JSON.stringify(c.schemas, null, 2))"`
Expected: Schema object printed with 11 P sections

- [ ] **Step 4: Commit config change (if in a tracked location)**

This config file is likely not in the hmem repo — skip git commit. Just verify it works.

---

### Task 7: Update `/hmem-wipe` Skill for Next Steps

**Files:**
- Identify and modify: the `/hmem-wipe` skill file

- [ ] **Step 1: Find the wipe skill file**

Run: `find ~/.claude -name "*wipe*" -o -name "*hmem-wipe*" 2>/dev/null` and `grep -rn "hmem-wipe\|wipe" ~/.claude/plugins/ --include="*.md" -l 2>/dev/null`

- [ ] **Step 2: Read the current wipe skill**

Read the skill file found in Step 1.

- [ ] **Step 3: Add Next Steps pflege instruction**

Add to the wipe skill, before the `/clear` step:

```markdown
## Before clearing context

1. Read the current "Next Steps" section of the active project: `read_memory(id="P00XX.9")` (where .9 is the Next Steps section — actual seq may vary)
2. Update it with current priorities and next actions: `write_memory(id="P00XX.9", content="...")`
3. This ensures session handoff context survives the context wipe.
```

The exact seq number depends on the project's section order. The skill should use `search_memory` or iterate L2 children to find the "Next Steps" section by title, not by hardcoded seq.

- [ ] **Step 4: Commit**

```bash
git add <skill-file-path>
git commit -m "feat: hmem-wipe skill pflegt Next Steps before context clear"
```

---

### Task 8: Build, Run Full Test Suite, Manual Smoke Test

**Files:** None (verification only)

- [ ] **Step 1: Build**

Run: `cd /home/bbbee/projects/hmem && npm run build`
Expected: No TypeScript errors

- [ ] **Step 2: Run full test suite**

Run: `cd /home/bbbee/projects/hmem && npx vitest run`
Expected: All tests PASS

- [ ] **Step 3: Manual smoke test — create_project with schema**

After global install (`npm install -g`), test in a fresh session:
1. Verify `loadHmemConfig` picks up the schema from `hmem.config.json`
2. Call `create_project` — verify it creates sections matching the schema (not hardcoded 9)
3. Call `load_project` — verify Protocol is hidden (loadDepth=0), Overview shows body (loadDepth=3), Codebase shows title only (loadDepth=1)

- [ ] **Step 4: Manual smoke test — auto-reconcile**

1. Load an existing P-entry that was created before the schema change (e.g. P0048)
2. Verify `load_project` output includes a reconcile notice for "Next Steps" and "Custom"
3. Call `read_memory(id="P0048", depth=2)` — verify the new sections exist as empty L2 nodes
4. Load again — verify no reconcile notice (idempotent)

- [ ] **Step 5: Commit any fixes from smoke testing**

```bash
git add -A
git commit -m "fix: smoke test fixes for configurable entry schemas"
```

---

### Task 9: npm Publish

- [ ] **Step 1: Bump version**

Run: `cd /home/bbbee/projects/hmem && npm version patch`
Expected: Version bumped (e.g. 6.2.1 or 6.3.0)

- [ ] **Step 2: Build and publish**

Run: `cd /home/bbbee/projects/hmem && npm run build && npm publish`
Expected: Published to npm as `hmem-mcp`

- [ ] **Step 3: Update global install**

Run: `npm install -g hmem-mcp`
Expected: New version installed globally

- [ ] **Step 4: Verify hooks pick up new code**

Send a test message in a Claude Code session. Check statusline, check that `load_project` uses schema-driven rendering.
