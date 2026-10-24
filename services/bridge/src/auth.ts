import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const SESSION_HOURS = 12;

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 32);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  try {
    const expected = Buffer.from(hashB64, "base64");
    if (expected.length === 0) return false;
    const actual = scryptSync(pin, Buffer.from(saltB64, "base64"), expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
