/**
 * hmem — Humanlike Memory for AI Agents
 *
 * Public API for using hmem as a library.
 */
export { HmemStore, openAgentMemory, openCompanyMemory, resolveHmemPath } from "./hmem-store.js";
export type { AgentRole, MemoryEntry, MemoryNode } from "./hmem-store.js";
export { loadHmemConfig, DEFAULT_CONFIG, DEFAULT_PREFIXES, formatPrefixList } from "./hmem-config.js";
export type { HmemConfig } from "./hmem-config.js";
export { searchMemory } from "./memory-search.js";
export type { SearchResult, SearchOptions, SearchScope } from "./memory-search.js";
