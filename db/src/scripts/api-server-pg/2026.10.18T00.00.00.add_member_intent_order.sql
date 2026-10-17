-- Additive migration. After first use retain this ledger and its high-water marks.
CREATE SCHEMA IF NOT EXISTS concord_integration AUTHORIZATION CURRENT_USER;
CREATE TABLE concord_integration.member_intent_heads (
  org_id varchar(255) NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  target_key char(64) NOT NULL CHECK (target_key ~ '^[0-9a-f]{64}$'),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  current_execution_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, target_key)
);
CREATE TABLE concord_integration.member_intents (
  org_id varchar(255) NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL,
  target_key char(64) NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  case_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('mrt-decision', 'manual-action-run')),
  source_id text NOT NULL,
  manual_review_decision_id uuid,
  action text NOT NULL CHECK (action IN ('ban_member', 'unban_member')),
  actor_id text NOT NULL,
  fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  request_payload jsonb NOT NULL,
  delivery_state text NOT NULL CHECK (delivery_state IN ('registered','acceptance_unknown','accepted','superseded','reconciliation_required')),
  accepted_decision_id uuid,
  accepted_status jsonb,
  superseded_by_execution_id uuid,
  bridge_superseded_by_execution_id uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  PRIMARY KEY (org_id, execution_id),
  UNIQUE (org_id, target_key, revision),
  FOREIGN KEY (org_id, target_key) REFERENCES concord_integration.member_intent_heads(org_id, target_key),
  FOREIGN KEY (org_id, superseded_by_execution_id) REFERENCES concord_integration.member_intents(org_id, execution_id)
);
ALTER TABLE concord_integration.member_intent_heads ADD CONSTRAINT member_intent_current_execution_fk FOREIGN KEY (org_id, current_execution_id) REFERENCES concord_integration.member_intents(org_id, execution_id);
CREATE INDEX member_intents_pending ON concord_integration.member_intents(org_id, delivery_state);
-- Original order cannot be inferred for previously recorded, unregistered executions.
CREATE TABLE concord_integration.member_intent_quarantine (
  org_id varchar(255) NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL,
  source_id text NOT NULL,
  request_payload jsonb NOT NULL,
  accepted_decision_id uuid,
  accepted_status jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, execution_id)
);
