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
| `coop-setup-org.sh` | Idempotently bootstrap an org's moderation config: the `nostr_event` content type (matching osprey's COOPSink payload, incl. media fields), review queues mirroring relay-manager's category tiers, and routing. Needs an **admin user session** (login email/password), not just the org API key. |
| `coop-bridge-import.sh` | Pull live kind-1984 reports from relay-manager and submit them to COOP for review (demo bridge). |
| `coop-configure-webhooks.sh` | Point COOP CUSTOM_ACTION webhooks at the relay-manager enforcement adapter. |

## Usage

```bash
export COOP_API_URL=https://coop.staging.dvines.org
export COOP_LOGIN_EMAIL=...        # org admin
export COOP_LOGIN_PASSWORD=...
./divine/coop-setup-org.sh
```

`coop-bridge-import.sh` / `coop-configure-webhooks.sh` read additional vars (relay URL,
CF Access creds, COOP API key, and the adapter URL reachable from COOP) — see
each script header.

## Design notes

- The category → queue mapping and the full ReportWatcher → COOP/Osprey migration plan
  live in `support-trust-safety/docs/moderation/coop-osprey-reportwatcher-migration.md`
  (cross-repo coordination doc).
- **Long-term:** this setup should be applied automatically as a post-deploy **Job in
  iac-coreconfig** (like `db-migrate`), with these scripts as the source — so COOP org
  config becomes GitOps-reproducible per environment rather than hand-run.
