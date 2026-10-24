import type { Agent } from "@sa/protocol";
import { useEffect, useSyncExternalStore } from "react";
import { agents as fetchAgents } from "../api";

/**
 * One cached agent list for the whole app. Every consumer shares it: the first mount fetches, later
 * mounts show the cached list at once and refresh it in the background, and `invalidateAgents()`
 * (after create, delete or a membership change) refetches for everyone.
 */
let cache: Agent[] | null = null;
let inflight: Promise<void> | null = null;
let failed = false;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

function refresh(): Promise<void> {
  if (!inflight) {
    inflight = fetchAgents()
      .then(
        (list) => {
          cache = list;
          failed = false;
        },
        () => {
          failed = true;
        },
      )
      .finally(() => {
        inflight = null;
        emit();
      });
  }
  return inflight;
}

export function invalidateAgents(): Promise<void> {
  return refresh();
}

/** Forgets the list, e.g. when another user signs in. */
export function resetAgents(): void {
  cache = null;
  failed = false;
  emit();
}

export type AgentsState = { agents: Agent[] | null; failed: boolean; reload: () => Promise<void> };

/** `agents` is null until the first load finishes. */
export function useAgents(): AgentsState {
  const agents = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => cache,
  );
  useEffect(() => {
    void refresh();
  }, []);
  return { agents, failed: failed && agents === null, reload: invalidateAgents };
}
