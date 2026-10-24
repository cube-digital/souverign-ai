export type Priority = "human" | "proactive";

type Waiting = {
  start: () => void;
  onPosition: ((ahead: number) => void) | undefined;
  last: number;
};

/** Caps how many model turns run at once across all agents. Human turns go before proactive
 * ones; inside a class it is first come, first served. */
export class TurnQueue {
  private concurrency: number;
  private running = 0;
  private lanes: Record<Priority, Waiting[]> = { human: [], proactive: [] };

  constructor(opts: { concurrency?: number } = {}) {
    const fromEnv = Number(process.env.SA_LLM_CONCURRENCY || 2);
    const n = opts.concurrency ?? fromEnv;
    this.concurrency = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
  }

  /** Runs `job` when a slot is free. `onPosition(ahead)` reports how many turns (running or
   * waiting) are in front of it, whenever that number changes while it waits. */
  enqueue<T>(
    job: () => Promise<T>,
    cls: Priority,
    onPosition?: (ahead: number) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.running++;
        job()
          .then(resolve, reject)
          .finally(() => {
            this.running--;
            this.pump();
          });
      };
      const entry: Waiting = { start: run, onPosition, last: -1 };
      this.lanes[cls].push(entry);
      this.pump();
    });
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const next = this.lanes.human.shift() ?? this.lanes.proactive.shift();
      if (!next) break;
      next.start();
    }
    const waiting = [...this.lanes.human, ...this.lanes.proactive];
    waiting.forEach((w, i) => {
      const ahead = this.running + i;
      if (ahead === w.last) return;
      w.last = ahead;
      try {
        w.onPosition?.(ahead);
      } catch {
        // a failing listener never stops the queue
      }
    });
  }
}
