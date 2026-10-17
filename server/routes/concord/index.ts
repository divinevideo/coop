import { type RequestHandler } from 'express';
import { type JsonObject } from 'type-fest';

import { type Dependencies } from '../../iocContainer/index.js';
import { createApiKeyMiddleware } from '../../utils/apiKeyMiddleware.js';
import { route } from '../../utils/route-helpers.js';
import { type Controller } from '../index.js';
import { accessVerifier } from './access.js';
import { roomActor } from './authorization.js';
import { roomIngest } from './ingest.js';
import { memberIntentStatuses } from './memberIntentStatus.js';
import {
  loadConcordConfig,
  object,
  parseRoomStatus,
  roomPermissions,
  roomRequest,
  UUID,
} from './service.js';

export function roomHandler(
  deps: Dependencies,
  env: NodeJS.ProcessEnv = process.env,
  testVerifier?: (token: string | undefined, email: string) => Promise<void>,
): RequestHandler {
  let verify = testVerifier;
  return async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      if (!request.isAuthenticated()) throw new Error('Staff session required');
      const session = object(request.user);
      if (typeof session.id !== 'string' || typeof session.orgId !== 'string')
        throw new Error('Staff identity required');
      const typeId = String(request.params.typeId),
        itemId = String(request.params.itemId);
      if (typeId.length > 256 || itemId.length > 512)
        throw new Error('Invalid item');
      const itemType = await deps.getItemTypeEventuallyConsistent({
        orgId: session.orgId,
        typeSelector: { id: typeId },
      });
      if (
        !itemType ||
        !['concord_message', 'concord_member'].includes(itemType.name)
      ) {
        response.json({ applicable: false });
        return;
      }
      const config = loadConcordConfig(env);
      const actor = await roomActor(deps, config, session.id, session.orgId);
      verify ??= accessVerifier(config, deps.fetchHTTP);
      await verify(request.get('cf-access-jwt-assertion'), actor.email);
      if (
        request.method !== 'GET' &&
        request.get('origin') !== config.coopOrigin
      )
        throw new Error('Same-origin staff request required');
      const item = await deps.ItemInvestigationService.getItemByIdentifier({
        orgId: actor.orgId,
        itemIdentifier: { id: itemId, typeId },
        latestSubmissionOnly: true,
      });
      const caseId = item?.latestSubmission?.data.case_id;
      if (typeof caseId !== 'string' || !UUID.test(caseId))
        throw new Error('Room case unavailable');
      const data = object(
        await roomRequest(
          config,
          deps.fetchHTTP,
          actor,
          'get',
          `/v1/cases/${caseId}`,
        ),
      );
      if (
        data.caseId !== caseId ||
        !Array.isArray(data.decisions) ||
        !(
          data.evidenceAvailable === false ||
          (data.evidenceAvailable === true &&
            typeof data.content === 'string' &&
            typeof data.reason === 'string' &&
            typeof data.expiresAt === 'string')
        )
      )
        throw new Error('Malformed room case');
      const decisions = data.decisions.map(parseRoomStatus);
      if (request.method === 'POST') {
        const decisionId = String(request.params.decisionId);
        const target = decisions.find(
          (decision) => decision.decisionId === decisionId,
        );
        if (
          !UUID.test(decisionId) ||
          !target ||
          !roomPermissions(actor).includes(target.action)
        )
          throw new Error('Room retry permission required');
        const retried = parseRoomStatus(
          await roomRequest(
            config,
            deps.fetchHTTP,
            actor,
            'post',
            `/v1/decisions/${decisionId}/retry`,
          ),
        );
        response.status(202).json({ applicable: true, decision: retried });
      } else {
        response.json({
          memberIntents: await memberIntentStatuses(
            deps.KyselyPg,
            actor.orgId,
            caseId,
          ),
          applicable: true,
          caseId,
          evidenceAvailable: data.evidenceAvailable,
          author: data.author,
          content: data.content,
          reason: data.reason,
          expiresAt: data.expiresAt,
          decisions,
          permissions: roomPermissions(actor),
        });
      }
    } catch {
      response
        .status(403)
        .json({ error: 'room_access_or_delivery_unavailable' });
    }
  };
}
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
export default {
  pathPrefix: '/concord',
  routes: [
    route.post<JsonObject, JsonObject>('/cases', (deps) => [
      createApiKeyMiddleware(deps),
      roomIngest(deps),
    ]),
    route.get<JsonObject>('/items/:typeId/:itemId', (deps) =>
      roomHandler(deps),
    ),
    route.post<JsonObject, JsonObject>(
      '/items/:typeId/:itemId/decisions/:decisionId/retry',
      (deps) => roomHandler(deps),
    ),
  ],
} as Controller;
