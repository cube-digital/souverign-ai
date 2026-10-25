// Acceptance test for T10 LatencyHud. Assumed (apps/web/src/voice/LatencyHud.tsx):
//   export function LatencyHud(props: { voiceToVoiceMs: number; latency: VoiceLatency })
// The pill is clickable and opens a popover with the per-stage timings.
import type { VoiceLatency } from "@sa/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { LatencyHud } from "../src/voice/LatencyHud";

afterEach(cleanup);

it("shows 'voice to voice 1.8 s', whole seconds from 10 s, and a popover that leaves out an absent stage", () => {
  const latency: VoiceLatency = { stt_ms: 400, first_token_ms: 900, total_ms: 3200 };
  render(<LatencyHud voiceToVoiceMs={1830} latency={latency} />);
  const pill = screen.getByText("voice to voice 1.8 s");
  fireEvent.click(pill);
  expect(document.body.textContent).toContain("transcribe 0.4 s · first words 0.9 s · total 3.2 s");
  expect(document.body.textContent).not.toContain("first audio");

  cleanup();
  render(<LatencyHud voiceToVoiceMs={12_400} latency={{ ...latency, first_audio_ms: 1300 }} />);
  expect(screen.getByText("voice to voice 12 s")).toBeTruthy();
  fireEvent.click(screen.getByText("voice to voice 12 s"));
  expect(document.body.textContent).toContain(
    "transcribe 0.4 s · first words 0.9 s · first audio 1.3 s · total 3.2 s",
  );
});
