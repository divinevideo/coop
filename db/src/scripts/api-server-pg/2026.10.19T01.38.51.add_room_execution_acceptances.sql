-- Durable completion evidence for MRT message removals. Retain on executable
-- rollback; compatible readers may ignore it, but writers must never reset it.
CREATE TABLE concord_integration.room_execution_acceptances (
  org_id varchar(255) NOT NULL,
  execution_id uuid NOT NULL,
  source_id text NOT NULL CHECK (source_id LIKE 'mrt-decision:%'),
  fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  request_payload jsonb NOT NULL,
  accepted_decision_id uuid NOT NULL,
  accepted_status jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, execution_id),
  CHECK (jsonb_typeof(request_payload) = 'object'),
  CHECK (jsonb_typeof(accepted_status) = 'object'),
  CHECK ((request_payload->>'orgId' = org_id) IS TRUE),
  CHECK ((request_payload->>'correlationId' = source_id) IS TRUE),
  CHECK ((request_payload->>'actionName' = 'concord_remove_message') IS TRUE),
  CHECK ((accepted_status->>'action' = 'remove_message') IS TRUE),
  CHECK ((accepted_status->>'executionId' = execution_id::text) IS TRUE),
  CHECK ((accepted_status->>'decisionId' = accepted_decision_id::text) IS TRUE)
);
CREATE INDEX room_execution_acceptances_source ON concord_integration.room_execution_acceptances(org_id, source_id);
CREATE TRIGGER protect_room_acceptances BEFORE UPDATE OR DELETE ON concord_integration.room_execution_acceptances
  FOR EACH ROW EXECUTE FUNCTION concord_integration.protect_room_disposition();
CREATE TRIGGER protect_room_acceptances_truncate BEFORE TRUNCATE ON concord_integration.room_execution_acceptances
  FOR EACH STATEMENT EXECUTE FUNCTION concord_integration.protect_room_disposition();
