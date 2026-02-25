#!/usr/bin/env node
/**
 * hmem — Humanlike Memory MCP Server.
 *
 * Provides persistent, hierarchical memory for AI agents via MCP.
 * SQLite-backed, 5-level lazy loading, role-based access control.
 *
 * Environment variables:
 *   HMEM_PROJECT_DIR         — Root directory where .hmem files are stored (required)
 *   HMEM_AGENT_ID            — Agent identifier (optional; defaults to memory.hmem)
 *   HMEM_AGENT_ROLE          — Role: worker | al | pl | ceo (default: worker)
 *   HMEM_AUDIT_STATE_PATH    — Path to audit_state.json (default: {PROJECT_DIR}/audit_state.json)
 *
 * Legacy fallbacks (Das Althing):
 *   COUNCIL_PROJECT_DIR, COUNCIL_AGENT_ID, COUNCIL_AGENT_ROLE
 */
export {};
