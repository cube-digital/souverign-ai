import { describe, expect, it } from "vitest";
import { MessageBody, SegmentIn, ServerEvent, TextMeta } from "../src/index.js";

const file = (voice: unknown) => ({
  type: "file",
  blob_id: "blob_0001",
  name: "voice.webm",
  mime: "audio/webm",
  size: 10,
  key: "AAAA",
  nonce: "BBBB",
  voice,
});

const item = (n: number) => ({ owner: "Sam", text: `task ${n}` });

describe("voice and calls protocol", () => {
  it("voice messages carry a duration of at most 60 s", () => {
    expect(MessageBody.safeParse(file({ duration_ms: 12000 })).success).toBe(true);
    expect(MessageBody.safeParse(file({ duration_ms: 60000 })).success).toBe(true);
    expect(MessageBody.safeParse(file({ duration_ms: 61000 })).success).toBe(false);
    expect(MessageBody.safeParse(file({ duration_ms: 0 })).success).toBe(false);
  });

  it("text meta carries latency, audio and transcript links, call markers and meeting items", () => {
    const ok = TextMeta.safeParse({
      latency: { stt_ms: 300, first_token_ms: 800, first_audio_ms: 1200, total_ms: 1800 },
      audio_id: "msg_00000001",
      transcript_of: "msg_00000002",
      call: { call_id: "call_0001", op: "started", media_key: "AAAA" },
      meeting: { call_id: "call_0001", action_items: [item(1), { ...item(2), due: "Friday" }] },
      call_notes: { call_id: "call_0001", notes_id: "notes_001", state: "pending" },
    });
    expect(ok.success).toBe(true);
    const items31 = Array.from({ length: 31 }, (_, i) => item(i));
    const bad = TextMeta.safeParse({ meeting: { call_id: "call_0001", action_items: items31 } });
    expect(bad.success).toBe(false);
    expect(TextMeta.safeParse({ latency: { stt_ms: -1, total_ms: 1 } }).success).toBe(false);
    expect(
      SegmentIn.safeParse({ speaker: "agent:x", t0_ms: 1, t1_ms: 2, text: "hi" }).success,
    ).toBe(false);
    expect(
      SegmentIn.safeParse({ speaker: "user:abc_1", t0_ms: 1, t1_ms: 2, text: "hi" }).success,
    ).toBe(true);
  });

  it("the server event stream carries call and voice events next to approvals", () => {
    const seg = ServerEvent.safeParse({
      type: "call.segment",
      call_id: "call_0001",
      segment: { id: 1, speaker_user_id: "u1", speaker_name: "Ana", t_ms: 5, text: "hello" },
    });
    expect(seg.success).toBe(true);
    expect(ServerEvent.safeParse({ type: "hello", user_id: "u1" }).success).toBe(true);
    const chunk = ServerEvent.safeParse({
      type: "voice.chunk",
      chat_id: "chat_0001",
      source_id: "msg_00000001",
      seq: 0,
      text: "hi",
      wav_b64: "AAAA",
    });
    expect(chunk.success).toBe(true);
    expect(
      ServerEvent.safeParse({ type: "call.notes", call_id: "call_0001", version: 0, final: false })
        .success,
    ).toBe(false);
  });
});
