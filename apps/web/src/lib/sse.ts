import { ServerEvent } from "@sa/protocol";
import { EVENTS_PATH, getSession } from "../api";

/** Reconnect delays in ms: 1, 2, 5 s, then every 10 s. */
const BACKOFF = [1000, 2000, 5000, 10_000];
/** The server pings about every 15 s; no bytes for 3 pings means a dead connection. */
export const IDLE_MS = 45_000;

/** Parses one SSE block (lines between blank lines); comments and invalid events give null. */
function parseBlock(block: string): ServerEvent | null {
  const data = block
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data) return null;
  try {
    const parsed = ServerEvent.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Streams server events with fetch (the bearer token cannot go through EventSource). Reconnects
 * after 1, 2, 5 and then every 10 s, calling `onOpen` on every (re)connect; stops on abort or 401.
 */
export function openEvents(
  onEvent: (e: ServerEvent) => void,
  opts: { signal: AbortSignal; onOpen?(): void },
): void {
  const { signal } = opts;
  let attempt = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;

  const retry = () => {
    if (signal.aborted) return;
    timer = setTimeout(() => void connect(), BACKOFF[Math.min(attempt, BACKOFF.length - 1)]);
    attempt += 1;
  };

  async function connect(): Promise<void> {
    if (signal.aborted) return;
    try {
      const headers = new Headers();
      const session = getSession();
      if (session) headers.set("Authorization", `Bearer ${session.token}`);
      headers.set("Accept", "text/event-stream");
      const conn = new AbortController();
      const onAbort = () => conn.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      const arm = () => {
        clearTimeout(idle);
        idle = setTimeout(() => conn.abort(), IDLE_MS);
      };
      try {
        await stream(headers, conn.signal, arm);
      } finally {
        clearTimeout(idle);
        signal.removeEventListener("abort", onAbort);
      }
    } catch {
      // dropped or idle: reconnect below
    }
    if (!stopped) retry();
  }

  async function stream(headers: Headers, sig: AbortSignal, arm: () => void): Promise<void> {
    arm();
    const res = await fetch(EVENTS_PATH, { headers, signal: sig });
    if (res.status === 401) {
      stopped = true;
      return;
    }
    if (!res.ok || !res.body) return;
    attempt = 0;
    opts.onOpen?.();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let cut = buf.indexOf("\n\n");
      while (cut >= 0) {
        const ev = parseBlock(buf.slice(0, cut));
        buf = buf.slice(cut + 2);
        if (ev) onEvent(ev);
        cut = buf.indexOf("\n\n");
      }
    }
  }

  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  void connect();
}
