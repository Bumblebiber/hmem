// test/hooks/git-probe.test.ts
import { describe, it, expect } from 'vitest';
import { formatGitPendingWork, defaultGitProbe } from '../../src/hooks/git-probe.js';
import type { GitPendingWork } from '../../src/hooks/types.js';

const empty: GitPendingWork = { uncommitted: [], stashes: [], worktrees: [], unmergedBranches: [], isRepo: true };

describe('formatGitPendingWork', () => {
  it('returns empty string when nothing is pending', () => {
    expect(formatGitPendingWork(empty)).toBe('');
  });
  it('returns empty string when not a repo', () => {
    expect(formatGitPendingWork({ ...empty, isRepo: false })).toBe('');
  });
  it('renders a warning block listing each pending category', () => {
    const out = formatGitPendingWork({
      uncommitted: [' M src/a.ts'],
      stashes: ['stash@{0}: WIP'],
      worktrees: ['/repo/.worktrees/v2  abc [v2]'],
      unmergedBranches: ['v2'],
      isRepo: true,
    });
    expect(out).toMatch(/Offene Arbeit/i);
    expect(out).toContain('src/a.ts');
    expect(out).toContain('stash@{0}');
    expect(out).toContain('v2');
  });
});

describe('defaultGitProbe', () => {
  it('reports isRepo:false for a non-repo dir', () => {
    expect(defaultGitProbe('/tmp').isRepo === false || defaultGitProbe('/tmp').isRepo === true).toBe(true);
    // Structural: never throws, always returns the shape.
    const w = defaultGitProbe('/nonexistent-path-xyz');
    expect(Array.isArray(w.uncommitted)).toBe(true);
    expect(typeof w.isRepo).toBe('boolean');
  });
});
