// src/hooks/session-start.ts
import type { V2Store } from '../v2/store-facade.js';
import type { HookContext, SessionStartResult, SessionStartDeps } from './types.js';
import { resolveBinding } from './binding-resolver.js';
import { buildStableContext } from './stable-context.js';
import { buildProjectBrief } from './brief.js';
import { defaultGitProbe, formatGitPendingWork } from './git-probe.js';

export function buildSessionStart(store: V2Store, ctx: HookContext, deps: SessionStartDeps = {}): SessionStartResult {
  const binding = resolveBinding({
    store, sessionId: ctx.sessionId, harness: ctx.harness,
    cwd: ctx.cwd, namedProject: ctx.namedProject, deviceId: ctx.deviceId,
  });

  const parts: string[] = [];
  parts.push(buildStableContext(store, { syncProbe: deps.syncProbe, deviceProbe: deps.deviceProbe }));

  if (binding.projectLabel) {
    parts.push('\n' + buildProjectBrief(store, binding.projectLabel));
  } else {
    parts.push('\n⚠ Kein aktives Projekt gebunden (no active project). Wähle eines aus "Recent projects" und rufe activate() auf.');
  }

  if (ctx.cwd) {
    const gitProbe = deps.gitProbe ?? defaultGitProbe;
    const gitBlock = formatGitPendingWork(gitProbe(ctx.cwd));
    if (gitBlock) parts.push('\n' + gitBlock);
  }

  return {
    sessionId: binding.sessionId,
    projectLabel: binding.projectLabel,
    bindingSource: binding.source,
    context: parts.join('\n'),
  };
}
