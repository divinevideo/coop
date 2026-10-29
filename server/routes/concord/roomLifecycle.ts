import { type RequestHandler } from 'express';

import { type Dependencies } from '../../iocContainer/index.js';
import { accessVerifier } from './access.js';
import { roomActor } from './authorization.js';
import {
  loadConcordConfig,
  object,
  parseRoomStatus,
  roomPermissions,
  roomRequest,
  UUID,
  validRoomReason,
} from './service.js';

/** Decision/lifecycle recovery intentionally does not fetch live case evidence. */
export function roomLifecycleHandler(
  deps: Dependencies,
  env: NodeJS.ProcessEnv = process.env,
  testVerifier?: (token: string | undefined, email: string) => Promise<void>,
): RequestHandler {
  return async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      if (!request.isAuthenticated()) throw new Error('Staff session required');
      const session = object(request.user);
      if (typeof session.id !== 'string' || typeof session.orgId !== 'string')
        throw new Error('Staff identity required');
      const config = loadConcordConfig(env);
      const actor = await roomActor(deps, config, session.id, session.orgId);
      await (testVerifier ?? accessVerifier(config, deps.fetchHTTP))(
        request.get('cf-access-jwt-assertion'),
        actor.email,
      );
      const id = String(request.params.id),
        resource = String(request.params.resource),
        operation = String(request.params.operation ?? '');
      if (!UUID.test(id)) throw new Error('Invalid room record');
      if (request.method === 'GET') {
        if (resource !== 'decisions' || operation)
          throw new Error('Invalid status route');
        response.json(
          parseRoomStatus(
            await roomRequest(
              config,
              deps.fetchHTTP,
              actor,
              'get',
              `/v1/decisions/${id}`,
            ),
          ),
        );
        return;
      }
      if (request.get('origin') !== config.coopOrigin)
        throw new Error('Same-origin staff request required');
      const body = object(request.body);
      const allowed =
        resource === 'cases'
          ? ['holds', 'held-evidence']
          : resource === 'holds'
            ? ['release']
            : resource === 'decisions'
              ? [
                  'appeal',
                  'close',
                  'restriction-refresh',
                  'publication-refresh',
                ]
              : [];
      if (!allowed.includes(operation))
        throw new Error('Invalid lifecycle route');
      const capability =
        operation === 'held-evidence'
          ? 'view_held_evidence'
          : 'manage_moderation_records';
      if (!roomPermissions(actor).includes(capability))
        throw new Error('Lifecycle permission required');
      const refresh = operation.endsWith('-refresh');
      const keys = refresh
        ? []
        : operation === 'holds'
          ? ['reason', 'holdUntil']
          : operation === 'appeal'
            ? ['reason', 'state']
            : ['reason'];
      if (
        Object.keys(body).some((key) => !keys.includes(key)) ||
        (!refresh &&
          !validRoomReason(
            typeof body.reason === 'string' ? body.reason : undefined,
          )) ||
        (operation === 'holds' &&
          (typeof body.holdUntil !== 'string' ||
            !Number.isFinite(Date.parse(body.holdUntil)))) ||
        (operation === 'appeal' &&
          !['open', 'closed'].includes(String(body.state)))
      )
        throw new Error('Invalid lifecycle request');
      const result = await roomRequest(
        config,
        deps.fetchHTTP,
        actor,
        'post',
        `/v1/${resource}/${id}/${operation}`,
        body,
      );
      response
        .status(refresh ? 202 : 200)
        .json(refresh ? parseRoomStatus(result) : result);
    } catch {
      response
        .status(403)
        .json({ error: 'room_access_or_delivery_unavailable' });
    }
  };
}
