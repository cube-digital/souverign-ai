import type { ConsentDecision } from "@sa/protocol";
import { useEffect, useRef } from "react";
import { Button, Chip } from "../ds";

export function ConsentBanner({
  inviter,
  notetaker,
  consent,
  busy,
  onAnswer,
}: {
  inviter: string;
  notetaker: string;
  consent: ConsentDecision;
  busy: boolean;
  onAnswer: (d: "accepted" | "declined") => void;
}) {
  const accept = useRef<HTMLButtonElement>(null);
  const change = useRef<HTMLButtonElement>(null);
  const wasPending = useRef(consent === "pending");

  // Focus the first answer when the question appears, and the chip's link after an answer.
  useEffect(() => {
    if (consent === "pending") {
      accept.current?.focus();
      wasPending.current = true;
    } else if (wasPending.current) {
      change.current?.focus();
      wasPending.current = false;
    }
  }, [consent]);

  if (consent === "pending") {
    return (
      <section
        aria-label="Notetaker consent"
        className="flex flex-col gap-2 rounded-md border border-ai-glow bg-ai-bg p-3 text-[13px] text-text-0"
      >
        <p>
          {`${inviter} invited ${notetaker} to take notes. ${notetaker} transcribes only people who accept, on this Mac. Notes go to ${inviter} first and reach the chat only if ${inviter} approves.`}
        </p>
        <div className="flex gap-2">
          <Button
            ref={accept}
            variant="primary"
            disabled={busy}
            onClick={() => onAnswer("accepted")}
          >
            Accept
          </Button>
          <Button disabled={busy} onClick={() => onAnswer("declined")}>
            Decline
          </Button>
        </div>
      </section>
    );
  }
  const captured = consent === "accepted";
  return (
    <div className="flex items-center gap-2 text-[12px] text-text-1">
      <Chip tone={captured ? "ok" : "neutral"}>
        {captured ? "You are captured" : "You are not captured"}
      </Chip>
      <button
        ref={change}
        type="button"
        disabled={busy}
        className="cursor-pointer text-text-2 underline hover:text-text-0"
        onClick={() => onAnswer(captured ? "declined" : "accepted")}
      >
        Change
      </button>
    </div>
  );
}
