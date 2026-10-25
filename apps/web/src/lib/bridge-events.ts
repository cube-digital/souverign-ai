import type { CallEvent, VoiceEvent } from "@sa/protocol";

export type BridgeEvent = CallEvent | VoiceEvent;
type Handler = (ev: BridgeEvent) => void;
const handlers = new Set<Handler>();

export function onBridgeEvent(h: Handler): () => void {
  handlers.add(h);
  return () => {
    handlers.delete(h);
  };
}

/** Called by the SSE client for every `call.*`, `voice.*` and `latency.*` event. */
export function dispatchBridgeEvent(ev: BridgeEvent): void {
  for (const h of [...handlers]) h(ev);
}
