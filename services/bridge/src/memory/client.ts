export type MemoryKind = "conversation" | "knowledge" | "correction" | "meeting";
export type MemoryScope = {
  namespace: string;
  /** null = no origin filter; a null entry matches origin_chat_id is null */
  origin_chat_ids?: (string | null)[] | null;
  since_ts?: number | null;
};
export type RecallHit = {
  text: string;
  score: number;
  space: string;
  kind: MemoryKind;
  origin_chat_id: string | null;
  source: { type: string; id: string; title: string | null; ts: number };
  chunk_idx: number;
};
export type IngestRequest = {
  namespace: string;
  kind: MemoryKind;
  origin_chat_id?: string | null;
  source: { type: string; id: string; title?: string | null; ts: number };
  text: string;
};
export interface Memory {
  ingest(req: IngestRequest): Promise<number>;
  recall(req: { scopes: MemoryScope[]; query: string; k?: number }): Promise<RecallHit[]>;
  deleteSource(req: {
    namespace: string;
    source_type: string;
    source_id: string;
    include_parts?: boolean;
  }): Promise<number>;
}

export class MemoryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class MemoryClient implements Memory {
  constructor(
    private base: string,
    private token: string,
    private timeoutMs = 120_000,
  ) {
    const u = new URL(base);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback))
      throw new Error("MEMORY_URL must be https or loopback http");
  }

  private async call<T>(method: string, path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.base.replace(/\/$/, "")}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-internal-token": this.token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new MemoryError(res.status, `memory ${path} ${res.status}`);
    return (await res.json()) as T;
  }
  async ingest(req: IngestRequest): Promise<number> {
    return (await this.call<{ chunks: number }>("POST", "/ingest", req)).chunks;
  }
  async recall(req: { scopes: MemoryScope[]; query: string; k?: number }): Promise<RecallHit[]> {
    if (req.scopes.length === 0) return [];
    return (await this.call<{ results: RecallHit[] }>("POST", "/recall", { k: 5, ...req })).results;
  }
  async deleteSource(req: {
    namespace: string;
    source_type: string;
    source_id: string;
    include_parts?: boolean;
  }): Promise<number> {
    return (await this.call<{ deleted: number }>("DELETE", "/sources", req)).deleted;
  }
}

let current: Memory | null | undefined;
/** The process-wide memory client, or null when MEMORY_TOKEN is not set (memory off). */
export function memory(): Memory | null {
  if (current === undefined) {
    const token = process.env.MEMORY_TOKEN;
    current = token
      ? new MemoryClient(process.env.MEMORY_URL ?? "http://127.0.0.1:8646", token)
      : null;
  }
  return current;
}
/** Tests only. */
export function setMemoryForTests(m: Memory | null | undefined): void {
  current = m;
}
