import type { CallInfo, CallSegment } from "@sa/protocol";
import { useEffect, useRef } from "react";
import { Chip } from "../ds";

export function mmss(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const clock = (t: number) =>
  new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

export function NotetakerPanel({
  info,
  segments,
  hideText = false,
}: {
  info: CallInfo;
  segments: CallSegment[];
  /** the viewer declined: they do not see what was transcribed */
  hideText?: boolean;
}) {
  const nt = info.notetaker;
  const end = useRef<HTMLDivElement>(null);
  const count = segments.length;
  useEffect(() => {
    if (count > 0) end.current?.scrollIntoView?.({ block: "end" });
  }, [count]);
  if (!nt) return null;

  const status =
    nt.status === "active"
      ? `${nt.agent_name} · taking notes · invited by ${nt.invited_by_name}`
      : `${nt.agent_name} · invited by ${nt.invited_by_name}`;
  const consentLine = [
    `${nt.invited_by_name} invited ${clock(nt.invited_at)}`,
    ...info.participants
      .filter((p) => p.user_id !== nt.invited_by && p.consent !== "pending")
      .map((p) => `${p.name} ${p.consent}`),
  ].join(" · ");

  return (
    <section aria-label="Notetaker" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 rounded-md border border-ai-glow bg-ai-bg p-3">
        <div className="flex items-center gap-2 text-[13px] text-text-0">
          <span>{status}</span>
          {nt.status === "active" && <Chip tone="ai">listening</Chip>}
        </div>
        <p className="text-[12px] text-text-2">
          Listens to each person's own audio, so every line has a speaker. No camera, no voice.
        </p>
        {nt.status === "stopped" && nt.stopped_by_name && (
          <p
            role="status"
            className="text-[12px] text-text-1"
          >{`${nt.stopped_by_name} stopped the notes.`}</p>
        )}
        {nt.status === "failed" && (
          <p role="status" className="text-[12px] text-warn-ink">
            {`The notetaker stopped unexpectedly. What it captured is kept for ${nt.invited_by_name}.`}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <h2 className="text-[13px] font-semibold text-text-0">{`What ${nt.agent_name} is capturing`}</h2>
        <p className="text-[12px] text-text-2">
          Everyone in the call sees this. Transcribed on this Mac.
        </p>
        <div
          role="log"
          aria-label="Live capture"
          className="flex max-h-64 flex-col gap-2 overflow-y-auto"
        >
          {hideText && (
            <p className="text-[12px] text-text-2">
              You declined, so the lines are not shown to you.
            </p>
          )}
          {(hideText ? [] : segments).map((s) => (
            <div key={s.id} className="text-[13px]">
              <div className="text-[11px] text-text-2">{`${s.speaker_name} · ${mmss(s.t_ms)}`}</div>
              <div className="text-text-0">{s.text}</div>
            </div>
          ))}
          <div ref={end} />
        </div>
      </div>

      <p className="text-[11px] text-text-2">
        {`Consent: ${consentLine}. Anyone in the call can stop the notes.`}
      </p>
    </section>
  );
}
