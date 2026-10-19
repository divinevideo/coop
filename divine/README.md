# divine/ — Divine-specific COOP tooling

Divine's customizations and operational tooling for this COOP fork, kept in `divine/`
so they never conflict with the roostorg upstream (same isolation pattern as
`osprey/divine/`).

These scripts configure and feed a COOP **org** for Divine's moderation pipeline
(Osprey → COOP review → relay-manager enforcement). COOP org config (content types,
queues, routing rules, actions) is runtime state in COOP's Postgres, not code — so it
does not travel between environments on its own. These scripts are that missing seed.

## Scripts

| Script | Purpose |
|--------|---------|
| `coop-setup-org.sh` | Idempotently bootstrap an org's moderation config: the `nostr_event` content type and `nostr_user` user type, review queues mirroring relay-manager's category tiers, routing, and (when `WEBHOOK_SECRET` is set) the enforcement CUSTOM_ACTION webhooks pointing at the deployed adapter. Needs an **admin user session** (login email/password), not just the org API key. |
| `test-coop-setup-guards.sh` | Guard tests for `coop-setup-org.sh`'s routing vocabulary, charset, route table, and priority checks. Runs in CI for `divine/` changes; run locally after editing the routing config: `bash divine/test-coop-setup-guards.sh`. No credentials or network needed. |
| `check-profile-field-parity.sh` | Cross-repo drift check: executes osprey's real `coop_profile.py` over every branch and compares the keys it emits to the profile fields `coop-setup-org.sh` declares, on BOTH the `nostr_event` content type and the `nostr_user` account type. Not in CI (no osprey checkout there); run it when either side's field list changes and before provisioning a new org: `divine/check-profile-field-parity.sh ../osprey origin/main`. |
| `coop-bridge-import.sh` | Pull live kind-1984 reports from relay-manager and submit them to COOP for review (demo bridge). |

## Usage

```bash
export COOP_API_URL=https://coop.staging.dvines.org
export COOP_LOGIN_EMAIL=...        # org admin
export COOP_LOGIN_PASSWORD=...
./divine/coop-setup-org.sh
```

`coop-bridge-import.sh` reads additional vars (relay URL, CF Access creds, COOP API
key) — see the script header. The enforcement webhooks are provisioned by
`coop-setup-org.sh` step 6 (gated on `WEBHOOK_SECRET`), not a separate script.
Account actions remain scoped to `nostr_event` by default. Set
`COOP_ACCOUNT_ACTIONS=1` only after the adapter can handle `nostr_user` action
targets; otherwise the Associated User panel can expose buttons that Coop accepts
but the adapter cannot execute.

## Design notes

- The category → queue mapping and the full ReportWatcher → COOP/Osprey migration plan
  live in `support-trust-safety/docs/moderation/coop-osprey-reportwatcher-migration.md`
  (cross-repo coordination doc).
- **Long-term:** this setup should be applied automatically as a post-deploy **Job in
  iac-coreconfig** (like `db-migrate`), with these scripts as the source — so COOP org
  config becomes GitOps-reproducible per environment rather than hand-run.

## Concord room enforcement

`coop-setup-concord.sh` creates separate room types, actions, routing and the
Room Review queue. It leaves platform-wide moderation unchanged. Only explicit
admin confirmation requests an entire Discord-server ban; the default is
community-only. The server independently rechecks current staff authority.

Build all matching artifacts from a clean, committed checkout with
`bash divine/build-concord-images.sh`. This builds the existing source server,
worker and migrator targets, plus `divine/coop-client-source/Dockerfile`. The
existing upstream static-asset repackager does not contain these UI changes.
The script does not push or deploy. Deploy the receipt migration before the
matching API/worker/client, and configure the private enforcement service and
Access policies through GitOps before enabling the POC.

Room decisions require a reason. Manual submissions retain an opaque operation
ID until acceptance is confirmed; retry the original input after an uncertain
response. Queue retries resume the recorded decision and original staff actor;
a changed action or reason is rejected. The three delivery rows remain separate:
queued and acknowledged do not mean verified enforcement.

### Membership source ordering

New staff ban/unban operations resolve the member and community from the authenticated bridge case response before recording intent. Coop stores a hashed org/community/member scope, an immutable request and actor, and a durable bigint revision. MRT records the revision in the same PostgreSQL transaction as the original review decision; manual operations use their persistent operation ID and the same ledger transaction. Repeated operations keep the original revision and reject changed payloads. Submissions with multiple membership actions for one target fail before committing.

Every membership publisher reads that ledger immediately before sending. It records acceptance uncertainty before HTTP and never holds the recording transaction open during a bridge request. Superseded operations complete queue cleanup without being reported as accepted. Default and appeal queues use the same recovery path. A timeout is reconciled with the org-scoped execution lookup. A lookup 404 does not prove the first request cannot still commit: after rechecking the latest local target head, recovery may resend only the exact original execution, actor, payload and revision. The bridge's per-execution fingerprint and revision fence make that retry idempotent even if the first request later commits. No new order is allocated and uncertainty remains until a validated response. Superseded uncertain executions may still be looked up to retain their original acceptance ID, but never resend. A registered execution requires its exact non-null source revision in any accepted response; a legacy/null or mismatched order requires reconciliation. The additive room status response exposes `memberIntents` with delivery state, source order, acceptance ID, successor and uncertainty; the publisher also returns a typed `roomOutcome` independently of its queue-completion boolean.

Previously recorded executions without a registered revision enter `member_intent_quarantine`. Lookup can retain an accepted legacy execution, without allocating order; missing or inconsistent executions require owner reconciliation. Automatic recovery never infers order from timestamps or allocates a revision for them. The original MRT audit remains unchanged.

Deploy the additive schemas and execution lookup before enabling revision-aware membership writers. Pause membership mutation during cutover, reconcile old recorded operations, and invalidate/drain old manual-operation writers and pending operations before reopening mutation. An old manual operation that was never durably recorded has no reliable original order; it must not be reintroduced as a new operation. New unfenced membership requests must remain rejected by the bridge. Message removal and accepted-decision delivery retry do not allocate membership revisions.

Source-ordered clients use a new session-storage namespace and `source-order-v1_<action>_<UUID>` operation token. The token remains opaque and is part of the hashed execution identity, so it cannot collide with a pre-cutover bare-UUID execution. Its action tag must match the selected room action: a pending removal token cannot allocate a membership revision if the user switches to ban or unban. The client still pins the original token until confirmed acceptance rather than silently minting a second operation after uncertainty. The server refuses to allocate an unseen bare-UUID membership operation; an already registered execution can still resume its existing revision and immutable payload. Refreshing an old client does not relabel its old stored operation: that key is retained for reconciliation but is not reused by the new form. A new submission is a new explicit staff decision. Deploy matching server and client code before reopening mutation; an older server rejects the new token rather than silently accepting it.

Rollback and restore must pause membership writes and recovery. Before any revisioned data exists, application rollback can leave the additive tables in place; only a separately verified empty ledger permits schema removal. Once a revision exists, retain both services' ledgers, counters, execution identities and bridge fence together. Never resume an old unfenced writer, lower a counter, remove source order, or restore one service's counter independently. Generic database clean/drop tooling is not a safe rollback or restore procedure for this feature. Use a compatible build or roll forward, verify retained high-water marks against the bridge, then reopen mutation. These tables intentionally have no destructive down migration.

The fence suppresses local stale recovery after a newer decision is recorded and rejects a delayed older request once the bridge knows the newer revision. A bridge cannot observe a newer decision that exists only in Coop; the local preflight cannot recall an already in-flight request.

Run the targeted tests against a dedicated loopback PostgreSQL container (the test creates and removes a unique database):

```bash
cd server
MEMBER_INTENT_TEST_DATABASE_URL=postgres://postgres:<local-test-password>@127.0.0.1:<local-test-port>/postgres npm run test:integ -- --runInBand --coverage=false memberIntents.integ.test.ts
npm run test:prepush -- --runInBand --coverage=false concord ActionApi.test.ts ActionPublisher.room.test.ts recordedRoomRecovery
npm run typecheck
npm run lint
```

CI runs both PostgreSQL ordering suites explicitly after the normal database suite, using the existing isolated compose test service with `NODE_ENV=test` and `MEMBER_INTENT_TEST_COMPOSE=1`. The shared test helper rejects any other remote host or an unguarded compose connection. Each suite creates and drops only its own uniquely named database; it never resets the existing CI database.


### Manual room operation recovery contract

One operation identifies one immutable staff decision. The GraphQL error extension
`roomAttemptOutcome: NOT_RECORDED` describes only the current request: it failed
before this attempt could register or publish intent. It is not a statement about
an earlier request using the same identity. Clients may release an operation only
when that response belongs to its first attempt and no retry has begun. Persist
attempt history before HTTP; reloads, browser-held identities, transport failures,
registration failures and later validation failures retain the original identity.
A successful retry must use the original action, reason and parameters.

Membership status distinguishes recorded, acceptance unknown, accepted, superseded
and reconciliation required. Accepted does not mean enforced; superseded does not
prove an earlier request never executed. A new remove-message decision does not
cancel a pending membership decision. Lookup 404 recovery retains execution,
payload, actor and original revision, with a fresh target-head check and bridge
fencing; it does not create a newer decision.

The explicit replacement interaction, audited terminal refusal/remediation outcome
and hands-on acceptance remain owner review gates under Coop #24. This recovery
change does not introduce an archive endpoint or claim unknown acceptance cancelled.

### Durable room operation API (owner UI integration)

Manual room actions now begin with `beginRoomOperation(input)` using a UUID
`clientNonce`, the selected `actionId`, `itemId`, `itemTypeId`, a nonblank `note`
(maximum 2048 characters), and validated `parameters`. Actor, organization,
queue permission and action configuration come from the authenticated server
session. The response supplies `operationId` (`source-order-v2_<action>_<uuid>`)
and immutable `executionId`. Pass that operation ID to `bulkExecuteActions`.
Repeat begin with the same nonce and exact claim to recover the same receipt;
changing its actor-bound request conflicts. Unseen old browser IDs cannot
register or send new work. Accepted legacy operations retain lookup recovery.

`roomOperationStatus(operationId)` works after evidence expiry. It returns
`phase`, `recorded`, `acceptanceUnknown`, `acceptedDecisionId`, `sourceOrder`,
`refusalCode`, `disposition`, `successorExecutionId` and `allowedNextActions`;
it contains no evidence or staff reason. `retireRoomOperation(operationId,
reason)` can retire only an unregistered, unattempted receipt. Recorded or
uncertain execution conflicts; retirement never recalls already-sent HTTP.
The existing form releases only its matching local receipt when the server
confirms retirement, no registration or unknown acceptance, and permits
`replace`. This neither closes durable attention nor reports enforcement success.
Preparation errors and delivery refusals alone do not release a receipt.
An exact recovery after lookup 404 keeps the original execution, payload and
source revision, rechecks the latest member head, and never resets delivery.

`roomNeedsAttention(cursor, limit)` reads committed primary-database attention
independently of Redis (limit 1–100). ADMIN `stopRoomAutomation(executionId,
reason)` preserves unknown acceptance and visibility. ADMIN
`closeRoomExecution(executionId, reason)` refuses unsettled acceptance and
records separate audit; archive is not enforcement success. A matching typed
`decision_source_unavailable` refusal is durable before queue completion;
generic authentication, configuration, timeout and transport failures are not
classified as permanent. Publisher `queueComplete` is separate from `success`.

`reverseRoomDecision(input)` takes `decisionId`, a new `clientNonce`, the configured
unban `actionId`/room `itemTypeId`, `note` and parameters. The backend obtains the
prior ban's authenticated target, issues a new receipt and source revision, and
posts a new reversal even after the original case has expired. It never recreates
evidence or reopens old delivery Retry. Existing fingerprints are unchanged.
Recover an uncertain reversal by calling `reverseRoomDecision` again with the
same nonce and exact input; do not pass its receipt to `bulkExecuteActions`.
The generic `send`/`recover` status affordances do not change this entry point.
Decision status preserves `discordRestriction` (state, observation time, code)
and `auditAvailable`; a community unban does not imply a Discord guild unban.

Decision metadata is available through GET `/api/v1/concord/decisions/:id`.
POST lifecycle routes mirror `/api/v1/concord/cases/:id/holds`,
`/api/v1/concord/cases/:id/held-evidence`, `/api/v1/concord/holds/:id/release`,
and `/api/v1/concord/decisions/:id/{appeal,close,restriction-refresh,publication-refresh}`.
They enforce current queue/org/session/Access and same-origin checks. ADMIN-only
capabilities separate lifecycle management from audited held-evidence access.
Refresh returns 202/current status and schedules upstream operator work; Coop
never settles publication proof. Ordinary case reads retain expiry behavior.

All new GraphQL room operations also verify the Access assertion and same origin
for mutations. Basic manual actions use server begin and preserve receipt identity on retry.
The assigned UI owner, mbradley (#24), retains broader recovery/retirement and
truthful attention/supersession/restriction displays.
The existing first-attempt and late-A-success/B-pending identity cleanup
regressions remain required. Backend delivery does not complete that UI work.

MRT message removals append exact-execution, request-bound Bridge acceptance to
`room_execution_acceptances` before queue cleanup. Retries reuse that immutable
acceptance even after transient evidence disappears; missing or mismatched
responses never complete a queue job. Stopped, durably retired unsent receipts
can be administratively closed without removing their retirement fence.

Deploy the additive lifecycle and `2026.10.19T01.38.51.add_room_execution_acceptances.sql` migrations with compatible API/worker/client
writers after draining old writers. Preserve receipts, retirement records,
dispositions, accepted-removal facts and source heads on rollback. Never resume old unfenced writers.
Audit retention configuration, owner UI acceptance, paired Bridge validation,
artifact publication and live rollout remain separate release gates.
