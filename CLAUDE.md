# COOP (Content Operations & Oversight Platform)

Divine's moderation review surface. Fork of [roostorg/coop](https://github.com/roostorg/coop).

## Cross-Repo Coordination

This repo is **Layer 4** (human review surface) in the moderation pipeline. Read the coordination doc at session start:
`~/code/support-trust-safety/docs/moderation/auto-hide-evolution-plan.md`

When you make decisions or discover constraints that affect other layers, update that doc and flag it for the user.

## Architecture

COOP receives flagged content from Osprey (rules engine) via REST API submission. Human moderators review items in the Manual Review Tool (MRT), then take actions (Ban User, Delete Content, Hide Content, Age Restrict) that fire webhooks to the relay-manager adapter.

```
Osprey verdict (flag_for_review) → COOP REST API → MRT queue
Moderator decision → COOP webhook → adapter → relay-manager RPC
```

## Divine Integration Points

- **Item Type:** "User Report" with fields for report metadata + media (VIDEO/IMAGE)
- **Actions:** CUSTOM_ACTION webhooks to adapter service
- **Adapter:** `support-trust-safety/scripts/coop-webhook-adapter.mjs` translates webhooks to relay-manager RPC
- **Bridge import:** `support-trust-safety/scripts/coop-bridge-import.sh` pulls Kind 1984 reports from staging relay

## Deployment

Images build via GitHub Actions to `ghcr.io/divinevideo/coop-server`, `coop-worker`, `coop-client`.
K8s manifests live in `divine-iac-coreconfig/k8s/applications/coop/`.

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

Pushing a `divine-v*` tag triggers CI, which produces Docker image tags `<version>` and `<major>.<minor>` (e.g., `0.1.0` and `0.1`). Pin these in iac-coreconfig kustomization overlays.

## Upstream Sync

Pull from `upstream` (roostorg/coop), push divine-specific changes to `origin` (divinevideo/coop). `gh repo set-default` is configured to target `divinevideo/coop` for PR operations.
