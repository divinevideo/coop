import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';

import { type MemberIntentPg } from '../routes/concord/memberIntentTypes.js';
import { RecordedRoomLookupIncomplete } from '../routes/concord/recordedRoomExecution.js';
import {
  closeRoomExecution,
  listRoomNeedsAttention,
  recordPermanentRefusal,
  roomJobQueueComplete,
  stopRoomAutomation,
} from '../routes/concord/roomDispositions.js';
import {
  deliverMrtRemoval,
  recordRoomRemovalAcceptance,
} from '../routes/concord/roomRemovalDelivery.js';
import { roomExecutionId } from '../routes/concord/service.js';
import { jsonStringify } from '../utils/encoding.js';
import { actor, config, input, response } from './memberIntentFixtures.js';

const deps = {
  getActor: async (id: string, orgId: string) => ({ ...actor, id, orgId }),
  fetchHTTP: jest.fn(),
};
async function recordedRemoval(
  pgQuery: Kysely<MemberIntentPg>,
  related = false,
) {
  const id = randomUUID();
  const jobId = `aXRlbQ:${Buffer.from(id).toString('base64url')}`;
  const request = {
    ...input('concord_remove_message'),
    itemTypeName: 'concord_message',
    correlationId: `mrt-decision:${jobId}`,
  };
  await sql`INSERT INTO manual_review_tool.manual_review_decisions
    (id, org_id, job_payload, decision_components, related_actions)
    VALUES (${id}, ${config.orgId}, ${jsonStringify({
      id: jobId,
      orgId: config.orgId,
      roomDeliveryRequired: true,
      payload: {
        item: {
          itemId: related ? 'other-item' : request.itemId,
          itemTypeIdentifier: { id: request.itemTypeId },
        },
      },
    })}::jsonb,
    ARRAY[${jsonStringify({ type: 'CUSTOM_ACTION', actions: related ? [] : [{ id: request.actionId }], policies: [], itemIds: ['not-the-primary-target'], itemTypeId: 'not-the-primary-type' })}::jsonb],
    ARRAY[${jsonStringify({ actionIds: related ? [request.actionId] : [], itemIds: [request.itemId], itemTypeId: request.itemTypeId })}::jsonb])`.execute(
    pgQuery,
  );
  return request;
}

export async function checkRecordedRoomRemoval(
  pgQuery: Kysely<MemberIntentPg>,
  attempted: boolean,
) {
  const request = await recordedRemoval(pgQuery);
  const identity = {
    orgId: config.orgId,
    actorId: actor.id,
    executionId: roomExecutionId(request),
    reason: 'Stop automatic recovery pending investigation',
  };
  if (attempted)
    await expect(
      deliverMrtRemoval(
        pgQuery,
        config,
        {
          ...deps,
          fetchHTTP: async () => {
            throw new Error('Lost first response');
          },
        },
        request,
      ),
    ).rejects.toThrow('Lost first response');
  expect(await stopRoomAutomation(pgQuery, deps, identity)).toMatchObject({
    automationStopped: true,
    attentionState: 'needs_attention',
    acceptanceUnknown: true,
  });
  expect(
    (
      await listRoomNeedsAttention(pgQuery, deps, {
        orgId: config.orgId,
        actorId: actor.id,
        limit: 100,
      })
    ).items,
  ).toContainEqual(
    expect.objectContaining({
      executionId: identity.executionId,
      acceptanceUnknown: true,
    }),
  );
  expect(
    await roomJobQueueComplete(pgQuery, config.orgId, request.correlationId, 1),
  ).toBe(true);
  await expect(closeRoomExecution(pgQuery, deps, identity)).rejects.toThrow(
    'Unsettled',
  );
  expect(await stopRoomAutomation(pgQuery, deps, identity)).toMatchObject({
    acceptanceUnknown: true,
  });
  const fetchHTTP = jest.fn();
  expect(
    await deliverMrtRemoval(pgQuery, config, { ...deps, fetchHTTP }, request),
  ).toMatchObject({
    outcome: 'stopped',
    queueComplete: true,
    acceptanceUnknown: true,
  });
  expect(fetchHTTP).not.toHaveBeenCalled();
  await recordRoomRemovalAcceptance(pgQuery, request, {
    ...response(request, '1'),
    action: 'remove_message',
    sourceOrder: null,
  });
  expect(await closeRoomExecution(pgQuery, deps, identity)).toMatchObject({
    attentionState: 'closed',
    acceptanceUnknown: false,
  });
}

export async function checkRelatedRecordedRoomRemoval(
  pgQuery: Kysely<MemberIntentPg>,
) {
  const request = await recordedRemoval(pgQuery, true);
  const identity = {
    orgId: config.orgId,
    actorId: actor.id,
    executionId: roomExecutionId(request),
    reason: 'Stop related action recovery',
  };
  expect(await stopRoomAutomation(pgQuery, deps, identity)).toMatchObject({
    acceptanceUnknown: true,
    automationStopped: true,
  });
  for (const changed of [
    { orgId: 'other-org' },
    { itemId: 'other-item' },
    { itemTypeId: 'other-type' },
    { actionId: 'other-action' },
    { correlationId: `mrt-decision:${randomUUID()}` },
  ])
    await expect(
      stopRoomAutomation(pgQuery, deps, {
        ...identity,
        ...('orgId' in changed ? { orgId: changed.orgId } : {}),
        executionId: roomExecutionId({ ...request, ...changed }),
      }),
    ).rejects.toThrow('Unknown room execution');
}

export async function checkRecordedRoomLookupBoundary(
  pgQuery: Kysely<MemberIntentPg>,
) {
  for (const change of [
    { orgId: 'other-org' },
    { id: `aXRlbQ:${Buffer.from(randomUUID()).toString('base64url')}` },
    { roomDeliveryRequired: false },
  ]) {
    const request = await recordedRemoval(pgQuery);
    await sql`UPDATE manual_review_tool.manual_review_decisions SET job_payload = job_payload || ${jsonStringify(change)}::jsonb WHERE job_payload->>'id' = ${request.correlationId.slice('mrt-decision:'.length)}`.execute(
      pgQuery,
    );
    await expect(
      stopRoomAutomation(pgQuery, deps, {
        orgId: config.orgId,
        actorId: actor.id,
        executionId: roomExecutionId(request),
        reason: 'Reject inconsistent primary source',
      }),
    ).rejects.toThrow('Unknown room execution');
    expect(
      await roomJobQueueComplete(
        pgQuery,
        config.orgId,
        request.correlationId,
        1,
      ),
    ).toBe(false);
  }
}

export async function checkRecordedRoomLookupBudget(
  pgQuery: Kysely<MemberIntentPg>,
) {
  const rows = Array.from({ length: 1000 }, () => {
    const id = randomUUID();
    return {
      id,
      job_payload: {
        id: `aXRlbQ:${Buffer.from(id).toString('base64url')}`,
        orgId: config.orgId,
        roomDeliveryRequired: true,
      },
    };
  });
  await sql`INSERT INTO manual_review_tool.manual_review_decisions (id, org_id, job_payload, decision_components, related_actions) SELECT id, ${config.orgId}, job_payload, ARRAY[]::jsonb[], ARRAY[]::jsonb[] FROM jsonb_to_recordset(${jsonStringify(rows)}::jsonb) AS r(id uuid, job_payload jsonb)`.execute(
    pgQuery,
  );
  const executionId = randomUUID();
  await expect(
    stopRoomAutomation(pgQuery, deps, {
      orgId: config.orgId,
      actorId: actor.id,
      executionId,
      reason: 'Do not misclassify incomplete search',
    }),
  ).rejects.toBeInstanceOf(RecordedRoomLookupIncomplete);
  expect(
    await pgQuery
      .selectFrom('concord_integration.room_execution_state')
      .selectAll()
      .where('execution_id', '=', executionId)
      .execute(),
  ).toEqual([]);
}

export async function checkRecordedRoomRefusal(
  pgQuery: Kysely<MemberIntentPg>,
) {
  const request = await recordedRemoval(pgQuery);
  const identity = {
    orgId: config.orgId,
    actorId: actor.id,
    executionId: roomExecutionId(request),
    reason: 'Stop until definitive settlement arrives',
  };
  await stopRoomAutomation(pgQuery, deps, identity);
  await recordPermanentRefusal(pgQuery, {
    orgId: config.orgId,
    executionId: identity.executionId,
    refusalCode: 'decision_source_unavailable',
  });
  expect(await closeRoomExecution(pgQuery, deps, identity)).toMatchObject({
    attentionState: 'closed',
    acceptanceUnknown: false,
    refusalCode: 'decision_source_unavailable',
  });
}

export async function checkRecordedRoomTargetBudget(
  pgQuery: Kysely<MemberIntentPg>,
) {
  const request = await recordedRemoval(pgQuery);
  const jobId = request.correlationId.slice('mrt-decision:'.length);
  const actions = Array.from({ length: 10001 }, (_, index) => ({
    id: `synthetic-action-${index}`,
  }));
  await sql`UPDATE manual_review_tool.manual_review_decisions SET decision_components = ARRAY[${jsonStringify({ type: 'CUSTOM_ACTION', actions })}::jsonb] WHERE job_payload->>'id' = ${jobId}`.execute(
    pgQuery,
  );
  const executionId = randomUUID();
  try {
    await expect(
      stopRoomAutomation(pgQuery, deps, {
        orgId: config.orgId,
        actorId: actor.id,
        executionId,
        reason: 'Do not write after target budget exhaustion',
      }),
    ).rejects.toBeInstanceOf(RecordedRoomLookupIncomplete);
    expect(
      await pgQuery
        .selectFrom('concord_integration.room_execution_state')
        .selectAll()
        .where('execution_id', '=', executionId)
        .execute(),
    ).toEqual([]);
  } finally {
    await sql`DELETE FROM manual_review_tool.manual_review_decisions WHERE job_payload->>'id' = ${jobId}`.execute(
      pgQuery,
    );
  }
}
