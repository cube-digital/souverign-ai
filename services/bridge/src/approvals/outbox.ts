import { randomBytes } from "node:crypto";
import { lstat, mkdir, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../db.js";
import { ExecError } from "./service.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const UNSAFE = "The local outbox folder is not safe to write to.";

/** Read at execute time, so a test (or an operator) can point it elsewhere. */
export const outboxDir = (): string => process.env.SA_OUTBOX_DIR || join(ROOT, ".run", "outbox");

const pad = (n: number) => String(n).padStart(2, "0");
/** yyyymmdd-hhmmss in UTC */
const stampOf = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
/** One header line: control characters and angle brackets become spaces. */
const oneLine = (s: string) =>
  [...s]
    .map((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c < 32 ||
        (c >= 127 && c <= 159) ||
        c === 0x2028 ||
        c === 0x2029 ||
        ch === "<" ||
        ch === ">"
        ? " "
        : ch;
    })
    .join("")
    .replace(/ +/g, " ")
    .trim();

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const BIDI = /[\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/;
export const isEmail = (s: string): boolean =>
  s.length <= 200 && EMAIL.test(s) && !BIDI.test(s) && oneLine(s) === s;

export type OutboxMail = {
  approvalId: string;
  agentId: string;
  agentName: string;
  to: string;
  subject: string;
  body: string;
  approvedBy: string;
};

/**
 * Saves the mail as a .eml file inside the real path of the outbox folder and records it. The file
 * name is built here; nothing is sent anywhere.
 */
export async function saveToOutbox(db: Db, m: OutboxMail): Promise<string> {
  if (!/^[a-z0-9]{1,40}$/.test(m.approvalId)) throw new ExecError(UNSAFE);
  if (!isEmail(m.to)) throw new ExecError("The address is not valid.");
  const subject = oneLine(m.subject).replace(BIDI, "");
  if (!subject) throw new ExecError("The subject is not valid.");
  const seen = await db.query("select 1 from sa.outbox where approval_id = $1", [m.approvalId]);
  if (seen.length > 0) throw new ExecError("That email was already saved.");
  const dir = outboxDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await lstat(dir)).isSymbolicLink()) throw new ExecError(UNSAFE);
  const real = await realpath(dir);
  const name = `${stampOf(new Date())}-${m.approvalId}.eml`;
  const text = [
    `From: ${oneLine(m.agentName) || "Agent"} <agent-${m.agentId.replace(/[^a-zA-Z0-9_-]/g, "")}@outbox.local>`,
    `To: ${m.to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `X-Approved-By: ${oneLine(m.approvedBy)}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    m.body.replace(/\r?\n/g, "\r\n"),
    "",
  ].join("\r\n");
  const path = join(real, name);
  await writeFile(path, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await db.query(
      "insert into sa.outbox (id, agent_id, approval_id, to_addr, subject, file) values ($1,$2,$3,$4,$5,$6)",
      [randomBytes(10).toString("hex"), m.agentId, m.approvalId, m.to, subject, name],
    );
  } catch (e) {
    await unlink(path).catch(() => {});
    throw e;
  }
  return name;
}
