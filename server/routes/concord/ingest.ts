import { type RequestHandler } from 'express';
import { sql } from 'kysely';

import { type Dependencies } from '../../iocContainer/index.js';
import {
  itemSubmissionToItemSubmissionWithTypeIdentifier,
  rawItemSubmissionToItemSubmission,
} from '../../services/itemProcessingService/index.js';
import { hasOrgId } from '../../utils/apiKeyMiddleware.js';
import { toCorrelationId } from '../../utils/correlationIds.js';
import { object, UUID } from './service.js';

export async function receiveRoomCase(
  input: unknown,
  deps: {
    once(caseId: string, effect: () => Promise<void>): Promise<void>;
    store(caseId: string): Promise<void>;
    enqueue(caseId: string): Promise<void>;
  },
) {
  const value = object(input);
  if (
    Object.keys(value).join(',') !== 'caseId' ||
    typeof value.caseId !== 'string' ||
    !UUID.test(value.caseId)
  )
    throw new Error('Invalid case reference');
  const caseId = value.caseId;
  await deps.once(caseId, async () => {
    await deps.store(caseId);
    await deps.enqueue(caseId);
  });
  return { caseId, state: 'queued' };
}

/** Machine route accepts opaque case references, never evidence or enforcement. */
export function roomIngest(
  deps: Dependencies,
  env: NodeJS.ProcessEnv = process.env,
): RequestHandler {
  return async (request, response) => {
    try {
      if (
        !hasOrgId(request) ||
        request.orgId !== env.CONCORD_ORG_ID ||
        !env.CONCORD_QUEUE_ID ||
        !env.CONCORD_MESSAGE_TYPE_ID ||
        !env.CONCORD_MEMBER_TYPE_ID
      )
        throw new Error('Invalid room organization');
      const orgId = request.orgId,
        queueId = env.CONCORD_QUEUE_ID;
      let message: Parameters<
        typeof itemSubmissionToItemSubmissionWithTypeIdentifier
      >[0];
      const result = await receiveRoomCase(request.body, {
        once: async (caseId, effect) => {
          // eslint-disable-next-line no-restricted-syntax -- Kysely uses a managed transaction().execute(callback), not an unmanaged Sequelize transaction.
          await deps.KyselyPg.transaction().execute(async (tx) => {
            await sql`SELECT pg_advisory_xact_lock(hashtextextended(${orgId + ':' + caseId}, 483221))`.execute(
              tx,
            );
            const found =
              await sql`SELECT case_id FROM concord_integration.receipts WHERE org_id = ${orgId} AND case_id = ${caseId}::uuid`.execute(
                tx,
              );
            if (found.rows.length) return;
            await effect();
            await sql`INSERT INTO concord_integration.receipts (org_id, case_id) VALUES (${orgId}, ${caseId}::uuid)`.execute(
              tx,
            );
          });
        },
        store: async (caseId) => {
          const types = await deps.ModerationConfigService.getItemTypes({
            orgId,
          });
          if (
            !types.some(
              (type) =>
                type.id === env.CONCORD_MESSAGE_TYPE_ID &&
                type.name === 'concord_message',
            ) ||
            !types.some(
              (type) =>
                type.id === env.CONCORD_MEMBER_TYPE_ID &&
                type.name === 'concord_member',
            )
          )
            throw new Error('Room item types unavailable');
          const reference = {
            case_id: caseId,
            room: 'Public community report',
          };
          for (const raw of [
            {
              id: caseId,
              typeId: env.CONCORD_MEMBER_TYPE_ID!,
              data: reference,
            },
            {
              id: caseId,
              typeId: env.CONCORD_MESSAGE_TYPE_ID!,
              data: {
                ...reference,
                author: { id: caseId, typeId: env.CONCORD_MEMBER_TYPE_ID! },
              },
            },
          ]) {
            const submission = await rawItemSubmissionToItemSubmission(
              types,
              orgId,
              deps.getItemTypeEventuallyConsistent,
              raw,
            );
            if (submission.error) throw new Error('Invalid room item schema');
            await deps.ItemInvestigationService.insertItem({
              orgId,
              requestId: toCorrelationId({ type: 'submit-report', id: caseId }),
              itemSubmission: {
                ...submission.itemSubmission,
                submissionTime:
                  submission.itemSubmission.submissionTime ?? new Date(),
              },
            });
            message = submission.itemSubmission;
          }
        },
        enqueue: async (caseId) => {
          const queued = await deps.ManualReviewToolService.enqueue(
            {
              orgId,
              createdAt: new Date(),
              enqueueSource: 'REPORT',
              enqueueSourceInfo: { kind: 'REPORT' },
              policyIds: [],
              correlationId: toCorrelationId({
                type: 'submit-report',
                id: caseId,
              }),
              payload: {
                kind: 'DEFAULT',
                item: itemSubmissionToItemSubmissionWithTypeIdentifier(message),
                reportHistory: [{ reportId: caseId, reportedAt: new Date() }],
              },
            },
            queueId,
          );
          if (!queued) throw new Error('Room job not confirmed');
        },
      });
      response.status(202).json(result);
    } catch {
      response.status(503).json({ error: 'room_case_not_queued' });
    }
  };
}
