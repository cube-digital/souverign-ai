import type { VoiceLatency } from "@sa/protocol";
import { useState } from "react";

const sec = (ms: number) => (ms >= 10_000 ? `${Math.round(ms / 1000)}` : (ms / 1000).toFixed(1));

/** The "voice to voice 1.8 s" pill with a per-stage popover. */
export function LatencyHud({
  voiceToVoiceMs,
  latency,
}: {
  voiceToVoiceMs: number;
  latency: VoiceLatency;
}) {
  const [open, setOpen] = useState(false);
  const stages: [string, number | undefined][] = [
    ["transcribe", latency.stt_ms],
    ["first words", latency.first_token_ms],
    ["first audio", latency.first_audio_ms],
    ["total", latency.total_ms],
  ];
  const detail = stages
    .filter((s): s is [string, number] => s[1] !== undefined)
    .map(([label, ms]) => `${label} ${sec(ms)} s`)
    .join(" · ");
  return (
    <span className="relative inline-block">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="cursor-pointer rounded-full border border-border-soft bg-bg-1 px-2 py-0.5 text-[11px] text-text-2 hover:bg-bg-2"
      >
        {`voice to voice ${sec(voiceToVoiceMs)} s`}
      </button>
      {open && (
        <div
          role="status"
          className="absolute bottom-full left-0 z-10 mb-1 whitespace-nowrap rounded-md border border-border-soft bg-bg-2 px-3 py-2 text-[12px] text-text-1"
        >
          {detail}
        </div>
      )}
    </span>
  );
}
