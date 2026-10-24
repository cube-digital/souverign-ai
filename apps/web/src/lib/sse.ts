import { ServerEvent } from "@sa/protocol";
import { EVENTS_PATH, getSession } from "../api";

/** Reconnect delays in ms: 1, 2, 5 s, then every 10 s. */
const BACKOFF = [1000, 2000, 5000, 10_000];

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
  let timer: ReturnType<typeof setTimeout> | undefined;

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
      const res = await fetch(EVENTS_PATH, { headers, signal });
      if (res.status === 401) return;
      if (!res.ok || !res.body) {
        retry();
        return;
      }
      attempt = 0;
      opts.onOpen?.();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let cut = buf.indexOf("\n\n");
        while (cut >= 0) {
          const ev = parseBlock(buf.slice(0, cut));
          buf = buf.slice(cut + 2);
          if (ev) onEvent(ev);
          cut = buf.indexOf("\n\n");
        }
      }
    } catch {
      if (signal.aborted) return;
    }
    retry();
  }

  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  void connect();
}
