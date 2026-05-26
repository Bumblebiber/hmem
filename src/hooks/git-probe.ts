// src/hooks/git-probe.ts
import { execFileSync } from 'node:child_process';
import type { GitPendingWork, GitProbe } from './types.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

export const defaultGitProbe: GitProbe = (cwd: string): GitPendingWork => {
  const blank: GitPendingWork = { uncommitted: [], stashes: [], worktrees: [], unmergedBranches: [], isRepo: false };
  try {
    git(cwd, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return blank;
  }
  const lines = (s: string) => s.split('\n').map(l => l.trim()).filter(Boolean);
  const safe = (fn: () => string) => { try { return fn(); } catch { return ''; } };

  const uncommitted = lines(safe(() => git(cwd, ['status', '--porcelain'])));
  const stashes = lines(safe(() => git(cwd, ['stash', 'list'])));
  const worktrees = lines(safe(() => git(cwd, ['worktree', 'list']))).slice(1); // drop the main worktree line
  const unmerged = lines(safe(() => git(cwd, ['branch', '--no-merged', 'main'])))
    .map(l => l.replace(/^\*?\s*/, ''))
    .filter(b => b && b !== 'main' && b !== 'master');

  return { uncommitted, stashes, worktrees, unmergedBranches: unmerged, isRepo: true };
};

/** German `⚠ Offene Arbeit` block; '' when nothing pending. */
export function formatGitPendingWork(w: GitPendingWork): string {
  if (!w.isRepo) return '';
  const sections: string[] = [];
  if (w.worktrees.length) sections.push('  Worktrees:\n' + w.worktrees.map(l => '    ' + l).join('\n'));
  if (w.stashes.length) sections.push('  Stashes:\n' + w.stashes.map(l => '    ' + l).join('\n'));
  if (w.unmergedBranches.length) sections.push('  Unmerged Branches:\n' + w.unmergedBranches.map(b => '    ' + b).join('\n'));
  if (w.uncommitted.length) sections.push('  Uncommitted:\n' + w.uncommitted.map(l => '    ' + l).join('\n'));
  if (!sections.length) return '';
  return '⚠ Offene Arbeit im Repo:\n' + sections.join('\n') + '\n\nWeiter dran arbeiten oder aufräumen?';
}
