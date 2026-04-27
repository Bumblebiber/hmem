#!/usr/bin/env node
/**
 * hmem — Humanlike Memory MCP Server (daily-use tools).
 *
 * Provides persistent, hierarchical memory for AI agents via MCP.
 * SQLite-backed, 5-level lazy loading.
 *
 * Curation/maintenance tools (memory_health, tag_bulk, rename_id, etc.) live in
 * the separate hmem-curate-server. Activate it with /mcp when needed.
 *
 * Environment variables:
 *   HMEM_PATH                — Full path to .hmem file (auto-resolved if not set)
 *   HMEM_PROJECT_DIR         — Root directory (fallback: dirname of HMEM_PATH)
 *   HMEM_AUDIT_STATE_PATH    — Path to audit_state.json (default: {PROJECT_DIR}/audit_state.json)
 */
export {};
