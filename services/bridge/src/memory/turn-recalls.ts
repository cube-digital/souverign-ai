import type { RecallHit } from "./client.js";

export type Numbered = { n: number; hit: RecallHit };

const MAX_SOURCES = 8;
const byTurn = new Map<string, Numbered[]>();

const keyOf = (h: RecallHit) => `${h.space}\u0000${h.source.id}`;

/**
 * Numbers the sources a turn has recalled (1..8, in order, deduped by space + source id).
 * Returns only the sources newly numbered by this call; a 9th distinct source is dropped.
 */
export function addRecalls(turnId: string, hits: RecallHit[]): Numbered[] {
  const list = byTurn.get(turnId) ?? [];
  const seen = new Set(list.map((r) => keyOf(r.hit)));
  const added: Numbered[] = [];
  for (const hit of hits) {
    const k = keyOf(hit);
    if (seen.has(k)) continue;
    if (list.length >= MAX_SOURCES) break;
    seen.add(k);
    const entry = { n: list.length + 1, hit };
    list.push(entry);
    added.push(entry);
  }
  if (list.length > 0) byTurn.set(turnId, list);
  return added;
}

export function recallsFor(turnId: string): Numbered[] {
  return [...(byTurn.get(turnId) ?? [])];
}

export function clearRecalls(turnId: string): void {
  byTurn.delete(turnId);
}
