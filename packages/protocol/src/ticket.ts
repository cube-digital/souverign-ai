import { createHmac, timingSafeEqual } from "node:crypto";

export function signTicket(
  secret: string,
  deviceId: string,
  ttlMs: number,
  now = Date.now(),
): { ticket: string; expires_at: number } {
  const expires_at = now + ttlMs;
  const payload = Buffer.from(JSON.stringify({ d: deviceId, e: expires_at })).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return { ticket: `${payload}.${sig}`, expires_at };
}

export function verifyTicket(
  secret: string,
  ticket: string,
  deviceId: string,
  now = Date.now(),
): boolean {
  const [payload, sig] = ticket.split(".");
  if (!payload || !sig) return false;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  try {
    const { d, e } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return d === deviceId && typeof e === "number" && e > now;
  } catch {
    return false;
  }
}
