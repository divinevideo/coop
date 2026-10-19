import { object, UUID } from './service.js';

export type DecisionSource =
  | { caseId: string; priorDecisionId?: never }
  | { caseId?: never; priorDecisionId: string };
export type ReversalContext = {
  decisionId: string;
  caseId: string;
  communityId: string;
  channelId: string;
  rumorId: string;
  author: string;
  action: 'ban_member';
  discordGuildConfirmed: boolean;
};
export type DiscordRestriction = {
  state: 'present' | 'absent' | 'unknown' | 'not_applicable';
  checkedAt: string | null;
  code: string;
};
export type LifecycleStatus = {
  decisionId: string;
  appealState: 'none' | 'open' | 'closed';
  closedAt: string | null;
  auditDeleteAfter: string | null;
  auditAvailable: boolean;
};
export type HoldStatus = {
  holdId: string;
  caseId: string;
  holdUntil: string;
  releasedAt: string | null;
};
export function parseReversalContext(
  value: unknown,
  decisionId: string,
): ReversalContext {
  const context = object(value);
  if (
    context.decisionId !== decisionId ||
    !UUID.test(String(context.caseId)) ||
    context.action !== 'ban_member' ||
    typeof context.discordGuildConfirmed !== 'boolean' ||
    !['communityId', 'channelId', 'rumorId', 'author'].every(
      (key) =>
        typeof context[key] === 'string' &&
        /^[0-9a-f]{64}$/.test(String(context[key])),
    )
  )
    throw new Error('Invalid authoritative reversal context');
  return context as ReversalContext;
}
export function parseDiscordRestriction(value: unknown): DiscordRestriction {
  const observation = object(value);
  if (
    !['present', 'absent', 'unknown', 'not_applicable'].includes(
      String(observation.state),
    ) ||
    !(
      observation.checkedAt === null ||
      (typeof observation.checkedAt === 'string' &&
        Number.isFinite(Date.parse(observation.checkedAt)))
    ) ||
    typeof observation.code !== 'string' ||
    !/^[a-z_]{1,64}$/.test(observation.code)
  )
    throw new Error('Invalid restriction observation');
  return observation as DiscordRestriction;
}
