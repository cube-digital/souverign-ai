export type Priority = "human" | "proactive";

export type EnqueueOptions = {
  /** at most one turn per agent runs at a time; later ones wait without blocking others */
  agentId?: string;
  /** who asked; turns are served round-robin between requesters */
  requester?: string;
  /** a Stop removes a waiting turn at once; its job then runs outside the queue to finish up */
  signal?: AbortSignal;
  /** the turn may not start before this time (ms since epoch) */
  notBefore?: () => number;
};

type Entry = {
  seq: number;
  cls: Priority;
  agent: string | undefined;
  requester: string;
  job: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  onPosition: ((ahead: number) => void) | undefined;
  notBefore: (() => number) | undefined;
  last: number;
  detach?: () => void;
};

/** Pending turns one requester may have waiting at once; the rest sit in their backlog. */
const PENDING_PER_REQUESTER = 2;

/** Caps how many model turns run at once across all agents. Human turns go before proactive
 * ones; inside a class requesters take turns (round-robin) and each has at most two waiting. */
export class TurnQueue {
  private concurrency: number;
  private running = 0;
  private runningAgents = new Set<string>();
  private waiting: Entry[] = [];
  private backlog: Entry[] = [];
  private served = new Map<string, number>();
  private tick = 0;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** per-requester limiter for work that needs no model (see `limit`) */
  private lite = new Map<string, { active: number; queue: (() => void)[] }>();

  constructor(opts: { concurrency?: number } = {}) {
    const n = opts.concurrency ?? Number(process.env.SA_LLM_CONCURRENCY || 2);
    this.concurrency = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
  }

  /** Runs `job` when a slot is free. `onPosition(ahead)` reports how many turns (running or
   * waiting) are in front of it, whenever that number changes while it waits. */
  enqueue<T>(
    job: () => Promise<T>,
    cls: Priority,
    onPosition?: (ahead: number) => void,
    opts: EnqueueOptions = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (opts.signal?.aborted) {
        job().then(resolve, reject);
        return;
      }
      const entry: Entry = {
        seq: this.seq++,
        cls,
        agent: opts.agentId,
        requester: opts.requester ?? "",
        job,
        resolve: resolve as (v: unknown) => void,
        reject,
        onPosition,
        notBefore: opts.notBefore,
        last: -1,
      };
      const signal = opts.signal;
      if (signal) {
        const onAbort = () => {
          const i = this.waiting.indexOf(entry);
          const j = this.backlog.indexOf(entry);
          if (i < 0 && j < 0) return;
          if (i >= 0) this.waiting.splice(i, 1);
          else this.backlog.splice(j, 1);
          entry.detach?.();
          job().then(resolve, reject);
          this.pump();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.detach = () => signal.removeEventListener("abort", onAbort);
      }
      this.backlog.push(entry);
      this.pump();
    });
  }

  /** Runs `fn` now, or after the requester's earlier calls when they already have two in flight.
   * For answers that need no model and so take no slot. */
  async limit<T>(requester: string, fn: () => Promise<T>): Promise<T> {
    let s = this.lite.get(requester);
    if (!s) {
      s = { active: 0, queue: [] };
      this.lite.set(requester, s);
    }
    const state = s;
    if (state.active >= PENDING_PER_REQUESTER) await new Promise<void>((r) => state.queue.push(r));
    else state.active++;
    try {
      return await fn();
    } finally {
      const next = state.queue.shift();
      if (next) next();
      else {
        state.active--;
        if (state.active === 0) this.lite.delete(requester);
      }
    }
  }

  private eligible(e: Entry, now: number): boolean {
    if (e.agent) {
      if (this.runningAgents.has(e.agent)) return false;
      // a waiting proactive turn never holds back a human one of the same agent
      const earlier = (x: Entry) =>
        x !== e &&
        x.agent === e.agent &&
        x.seq < e.seq &&
        (x.cls === e.cls || e.cls === "proactive");
      if (this.waiting.some(earlier) || this.backlog.some(earlier)) return false;
    }
    return !e.notBefore || e.notBefore() <= now;
  }

  private better(a: Entry, b: Entry, served: Map<string, number>): boolean {
    if (a.cls !== b.cls) return a.cls === "human";
    const sa = served.get(a.requester) ?? -1;
    const sb = served.get(b.requester) ?? -1;
    return sa !== sb ? sa < sb : a.seq < b.seq;
  }

  private pick(now: number): Entry | undefined {
    let best: Entry | undefined;
    for (const e of this.waiting) {
      if (!this.eligible(e, now)) continue;
      if (!best || this.better(e, best, this.served)) best = e;
    }
    return best;
  }

  private pump(): void {
    this.promote();
    const now = Date.now();
    while (this.running < this.concurrency) {
      const next = this.pick(now);
      if (!next) break;
      this.waiting.splice(this.waiting.indexOf(next), 1);
      next.detach?.();
      this.start(next);
      this.promote();
    }
    this.schedule(now);
    this.notify();
  }

  private promote(): void {
    for (const e of [...this.backlog]) {
      if (this.waiting.filter((w) => w.requester === e.requester).length >= PENDING_PER_REQUESTER)
        continue;
      this.backlog.splice(this.backlog.indexOf(e), 1);
      this.waiting.push(e);
    }
  }

  private start(e: Entry): void {
    this.running++;
    if (e.agent) this.runningAgents.add(e.agent);
    this.served.set(e.requester, ++this.tick);
    e.job()
      .then(e.resolve, e.reject)
      .finally(() => {
        this.running--;
        if (e.agent) this.runningAgents.delete(e.agent);
        this.pump();
      });
  }

  /** Wakes the queue when the earliest "not before" time passes. */
  private schedule(now: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    let at = Number.POSITIVE_INFINITY;
    for (const e of [...this.waiting, ...this.backlog]) {
      const t = e.notBefore?.() ?? 0;
      if (t > now) at = Math.min(at, t);
    }
    if (at === Number.POSITIVE_INFINITY) return;
    this.timer = setTimeout(() => this.pump(), at - now + 5);
    this.timer.unref?.();
  }

  private notify(): void {
    const served = new Map(this.served);
    const rest = [...this.waiting];
    let index = 0;
    const tell = (e: Entry, ahead: number) => {
      if (ahead === e.last) return;
      e.last = ahead;
      try {
        e.onPosition?.(ahead);
      } catch {
        // a failing listener never stops the queue
      }
    };
    while (rest.length > 0) {
      let best = rest[0] as Entry;
      for (const e of rest) if (this.better(e, best, served)) best = e;
      rest.splice(rest.indexOf(best), 1);
      served.set(best.requester, ++index + this.tick);
      tell(best, this.running + index - 1);
    }
    for (const [i, e] of this.backlog.entries()) tell(e, this.running + this.waiting.length + i);
  }
}
