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

Every membership publisher reads that ledger immediately before sending. It records acceptance uncertainty before HTTP and never holds the recording transaction open during a bridge request. Superseded operations complete queue cleanup without being reported as accepted. Default and appeal queues use the same recovery path. A timeout is reconciled with the org-scoped execution lookup; a lookup 404 does not authorize another POST. Superseded uncertain executions may still be looked up to retain their original acceptance ID, but never resend. The additive room status response exposes `memberIntents` with delivery state, source order, acceptance ID, successor and uncertainty; the publisher also returns a typed `roomOutcome` independently of its queue-completion boolean.

Previously recorded executions without a registered revision enter `member_intent_quarantine`. Lookup can retain an accepted legacy execution, without allocating order; missing or inconsistent executions require owner reconciliation. Automatic recovery never infers order from timestamps or allocates a revision for them. The original MRT audit remains unchanged.

Deploy the additive schemas and execution lookup before enabling revision-aware membership writers. Pause membership mutation during cutover, reconcile old recorded operations, and invalidate/drain old manual-operation writers and pending operations before reopening mutation. An old manual operation that was never durably recorded has no reliable original order; it must not be reintroduced as a new operation. New unfenced membership requests must remain rejected by the bridge. Message removal and accepted-decision delivery retry do not allocate membership revisions.

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
