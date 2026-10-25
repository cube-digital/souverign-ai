import type { CallInfo, CallMeta } from "@sa/protocol";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "../ds";
import { callApi } from "./api";

export function CallCard({ meta }: { meta: CallMeta }) {
  const navigate = useNavigate();
  const [info, setInfo] = useState<CallInfo | null>(null);

  useEffect(() => {
    let live = true;
    callApi.get(meta.call_id).then(
      (i) => live && setInfo(i),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [meta.call_id]);

  if (!info) return null;
  const ended = info.ended_at !== null || meta.op === "ended";
  const starter = info.participants.find((p) => p.user_id === info.started_by)?.name ?? "Someone";
  const inCall = info.participants.filter((p) => p.in_call).length;
  const minutes = Math.max(1, Math.round((meta.duration_ms ?? 0) / 60_000));
  return (
    <div className="flex items-center gap-3 rounded-md border border-border-soft bg-bg-1 px-3 py-2 text-[13px] text-text-0">
      <span>
        {meta.op === "ended"
          ? `Call ended · ${minutes} min`
          : `${starter} started a call · ${inCall} in call`}
      </span>
      <Button
        size="sm"
        disabled={ended}
        onClick={() => navigate(`/c/${info.chat_id}/call/${info.id}`)}
      >
        Join
      </Button>
    </div>
  );
}
