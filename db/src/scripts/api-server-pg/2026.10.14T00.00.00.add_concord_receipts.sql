-- Opaque delivery receipts only. No report text, author, or reporter identity.
CREATE SCHEMA IF NOT EXISTS concord_integration;
CREATE TABLE concord_integration.receipts (
  org_id varchar(255) NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  case_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, case_id)
);
