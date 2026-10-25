import type { ChatMessage } from "@sa/client";
import type { MessageBody } from "@sa/protocol";

type FileBody = Extract<MessageBody, { type: "file" }>;

export type VoiceRows = {
  /** voice file id -> transcript text */
  transcripts: Map<string, string>;
  /** file ids spoken by an agent text (their own rows are hidden) */
  audioIds: Set<string>;
  files: Map<string, FileBody>;
  /** agent texts with audio that answer a voice message the viewer sent */
  requesterOf: Set<string>;
};

/** Which rows of a message list fold into a voice bubble, and what each text row shows. */
export function voiceRows(list: ChatMessage[], deviceId: string | null): VoiceRows {
  const transcripts = new Map<string, string>();
  const audioIds = new Set<string>();
  const files = new Map<string, FileBody>();
  const requesterOf = new Set<string>();
  for (const m of list) {
    const b = m.status === "ok" ? m.body : undefined;
    if (b?.type === "text") {
      if (b.meta?.transcript_of) transcripts.set(b.meta.transcript_of, b.text);
      if (b.meta?.audio_id) audioIds.add(b.meta.audio_id);
    } else if (b?.type === "file" && b.voice) files.set(m.id, b);
  }
  let lastVoiceMine = false;
  for (const m of list) {
    if (isHiddenVoiceRow(m, audioIds)) continue;
    const b = m.status === "ok" ? m.body : undefined;
    if (b?.type === "text" && b.meta?.audio_id && lastVoiceMine) requesterOf.add(m.id);
    if (b?.type === "file" && b.voice) lastVoiceMine = m.senderDevice === deviceId;
  }
  return { transcripts, audioIds, files, requesterOf };
}

export function isHiddenVoiceRow(m: ChatMessage, audioIds: Set<string>): boolean {
  if (audioIds.has(m.id)) return true;
  return m.status === "ok" && m.body?.type === "text" && !!m.body.meta?.transcript_of;
}

/** The MessageItem props a row gets from the voice derivation. */
export function voiceProps(m: ChatMessage, v: VoiceRows) {
  const audioId = m.status === "ok" && m.body?.type === "text" ? m.body.meta?.audio_id : undefined;
  return {
    transcript: v.transcripts.get(m.id),
    audio: audioId ? v.files.get(audioId) : undefined,
    requester: v.requesterOf.has(m.id),
  };
}
