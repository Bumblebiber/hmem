// Semantic Memory Search — Full-text search over .hmem files and optionally project docs.
//
// Lightweight: No external dependencies (no ChromaDB/Faiss).
// Uses keyword matching with TF-based relevance scoring.
//
// Searches:
//   - *.hmem files in PROJECT_DIR and subdirectories (agent memories — SQLite, hierarchical)
//   - Optional: Personality.md, project docs, skill docs (if directories exist)

import fs from "node:fs";
import path from "node:path";
import { HmemStore } from "./hmem-store.js";

export type SearchScope = "memories" | "personalities" | "projects" | "skills" | "all";

export interface SearchResult {
  file: string;           // Relative path (from PROJECT_DIR)
  agent?: string;         // Agent name (if .hmem or Personality.md)
  scope: SearchScope;     // Which scope
  score: number;          // Relevance score (higher = better)
  excerpts: string[];     // Relevant text excerpts (max 3 per file)
}

export interface SearchOptions {
  scope?: SearchScope;
  maxResults?: number;
  contextLines?: number;  // Lines of context around each match (for file-based scopes)
}

// ---- .hmem search (memories scope) ----

/**
 * Searches a single .hmem SQLite file for the given keywords.
 * Returns a SearchResult or null if no matches found.
 */
function searchHmemFile(
  hmemPath: string,
  agentName: string,
  keywords: string[],
  query: string,
  projectDir: string
): SearchResult | null {
  let store: HmemStore | null = null;
  try {
    store = new HmemStore(hmemPath);
    const entries = store.read({ search: query });
    if (entries.length === 0) return null;

    // Score: number of matching entries weighted by keyword matches in L1
    let score = 0;
    const excerpts: string[] = [];

    for (const entry of entries.slice(0, 3)) {
      const text = entry.level_1 || "";
      const entryScore = scoreText(text, keywords);
      score += entryScore + 1; // +1 per match regardless of keyword density

      // Build excerpt: [ID] L1 text + up to 1 child
      let excerpt = `[${entry.id}] ${entry.level_1}`;
      if (entry.children && entry.children.length > 0) {
        const child = entry.children[0];
        const preview = child.content.length > 120
          ? child.content.substring(0, 117) + "..."
          : child.content;
        excerpt += `\n  └ ${preview}`;
      }
      excerpts.push(excerpt);
    }

    if (score <= 0) return null;

    return {
      file: path.relative(projectDir, hmemPath),
      agent: agentName,
      scope: "memories",
      score: Math.round(score * 100) / 100,
      excerpts,
    };
  } catch {
    return null;
  } finally {
    store?.close();
  }
}

/**
 * Collects all .hmem files for the memories scope.
 * Scans PROJECT_DIR root + common subdirectory patterns (Agents/, Assistenten/, agents/).
 */
function collectHmemFiles(projectDir: string): { hmemPath: string; agentName: string }[] {
  const results: { hmemPath: string; agentName: string }[] = [];

  // Scan common agent directory patterns
  for (const subdir of ["Agents", "Assistenten", "agents"]) {
    const dir = path.join(projectDir, subdir);
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const d of entries) {
        if (!d.isDirectory()) continue;
        const hmemPath = path.join(dir, d.name, `${d.name}.hmem`);
        if (fs.existsSync(hmemPath)) {
          results.push({ hmemPath, agentName: d.name });
        }
      }
    } catch { /* dir does not exist */ }
  }

  // Check for standalone .hmem files in PROJECT_DIR root
  try {
    const rootEntries = fs.readdirSync(projectDir, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.isFile() && entry.name.endsWith(".hmem")) {
        const name = entry.name.replace(/\.hmem$/, "");
        const hmemPath = path.join(projectDir, entry.name);
        // Avoid duplicates (agent dirs already scanned above)
        if (!results.some(r => r.hmemPath === hmemPath)) {
          results.push({ hmemPath, agentName: name === "memory" ? "default" : name });
        }
      }
    }
  } catch { /* */ }

  return results;
}

// ---- File-based search (personalities, projects, skills) ----

/**
 * Collects searchable .md files based on scope.
 */
function collectMdFiles(
  dir: string,
  results: { file: string; scope: SearchScope }[],
  scope: SearchScope,
  maxDepth: number,
  currentDepth = 0
): void {
  if (currentDepth > maxDepth) return;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push({ file: fullPath, scope });
      } else if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        collectMdFiles(fullPath, results, scope, maxDepth, currentDepth + 1);
      }
    }
  } catch { /* Access error */ }
}

function collectMdFilesByScope(
  projectDir: string,
  scope: Exclude<SearchScope, "memories">
): { file: string; scope: SearchScope }[] {
  const results: { file: string; scope: SearchScope }[] = [];
  const agentsDir = path.join(projectDir, "Agents");
  const projectsDir = path.join(projectDir, "Projects");
  const skillsDir = path.join(projectDir, "skills");

  if (scope === "personalities" || scope === "all") {
    try {
      const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
      for (const d of entries) {
        if (!d.isDirectory()) continue;
        const persFile = path.join(agentsDir, d.name, "Personality.md");
        if (fs.existsSync(persFile)) {
          results.push({ file: persFile, scope: "personalities" });
        }
      }
    } catch { /* */ }
  }

  if (scope === "projects" || scope === "all") {
    try {
      const projects = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const p of projects) {
        if (!p.isDirectory()) continue;
        collectMdFiles(path.join(projectsDir, p.name), results, "projects", 2);
      }
    } catch { /* */ }
  }

  if (scope === "skills" || scope === "all") {
    try {
      const skills = fs.readdirSync(skillsDir, { withFileTypes: true });
      for (const s of skills) {
        if (!s.isDirectory()) continue;
        collectMdFiles(path.join(skillsDir, s.name), results, "skills", 1);
      }
    } catch { /* */ }
  }

  return results;
}

// ---- Keyword scoring ----

/**
 * Tokenizes a search query into keywords.
 */
function tokenize(query: string): string[] {
  const stopwords = new Set([
    "der", "die", "das", "ein", "eine", "und", "oder", "in", "von", "zu",
    "mit", "auf", "fuer", "ist", "sind", "was", "wie", "wo", "wer",
    "the", "a", "an", "and", "or", "in", "of", "to", "with", "on",
    "for", "is", "are", "what", "how", "where", "who",
  ]);

  return query
    .toLowerCase()
    .replace(/[^a-z0-9äöüß_-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1 && !stopwords.has(w));
}

/**
 * Scores a text string based on keyword frequency.
 */
function scoreText(content: string, keywords: string[]): number {
  const lower = content.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    let idx = 0;
    let count = 0;
    while ((idx = lower.indexOf(kw, idx)) !== -1) {
      count++;
      idx += kw.length;
    }
    if (count > 0) {
      score += count * (1 + kw.length / 5);
    }
  }
  return Math.round(score * 100) / 100;
}

/**
 * Extracts text excerpts around keyword matches.
 */
function extractExcerpts(content: string, keywords: string[], contextLines: number): string[] {
  const lines = content.split("\n");
  const matchedLineNums = new Set<number>();

  for (const kw of keywords) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(kw)) {
        matchedLineNums.add(i);
      }
    }
  }

  if (matchedLineNums.size === 0) return [];

  const sorted = Array.from(matchedLineNums).sort((a, b) => a - b);
  const excerpts: string[] = [];
  let currentGroup: number[] = [];

  for (const lineNum of sorted) {
    if (currentGroup.length === 0 || lineNum - currentGroup[currentGroup.length - 1] <= contextLines * 2 + 1) {
      currentGroup.push(lineNum);
    } else {
      excerpts.push(buildExcerpt(lines, currentGroup, contextLines));
      currentGroup = [lineNum];
    }
  }
  if (currentGroup.length > 0) {
    excerpts.push(buildExcerpt(lines, currentGroup, contextLines));
  }

  return excerpts.slice(0, 3);
}

function buildExcerpt(lines: string[], matchedLines: number[], contextLines: number): string {
  const start = Math.max(0, matchedLines[0] - contextLines);
  const end = Math.min(lines.length - 1, matchedLines[matchedLines.length - 1] + contextLines);
  const excerpt = lines.slice(start, end + 1).join("\n").trim();
  return excerpt.length > 500 ? excerpt.substring(0, 497) + "..." : excerpt;
}

// ---- Main export ----

/**
 * Searches the knowledge base across agent memories (.hmem), personalities,
 * project docs, and skills.
 */
export function searchMemory(
  projectDir: string,
  query: string,
  options: SearchOptions = {}
): SearchResult[] {
  const { scope = "all", maxResults = 10, contextLines = 2 } = options;
  const keywords = tokenize(query);

  if (keywords.length === 0) return [];

  const results: SearchResult[] = [];

  // --- Memories scope: .hmem SQLite ---
  if (scope === "memories" || scope === "all") {
    const hmemFiles = collectHmemFiles(projectDir);
    for (const { hmemPath, agentName } of hmemFiles) {
      const result = searchHmemFile(hmemPath, agentName, keywords, query, projectDir);
      if (result) results.push(result);
    }
  }

  // --- File-based scopes: personalities, projects, skills ---
  if (scope !== "memories") {
    const mdScope = scope === "all" ? "all" : scope;
    const mdFiles = collectMdFilesByScope(projectDir, mdScope as Exclude<SearchScope, "memories">);

    for (const { file, scope: fileScope } of mdFiles) {
      let content: string;
      try {
        const stat = fs.statSync(file);
        if (stat.size > 500 * 1024) continue;
        content = fs.readFileSync(file, "utf-8");
      } catch {
        continue;
      }

      if (content.trim().length < 50) continue;

      const score = scoreText(content, keywords);
      if (score <= 0) continue;

      const relPath = path.relative(projectDir, file);

      let agent: string | undefined;
      const agentMatch = relPath.match(/^Agents\/([^/]+)\//);
      if (agentMatch) agent = agentMatch[1];

      const excerpts = extractExcerpts(content, keywords, contextLines);

      results.push({
        file: relPath,
        agent,
        scope: fileScope,
        score,
        excerpts,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}
