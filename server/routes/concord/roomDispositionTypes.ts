import { type Generated } from 'kysely';

export type RoomExecutionDisposition = {
  executionId: string;
  attentionState: 'none' | 'needs_attention' | 'closed';
  automationStopped: boolean;
  acceptanceUnknown: boolean;
  refusalCode: string | null;
  latestEventId: string;
};
export type RoomDispositionPg = {
  'concord_integration.room_execution_dispositions': {
    id: string;
    org_id: string;
    execution_id: string;
    kind: 'permanent_refusal' | 'automation_stopped' | 'closed';
    refusal_code: string | null;
    actor_id: string | null;
    reason: string | null;
    recorded_at: Generated<Date>;
  };
  'concord_integration.room_execution_state': {
    org_id: string;
    execution_id: string;
    source_id: string;
    attention_state: RoomExecutionDisposition['attentionState'];
    automation_stopped: boolean;
    latest_event_id: string;
    updated_at: Generated<Date>;
  };
};
