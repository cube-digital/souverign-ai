const TTL_MS = 120_000;
const sent = new Map<string, number>();

/** Remembers when the user released the mic for a source. */
export function markSent(sourceId: string, releasedAt: number): void {
  for (const [id, at] of sent) if (releasedAt - at > TTL_MS) sent.delete(id);
  sent.set(sourceId, releasedAt);
}

/** Voice-to-voice time for a source, once; null if unknown, already counted or older than 2 min. */
export function firstAudio(sourceId: string, now: number): number | null {
  const at = sent.get(sourceId);
  if (at === undefined) return null;
  sent.delete(sourceId);
  return now - at > TTL_MS ? null : now - at;
}
