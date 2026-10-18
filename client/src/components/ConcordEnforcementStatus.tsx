import { type ItemIdentifier } from '@roostorg/types';
import { useEffect, useState } from 'react';

type Delivery = {
  target: 'divine_relay' | 'concord' | 'discord';
  state: 'pending' | 'acknowledged' | 'verified' | 'failed' | 'not_applicable';
  attempts: number;
  resultCode: string | null;
};
type Decision = { decisionId: string; action: string; deliveries: Delivery[] };
type CaseStatus = {
  applicable: boolean;
  evidenceAvailable?: boolean;
  author?: string;
  content?: string;
  reason?: string;
  expiresAt?: string;
  decisions?: Decision[];
  memberIntents?: {
    executionId: string;
    deliveryState:
      | 'registered'
      | 'acceptance_unknown'
      | 'accepted'
      | 'superseded'
      | 'reconciliation_required';
    acceptedDecisionId: string | null;
    acceptanceUnknown: boolean;
  }[];
  permissions?: string[];
};
const targetNames = {
  divine_relay: 'Divine relay',
  concord: 'Concord',
  discord: 'Discord',
};
const stateNames = {
  pending: 'Queued',
  acknowledged: 'Acknowledged — verification pending',
  verified: 'Verified',
  failed: 'Failed',
  not_applicable: 'Not applicable',
};

/** Status is independent of Coop's resolved-job state: accepted is not enforced. */
export default function ConcordEnforcementStatus({
  itemIdentifier,
}: {
  itemIdentifier: ItemIdentifier;
}) {
  const [data, setData] = useState<CaseStatus>();
  const [error, setError] = useState(false);
  const [evidenceVisible, setEvidenceVisible] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const path = `/api/v1/concord/items/${encodeURIComponent(itemIdentifier.typeId)}/${encodeURIComponent(itemIdentifier.id)}`;
  useEffect(() => {
    const controller = new AbortController();
    setData(undefined);
    setError(false);
    setEvidenceVisible(false);
    fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unavailable');
        return response.json() as Promise<CaseStatus>;
      })
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [path, refresh]);
  async function retry(decisionId: string) {
    setRetrying(true);
    setError(false);
    try {
      const response = await fetch(
        `${path}/decisions/${encodeURIComponent(decisionId)}/retry`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        },
      );
      if (!response.ok) throw new Error('Unavailable');
      setRefresh((value) => value + 1);
    } catch {
      setError(true);
    } finally {
      setRetrying(false);
    }
  }
  if (data?.applicable === false) return null;
  if (!data && !error) return null;
  return (
    <section
      aria-label="Room enforcement"
      className="my-4 rounded border p-4 text-start"
    >
      <h3 className="font-semibold">Room enforcement</h3>
      <p>
        A resolved report does not mean delivery is complete. Each service is
        verified separately.
      </p>
      {error && (
        <p role="alert">
          Room enforcement status is unavailable. Refresh or escalate to your
          moderation lead.
        </p>
      )}
      <button type="button" onClick={() => setRefresh((value) => value + 1)}>
        Refresh status
      </button>
      {data?.applicable && (
        <>
          {data.evidenceAvailable !== false && (
            <button
              type="button"
              className="ml-4"
              onClick={() => setEvidenceVisible((value) => !value)}
            >
              {evidenceVisible
                ? 'Hide report evidence'
                : 'View report evidence'}
            </button>
          )}
          {data.evidenceAvailable === false && (
            <p>
              Report evidence has expired or is unavailable. Delivery results
              remain below.
            </p>
          )}
          {evidenceVisible && (
            <div className="my-3 whitespace-pre-wrap break-words">
              {data.author && <p>Author public key: {data.author}</p>}
              <p>{data.content}</p>
              <p>Report reason: {data.reason}</p>
              <p>Evidence expires: {data.expiresAt}</p>
            </div>
          )}
          {data.memberIntents?.map((intent) => (
            <p key={intent.executionId} role="status">
              {intent.deliveryState === 'reconciliation_required'
                ? 'Recorded membership decision requires reconciliation. Ask your moderation lead to investigate; do not assume it was cancelled.'
                : intent.deliveryState === 'superseded'
                  ? 'Recorded membership decision was superseded by a newer decision.'
                  : intent.deliveryState === 'accepted'
                    ? 'Membership decision accepted. Check delivery results for enforcement.'
                    : 'Membership decision recorded; acceptance is not confirmed. It may still execute. Changing actions does not cancel it.'}
              {intent.deliveryState === 'superseded' &&
                intent.acceptanceUnknown &&
                ' Acceptance of the earlier request is still unknown; supersession is not proof it never executed.'}
            </p>
          ))}
          {!data.decisions?.length && !data.memberIntents?.length && (
            <p>No room enforcement decision has been submitted.</p>
          )}
          {data.decisions?.map((decision) => (
            <div key={decision.decisionId} className="mt-4">
              <h4>
                {decision.action === 'remove_message'
                  ? 'Remove message'
                  : decision.action === 'ban_member'
                    ? 'Community ban'
                    : 'Remove community ban'}
              </h4>
              <dl>
                {decision.deliveries.map((delivery) => (
                  <div
                    key={delivery.target}
                    className="flex justify-between gap-4 py-1"
                  >
                    <dt>{targetNames[delivery.target]}</dt>
                    <dd>
                      {stateNames[delivery.state]}
                      {delivery.resultCode
                        ? ` (${delivery.resultCode.replaceAll('_', ' ')})`
                        : ''}
                    </dd>
                  </div>
                ))}
              </dl>
              {decision.deliveries.some(
                (delivery) =>
                  delivery.state === 'failed' &&
                  delivery.attempts < 8 &&
                  delivery.resultCode !== 'decision_expired',
              ) &&
                data.permissions?.includes('retry') &&
                data.permissions.includes(decision.action) && (
                  <button
                    type="button"
                    disabled={retrying}
                    onClick={() => void retry(decision.decisionId)}
                  >
                    Retry delivery
                  </button>
                )}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
