import { useCallback, useEffect, useRef, useState } from "react";
import { type Rec, type Recording, startRecording } from "./recorder";
import { stopAll } from "./voiceStream";

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Hold to record, release to send, Esc or leaving the button cancels. */
export function PushToTalk({ onSend, disabled }: { onSend(rec: Rec): void; disabled?: boolean }) {
  const [active, setActive] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const rec = useRef<Recording | null>(null);
  const held = useRef(false);
  const gen = useRef(0);
  const sendRef = useRef(onSend);
  sendRef.current = onSend;

  const end = useCallback(() => {
    held.current = false;
    setActive(false);
  }, []);

  const cancel = useCallback(() => {
    gen.current++;
    rec.current?.cancel();
    rec.current = null;
    end();
  }, [end]);

  const release = useCallback(async () => {
    if (!held.current) return;
    const r = rec.current;
    rec.current = null;
    end();
    if (!r) {
      gen.current++; // released before the mic opened: drop the pending start
      return;
    }
    const out = await r.stop();
    if (out) sendRef.current(out);
    else setNote("Too short");
  }, [end]);

  const press = async () => {
    if (disabled || held.current) return;
    held.current = true;
    const mine = ++gen.current;
    setNote(null);
    setElapsed(0);
    setActive(true);
    stopAll();
    try {
      const r = await startRecording({
        onAutoStop: (out) => {
          if (gen.current !== mine) return;
          rec.current = null;
          end();
          if (out) sendRef.current(out);
        },
      });
      if (gen.current !== mine || !held.current) {
        r.cancel();
        return;
      }
      rec.current = r;
    } catch (e) {
      if (gen.current !== mine) return;
      end();
      const name = (e as { name?: string } | null)?.name;
      setNote(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone access is blocked for this site."
          : "Could not start the microphone.",
      );
    }
  };

  useEffect(() => {
    if (!active) return;
    const at = Date.now();
    const tick = setInterval(() => setElapsed(Date.now() - at), 250);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearInterval(tick);
      document.removeEventListener("keydown", onKey);
    };
  }, [active, cancel]);

  useEffect(
    () => () => {
      gen.current++;
      held.current = false;
      rec.current?.cancel();
      rec.current = null;
    },
    [],
  );

  return (
    <div className="relative flex items-center gap-2">
      {/* the hint floats above the button: if it took space, the button would slide away from the pointer and cancel */}
      <button
        type="button"
        aria-label="Hold to talk"
        disabled={disabled}
        onPointerDown={() => void press()}
        onPointerUp={() => void release()}
        onPointerLeave={() => active && cancel()}
        onPointerCancel={() => cancel()}
        className={`flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full border border-ai bg-ai-bg text-ai disabled:cursor-not-allowed disabled:opacity-50 ${active ? "ring-2 ring-ai" : ""}`}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <rect x="9" y="3" width="6" height="12" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
        </svg>
      </button>
      {active && (
        <div className="absolute right-0 bottom-full mb-1 flex items-center gap-2 whitespace-nowrap rounded-md bg-bg-1 px-2 py-1 text-[12px] text-text-1 shadow">
          <span className="h-2 w-2 rounded-full bg-danger" aria-hidden="true" />
          <span>{clock(elapsed)}</span>
          <span className="text-text-3">Release to send · Esc to cancel</span>
        </div>
      )}
      {note && !active && (
        <div
          role="status"
          className="absolute right-0 bottom-full mb-1 whitespace-nowrap text-[12px] text-text-2"
        >
          {note}
        </div>
      )}
    </div>
  );
}
