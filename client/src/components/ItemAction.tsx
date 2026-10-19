import {
  namedOperations,
  useGQLBeginItemRoomOperationMutation,
  useGQLBulkActionExecutionMutation,
  useGQLBulkActionsFormDataQuery,
  useGQLRoomOperationActorQuery,
  type GQLActionParameter,
} from '@/graphql/generated';
import { stripTypename } from '@/graphql/inputHelpers';
import Pencil from '@/icons/lni/Education/pencil.svg?react';
import { ItemIdentifier } from '@roostorg/types';
import { Button, Input, Select } from 'antd';
import orderBy from 'lodash/orderBy';
import { useCallback, useMemo, useState } from 'react';
import { type JsonObject } from 'type-fest';

import { type ActionParameterValues } from '@/components/ActionParameterInputs';
import ActionParametersModal, {
  defaultValuesForParameters,
} from '@/components/ActionParametersModal';
import { selectFilterByLabelOption } from '@/webpages/dashboard/components/antDesignUtils';
import CoopButton from '@/webpages/dashboard/components/CoopButton';
import CoopModal from '@/webpages/dashboard/components/CoopModal';
import PolicyDropdown from '@/webpages/dashboard/components/PolicyDropdown';

import ConcordEnforcementStatus from './ConcordEnforcementStatus';
import {
  beginRoomOperation,
  completeRoomOperation,
  prepareRoomOperation,
  rememberRoomReceipt,
} from './roomOperation';

const { Option } = Select;

type EligibleAction = {
  id: string;
  name: string;
  parameters: ReadonlyArray<GQLActionParameter>;
};

type ParamsModalState =
  | { open: false }
  | { open: true; mode: 'create' | 'edit'; actionId: string };

export default function ItemAction(props: {
  itemIdentifier: ItemIdentifier;
  title?: string;
}) {
  const { itemIdentifier, title = 'Take action on this item' } = props;

  const { data: queryData } = useGQLBulkActionsFormDataQuery();
  const { data: roomActor } = useGQLRoomOperationActorQuery();
  const [prepareReceipt] = useGQLBeginItemRoomOperationMutation();
  const [preparing, setPreparing] = useState(false);
  const [bulkAction, { loading }] = useGQLBulkActionExecutionMutation({
    refetchQueries: [
      namedOperations.Query.ItemActionHistory,
      namedOperations.Query.GetRecentDecisions,
    ],
    onCompleted: (data) => {
      const results = data?.bulkExecuteActions?.results ?? [];
      const anyFailed = results.some((r) => r.success === false);
      if (anyFailed) {
        setModalBody(
          'One or more actions failed. The callback URL may have returned an error. If your org requires a policy for decisions, select a policy and try again.',
        );
      } else {
        setModalBody(
          eligibleActions.some(
            (action) =>
              selectedActionIds.includes(action.id) &&
              action.name.startsWith('concord_'),
          )
            ? 'Room request processed. Check Room enforcement for its recorded outcome and verified delivery.'
            : 'Actions submitted successfully.',
        );
      }
      setShowModal(true);
    },
    onError: () => {
      setModalBody('Error submitting actions. Please try again.');
      setShowModal(true);
    },
  });

  const [selectedPolicyIds, setSelectedPolicyIds] = useState<string[]>([]);
  const [selectedActionIds, setSelectedActionIds] = useState<string[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [modalBody, setModalBody] = useState<string>('');
  const [parametersByActionId, setParametersByActionId] = useState<
    Record<string, ActionParameterValues>
  >({});
  const [paramsModal, setParamsModal] = useState<ParamsModalState>({
    open: false,
  });
  const [moderatorNote, setModeratorNote] = useState<string>('');

  const eligibleActions: EligibleAction[] = (queryData?.myOrg?.actions ?? [])
    .filter((it) =>
      it.itemTypes.map((t) => t.id).includes(itemIdentifier.typeId),
    )
    .map((it) => ({
      id: it.id,
      name: it.name,
      parameters: ('parameters' in it ? it.parameters : []) ?? [],
    }));

  const eligibleActionsById = useMemo(
    () => new Map(eligibleActions.map((a) => [a.id, a])),
    [eligibleActions],
  );

  const selectedParameterizedActions = useMemo(
    () =>
      selectedActionIds
        .map((id) => eligibleActionsById.get(id))
        .filter(
          (a): a is EligibleAction => a != null && a.parameters.length > 0,
        ),
    [selectedActionIds, eligibleActionsById],
  );

  const selectOnChange = useCallback(
    (actionIds: string[]) => {
      const previous = new Set(selectedActionIds);
      const added = actionIds.find((id) => !previous.has(id));

      const addedAction = added ? eligibleActionsById.get(added) : undefined;
      if (addedAction && addedAction.parameters.length > 0) {
        // Stage the selection but gate the actual commit behind the modal so
        // a moderator can never publish a parameterized action without
        // filling in required values. Cancel removes the staged id.
        setSelectedActionIds(actionIds);
        setParamsModal({
          open: true,
          mode: 'create',
          actionId: addedAction.id,
        });
        return;
      }

      setSelectedActionIds(actionIds);
      // Drop param payloads for any actions that were just deselected so the
      // submitted input doesn't carry stale values.
      const next = new Set(actionIds);
      setParametersByActionId((prev) => {
        const out: Record<string, ActionParameterValues> = {};
        for (const [id, values] of Object.entries(prev)) {
          if (next.has(id)) out[id] = values;
        }
        return out;
      });
    },
    [selectedActionIds, eligibleActionsById],
  );

  const onParamsModalCancel = useCallback(() => {
    if (paramsModal.open && paramsModal.mode === 'create') {
      setSelectedActionIds((ids) =>
        ids.filter((id) => id !== paramsModal.actionId),
      );
    }
    setParamsModal({ open: false });
  }, [paramsModal]);

  const onParamsModalSave = useCallback(
    (values: ActionParameterValues) => {
      if (!paramsModal.open) return;
      setParametersByActionId((prev) => ({
        ...prev,
        [paramsModal.actionId]: values,
      }));
      setParamsModal({ open: false });
    },
    [paramsModal],
  );

  const selectDropdownRender = useCallback(
    (menu: React.ReactElement) => {
      if (eligibleActions.length === 0) {
        return (
          <div>
            <div className="text-coop-alert-red">No actions available</div>
            {menu}
          </div>
        );
      }
      return menu;
    },
    [eligibleActions.length],
  );

  const policies = queryData?.myOrg?.policies;
  const policiesMemo = useMemo(
    () => (policies ? policies.map((p) => stripTypename(p)) : []),
    [policies],
  );

  const policiesDropdownOnChange = useCallback(
    (policyIds: string | readonly string[]) => {
      if (Array.isArray(policyIds)) {
        setSelectedPolicyIds(policyIds.map((id) => id.toString()));
      } else {
        // NB: This cast is required because of a longstanding typescript
        // issue. See https://github.com/microsoft/TypeScript/issues/17002 for
        // more details.
        const policyId = policyIds satisfies
          | string
          | readonly string[] as string;
        setSelectedPolicyIds([policyId]);
      }
    },
    [],
  );

  const buttonOnClick = useCallback(async () => {
    const roomAction = eligibleActions.find(
      (action) =>
        selectedActionIds.includes(action.id) &&
        action.name.startsWith('concord_'),
    );
    let attempt: ReturnType<typeof beginRoomOperation> | undefined;
    if (roomAction) {
      if (!moderatorNote.trim() || moderatorNote.trim().length > 2048) {
        setModalBody('Enter a room reason between 1 and 2048 characters.');
        setShowModal(true);
        return;
      }
      setPreparing(true);
      try {
        if (!roomActor?.me?.id || !roomActor.myOrg?.id)
          throw new Error('Room session unavailable.');
        if (selectedActionIds.length !== 1)
          throw new Error('Select one room action.');
        const claim = {
          actionId: roomAction.id,
          itemId: itemIdentifier.id,
          itemTypeId: itemIdentifier.typeId,
          note: moderatorNote.trim(),
          parameters: (parametersByActionId[roomAction.id] ?? {}) as JsonObject,
        };
        const pending = await prepareRoomOperation(
          itemIdentifier,
          {
            actorId: roomActor.me.id,
            orgId: roomActor.myOrg.id,
          },
          claim,
        );
        let operationId = pending.operationId;
        if ('clientNonce' in pending) {
          const response = await prepareReceipt({
            context: { roomOperationAttempt: true },
            variables: {
              input: {
                clientNonce: pending.clientNonce,
                ...claim,
              },
            },
          });
          const status = response.data?.beginRoomOperation;
          if (response.errors?.length || !status)
            throw new Error('Room preparation response unavailable.');
          operationId = status.operationId;
          rememberRoomReceipt(itemIdentifier, pending.clientNonce, operationId);
          if (status.acceptedDecisionId && !status.acceptanceUnknown) {
            completeRoomOperation(itemIdentifier, operationId);
            setModalBody(
              'This room request was already recorded. Check Room enforcement for verified delivery.',
            );
            setShowModal(true);
            return;
          }
          if (
            status.phase === 'retired' ||
            status.phase === 'refused' ||
            status.refusalCode ||
            status.successorExecutionId ||
            status.disposition !== 'none'
          ) {
            setModalBody(
              `This room request cannot be sent (state: ${status.phase}; disposition: ${status.disposition}). Check Room enforcement or ask your moderation lead to reconcile it.`,
            );
            setShowModal(true);
            return;
          }
        }
        if (!operationId) throw new Error('Room receipt unavailable.');
        attempt = beginRoomOperation(itemIdentifier, operationId);
      } catch {
        setModalBody(
          'Could not prepare this room request. No delivery was started by this attempt. Re-enter the original action, reason and parameters in the original session and retry; changed inputs cannot replace the saved request.',
        );
        setShowModal(true);
        return;
      } finally {
        setPreparing(false);
      }
    }
    return bulkAction({
      // A hidden transport retry would invalidate first-attempt rejection certainty.
      context: { roomOperationAttempt: Boolean(attempt) },
      onError: (error) => {
        if (
          attempt &&
          error.graphQLErrors.some(
            (entry) => entry.extensions?.roomAttemptOutcome === 'NOT_RECORDED',
          )
        ) {
          setModalBody(
            'This delivery attempt was not recorded. The original room request is still saved. Retry the original action and reason, or ask your moderation lead to reconcile it.',
          );
        } else if (attempt) {
          setModalBody(
            'Acceptance is unknown. The original room decision may still execute. Retry the original action and reason, or ask your moderation lead to reconcile it. Changing actions does not cancel it.',
          );
        } else {
          setModalBody('Error submitting actions. Please try again.');
        }
        setShowModal(true);
      },
      variables: {
        input: {
          operationId: attempt?.operationId,
          itemTypeId: itemIdentifier.typeId,
          actionIds: selectedActionIds,
          itemIds: [itemIdentifier.id],
          policyIds: selectedPolicyIds,
          // Drop empty per-action entries so the input doesn't carry
          // meaningless `{}` payloads. GQL `JSONObject` constrains values
          // to `JsonValue`; our per-action map's inner values are
          // `unknown` because each parameter type produces a different
          // concrete value. They're all JSON-serializable in practice
          // (string, number, boolean, string[]) and the server
          // re-validates. Cast through unknown to satisfy the input type.
          parameters:
            Object.keys(parametersByActionId).length > 0
              ? (parametersByActionId as unknown as JsonObject)
              : undefined,
          note: moderatorNote.trim() === '' ? undefined : moderatorNote.trim(),
        },
      },
    }).then((response) => {
      const results = response.data?.bulkExecuteActions?.results;
      if (
        attempt &&
        !response.errors?.length &&
        results?.length &&
        results.every((result) => result.success)
      )
        completeRoomOperation(itemIdentifier, attempt.operationId);
      return response;
    });
  }, [
    bulkAction,
    prepareReceipt,
    roomActor,
    eligibleActions,
    itemIdentifier,
    selectedActionIds,
    selectedPolicyIds,
    parametersByActionId,
    moderatorNote,
  ]);

  const modalOnClose = useCallback(() => setShowModal(false), []);

  if (eligibleActions.length === 0) {
    return <ConcordEnforcementStatus itemIdentifier={itemIdentifier} />;
  }

  const activeParamsAction = paramsModal.open
    ? eligibleActionsById.get(paramsModal.actionId)
    : undefined;

  return (
    <div className="flex flex-col">
      <ConcordEnforcementStatus itemIdentifier={itemIdentifier} />
      <div className="flex flex-col items-start mb-2">
        <div className="text-base font-semibold">{title}</div>
      </div>
      <div className="flex flex-row gap-4">
        <div className="flex flex-col items-start">
          <div>
            <Select
              className="w-80"
              mode="multiple"
              maxTagCount={1}
              placeholder="Select action"
              dropdownMatchSelectWidth={false}
              filterOption={selectFilterByLabelOption}
              value={selectedActionIds}
              onChange={selectOnChange}
              dropdownRender={selectDropdownRender}
            >
              {orderBy(eligibleActions, ['name']).map((action) => (
                <Option key={action.id} value={action.id} label={action.name}>
                  {action.name}
                </Option>
              ))}
            </Select>
          </div>
        </div>
        <div className="flex flex-col items-start">
          <div>
            <PolicyDropdown
              className="w-80"
              policies={policiesMemo}
              maxTagCount={1}
              onChange={policiesDropdownOnChange}
              selectedPolicyIds={selectedPolicyIds}
              multiple={
                queryData?.myOrg?.allowMultiplePoliciesPerAction ?? false
              }
            />
          </div>
        </div>
        <CoopButton
          title="Submit Actions"
          size="small"
          onClick={buttonOnClick}
          loading={loading || preparing}
          disabled={
            loading ||
            preparing ||
            selectedActionIds.length === 0 ||
            (selectedActionIds.some((id) =>
              eligibleActionsById.get(id)?.name.startsWith('concord_'),
            ) &&
              !moderatorNote.trim())
          }
        />
      </div>
      {selectedParameterizedActions.length > 0 && (
        <div className="mt-3 flex flex-col gap-1">
          {selectedParameterizedActions.map((action) => (
            <div
              key={action.id}
              className="flex flex-row items-center gap-2 text-sm"
            >
              <span className="text-gray-700">{action.name} details:</span>
              <Button
                type="link"
                size="small"
                icon={<Pencil className="w-3 h-3" />}
                onClick={() =>
                  setParamsModal({
                    open: true,
                    mode: 'edit',
                    actionId: action.id,
                  })
                }
              >
                Edit
              </Button>
            </div>
          ))}
        </div>
      )}
      {selectedActionIds.length > 0 && (
        <div className="mt-4 flex flex-col">
          <label
            htmlFor="item-action-moderator-note"
            className="mb-1 text-sm font-medium text-gray-700"
          >
            Note (optional)
          </label>
          <Input.TextArea
            id="item-action-moderator-note"
            placeholder="Why are you taking this action? Sent to the action's webhook as `actorNote`."
            rows={2}
            maxLength={5000}
            value={moderatorNote}
            onChange={(e) => setModeratorNote(e.target.value)}
          />
        </div>
      )}
      {paramsModal.open && activeParamsAction && (
        <ActionParametersModal
          open
          mode={paramsModal.mode}
          actionName={activeParamsAction.name}
          parameters={activeParamsAction.parameters}
          initialValues={
            parametersByActionId[activeParamsAction.id] ??
            defaultValuesForParameters(activeParamsAction.parameters)
          }
          onCancel={onParamsModalCancel}
          onSave={onParamsModalSave}
        />
      )}
      <CoopModal visible={showModal} onClose={modalOnClose}>
        {modalBody}
      </CoopModal>
    </div>
  );
}
