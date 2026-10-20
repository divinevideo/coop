import {
  type GQLMutationResolvers,
  type GQLQueryResolvers,
} from '../generated.js';
import { type Context } from '../resolvers.js';
import { unauthenticatedError } from '../utils/errors.js';

export const typeDefs = /* GraphQL */ `
  type RoomSourceOrder {
    version: Int!
    revision: String!
  }
  type RoomOperationStatus {
    operationId: String!
    executionId: ID!
    phase: String!
    recorded: Boolean!
    acceptanceUnknown: Boolean!
    acceptedDecisionId: ID
    sourceOrder: RoomSourceOrder
    refusalCode: String
    disposition: String!
    successorExecutionId: ID
    allowedNextActions: [String!]!
  }
  type RoomExecutionDisposition {
    executionId: ID!
    attentionState: String!
    automationStopped: Boolean!
    acceptanceUnknown: Boolean!
    refusalCode: String
    latestEventId: ID!
  }
  type RoomNeedsAttentionPage {
    items: [RoomExecutionDisposition!]!
    nextCursor: String
  }
  input BeginRoomOperationInput {
    clientNonce: ID!
    actionId: ID!
    itemId: ID!
    itemTypeId: ID!
    note: String!
    parameters: JSONObject
  }
  input ReverseRoomDecisionInput {
    decisionId: ID!
    clientNonce: ID!
    actionId: ID!
    itemTypeId: ID!
    note: String!
    parameters: JSONObject
  }
  type Query {
    roomOperationStatus(operationId: String!): RoomOperationStatus!
    roomNeedsAttention(cursor: String, limit: Int = 50): RoomNeedsAttentionPage!
  }
  type Mutation {
    beginRoomOperation(input: BeginRoomOperationInput!): RoomOperationStatus!
    retireRoomOperation(
      operationId: String!
      reason: String!
    ): RoomOperationStatus!
    stopRoomAutomation(
      executionId: ID!
      manualReviewDecisionId: ID
      reason: String!
    ): RoomExecutionDisposition!
    closeRoomExecution(
      executionId: ID!
      reason: String!
    ): RoomExecutionDisposition!
    reverseRoomDecision(input: ReverseRoomDecisionInput!): RoomOperationStatus!
  }
`;
async function roomSession(context: Context, mutation: boolean) {
  const user = context.getUser();
  if (!user) throw unauthenticatedError('User required.');
  const identity = { orgId: user.orgId, actorId: user.id };
  await context.dataSources.actionAPI.authorizeRoomRequest({
    ...identity,
    mutation,
    token: context.req.get('cf-access-jwt-assertion'),
    origin: context.req.get('origin'),
  });
  return identity;
}

const Query: GQLQueryResolvers = {
  async roomOperationStatus(_, { operationId }, context) {
    return context.dataSources.actionAPI.roomOperationStatus({
      ...(await roomSession(context, false)),
      operationId,
    });
  },
  async roomNeedsAttention(_, { cursor, limit }, context) {
    return context.dataSources.actionAPI.roomNeedsAttention({
      ...(await roomSession(context, false)),
      cursor: cursor ?? undefined,
      limit: limit ?? 50,
    });
  },
};
const Mutation: GQLMutationResolvers = {
  async beginRoomOperation(_, { input }, context) {
    return context.dataSources.actionAPI.beginRoomOperation({
      ...input,
      ...(await roomSession(context, true)),
      parameters: input.parameters ?? undefined,
    });
  },
  async retireRoomOperation(_, input, context) {
    return context.dataSources.actionAPI.retireRoomOperation({
      ...input,
      ...(await roomSession(context, true)),
    });
  },
  async stopRoomAutomation(_, input, context) {
    return context.dataSources.actionAPI.roomDisposition(
      {
        ...input,
        manualReviewDecisionId: input.manualReviewDecisionId ?? undefined,
        ...(await roomSession(context, true)),
      },
      false,
    );
  },
  async closeRoomExecution(_, input, context) {
    return context.dataSources.actionAPI.roomDisposition(
      { ...input, ...(await roomSession(context, true)) },
      true,
    );
  },
  async reverseRoomDecision(_, { input }, context) {
    return context.dataSources.actionAPI.beginRoomOperation(
      {
        ...input,
        itemId: input.decisionId,
        ...(await roomSession(context, true)),
        parameters: input.parameters ?? undefined,
      },
      input.decisionId,
    );
  },
};
export const resolvers = { Query, Mutation };
