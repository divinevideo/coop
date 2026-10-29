import { gql } from '@apollo/client';

gql`
  query RoomOperationActor {
    me {
      id
    }
    myOrg {
      id
    }
  }
  mutation BeginItemRoomOperation($input: BeginRoomOperationInput!) {
    beginRoomOperation(input: $input) {
      operationId
      executionId
      phase
      recorded
      acceptanceUnknown
      acceptedDecisionId
      refusalCode
      disposition
      successorExecutionId
      allowedNextActions
    }
  }
`;
