/** A sliding-window counter: `hit` is false once `max` calls happened inside `windowMs`. */
export class Limiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly now: () => number = Date.now) {}

  hit(key: string, max: number, windowMs = 60_000): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits) if (v.every((x) => t - x >= windowMs)) this.hits.delete(k);
    }
    return true;
  }

  clear(): void {
    this.hits.clear();
  }
}

export const LIMITS = {
  start: 5,
  invite: 3,
  presence: 30,
} as const;
