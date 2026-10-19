import { type Generated } from 'kysely';

import {
  type RoomAction,
  type RoomDecisionInput,
  type RoomStatus,
  type SourceOrder,
} from './service.js';

export type ManualRoomOperationPhase =
  | 'prepared'
  | 'registered'
  | 'acceptance_unknown'
  | 'accepted'
  | 'refused'
  | 'retired';
export type ManualRoomOperationPg = {
  'concord_integration.room_manual_operations': {
    org_id: string;
    execution_id: string;
    operation_id: string;
    actor_id: string;
    client_nonce: string;
    item_id: string;
    item_type_id: string;
    action: RoomAction;
    case_id: string;
    fingerprint: string;
    request_payload: RoomDecisionInput;
    phase: ManualRoomOperationPhase;
    accepted_decision_id: string | null;
    accepted_status: RoomStatus | null;
    refusal_code: string | null;
    prepared_at: Generated<Date>;
    attempted_at: Date | null;
    updated_at: Generated<Date>;
    retired_at: Date | null;
    retiring_actor: string | null;
    retirement_audit: string | null;
  };
};
export type ManualRoomOperationStatus = {
  operationId: string;
  executionId: string;
  phase: ManualRoomOperationPhase;
  recorded: boolean;
  acceptanceUnknown: boolean;
  acceptedDecisionId: string | null;
  sourceOrder: SourceOrder | null;
  refusalCode: string | null;
  disposition: 'none' | 'needs_attention' | 'closed';
  successorExecutionId: string | null;
  allowedNextActions: ('send' | 'recover' | 'retire' | 'replace')[];
};
