import { type Dependencies } from '../../iocContainer/index.js';
import { roomPermissions, type ConcordConfig } from './service.js';

export async function roomActor(
  dependencies: Pick<
    Dependencies,
    'UserAPIDataSource' | 'ManualReviewToolService'
  >,
  config: ConcordConfig,
  id: string,
  orgId: string,
) {
  if (orgId !== config.orgId)
    throw new Error('Room organization not permitted');
  const actor = await dependencies.UserAPIDataSource.getGraphQLUserFromId({
    id,
    orgId,
  });
  if (!roomPermissions(actor).includes('view'))
    throw new Error('Room permission required');
  const queues =
    await dependencies.ManualReviewToolService.getReviewableQueuesForUser({
      invoker: {
        userId: actor.id,
        orgId: actor.orgId,
        permissions: actor.getPermissions(),
      },
    });
  if (!queues.some((queue) => queue.id === config.queueId))
    throw new Error('Room queue permission required');
  return actor;
}
