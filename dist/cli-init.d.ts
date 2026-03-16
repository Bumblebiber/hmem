/**
 * Script:    cli-init.ts
 * Purpose:   Interactive installer for hmem MCP — configures AI coding tools
 * Author:    DEVELOPER
 * Created:   2026-02-21
 */
export declare function runInit(): Promise<void>;
/**
 * Copy bundled skill files to detected AI tool skill directories.
 * Overwrites existing skills with the version from the npm package.
 */
export declare function updateSkills(): void;
