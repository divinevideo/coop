/** Run inside the source server/worker image with an isolated migrated database.
 * NODE_ENV=production node /acceptance/test-coop-image-runtime.mjs
 * Requires the ordinary backing services configured by the caller. Never use a
 * live database: creates synthetic orgs/users and retains its audit evidence.
 */
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

assert.equal(process.env.NODE_ENV, 'production');
assert.match(process.env.DATABASE_NAME ?? '', /^coop_task2_(upgrade|fresh)$/);
const require = createRequire('/app/package.json');
const { sql } = require('kysely');
const { Pool } = require('pg');
const { default: getBottle } = await import('/app/iocContainer/index.js');
const { default: Settings } =
  await import('/app/services/manualReviewToolService/modules/ManualReviewToolSettings.js');
const { roomActor } = await import('/app/routes/concord/authorization.js');
const { roomExecutionId } = await import('/app/routes/concord/service.js');
const {
  beginManualRoomOperation,
  claimManualRoomOperation,
  retirePreparedManualRoomOperation,
  getManualRoomOperation,
} = await import('/app/routes/concord/manualRoomOperations.js');
const { deliverManualRoomOperation } =
  await import('/app/routes/concord/manualRoomDelivery.js');
const { deliverMrtRemoval } =
  await import('/app/routes/concord/roomRemovalDelivery.js');
const { prepareMemberIntent, registerMemberIntents, deliverMemberIntent } =
  await import('/app/routes/concord/memberIntents.js');
const {
  stopRoomAutomation,
  closeRoomExecution,
  roomJobQueueComplete,
  getRoomExecutionDisposition,
} = await import('/app/routes/concord/roomDispositions.js');
const { ActionPublisher } = await import('/app/rule_engine/ActionPublisher.js');
const { ActionType } =
  await import('/app/services/moderationConfigService/index.js');
const { default: QueueOperations, getOrCreateBullQueue } =
  await import('/app/services/manualReviewToolService/modules/QueueOperations.js');
const { makeKyselyTransactionWithRetry } =
  await import('/app/utils/kyselyTransactionWithRetry.js');
const run = promisify(execFile);
const email = `runtime-${randomUUID()}@example.invalid`;
// The CLI prints its generated API key. Capture, never persist or echo it.
try {
  await run(
    process.execPath,
    [
      '/app/bin/create-org-and-user.js',
      '--name',
      `Synthetic runtime ${randomUUID()}`,
      '--email',
      email,
      '--website',
      `https://${randomUUID()}.example.invalid`,
      '--firstName',
      'Synthetic',
      '--lastName',
      'Admin',
      '--password',
      randomUUID(),
    ],
    { maxBuffer: 1024 * 1024, timeout: 120000 },
  );
} catch (error) {
  throw new Error(`create-org-and-user failed: ${error.stderr ?? error.code}`);
}
const { container: c } = await getBottle();
const db = c.KyselyPg;
let listener;
try {
  const { rows: owners } =
    await sql`SELECT tableowner = current_user AS owned FROM pg_tables WHERE schemaname = 'concord_integration'`.execute(
      db,
    );
  assert.ok(owners.length >= 7);
  assert.ok(owners.every((row) => row.owned));
  const migrations = await db
    .selectFrom('public.SequelizeMeta')
    .select('name')
    .execute();
  assert.equal(migrations.length, 24); // staging seed deliberately excluded in prod
  assert.ok(
    await db
      .selectFrom('public.view_maintenance_metadata')
      .select('table_name')
      .where(
        'table_name',
        '=',
        'manual_review_tool.dim_mrt_decisions_materialized',
      )
      .executeTakeFirst(),
  );
  const user = await db
    .selectFrom('public.users')
    .selectAll()
    .where('email', '=', email)
    .executeTakeFirstOrThrow();
  const orgId = user.org_id;
  const settings = new Settings(db);
  assert.equal(await settings.getRequiresDecisionReason(orgId), false);
  assert.equal(await settings.getRequiresDecisionReasonOnIgnore(orgId), false);
  await settings.updateRequiresDecisionReasonOnIgnore(orgId, true);
  assert.equal(await settings.getRequiresDecisionReason(orgId), false);
  assert.equal(await settings.getRequiresDecisionReasonOnIgnore(orgId), true);
  if (process.env.DATABASE_NAME.endsWith('upgrade')) {
    const before = await db
      .selectFrom('manual_review_tool.manual_review_tool_settings')
      .selectAll()
      .where('org_id', '=', 'synthetic-existing-org')
      .executeTakeFirstOrThrow();
    assert.equal(before.mrt_requires_decision_reason_on_action, true);
    assert.equal(before.mrt_requires_decision_reason_on_ignore, false);
    assert.equal(before.requires_policy_for_decisions, true);
    assert.equal(before.hide_skip_button_for_non_admins, true);
    assert.equal(before.preview_jobs_view_enabled, true);
    assert.equal(before.ignore_callback_url, 'https://example.invalid/ignore');
    await settings.upsertDefaultSettings({ orgId: 'synthetic-existing-org' });
    assert.deepEqual(
      await db
        .selectFrom('manual_review_tool.manual_review_tool_settings')
        .selectAll()
        .where('org_id', '=', 'synthetic-existing-org')
        .executeTakeFirstOrThrow(),
      before,
    );
  }
  // Force an actual database-backed role, then revoke its permission below.
  const role = await db
    .insertInto('public.roles')
    .values({
      org_id: orgId,
      key: 'ADMIN',
      display_name: 'Synthetic runtime admin',
      is_system: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('public.role_permissions')
    .values(
      ['MANUALLY_ACTION_CONTENT', 'EDIT_MRT_QUEUES', 'VIEW_MRT'].map(
        (permission) => ({ role_id: role.id, permission }),
      ),
    )
    .execute();
  await db
    .updateTable('public.users')
    .set({ role_id: role.id })
    .where('id', '=', user.id)
    .execute();
  const loaded = await c.UserAPIDataSource.getGraphQLUserFromId({
    id: user.id,
    orgId,
  });
  assert.deepEqual(loaded.getPermissions().sort(), [
    'EDIT_MRT_QUEUES',
    'MANUALLY_ACTION_CONTENT',
    'VIEW_MRT',
  ]);
  const queue = await c.ManualReviewToolService.createManualReviewQueue({
    name: 'Synthetic runtime queue',
    description: null,
    userIds: [user.id],
    hiddenActionIds: [],
    isAppealsQueue: false,
    invokedBy: { userId: user.id, orgId, permissions: loaded.getPermissions() },
  });
  const target = {
    communityId: 'a'.repeat(64),
    channelId: 'b'.repeat(64),
    rumorId: 'c'.repeat(64),
  };
  const hmacKey = 'ab'.repeat(32);
  const accepted = new Map();
  const sent = new Map();
  const postCounts = new Map();
  const webhooks = [];
  listener = http.createServer(async (req, res) => {
    try {
      let bytes = '';
      for await (const chunk of req) bytes += chunk;
      const body = bytes ? JSON.parse(bytes) : undefined;
      res.setHeader('content-type', 'application/json');
      if (req.url === '/ordinary') {
        webhooks.push(body);
        res.end('{}');
        return;
      }
      const signature = createHmac('sha256', Buffer.from(hmacKey, 'hex'))
        .update(
          JSON.stringify([
            req.method,
            req.url,
            createHash('sha256').update(bytes).digest('hex'),
            req.headers['x-coop-timestamp'],
            req.headers['x-coop-actor'],
          ]),
        )
        .digest('hex');
      assert.equal(req.headers['x-coop-signature'], signature);
      const staff = JSON.parse(
        Buffer.from(req.headers['x-coop-actor'], 'base64').toString(),
      );
      assert.equal(staff.actorId, user.id);
      assert.equal(staff.orgId, orgId);
      if (req.url.startsWith('/v1/cases/')) {
        res.end(
          JSON.stringify({
            caseId: req.url.split('/').at(-1),
            author: 'd'.repeat(64),
            target,
          }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/decisions') {
        const executionId = body.executionId;
        postCounts.set(executionId, (postCounts.get(executionId) ?? 0) + 1);
        const prior = sent.get(executionId);
        if (prior) assert.deepEqual(body, prior);
        sent.set(executionId, body);
        if (!accepted.has(executionId))
          accepted.set(executionId, {
            executionId,
            decisionId: randomUUID(),
            action: body.action,
            target,
            sourceOrder: body.sourceOrder ?? null,
            deliveries: ['divine_relay', 'concord', 'discord'].map(
              (target) => ({
                target,
                state: 'pending',
                attempts: 0,
                resultCode: null,
              }),
            ),
          });
        res.statusCode = 202;
        res.end(JSON.stringify(accepted.get(executionId)));
        return;
      }
      const status = accepted.get(req.url.split('/').at(-1));
      res.statusCode = status ? 200 : 404;
      res.end(JSON.stringify(status ?? { error: 'not_found' }));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${listener.address().port}`;
  const config = {
    origin,
    orgId,
    hmacKey,
    coopOrigin: 'https://coop.example.invalid',
    accessIssuer: 'https://synthetic.cloudflareaccess.com',
    accessAudience: 'synthetic',
    queueId: queue.id,
  };
  const fetchHTTP = async (request) => {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    return {
      ok: response.ok,
      status: response.status,
      body: await response.json(),
    };
  };
  const deps = {
    getActor: (id, orgId) => roomActor(c, config, id, orgId),
    fetchHTTP,
  };
  const request = (actionName) => ({
    orgId,
    actorId: user.id,
    actionId: actionName,
    actionName,
    itemId: 'synthetic-item',
    itemTypeId: 'synthetic-type',
    itemTypeName:
      actionName === 'concord_remove_message'
        ? 'concord_message'
        : 'concord_member',
    caseId: randomUUID(),
    correlationId: `mrt-decision:${randomUUID()}`,
    note: 'Synthetic runtime reason',
    parameters: {},
  });
  const removal = request('concord_remove_message');
  const jobGuid = randomUUID();
  const jobId = `${Buffer.from(jobGuid).toString('base64url')}:${Buffer.from(jobGuid).toString('base64url')}`;
  removal.correlationId = `mrt-decision:${jobId}`;
  const bull = await getOrCreateBullQueue(c.IORedis, {
    orgId,
    queueId: queue.id,
  });
  const ops = new QueueOperations(db, db, c.ModerationConfigService, c.IORedis);
  const queueInput = {
    orgId,
    queueId: queue.id,
    jobId,
    invokerUserId: user.id,
  };
  await bull.add(
    'synthetic-review',
    {
      id: jobId,
      orgId,
      payload: { kind: 'DEFAULT', roomDeliveryRequired: true },
    },
    { jobId: jobGuid },
  );
  await db
    .insertInto('manual_review_tool.manual_review_decisions')
    .values({
      id: jobGuid,
      org_id: orgId,
      queue_id: queue.id,
      reviewer_id: user.id,
      job_payload: {
        id: jobId,
        orgId,
        roomDeliveryRequired: true,
        payload: {
          kind: 'DEFAULT',
          item: {
            itemId: removal.itemId,
            itemTypeIdentifier: { id: removal.itemTypeId },
          },
        },
      },
      decision_components: [
        { type: 'CUSTOM_ACTION', actions: [{ id: removal.actionId }] },
      ],
      related_actions: [],
      decision_reason: removal.note,
    })
    .execute();
  assert.equal(await ops.removeJobAllowingInvokerLock(queueInput), false);
  assert.ok(await bull.getJob(jobGuid));
  const first = await deliverMrtRemoval(db, config, deps, removal);
  assert.equal(first.outcome, 'accepted');
  assert.equal(await ops.removeJobAllowingInvokerLock(queueInput), true);
  assert.equal(await bull.getJob(jobGuid), undefined);
  await ops.close();
  await bull.close();

  assert.equal(
    await roomJobQueueComplete(db, orgId, removal.correlationId, 1),
    true,
  );
  assert.equal(
    await roomJobQueueComplete(db, orgId, removal.correlationId, 2),
    false,
  );
  assert.deepEqual(await deliverMrtRemoval(db, config, deps, removal), first);
  await assert.rejects(
    () =>
      deliverMrtRemoval(db, config, deps, {
        ...removal,
        note: 'Changed reason',
      }),
    /request conflict/,
  );
  const identity = {
    orgId,
    actorId: user.id,
    executionId: roomExecutionId(removal),
    reason: 'Synthetic resolved execution',
  };
  await stopRoomAutomation(db, deps, identity);
  assert.equal(
    (await closeRoomExecution(db, deps, identity)).attentionState,
    'closed',
  );
  const lost = request('concord_remove_message');
  const { correlationId, ...claim } = lost;
  const nonce = randomUUID();
  const begin = { orgId, actorId: user.id, clientNonce: nonce, request: claim };
  const receipt = await beginManualRoomOperation(db, config, deps, begin);
  assert.deepEqual(
    await beginManualRoomOperation(db, config, deps, begin),
    receipt,
  );
  const manual = {
    ...claim,
    correlationId: `manual-action-run:${receipt.operationId}`,
  };
  let lose = true;
  const lostDeps = {
    ...deps,
    fetchHTTP: async (input) => {
      const result = await fetchHTTP(input);
      if (lose && input.method === 'post') {
        lose = false;
        throw new Error('Synthetic lost response after acceptance');
      }
      return result;
    },
  };
  await assert.rejects(
    () => deliverManualRoomOperation(db, config, lostDeps, manual),
    /lost response/,
  );
  assert.equal(
    (
      await getManualRoomOperation(db, deps, {
        orgId,
        actorId: user.id,
        operationId: receipt.operationId,
      })
    ).acceptanceUnknown,
    true,
  );
  const recovered = await deliverManualRoomOperation(db, config, deps, manual);
  assert.equal(recovered.outcome, 'accepted');
  assert.equal(recovered.status.executionId, receipt.executionId);
  assert.equal(sent.has(receipt.executionId), true);
  assert.equal(postCounts.get(receipt.executionId), 1);
  // Lost before acceptance: 404 recovery must resend the exact original body.
  const unsentClaim = request('concord_remove_message');
  delete unsentClaim.correlationId;
  const unsent = await beginManualRoomOperation(db, config, deps, {
    orgId,
    actorId: user.id,
    clientNonce: randomUUID(),
    request: unsentClaim,
  });
  const unsentRequest = {
    ...unsentClaim,
    correlationId: `manual-action-run:${unsent.operationId}`,
  };
  let originalBytes;
  const unsentDeps = {
    ...deps,
    fetchHTTP: async (input) => {
      if (input.method === 'post' && originalBytes === undefined) {
        originalBytes = input.body;
        throw new Error('Synthetic unsent response uncertainty');
      }
      if (input.method === 'post') assert.equal(input.body, originalBytes);
      return fetchHTTP(input);
    },
  };
  await assert.rejects(
    () => deliverManualRoomOperation(db, config, unsentDeps, unsentRequest),
    /response uncertainty/,
  );
  const retried = await deliverManualRoomOperation(
    db,
    config,
    unsentDeps,
    unsentRequest,
  );
  assert.equal(retried.outcome, 'accepted');
  assert.equal(retried.status.executionId, unsent.executionId);
  assert.equal(postCounts.get(unsent.executionId), 1);
  const stoppedClaim = request('concord_remove_message');
  delete stoppedClaim.correlationId;
  const stopped = await beginManualRoomOperation(db, config, deps, {
    orgId,
    actorId: user.id,
    clientNonce: randomUUID(),
    request: stoppedClaim,
  });
  const stopInput = {
    orgId,
    actorId: user.id,
    executionId: stopped.executionId,
    operationId: stopped.operationId,
    reason: 'Synthetic stop before send',
  };
  await stopRoomAutomation(db, deps, stopInput);
  await assert.rejects(
    () => closeRoomExecution(db, deps, stopInput),
    /Unsettled/,
  );
  await retirePreparedManualRoomOperation(db, deps, stopInput);
  assert.equal(
    (await closeRoomExecution(db, deps, stopInput)).attentionState,
    'closed',
  );
  assert.equal(
    (await claimManualRoomOperation(db, deps, stopInput)).kind,
    'blocked',
  );
  await assert.rejects(
    () =>
      deliverManualRoomOperation(db, config, deps, {
        ...stoppedClaim,
        correlationId: `manual-action-run:${stopped.operationId}`,
      }),
    /receipt retired/,
  );
  assert.equal(sent.has(stopped.executionId), false);
  // Membership revision ordering and a stopped late writer on the full schema.
  const member = request('concord_ban_member');
  const prepared = await prepareMemberIntent(config, deps, member);
  await makeKyselyTransactionWithRetry(db)((tx) =>
    registerMemberIntents(tx, [prepared]),
  );
  const memberResult = await deliverMemberIntent(db, config, deps, member);
  assert.equal(memberResult.outcome, 'accepted');
  assert.equal(memberResult.status.sourceOrder.revision, '1');
  const next = request('concord_unban_member');
  const nextPrepared = await prepareMemberIntent(config, deps, next);
  await makeKyselyTransactionWithRetry(db)((tx) =>
    registerMemberIntents(tx, [nextPrepared]),
  );
  const unknownDeps = {
    ...deps,
    fetchHTTP: async (input) => {
      const result = await fetchHTTP(input);
      if (input.method === 'post')
        throw new Error('Synthetic member response lost');
      return result;
    },
  };
  await assert.rejects(
    () => deliverMemberIntent(db, config, unknownDeps, next),
    /response lost/,
  );
  const nextIdentity = {
    orgId,
    actorId: user.id,
    executionId: roomExecutionId(next),
    reason: 'Synthetic uncertain stop',
  };
  await stopRoomAutomation(db, deps, nextIdentity);
  assert.equal(
    (await getRoomExecutionDisposition(db, orgId, nextIdentity.executionId))
      .acceptanceUnknown,
    true,
  );
  await assert.rejects(
    () => closeRoomExecution(db, deps, nextIdentity),
    /Unsettled/,
  );
  assert.equal(
    (await deliverMemberIntent(db, config, deps, next)).outcome,
    'stopped',
  );
  assert.equal(postCounts.get(nextIdentity.executionId), 1);
  await db
    .deleteFrom('public.role_permissions')
    .where('role_id', '=', role.id)
    .where('permission', '=', 'MANUALLY_ACTION_CONTENT')
    .execute();
  await assert.rejects(() => deps.getActor(user.id, orgId), /permission/);
  await db
    .insertInto('public.role_permissions')
    .values({ role_id: role.id, permission: 'MANUALLY_ACTION_CONTENT' })
    .execute();
  await assert.rejects(
    () => deps.getActor(user.id, 'synthetic-other-org'),
    /organization/,
  );
  for (const table of [
    'room_execution_acceptances',
    'room_execution_dispositions',
  ]) {
    for (const statement of [
      `DELETE FROM concord_integration.${table}`,
      `TRUNCATE concord_integration.${table} CASCADE`,
    ])
      await assert.rejects(() => sql.raw(statement).execute(db), /append-only/);
  }
  const moderatorRole = await db
    .insertInto('public.roles')
    .values({
      org_id: orgId,
      key: 'MODERATOR',
      display_name: 'Synthetic moderator',
      is_system: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('public.role_permissions')
    .values(
      ['MANUALLY_ACTION_CONTENT', 'EDIT_MRT_QUEUES', 'VIEW_MRT'].map(
        (permission) => ({
          role_id: moderatorRole.id,
          permission,
        }),
      ),
    )
    .execute();
  await db
    .updateTable('public.users')
    .set({ role: 'MODERATOR', role_id: moderatorRole.id })
    .where('id', '=', user.id)
    .execute();
  await assert.rejects(
    () => stopRoomAutomation(db, deps, identity),
    /administrator/,
  );
  await db
    .updateTable('public.users')
    .set({ role: 'ADMIN', role_id: role.id })
    .where('id', '=', user.id)
    .execute();
  const apiRole = process.env.ACCEPTANCE_API_USER;
  assert.equal(apiRole, 'coop_task2_api');
  await sql
    .raw(`GRANT USAGE ON SCHEMA concord_integration TO ${apiRole}`)
    .execute(db);
  await sql
    .raw(
      `GRANT SELECT ON ALL TABLES IN SCHEMA concord_integration TO ${apiRole}`,
    )
    .execute(db);
  const apiPool = new Pool({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT),
    database: process.env.DATABASE_NAME,
    user: apiRole,
    password: process.env.ACCEPTANCE_API_PASSWORD,
  });
  try {
    assert.ok(
      (
        await apiPool.query(
          'SELECT * FROM concord_integration.room_execution_acceptances',
        )
      ).rows.length > 0,
    );
    await assert.rejects(
      () =>
        apiPool.query(
          'DELETE FROM concord_integration.room_execution_acceptances',
        ),
      /permission denied/,
    );
    await assert.rejects(
      () =>
        apiPool.query(
          'ALTER TABLE concord_integration.room_execution_acceptances DISABLE TRIGGER ALL',
        ),
      /must be owner/,
    );
  } finally {
    await apiPool.end();
  }
  // Ordinary custom-action payload through installed publisher, real signing,
  // real strike storage and a local HTTP consumer. It remains separate from room transport.
  const publisher = new ActionPublisher(
    c.ActionExecutionLogger,
    c.Tracer,
    fetchHTTP,
    c.SigningKeyPairService,
    c.ManualReviewToolService,
    c.NcmecService,
    c.ItemInvestigationService,
    c.UserStrikeService,
    c.getItemTypeEventuallyConsistent,
    c.UserAPIDataSource,
    db,
  );
  const creator = {
    id: 'synthetic-content-author',
    typeId: 'synthetic-user-type',
  };
  await c.UserStrikeService.applyUserStrike(
    orgId,
    creator,
    'synthetic-policy',
    4,
  );
  const expectedStrikes = await c.UserStrikeService.getUserStrikeValue(
    orgId,
    creator,
  );
  assert.equal(expectedStrikes, 4);
  const ordinary = {
    id: 'synthetic-ordinary',
    orgId,
    name: 'Ordinary webhook',
    description: null,
    applyUserStrikes: false,
    penalty: 'NONE',
    actionType: ActionType.CUSTOM_ACTION,
    callbackUrl: origin + '/ordinary',
    callbackUrlHeaders: null,
    callbackUrlBody: null,
    customMrtApiParams: null,
  };
  const published = await publisher.publishActions(
    [
      {
        action: ordinary,
        policies: [],
        matchingRules: undefined,
        ruleEnvironment: undefined,
      },
    ],
    {
      orgId,
      correlationId: `manual-action-run:${randomUUID()}`,
      sync: true,
      actorId: user.id,
      decisionReason: 'Synthetic ordinary reason',
      targetItem: {
        itemId: 'synthetic-content',
        itemType: {
          id: 'synthetic-content-type',
          kind: 'CONTENT',
          name: 'Synthetic content',
        },
        submissionId: randomUUID(),
        data: { text: 'Synthetic content' },
        creator,
      },
    },
  );
  assert.equal(published[0].success, true);
  assert.equal(webhooks.length, 1);
  assert.deepEqual(webhooks[0].creator, creator);
  assert.equal(webhooks[0].userStrikeCount, expectedStrikes);
  assert.equal(webhooks[0].decisionReason, 'Synthetic ordinary reason');
  assert.equal('executionId' in webhooks[0], false);
  console.log(
    `PASS ${process.env.DATABASE_NAME}: compiled runtime CLI/bootstrap, settings, database-backed permissions, signed HTTP room acceptance/lost-response/recovery, exact identities, completion, audited stop/closure/late writers, owner audit protection, ordinary creator/strike webhook`,
  );
} finally {
  if (listener) await new Promise((resolve) => listener.close(resolve));
  await c.closeSharedResourcesForShutdown();
}

// As in the shipped one-shot bootstrap CLI, terminate after explicit cleanup;
// long-lived telemetry libraries can retain background handles.
console.log('PASS runtime resources explicitly closed');
process.exit(0);
