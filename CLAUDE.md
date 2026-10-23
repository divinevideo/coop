# COOP (Content Operations & Oversight Platform)

Divine's moderation review surface. Fork of [roostorg/coop](https://github.com/roostorg/coop).

## Cross-Repo Coordination

Before cross-repository work, read `~/code/divine-context/AGENT_CONTEXT.md` and `~/code/divine-context/PR_REVIEW.md`. The existing relay-manager pipeline and the separate Concord room integration coexist; preserve their distinct item types and delivery contracts.

## Architecture

COOP receives flagged content from Osprey (rules engine) via REST API submission. Human moderators review items in the Manual Review Tool (MRT), then take actions (Ban User, Delete Content, Hide Content, Age Restrict) that fire webhooks to the relay-manager adapter.

```
Osprey verdict (flag_for_review) → COOP REST API → MRT queue
Moderator decision → COOP webhook → adapter → relay-manager RPC
```

## Divine Integration Points

- **Item Type:** `nostr_event` with fields for report metadata + media (VIDEO/IMAGE)
- **Actions:** CUSTOM_ACTION webhooks to adapter service
- **Adapter:** `support-trust-safety/scripts/coop-webhook-adapter.mjs` translates webhooks to relay-manager RPC
- **Bridge import:** `divine/coop-bridge-import.sh` pulls Kind 1984 reports from staging relay

## Concord Room Integration

The separate room pipeline uses `concord_message` and `concord_member` item types, configured by `divine/coop_setup_concord.py`. Authenticated room reports enter through `server/routes/concord/`; staff decisions use durable server-issued operation receipts and ordered delivery. Preserve the original identity through unknown responses and exact retries. Recovery, evidence retention, stop and reversal contracts live in the room service and its tests; broader recovery UI remains separately owned.

## Deployment

The room integration uses fixed upstream Coop 1.0.2 source. `divine/concord-image-artifacts.py` builds and verifies a complete source-bound server, worker, migrator and client image set; the client uses `divine/coop-client-source/Dockerfile`. `.github/workflows/publish-concord-source.yaml` requires reviewed source in main and explicit publication authorization. Local image IDs are not registry deployment digests.

The legacy client-only workflow repackages official upstream assets and does not contain the room UI. Do not deploy the room changes by mixing new source-built components with older application/database inputs. K8s manifests live in `divine-iac-coreconfig/k8s/applications/coop/`; source readiness, registry publication and production activation are separate steps.

## Staging Dependencies

- **PostgreSQL:** shared CNPG cluster in `postgres-clusters` namespace
- **Redis:** shared sentinel cluster in `redis-clusters` namespace
- **ClickHouse:** ClickHouse operator available; needs a ClickHouseInstallation CR
- **ScyllaDB:** not available on cluster; env vars stubbed with dummy values (MRT workflow does not require Scylla on the critical path)

## Local Dev

```bash
docker compose up -d postgres redis clickhouse scylla
docker compose run migrations
# Then run server and client separately or via docker compose
```

## Release Tagging

Use `divine-v<semver>` tags for stable releases only (e.g., `divine-v0.1.0`). The `divine-` prefix avoids collisions with upstream roostorg tags when syncing. Do NOT use plain `v*` tags — those belong to upstream's namespace. Do NOT use pre-release tags (`divine-v0.1.0-rc1`) — use branch builds (`divine/*`) for pre-release testing instead.

Pushing a `divine-v*` tag triggers CI for the Divine client image, producing Docker image tags `<version>` and `<major>.<minor>` (e.g., `0.1.0` and `0.1`). This legacy client-only tagging does not publish the complete source-bound chat image set described above.

## Upstream Sync

Pull from `upstream` (roostorg/coop), push divine-specific changes to `origin` (divinevideo/coop). `gh repo set-default` is configured to target `divinevideo/coop` for PR operations.
