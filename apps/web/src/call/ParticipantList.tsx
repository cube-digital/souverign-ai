import type { CallParticipant } from "@sa/protocol";
import { Chip } from "../ds";

const CAPTURE = {
  accepted: { label: "captured", tone: "ok" },
  declined: { label: "not captured", tone: "neutral" },
  pending: { label: "waiting for answer", tone: "warn" },
} as const;

export function ParticipantList({
  participants,
  meId,
  speaking,
  muted,
  showCapture,
}: {
  participants: CallParticipant[];
  meId: string;
  /** user ids that are speaking now */
  speaking: ReadonlySet<string>;
  /** user ids known to be muted */
  muted: ReadonlySet<string>;
  showCapture: boolean;
}) {
  return (
    <ul aria-label="People in the call" className="flex flex-col gap-1">
      {participants
        .filter((p) => p.in_call)
        .map((p) => {
          const cap = CAPTURE[p.consent];
          const state = p.user_id === meId ? "you" : speaking.has(p.user_id) ? "speaking" : null;
          return (
            <li key={p.user_id} className="flex items-center gap-2 text-[13px] text-text-0">
              <span>{state ? `${p.name} · ${state}` : p.name}</span>
              {showCapture && <Chip tone={cap.tone}>{cap.label}</Chip>}
              {muted.has(p.user_id) && <Chip>muted</Chip>}
            </li>
          );
        })}
    </ul>
  );
}
