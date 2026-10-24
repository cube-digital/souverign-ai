import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** The master key is read on use so tests can set it late; `requireMasterKey` fails fast at startup. */
function masterKey(): string {
  const k = process.env.BRIDGE_MASTER_KEY;
  if (!k) throw new Error("BRIDGE_MASTER_KEY is required");
  return k;
}

export function requireMasterKey(): void {
  masterKey();
}

const aesKey = (): Buffer => createHash("sha256").update(masterKey()).digest();

/** AES-256-GCM; blob = iv.tag.ct, each base64url. */
export function encrypt(text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", aesKey(), iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(blob: string): string {
  const [iv, tag, ct] = blob.split(".").map((p) => Buffer.from(p ?? "", "base64url"));
  if (!iv || !tag || !ct) throw new Error("bad blob");
  const d = createDecipheriv("aes-256-gcm", aesKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

const mac = (label: string, agentId: string): string =>
  createHmac("sha256", masterKey()).update(`${label}:${agentId}`).digest("base64url");

export const hermesApiKey = (agentId: string): string => mac("hermes", agentId);

export const mcpToken = (agentId: string): string => `${agentId}.${mac("mcp", agentId)}`;

export function verifyMcpToken(token: string): string | null {
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const agentId = token.slice(0, i);
  const a = Buffer.from(token);
  const b = Buffer.from(mcpToken(agentId));
  return a.length === b.length && timingSafeEqual(a, b) ? agentId : null;
}
