import { useGQLRoomScopeStaffQuery } from '@/graphql/generated';
import { gql } from '@apollo/client';
import { Switch } from 'antd';

gql`
  query RoomScopeStaff {
    me {
      id
      role
      approvedByAdmin
      rejectedByAdmin
    }
  }
`;

/** The server independently rechecks role, queue membership and verified mapping. */
export default function DiscordGuildConfirmation({
  value,
  onChange,
  disabled,
}: {
  value: unknown;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const { data } = useGQLRoomScopeStaffQuery();
  const admin =
    data?.me?.role === 'ADMIN' &&
    data.me.approvedByAdmin &&
    !data.me.rejectedByAdmin;
  if (!admin)
    return (
      <p>
        Only an admin can also apply this action to the entire Discord server.
        This decision affects the community only.
      </p>
    );
  return (
    <label className="flex items-center gap-2">
      <Switch
        checked={value === true}
        onChange={(checked) => onChange(checked)}
        disabled={disabled}
        aria-label="Also apply to the entire Discord server"
      />
      Also apply to the entire Discord server. This affects every channel, not
      just this room.
    </label>
  );
}
