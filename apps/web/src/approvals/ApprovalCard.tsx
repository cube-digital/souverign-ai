import type { Approval } from "@sa/protocol";
import { useEffect, useId, useState } from "react";
import { Button, Card, Chip, Input, Textarea } from "../ds";
import { timeOf } from "../lib/format";
import { useSession } from "../state/session";
import { useApproval, useCancel, useDecide } from "./store";

const HOUR = 3_600_000;

const PRIMARY: Record<string, string> = {
  chat_send: "Approve and post",
  share_answer: "Approve and post",
  email_send: "Approve and send",
  notes_create: "Approve and save",
  ticket_comment: "Approve and comment",
};

/** Time left until `expiresAt`; re-renders every minute above one hour, every second below. */
function useRemaining(expiresAt: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  // biome-ignore lint/correctness/useExhaustiveDependencies: `now` re-arms the next tick
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const left = expiresAt - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => setNow(Date.now()), left > HOUR ? 60_000 : 1000);
    return () => clearTimeout(t);
  }, [expiresAt, active, now]);
  return expiresAt - now;
}

function countdownText(left: number): string {
  if (left <= 0) return "Expired";
  if (left > HOUR) {
    const mins = Math.ceil(left / 60_000);
    return `Expires in ${Math.floor(mins / 60)} h ${mins % 60} min`;
  }
  const secs = Math.ceil(left / 1000);
  return `Expires in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

export function ApprovalCard({
  approval,
  compact = false,
}: {
  approval: Approval;
  compact?: boolean;
}) {
  const { user } = useSession();
  const a = useApproval(approval.id) ?? approval;
  const decide = useDecide();
  const cancel = useCancel();
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [always, setAlways] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alwaysId = useId();

  const pending = a.status === "pending";
  const left = useRemaining(a.expires_at, pending);
  const expired = pending && left <= 0;
  const canAct = pending && !expired && !busy;
  const isApprover = a.approver_user_id === user.id;
  const isRequester = a.requester_user_id === user.id;
  const minuteBucket = Math.max(0, Math.ceil(left / 60_000));

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch {
      setError("That did not go through. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const approve = () => {
    const changed: Record<string, string> = {};
    for (const f of a.preview.fields) {
      const v = edits[f.key];
      if (f.editable && v !== undefined && v !== f.value) changed[f.key] = v;
    }
    void run(() =>
      decide(a.id, {
        decision: "approve",
        ...(Object.keys(changed).length > 0 ? { args: changed } : {}),
        ...(always ? { always: true } : {}),
      }),
    );
  };
  const deny = () => void run(() => decide(a.id, { decision: "deny" }));
  const cancelNow = () => void run(() => cancel(a.id));

  const decider = a.decided_by === user.id ? user.display_name : a.approver_name;
  const stamp = stampText(a, decider);

  return (
    <Card ai role="region" aria-label="Approval" className="flex flex-col gap-2 text-[13px]">
      <div className="flex items-center gap-2">
        <Chip tone="ai">{a.tool}</Chip>
        <span className="font-semibold text-text-0">{`${a.agent_name} wants to: ${a.preview.title}`}</span>
      </div>
      {a.preview.target && <div className="text-text-2">{a.preview.target}</div>}
      <dl className="flex flex-col gap-1.5">
        {a.preview.fields.map((f) =>
          editing && f.editable && pending ? (
            <div key={f.key}>
              {f.multiline ? (
                <Textarea
                  label={f.label}
                  value={edits[f.key] ?? f.value}
                  onChange={(e) => setEdits({ ...edits, [f.key]: e.target.value })}
                  className="w-full"
                />
              ) : (
                <Input
                  label={f.label}
                  value={edits[f.key] ?? f.value}
                  onChange={(e) => setEdits({ ...edits, [f.key]: e.target.value })}
                  className="w-full"
                />
              )}
            </div>
          ) : (
            <div key={f.key}>
              <dt className="text-[12px] text-text-2">{f.label}</dt>
              <dd className={`whitespace-pre-wrap text-text-0 ${compact ? "line-clamp-2" : ""}`}>
                {f.value}
              </dd>
            </div>
          ),
        )}
      </dl>
      {a.tool === "share_answer" && a.preview.sources && a.preview.sources.length > 0 && (
        <div>
          <div className="text-[12px] text-text-2">Sources</div>
          <ul className="list-disc pl-4 text-text-1">
            {a.preview.sources.map((s) => (
              <li key={`${s.source_type}:${s.source_id}`}>{s.title ?? s.source_id}</li>
            ))}
          </ul>
        </div>
      )}
      {pending ? (
        <>
          <div className="flex items-center gap-2 text-[12px] text-text-2">
            <span aria-hidden="true">{countdownText(left)}</span>
            <span role="status" className="sr-only">
              {expired ? "Approval expired" : `Approval expires in ${minuteBucket} min`}
            </span>
          </div>
          {a.always_allowed && (
            <label htmlFor={alwaysId} className="flex items-center gap-2 text-text-1">
              <input
                id={alwaysId}
                type="checkbox"
                checked={always}
                onChange={(e) => setAlways(e.target.checked)}
              />
              {`Always approve ${a.tool} for ${a.agent_name}`}
            </label>
          )}
          {isApprover && (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={!canAct} onClick={approve}>
                {PRIMARY[a.tool] ?? "Approve"}
              </Button>
              {a.preview.fields.some((f) => f.editable) && !editing && (
                <Button disabled={!canAct} onClick={() => setEditing(true)}>
                  Edit first
                </Button>
              )}
              {isRequester ? (
                <Button disabled={!canAct} onClick={cancelNow}>
                  Cancel
                </Button>
              ) : (
                <Button disabled={!canAct} onClick={deny}>
                  Deny
                </Button>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="text-[12px] text-text-1">{stamp}</div>
      )}
      {error && (
        <div role="alert" className="text-[12px] text-danger">
          {error}
        </div>
      )}
      <div className="text-[11px] text-text-3">
        <div>Only you see this card.</div>
        {a.tool === "email_send" && (
          <div>Nothing leaves this Mac: the email is saved to the local outbox.</div>
        )}
      </div>
    </Card>
  );
}

export function stampText(a: Approval, decider: string): string {
  switch (a.status) {
    case "approved":
      return `Approved by ${decider}${a.decided_at ? ` · ${timeOf(a.decided_at)}` : ""}`;
    case "denied":
      return "Declined";
    case "expired":
      return "Expired";
    case "failed":
      return `Failed: ${a.result ?? "unknown error"}`;
    case "canceled":
      return `Canceled by ${decider}`;
    case "executed":
      return `Done: ${a.result ?? "completed"}`;
    default:
      return "";
  }
}
