import { type Generated } from 'kysely';

import {
  type RoomDecisionInput,
  type RoomStatus,
  type RoomTransport,
  type StaffActor,
} from './service.js';

export type MemberDeliveryState =
  | 'registered'
  | 'acceptance_unknown'
  | 'accepted'
  | 'superseded'
  | 'reconciliation_required';
export type MemberIntentPg = {
  'concord_integration.member_intent_heads': {
    org_id: string;
    target_key: string;
    revision: string;
    current_execution_id: string | null;
    updated_at: Generated<Date>;
  };
  'concord_integration.member_intents': {
    org_id: string;
    execution_id: string;
    target_key: string;
    revision: string;
    case_id: string;
    source_kind: 'mrt-decision' | 'manual-action-run';
    source_id: string;
    manual_review_decision_id: string | null;
    action: 'ban_member' | 'unban_member';
    actor_id: string;
    fingerprint: string;
    request_payload: RoomDecisionInput;
    delivery_state: MemberDeliveryState;
    accepted_decision_id: string | null;
    accepted_status: RoomStatus | null;
    superseded_by_execution_id: string | null;
    bridge_superseded_by_execution_id: Generated<string | null>;
    recorded_at: Generated<Date>;
    last_attempt_at: Date | null;
  };
  'concord_integration.member_intent_quarantine': {
    org_id: string;
    execution_id: string;
    source_id: string;
    request_payload: RoomDecisionInput;
    accepted_decision_id: Generated<string | null>;
    accepted_status: Generated<RoomStatus | null>;
    recorded_at: Generated<Date>;
  };
};
export type MemberIntentDependencies = {
  fetchHTTP: RoomTransport;
  getActor(id: string, orgId: string): Promise<StaffActor>;
};
export type PreparedMemberIntent = {
  input: RoomDecisionInput;
  targetKey: string;
  executionId: string;
  fingerprint: string;
  action: 'ban_member' | 'unban_member';
};
export type MemberDeliveryOutcome =
  | { outcome: 'accepted'; status: RoomStatus }
  | {
      outcome: 'superseded';
      executionId: string;
      supersededByExecutionId: string | null;
      acceptedDecisionId: string | null;
      acceptanceUnknown: boolean;
    };
