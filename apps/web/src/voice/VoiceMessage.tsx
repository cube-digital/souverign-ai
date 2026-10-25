import { useEffect, useRef, useState } from "react";

const clock = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A voice bubble. `load` returns the decrypted audio through the existing download path. */
export function VoiceMessage({
  load,
  durationMs,
  transcript,
}: {
  load(): Promise<Blob>;
  durationMs: number;
  transcript?: string | undefined;
}) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [failed, setFailed] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);

  useEffect(
    () => () => {
      audio.current?.pause();
      if (url.current) URL.revokeObjectURL(url.current);
    },
    [],
  );

  const toggle = async () => {
    try {
      if (!audio.current) {
        const blob = await load();
        url.current = URL.createObjectURL(blob);
        const a = new Audio(url.current);
        a.addEventListener("timeupdate", () =>
          setProgress(a.duration > 0 ? a.currentTime / a.duration : 0),
        );
        a.addEventListener("ended", () => {
          setPlaying(false);
          setProgress(0);
        });
        audio.current = a;
      }
      const a = audio.current;
      if (a.paused) {
        await a.play();
        setPlaying(true);
      } else {
        a.pause();
        setPlaying(false);
      }
    } catch {
      setFailed(true);
    }
  };

  return (
    <div className="flex max-w-xs flex-col gap-1">
      <figure
        aria-label="voice message"
        className="m-0 flex items-center gap-2 rounded-lg border border-border-soft bg-bg-1 px-2 py-1.5"
      >
        <button
          type="button"
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => void toggle()}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-bg-3 text-text-0"
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          className="h-1 flex-1 overflow-hidden rounded bg-bg-3"
        >
          <div className="h-full bg-text-2" style={{ width: `${progress * 100}%` }} />
        </div>
        <span className="text-[11px] text-text-2">{clock(durationMs)}</span>
      </figure>
      {failed && <div className="text-[11px] text-danger">Could not play this message.</div>}
      {transcript && (
        <div className="text-[12px] text-text-1">
          <div className="text-[11px] text-text-3">Transcript · on this Mac</div>
          {transcript}
        </div>
      )}
    </div>
  );
}
