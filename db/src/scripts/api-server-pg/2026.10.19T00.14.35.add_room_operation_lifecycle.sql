-- Additive safety ledger. Roll back executables only to compatible writers; retain
-- receipts, tombstones, source revisions and dispositions after first use.
CREATE SCHEMA IF NOT EXISTS concord_integration AUTHORIZATION CURRENT_USER;
CREATE TABLE concord_integration.room_manual_operations (
  org_id varchar(255) NOT NULL,
  execution_id uuid NOT NULL,
  operation_id varchar(128) NOT NULL,
  actor_id text NOT NULL,
  client_nonce uuid NOT NULL,
  item_id text NOT NULL,
  item_type_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('remove_message','ban_member','unban_member')),
  case_id uuid NOT NULL,
  fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  request_payload jsonb NOT NULL,
  phase text NOT NULL CHECK (phase IN ('prepared','registered','acceptance_unknown','accepted','refused','retired')),
  accepted_decision_id uuid,
  accepted_status jsonb,
  refusal_code text,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  attempted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  retiring_actor text,
  retirement_audit text,
  PRIMARY KEY (org_id, execution_id),
  UNIQUE (org_id, operation_id),
  UNIQUE (org_id, actor_id, client_nonce),
  CHECK ((phase = 'retired') = (retired_at IS NOT NULL)),
  CHECK (phase <> 'retired' OR (attempted_at IS NULL AND accepted_decision_id IS NULL))
);
CREATE FUNCTION concord_integration.protect_manual_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Room operation safety records cannot be deleted'; END IF;
  IF (OLD.org_id, OLD.execution_id, OLD.operation_id, OLD.actor_id, OLD.client_nonce,
      OLD.item_id, OLD.item_type_id, OLD.action, OLD.case_id, OLD.fingerprint, OLD.request_payload, OLD.prepared_at)
    IS DISTINCT FROM
     (NEW.org_id, NEW.execution_id, NEW.operation_id, NEW.actor_id, NEW.client_nonce,
      NEW.item_id, NEW.item_type_id, NEW.action, NEW.case_id, NEW.fingerprint, NEW.request_payload, NEW.prepared_at)
    OR (OLD.phase = 'retired' AND NEW IS DISTINCT FROM OLD)
    OR (OLD.attempted_at IS NOT NULL AND NEW.attempted_at IS DISTINCT FROM OLD.attempted_at)
    OR (OLD.accepted_decision_id IS NOT NULL AND NEW.accepted_decision_id IS DISTINCT FROM OLD.accepted_decision_id)
  THEN RAISE EXCEPTION 'Immutable room operation safety record'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER protect_manual_operation BEFORE UPDATE OR DELETE ON concord_integration.room_manual_operations
  FOR EACH ROW EXECUTE FUNCTION concord_integration.protect_manual_operation();
CREATE FUNCTION concord_integration.guard_manual_member_registration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt concord_integration.room_manual_operations%ROWTYPE;
BEGIN
  -- Exactly matches JSON.stringify([orgId, executionId]) used by existing writers.
  PERFORM pg_advisory_xact_lock(hashtextextended(format('[%s,%s]', to_json(NEW.org_id)::text, to_json(NEW.execution_id::text)::text), 0));
  SELECT * INTO receipt FROM concord_integration.room_manual_operations WHERE org_id = NEW.org_id AND execution_id = NEW.execution_id;
  IF receipt.phase = 'retired' THEN RAISE EXCEPTION 'Room operation receipt retired'; END IF;
  IF NEW.source_kind = 'manual-action-run' AND
    (receipt.execution_id IS NULL OR receipt.actor_id <> NEW.actor_id OR receipt.request_payload <> NEW.request_payload OR receipt.phase <> 'prepared')
  THEN RAISE EXCEPTION 'Valid server-owned room operation receipt required'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_manual_member_registration BEFORE INSERT ON concord_integration.member_intents
  FOR EACH ROW EXECUTE FUNCTION concord_integration.guard_manual_member_registration();
