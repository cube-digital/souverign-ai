const voiceSeen = new Map<string, number>(); // message id → expiry (ms)
const SEEN_MS = 10 * 60_000;

/** True once per voice message id across all agent devices (10 min memory). */
export function claimVoice(messageId: string, now = Date.now()): boolean {
  for (const [id, until] of voiceSeen) if (until < now) voiceSeen.delete(id);
  if (voiceSeen.has(messageId)) return false;
  voiceSeen.set(messageId, now + SEEN_MS);
  return true;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "Hey Ops, …", "Ops: …", "@Ops …" at the start of a transcript. */
export function addressesAgent(transcript: string, agentName: string): boolean {
  return new RegExp(`^\\W*(?:hey|hi|ok|okay)?[\\s,]*@?${escapeRe(agentName)}\\b`, "i").test(
    transcript,
  );
}
