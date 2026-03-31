/**
 * cli-migrate-o.ts
 *
 * One-time migration: reassign O-entry IDs to match their linked P-entry IDs.
 * O0042 linked to P0048 becomes O0048. Unlinked O-entries go to O0000.
 *
 * Usage: hmem migrate-o-entries
 */

import fs from "node:fs";
import path from "node:path";
import { HmemStore, resolveHmemPath } from "./hmem-store.js";
import { loadHmemConfig } from "./hmem-config.js";
import { resolveEnvDefaults } from "./cli-env.js";

export async function migrateOEntries(): Promise<void> {
  resolveEnvDefaults();
  const projectDir = process.env.HMEM_PROJECT_DIR || process.env.COUNCIL_PROJECT_DIR;
  if (!projectDir) {
    console.error("HMEM_PROJECT_DIR not set");
    process.exit(1);
  }

  const agentId = process.env.HMEM_AGENT_ID || process.env.COUNCIL_AGENT_ID || "";
  const templateName = agentId.replace(/_\d+$/, "");
  const hmemPath = resolveHmemPath(projectDir, templateName);
  if (!fs.existsSync(hmemPath)) {
    console.error(`hmem file not found: ${hmemPath}`);
    process.exit(1);
  }

  const config = loadHmemConfig(path.dirname(hmemPath));
  const store = new HmemStore(hmemPath, config);

  try {
    console.log("=== hmem O-Entry Migration ===\n");

    // Step 1: Ensure P0000 exists
    const p0000 = store.readEntry("P0000");
    if (!p0000) {
      console.log("Creating P0000 (Non-Project)...");
      // Use direct SQL since writeLinear auto-assigns seq
      store.db.prepare(`
        INSERT INTO memories (id, prefix, seq, created_at, updated_at, title, level_1, min_role)
        VALUES ('P0000', 'P', 0, ?, ?, 'Non-Project', 'Non-Project | Catch-all for unassigned exchanges', 'worker')
      `).run(new Date().toISOString(), new Date().toISOString());
      store.addTag("P0000", "#project");
      console.log("  Created P0000");
    }

    // Step 2: Ensure O0000 exists
    const o0000 = store.readEntry("O0000");
    if (!o0000) {
      console.log("Creating O0000 (Non-Project catch-all)...");
      store.db.prepare(`
        INSERT INTO memories (id, prefix, seq, created_at, updated_at, title, level_1, min_role)
        VALUES ('O0000', 'O', 0, ?, ?, 'Non-Project', 'Non-Project', 'worker')
      `).run(new Date().toISOString(), new Date().toISOString());
      console.log("  Created O0000");
    }

    // Step 3: Get all O-entries
    const oEntries = store.db.prepare(
      "SELECT id, title, links, seq FROM memories WHERE prefix = 'O' ORDER BY seq"
    ).all() as { id: string; title: string; links: string | null; seq: number }[];

    console.log(`Found ${oEntries.length} O-entries to process.\n`);

    // Step 4: Build migration plan
    const plan: { oldId: string; newId: string; reason: string }[] = [];
    const targetIds = new Set<string>();

    for (const o of oEntries) {
      let linkedP: string | null = null;
      if (o.links) {
        try {
          const links = JSON.parse(o.links) as string[];
          linkedP = links.find(l => l.startsWith("P")) || null;
        } catch {}
      }

      if (linkedP) {
        const pSeq = parseInt(linkedP.replace(/\D/g, ""), 10);
        const targetId = `O${String(pSeq).padStart(4, "0")}`;

        if (o.id === targetId) {
          console.log(`  ${o.id} -> OK (already matches ${linkedP})`);
        } else if (targetIds.has(targetId)) {
          console.log(`  ${o.id} -> CONFLICT (${targetId} already claimed, tagging #legacy)`);
          plan.push({ oldId: o.id, newId: "", reason: `conflict for ${targetId}` });
        } else {
          plan.push({ oldId: o.id, newId: targetId, reason: `linked to ${linkedP}` });
          targetIds.add(targetId);
          console.log(`  ${o.id} -> ${targetId} (${linkedP} ${o.title})`);
        }
      } else {
        if (o.id === "O0000") {
          console.log(`  ${o.id} -> OK (catch-all)`);
        } else {
          console.log(`  ${o.id} -> #legacy (no P-link)`);
          plan.push({ oldId: o.id, newId: "", reason: "no P-link" });
        }
      }
    }

    if (plan.length === 0) {
      console.log("\nNothing to migrate.");
      return;
    }

    const renameCount = plan.filter(p => p.newId).length;
    const legacyCount = plan.filter(p => !p.newId).length;
    console.log(`\nMigration plan: ${renameCount} renames, ${legacyCount} legacy tags.\n`);

    // Step 5: Clear active flag from all O-entries
    store.db.prepare("UPDATE memories SET active = 0 WHERE prefix = 'O' AND active = 1").run();

    // Step 6: Execute renames
    const renames = plan.filter(p => p.newId);
    for (const r of renames) {
      const blocker = store.readEntry(r.newId);
      if (blocker) {
        const tempId = `O9${r.newId.substring(1)}`;
        console.log(`  Moving blocker ${r.newId} -> ${tempId}`);
        const tempResult = store.renameId(r.newId, tempId);
        if (!tempResult.ok) {
          console.error(`  FAILED to move blocker: ${tempResult.error}`);
          continue;
        }
      }

      const result = store.renameId(r.oldId, r.newId);
      if (result.ok) {
        console.log(`  Renamed ${r.oldId} -> ${r.newId} (${result.affected} records)`);
        store.addTag(r.newId, "#legacy");
      } else {
        console.error(`  FAILED ${r.oldId} -> ${r.newId}: ${result.error}`);
      }
    }

    // Step 7: Tag remaining as #legacy
    const legacyOnly = plan.filter(p => !p.newId);
    for (const l of legacyOnly) {
      store.addTag(l.oldId, "#legacy");
      console.log(`  Tagged ${l.oldId} as #legacy (${l.reason})`);
    }

    console.log("\nMigration complete. Run 'hmem self-curate' to review #legacy entries.");

  } catch (e) {
    console.error(`Migration failed: ${e}`);
    process.exit(1);
  } finally {
    store.close();
  }
}
