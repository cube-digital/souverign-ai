import { useEffect, useState } from "react";
import { Button, Chip } from "../ds";
import { useSession } from "../state/session";
import { ApprovalCard } from "./ApprovalCard";
import { useApproval, useApprovalPublic, useCancel, useLoadAllApprovals } from "./store";

/** Approval cards in a thread: the approver sees the card, everyone else a status chip. */
export function ApprovalSlot({ ids }: { ids: string[] }) {
  return (
    <div className="flex flex-col gap-2">
      {ids.map((id) => (
        <SlotItem key={id} id={id} />
      ))}
    </div>
  );
}

function SlotItem({ id }: { id: string }) {
  const { user } = useSession();
  const full = useApproval(id);
  const pub = useApprovalPublic(id);
  const cancel = useCancel();
  const [failed, setFailed] = useState(false);
  const loadAll = useLoadAllApprovals();
  // After a reload a decided approval is no longer pushed: the approver loads the full record.
  const maybeMine =
    !full && pub && pub.status !== "pending" && pub.approver_name === user.display_name;
  useEffect(() => {
    if (maybeMine) loadAll();
  }, [maybeMine, loadAll]);

  if (full && full.approver_user_id === user.id) return <ApprovalCard approval={full} />;
  const view = pub ?? (full && { ...full });
  if (!view) return null;
  const approverName = "approver_name" in view ? view.approver_name : "";
  const label =
    view.status === "pending"
      ? `Waiting for ${approverName} · ${view.tool}`
      : `${view.tool}: ${view.status}`;
  const canCancel =
    view.status === "pending" &&
    view.requester_user_id === user.id &&
    !("approver_user_id" in view && view.approver_user_id === user.id);
  return (
    <div className="flex items-center gap-2">
      <Chip tone={view.status === "pending" ? "ai" : "neutral"}>{label}</Chip>
      {canCancel && (
        <Button
          size="sm"
          onClick={() => {
            setFailed(false);
            cancel(id).catch(() => setFailed(true));
          }}
        >
          Cancel request
        </Button>
      )}
      {failed && (
        <span role="alert" className="text-[12px] text-danger">
          Could not cancel.
        </span>
      )}
    </div>
  );
}
