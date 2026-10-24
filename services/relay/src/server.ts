import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ClientOp,
  type Envelope,
  type ErrorCode,
  MAX_BLOB_BYTES,
  RelayMemberChange,
  type RelayOp,
} from "@sa/protocol";
import { verifyTicket } from "@sa/protocol/ticket";
import { type WebSocket, WebSocketServer } from "ws";
import { openDb } from "./db.js";

const SYNC_LIMIT = 500;
const MAX_ADMIN_BODY = 4096;

export interface RelayOptions {
  dbPath: string;
  adminToken: string;
  host?: string;
  port?: number;
}

const log = (obj: Record<string, unknown>) => console.log(JSON.stringify(obj));

function tokenOk(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

function anyDeviceTicketOk(header: string | undefined, secret: string): boolean {
  const ticket = header?.startsWith("Bearer ") ? header.slice(7) : "";
  try {
    const payload = ticket.split(".")[0] ?? "";
    const { d } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof d === "string" && verifyTicket(secret, ticket, d);
  } catch {
    return false;
  }
}

export async function createRelay(
  opts: RelayOptions,
): Promise<{ url: string; close(): Promise<void> }> {
  const { dbPath, adminToken, host = "127.0.0.1", port = 0 } = opts;
  const db = openDb(dbPath);
  const sockets = new Map<string, Set<WebSocket>>();

  const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://relay");
    if (req.method === "GET" && u.pathname === "/relay/healthz")
      return json(res, 200, { ok: true });
    if (req.method === "GET" && u.pathname === "/relay/debug/recent") {
      if (!anyDeviceTicketOk(req.headers.authorization, adminToken)) {
        return json(res, 401, { error: "unauthorized" });
      }
      const n = Number(u.searchParams.get("limit") ?? 50);
      const limit = Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 500) : 50;
      return json(res, 200, db.recent(limit));
    }
    if (req.method === "POST" && u.pathname === "/relay/admin/members") {
      if (!tokenOk(req.headers.authorization, adminToken)) {
        return json(res, 401, { error: "unauthorized" });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size <= MAX_ADMIN_BODY) chunks.push(c);
      });
      req.on("end", () => {
        if (size > MAX_ADMIN_BODY) return json(res, 413, { error: "too_large" });
        let parsed: ReturnType<typeof RelayMemberChange.safeParse>;
        try {
          parsed = RelayMemberChange.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          return json(res, 400, { error: "bad_request" });
        }
        if (!parsed.success) return json(res, 400, { error: "bad_request" });
        const { chat_id, device_id, op } = parsed.data;
        if (op === "add") db.addMember(chat_id, device_id);
        else db.removeMember(chat_id, device_id);
        log({ level: "info", msg: "membership", op, chat_id, device_id });
        return json(res, 200, { ok: true });
      });
      return;
    }
    json(res, 404, { error: "not_found" });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url ?? "/", "http://relay");
    if (u.pathname !== "/relay/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  const out = (ws: WebSocket, op: RelayOp) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(op));
  };
  const fail = (ws: WebSocket, code: ErrorCode, message: string, ref?: string) =>
    out(ws, { op: "error", code, message, ...(ref !== undefined ? { ref } : {}) });

  function fanOut(env: Envelope, seq: number) {
    const targets =
      env.kind === "key" && env.to_device ? [env.to_device] : db.activeDevices(env.chat_id);
    for (const d of new Set(targets)) {
      for (const s of sockets.get(d) ?? []) out(s, { op: "deliver", seq, env });
    }
  }

  function onConnection(ws: WebSocket) {
    let device: string | undefined;
    log({ level: "info", msg: "connection" });
    ws.on("close", () => {
      if (!device) return;
      const set = sockets.get(device);
      set?.delete(ws);
      if (set?.size === 0) sockets.delete(device);
    });
    ws.on("error", () => ws.terminate());
    ws.on("message", (raw) => {
      let value: unknown;
      try {
        value = JSON.parse(raw.toString());
      } catch {
        return fail(ws, "bad_request", "invalid json");
      }
      const parsed = ClientOp.safeParse(value);
      if (!parsed.success) {
        const op = (value as { op?: unknown } | null)?.op;
        if (!device && op !== "hello") {
          fail(ws, "no_hello", "send hello first");
          return ws.close();
        }
        const ref = (value as { env?: { id?: unknown } } | null)?.env?.id;
        return fail(ws, "bad_request", "invalid op", typeof ref === "string" ? ref : undefined);
      }
      const msg = parsed.data;
      if (!device) {
        if (msg.op !== "hello") {
          fail(ws, "no_hello", "send hello first");
          return ws.close();
        }
        if (!verifyTicket(adminToken, msg.ticket, msg.device_id)) {
          fail(ws, "bad_ticket", "invalid ticket");
          return ws.close();
        }
        device = msg.device_id;
        const set = sockets.get(device) ?? new Set<WebSocket>();
        sockets.set(device, set);
        set.add(ws);
        return out(ws, { op: "ready", device_id: device });
      }
      try {
        switch (msg.op) {
          case "hello":
            return fail(ws, "bad_request", "already said hello");
          case "send": {
            const env = msg.env;
            const ok =
              env.sender_device === device &&
              db.isActive(env.chat_id, device) &&
              (env.kind !== "key" || (!!env.to_device && db.isActive(env.chat_id, env.to_device)));
            if (!ok) return fail(ws, "not_member", "not a member of this chat", env.id);
            const existing = db.findEnvelope(env.id);
            if (existing) return out(ws, { op: "ack", id: env.id, seq: existing.seq });
            const seq = db.insertEnvelope(env);
            log({
              level: "info",
              msg: "send",
              id: env.id,
              chat_id: env.chat_id,
              kind: env.kind,
              size: env.ciphertext.length,
              seq,
            });
            out(ws, { op: "ack", id: env.id, seq });
            fanOut(env, seq);
            return;
          }
          case "sync": {
            const added = db.activeSince(msg.chat_id, device);
            if (added === undefined) return fail(ws, "not_member", "not a member of this chat");
            const after = Math.max(msg.since, added);
            const rows = db.sync(msg.chat_id, device, after, SYNC_LIMIT);
            for (const r of rows) out(ws, { op: "deliver", seq: r.seq, env: r.env });
            const last = rows.at(-1)?.seq ?? after;
            const more = rows.length === SYNC_LIMIT && db.hasMoreAfter(msg.chat_id, device, last);
            return out(ws, { op: "synced", chat_id: msg.chat_id, seq: last, more });
          }
          case "blob_put": {
            if (!db.isActive(msg.chat_id, device)) {
              return fail(ws, "not_member", "not a member of this chat", msg.id);
            }
            const data = Buffer.from(msg.data, "base64url");
            if (data.length > MAX_BLOB_BYTES)
              return fail(ws, "too_large", "blob too large", msg.id);
            if (db.putBlob(msg.id, msg.chat_id, data) === "conflict") {
              return fail(ws, "bad_request", "blob id in use", msg.id);
            }
            log({
              level: "info",
              msg: "blob_put",
              id: msg.id,
              chat_id: msg.chat_id,
              size: data.length,
            });
            return out(ws, { op: "blob_ok", id: msg.id });
          }
          case "blob_get": {
            const blob = db.getBlob(msg.id);
            if (!blob) return fail(ws, "not_found", "unknown blob", msg.id);
            if (!db.isActive(blob.chat_id, device)) {
              return fail(ws, "not_member", "not a member of this chat", msg.id);
            }
            return out(ws, { op: "blob", id: msg.id, data: blob.data.toString("base64url") });
          }
        }
      } catch {
        log({ level: "error", msg: "op_failed", op: msg.op });
        const ref =
          msg.op === "send"
            ? msg.env.id
            : msg.op === "blob_put" || msg.op === "blob_get"
              ? msg.id
              : undefined;
        return fail(ws, "bad_request", "operation failed", ref);
      }
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const addr = server.address() as AddressInfo;
  const url = `http://${host}:${addr.port}`;
  log({ level: "info", msg: "relay listening", host, port: addr.port });

  return {
    url,
    async close() {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      db.close();
    },
  };
}
