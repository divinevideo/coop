import { createHash, createHmac } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';

import {
  hasPermission,
  UserPermission,
  UserRole,
} from '../../models/types/permissioning.js';
import { jsonStringify } from '../../utils/encoding.js';
import {
  parseDiscordRestriction,
  type DiscordRestriction,
} from './lifecycleContracts.js';

export type StaffActor = {
  id: string;
  orgId: string;
  role: UserRole;
  approvedByAdmin: boolean;
  rejectedByAdmin: boolean;
};
export type ConcordConfig = {
  origin: string;
  orgId: string;
  hmacKey: string;
  coopOrigin: string;
  accessIssuer: string;
  accessAudience: string;
  queueId: string;
  accessClientId?: string;
  accessClientSecret?: string;
};
export type RoomAction = 'remove_message' | 'ban_member' | 'unban_member';
export type RoomRequest = {
  url: string;
  method: 'get' | 'post';
  body?: string;
  headers: Record<string, string>;
  handleResponseBody: 'as-json';
  logRequestAndResponseBody: 'NEVER';
  timeoutMs: number;
  redirect?: 'error';
};
export type RoomTransport = (
  request: RoomRequest,
) => Promise<{ ok: boolean; status: number; body: unknown }>;
export type SourceOrder = { version: 1; revision: string };
export const SOURCE_ORDER_OPERATION_PREFIX = 'source-order-v1_';
export const MANUAL_ROOM_OPERATION_PREFIX = 'source-order-v2_';
export function isServerRoomOperationId(
  value: string,
  expectedAction?: RoomAction,
): boolean {
  return (
    expectedAction
      ? [expectedAction]
      : ['remove_message', 'ban_member', 'unban_member']
  ).some((action) => {
    const prefix = `${MANUAL_ROOM_OPERATION_PREFIX}${action}_`;
    return value.startsWith(prefix) && UUID.test(value.slice(prefix.length));
  });
}
export function isSourceOrderedRoomOperationId(
  value: string,
  expectedAction?: RoomAction,
): boolean {
  return (
    expectedAction
      ? [expectedAction]
      : ['remove_message', 'ban_member', 'unban_member']
  ).some((action) => {
    const prefix = `${SOURCE_ORDER_OPERATION_PREFIX}${action}_`;
    return value.startsWith(prefix) && UUID.test(value.slice(prefix.length));
  });
}
export function parseSourceOrder(value: unknown): SourceOrder {
  const order = object(value);
  if (
    order.version !== 1 ||
    typeof order.revision !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(order.revision) ||
    BigInt(order.revision) > 9223372036854775807n
  )
    throw new Error('Invalid member source order');
  return { version: 1, revision: order.revision };
}
export class RoomResponseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown>,
  ) {
    super('Room moderation ' + code);
  }
}
export type RoomStatus = {
  discordRestriction?: DiscordRestriction;
  auditAvailable?: boolean;
  executionId?: string;
  sourceOrder?: SourceOrder | null;
  decisionId: string;
  action: RoomAction;
  target: { communityId: string; channelId: string; rumorId: string };
  deliveries: {
    target: 'divine_relay' | 'concord' | 'discord';
    state: string;
    attempts: number;
    resultCode: string | null;
  }[];
};
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid room response');
  return value as Record<string, unknown>;
}
export function loadConcordConfig(env: NodeJS.ProcessEnv): ConcordConfig {
  const require = (name: string) => {
    const value = env[name];
    if (!value) throw new Error('Room moderation is not configured');
    return value;
  };
  const origin = require('CONCORD_MODERATION_ORIGIN'),
    coopOrigin = require('CONCORD_COOP_ORIGIN'),
    accessIssuer = require('CONCORD_ACCESS_ISSUER'),
    hmacKey = require('CONCORD_MODERATION_HMAC_KEY');
  // This fixed service is private to the cluster and protected by NetworkPolicy.
  // Browser/Access origins and every external enforcement origin still require TLS.
  const internalOrigin =
    'http://concord-moderation.armada-chat.svc.cluster.local:8080';
  for (const value of [
    coopOrigin,
    accessIssuer,
    ...(origin === internalOrigin ? [] : [origin]),
  ])
    if (new URL(value).protocol !== 'https:' || new URL(value).origin !== value)
      throw new Error('Invalid room service origin');
  if (
    !/^[0-9a-f]{64}$/.test(hmacKey) ||
    !new URL(accessIssuer).hostname.endsWith('.cloudflareaccess.com')
  )
    throw new Error('Invalid room service credential configuration');
  const accessClientId = env.CONCORD_ACCESS_CLIENT_ID,
    accessClientSecret = env.CONCORD_ACCESS_CLIENT_SECRET;
  if (
    Boolean(accessClientId) !== Boolean(accessClientSecret) ||
    (accessClientId && new URL(origin).protocol !== 'https:')
  )
    throw new Error('Invalid service Access credentials');
  return {
    accessClientId,
    accessClientSecret,
    origin,
    coopOrigin,
    accessIssuer,
    hmacKey,
    orgId: require('CONCORD_ORG_ID'),
    accessAudience: require('CONCORD_ACCESS_AUDIENCE'),
    queueId: require('CONCORD_QUEUE_ID'),
  };
}
export function roomPermissions(actor: StaffActor): string[] {
  if (
    !actor.id ||
    !actor.orgId ||
    !actor.approvedByAdmin ||
    actor.rejectedByAdmin ||
    !hasPermission(UserPermission.MANUALLY_ACTION_CONTENT, actor.role)
  )
    return [];
  return [
    'view',
    'remove_message',
    'retry',
    ...([UserRole.ADMIN, UserRole.MODERATOR_MANAGER].includes(actor.role)
      ? ['ban_member', 'unban_member']
      : []),
    ...(actor.role === UserRole.ADMIN
      ? ['discord_guild_ban', 'manage_moderation_records', 'view_held_evidence']
      : []),
  ];
}
export function roomAction(name: string): RoomAction | undefined {
  if (name === 'concord_remove_message') return 'remove_message';
  if (name === 'concord_ban_member') return 'ban_member';
  if (name === 'concord_unban_member') return 'unban_member';
  return undefined;
}
export function validRoomReason(note: string | undefined): note is string {
  return (
    typeof note === 'string' && note.trim().length > 0 && note.length <= 2048
  );
}
export function validateRoomActionPermission(
  actor: StaffActor,
  actionName: string,
  parameters: Record<string, unknown>,
) {
  const action = roomAction(actionName);
  const permissions = roomPermissions(actor);
  if (
    !action ||
    Object.keys(parameters).some((key) => key !== 'discordGuildConfirmed') ||
    (parameters.discordGuildConfirmed !== undefined &&
      typeof parameters.discordGuildConfirmed !== 'boolean') ||
    !permissions.includes(action) ||
    (parameters.discordGuildConfirmed === true &&
      !permissions.includes('discord_guild_ban'))
  )
    throw new Error('Room action permission or scope invalid');
}
export async function roomRequest(
  config: ConcordConfig,
  fetchHTTP: RoomTransport,
  actor: StaffActor,
  method: 'get' | 'post',
  path: string,
  payload?: unknown,
): Promise<unknown> {
  if (actor.orgId !== config.orgId || !roomPermissions(actor).includes('view'))
    throw new Error('Room permission required');
  if (
    !/^\/v1\/(decisions(?:\/[0-9a-f-]{36}(?:\/(?:retry|reversal-context|reversals|appeal|close|restriction-refresh|publication-refresh))?)?|decision-executions\/[0-9a-f-]{36}|cases\/[0-9a-f-]{36}(?:\/(?:holds|held-evidence))?|holds\/[0-9a-f-]{36}\/release)$/.test(
      path,
    )
  )
    throw new Error('Invalid room service path');
  const body = payload === undefined ? '' : jsonStringify(payload);
  const staff = Buffer.from(
    jsonStringify({
      orgId: actor.orgId,
      actorId: actor.id,
      permissions: roomPermissions(actor),
    }),
  ).toString('base64');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const bytes = jsonStringify([
    method.toUpperCase(),
    path,
    createHash('sha256').update(body).digest('hex'),
    timestamp,
    staff,
  ]);
  const signature = createHmac('sha256', Buffer.from(config.hmacKey, 'hex'))
    .update(bytes)
    .digest('hex');
  const response = await fetchHTTP({
    url: config.origin + path,
    method,
    ...(body ? { body } : {}),
    headers: {
      ...(config.accessClientId && config.accessClientSecret
        ? {
            'CF-Access-Client-Id': config.accessClientId,
            'CF-Access-Client-Secret': config.accessClientSecret,
          }
        : {}),
      'content-type': 'application/json',
      'x-coop-actor': staff,
      'x-coop-timestamp': timestamp,
      'x-coop-signature': signature,
    },
    handleResponseBody: 'as-json',
    logRequestAndResponseBody: 'NEVER',
    timeoutMs: 5000,
    redirect: 'error',
  });
  const holdCreated =
    method === 'post' &&
    /^\/v1\/cases\/[0-9a-f-]{36}\/holds$/.test(path) &&
    response.status === 201;
  if (!response.ok || (!holdCreated && ![200, 202].includes(response.status))) {
    const details = object(response.body);
    if (
      response.status === 404 ||
      (response.status === 409 &&
        [
          'decision_source_unavailable',
          'member_intent_superseded',
          'member_intent_order_conflict',
          'member_intent_order_required',
        ].includes(String(details.error)))
    )
      throw new RoomResponseError(
        response.status,
        String(details.error),
        details,
      );
    throw new Error('Room moderation delivery unavailable');
  }
  return response.body;
}
export function parseRoomStatus(value: unknown): RoomStatus {
  const status = object(value),
    target = object(status.target);
  if (
    typeof status.decisionId !== 'string' ||
    !UUID.test(status.decisionId) ||
    !['remove_message', 'ban_member', 'unban_member'].includes(
      String(status.action),
    ) ||
    !['communityId', 'channelId', 'rumorId'].every(
      (key) =>
        typeof target[key] === 'string' &&
        /^[0-9a-f]{64}$/.test(target[key] as string),
    ) ||
    !Array.isArray(status.deliveries) ||
    status.deliveries.length !== 3
  )
    throw new Error('Malformed room delivery status');
  const deliveries = status.deliveries.map(object);
  if (
    new Set(deliveries.map((delivery) => delivery.target)).size !== 3 ||
    deliveries.some(
      (delivery) =>
        !['divine_relay', 'concord', 'discord'].includes(
          String(delivery.target),
        ) ||
        ![
          'pending',
          'acknowledged',
          'verified',
          'failed',
          'not_applicable',
        ].includes(String(delivery.state)) ||
        !Number.isSafeInteger(delivery.attempts) ||
        !(
          delivery.resultCode === null ||
          (typeof delivery.resultCode === 'string' &&
            /^[a-z_]{1,64}$/.test(delivery.resultCode))
        ),
    )
  )
    throw new Error('Malformed room delivery status');
  return {
    ...(status.discordRestriction === undefined
      ? {}
      : {
          discordRestriction: parseDiscordRestriction(
            status.discordRestriction,
          ),
        }),
    ...(status.auditAvailable === undefined
      ? {}
      : {
          auditAvailable:
            typeof status.auditAvailable === 'boolean'
              ? status.auditAvailable
              : (() => {
                  throw new Error('Invalid audit availability');
                })(),
        }),
    ...(status.executionId === undefined
      ? {}
      : {
          executionId: UUID.test(String(status.executionId))
            ? String(status.executionId)
            : (() => {
                throw new Error('Malformed execution ID');
              })(),
        }),
    ...(status.sourceOrder === undefined
      ? {}
      : {
          sourceOrder:
            status.sourceOrder === null
              ? null
              : parseSourceOrder(status.sourceOrder),
        }),
    decisionId: status.decisionId,
    action: status.action as RoomAction,
    target: {
      communityId: String(target.communityId),
      channelId: String(target.channelId),
      rumorId: String(target.rumorId),
    },
    deliveries: deliveries.map((delivery) => ({
      target: delivery.target as RoomStatus['deliveries'][number]['target'],
      state: String(delivery.state),
      attempts: Number(delivery.attempts),
      resultCode: delivery.resultCode as string | null,
    })),
  };
}
export type RoomDecisionInput = {
  orgId: string;
  actionId: string;
  actionName: string;
  itemId: string;
  itemTypeId: string;
  itemTypeName: string;
  caseId?: string;
  priorDecisionId?: string;
  correlationId: string;
  actorId?: string;
  note?: string;
  parameters?: Record<string, unknown>;
};
export function roomExecutionId(input: RoomDecisionInput): string {
  return uuidv5(
    jsonStringify(
      input.correlationId.startsWith('manual-action-run:')
        ? [input.orgId, input.correlationId]
        : [
            input.orgId,
            input.correlationId,
            input.actionId,
            input.itemTypeId,
            input.itemId,
          ],
    ),
    '7d6e67c4-c685-4a34-8d53-dd5ca90f1c43',
  );
}
export async function publishRoomDecision(
  config: ConcordConfig,
  dependencies: {
    fetchHTTP: RoomTransport;
    getActor(id: string, orgId: string): Promise<StaffActor>;
    sourceOrder?: SourceOrder;
  },
  input: RoomDecisionInput,
): Promise<RoomStatus> {
  const action = roomAction(input.actionName);
  if (
    !action ||
    !input.actorId ||
    input.orgId !== config.orgId ||
    !/^(manual-action-run|mrt-decision):.+/.test(input.correlationId) ||
    !['concord_message', 'concord_member'].includes(input.itemTypeName) ||
    !(input.priorDecisionId
      ? input.caseId === undefined &&
        action === 'unban_member' &&
        UUID.test(input.priorDecisionId)
      : UUID.test(input.caseId ?? '')) ||
    !validRoomReason(input.note)
  )
    throw new Error('Room action requires a staff decision and reason');
  const actor = await dependencies.getActor(input.actorId, input.orgId);
  const parameters = input.parameters ?? {};
  validateRoomActionPermission(actor, input.actionName, parameters);
  if (action !== 'remove_message' && !dependencies.sourceOrder)
    throw new Error('Membership intent must be durably registered');
  const executionId = roomExecutionId(input);
  const result = parseRoomStatus(
    await roomRequest(
      config,
      dependencies.fetchHTTP,
      actor,
      'post',
      input.priorDecisionId
        ? `/v1/decisions/${input.priorDecisionId}/reversals`
        : '/v1/decisions',
      {
        ...(input.priorDecisionId ? {} : { caseId: input.caseId }),
        executionId,
        ...(action === 'remove_message'
          ? {}
          : { sourceOrder: parseSourceOrder(dependencies.sourceOrder) }),
        action,
        reason: input.note,
        scope: action === 'remove_message' ? 'message' : 'community',
        discordGuildConfirmed: parameters.discordGuildConfirmed === true,
      },
    ),
  );
  if (result.action !== action)
    throw new Error('Mismatched room decision response');
  return result;
}
