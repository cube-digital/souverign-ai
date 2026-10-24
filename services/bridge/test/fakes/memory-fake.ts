import { createServer } from "node:http";
import type {
  IngestRequest,
  Memory,
  MemoryKind,
  MemoryScope,
  RecallHit,
} from "../../src/memory/client.js";

type Entry = {
  namespace: string;
  kind: MemoryKind;
  origin: string | null;
  source: { type: string; id: string; title: string | null; ts: number };
  text: string;
};

function matches(e: Entry, s: MemoryScope): boolean {
  if (e.namespace !== s.namespace) return false;
  if (Array.isArray(s.origin_chat_ids)) {
    const ok =
      e.origin === null
        ? s.origin_chat_ids.includes(null)
        : s.origin_chat_ids.some((o) => o !== null && o === e.origin);
    if (!ok) return false;
  }
  if (s.since_ts != null && e.source.ts < s.since_ts) return false;
  return true;
}

export class FakeMemory implements Memory {
  readonly ingested: IngestRequest[] = [];
  private entries = new Map<string, Entry>();

  async ingest(req: IngestRequest): Promise<number> {
    this.ingested.push(req);
    this.entries.set(`${req.namespace}\u0000${req.source.type}\u0000${req.source.id}`, {
      namespace: req.namespace,
      kind: req.kind,
      origin: req.origin_chat_id ?? null,
      source: { ...req.source, title: req.source.title ?? null },
      text: req.text,
    });
    return 1;
  }

  async recall(req: { scopes: MemoryScope[]; query: string; k?: number }): Promise<RecallHit[]> {
    const words = new Set(
      (req.query.toLowerCase().match(/\p{L}{3,}/gu) ?? []).filter((w) => w.length >= 3),
    );
    const hits: RecallHit[] = [];
    for (const e of this.entries.values()) {
      if (!req.scopes.some((s) => matches(e, s))) continue;
      const lower = e.text.toLowerCase();
      let score = 0;
      for (const w of words) if (lower.includes(w)) score++;
      if (score === 0) continue;
      hits.push({
        text: e.text,
        score,
        space: e.namespace,
        kind: e.kind,
        origin_chat_id: e.origin,
        source: e.source,
        chunk_idx: 0,
      });
    }
    hits.sort((a, b) => b.score - a.score || b.source.ts - a.source.ts);
    return hits.slice(0, req.k ?? 5);
  }

  async deleteSource(req: {
    namespace: string;
    source_type: string;
    source_id: string;
    include_parts?: boolean;
  }): Promise<number> {
    let n = 0;
    for (const [key, e] of this.entries) {
      if (e.namespace !== req.namespace || e.source.type !== req.source_type) continue;
      const hit =
        e.source.id === req.source_id ||
        (req.include_parts === true && e.source.id.startsWith(`${req.source_id}#`));
      if (hit) {
        this.entries.delete(key);
        n++;
      }
    }
    return n;
  }
}

export async function startFakeMemoryServer(opts: {
  port: number;
  token: string;
}): Promise<{ close(): Promise<void> }> {
  const mem = new FakeMemory();
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/healthz") return send(200, { ok: true });
    if (req.headers["x-internal-token"] !== opts.token) return send(401, { error: "unauthorized" });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        if (req.method === "POST" && req.url === "/ingest")
          return send(200, { chunks: await mem.ingest(body) });
        if (req.method === "POST" && req.url === "/recall")
          return send(200, { results: await mem.recall(body) });
        if (req.method === "DELETE" && req.url === "/sources")
          return send(200, { deleted: await mem.deleteSource(body) });
        send(404, { error: "not found" });
      } catch {
        send(400, { error: "bad request" });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port, "127.0.0.1", resolve));
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
