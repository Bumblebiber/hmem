export type SearchScope = "memories" | "personalities" | "projects" | "skills" | "all";
export interface SearchResult {
    file: string;
    agent?: string;
    scope: SearchScope;
    score: number;
    excerpts: string[];
}
export interface SearchOptions {
    scope?: SearchScope;
    maxResults?: number;
    contextLines?: number;
}
/**
 * Searches the knowledge base across agent memories (.hmem), personalities,
 * project docs, and skills.
 */
export declare function searchMemory(projectDir: string, query: string, options?: SearchOptions): SearchResult[];
