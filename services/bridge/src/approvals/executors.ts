import { randomBytes } from "node:crypto";
import type { ApprovalPreview } from "@sa/protocol";
import { isEmail, saveToOutbox } from "./outbox.js";
import { ArgsError, ExecError, type Executor, type ValidateCtx } from "./service.js";

const STAMP_LINE =
  /^\s*(Approved\s+by|Auto-approved\s+for|Declined\s+by|Canceled\s+by|Expired\s+after)\b/im;
/** Zero-width, soft-hyphen, bidi and BOM characters that hide a lookalike. */
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const looksLikeStamp = (s: string): boolean =>
  STAMP_LINE.test(
    s
      .normalize("NFKC")
      .replace(INVISIBLE, "")
      .replace(/[\u0085\u2028\u2029\r]/g, "\n"),
  );
const TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
/** Control characters, CR/LF and Unicode line separators. */
const hasControl = (s: string): boolean =>
  [...s].some((ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return c < 32 || (c >= 127 && c <= 159) || c === 0x2028 || c === 0x2029;
  });
const SIM_TIMEOUT_MS = 8000;
const MAX_OPTIONS = 8;

function text(v: unknown, name: string, min: number, max: number): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length < min || s.length > max) {
    throw new ArgsError(`${name} must be ${min} to ${max} characters.`);
  }
  return s;
}
const field = (
  key: string,
  label: string,
  value: string,
  editable: boolean,
  multiline = false,
) => ({
  key,
  label,
  value: value.slice(0, 8000),
  editable,
  multiline,
});

type Shared = { id: string; title: string };
/** Chats where the agent and the approver are both active members. */
async function sharedChats(ctx: ValidateCtx): Promise<Shared[]> {
  return ctx.db.query<Shared>(
    `select c.id, coalesce(c.title, 'chat') as title
       from sa.chats c
       join sa.chat_members a on a.chat_id = c.id and a.member_type = 'agent'
        and a.member_id = $1 and a.removed_at is null
       join sa.chat_members h on h.chat_id = c.id and h.member_type = 'user'
        and h.member_id = $2 and h.removed_at is null
      order by c.title, c.id`,
    [ctx.agentId, ctx.approverUserId],
  );
}

export const chatSend: Executor = {
  editable: ["text"],
  alwaysAllowed: false,
  stamp: true,
  async validate(args, ctx) {
    const body = text(args.text, "text", 1, 4000);
    if (looksLikeStamp(body)) {
      throw new ArgsError("The message can't start with an approval status line.");
    }
    const resolved = typeof args.chat === "string" ? args.chat : args.chat_id;
    const ref = typeof resolved === "string" ? resolved.trim() : "";
    const chats = await sharedChats(ctx);
    // Only chats the requester is in are named, so they never learn other chat titles.
    const mine = ctx.requesterUserId
      ? new Set(
          (
            await ctx.db.query<{ chat_id: string }>(
              "select chat_id from sa.chat_members where member_type = 'user' and member_id = $1 and removed_at is null",
              [ctx.requesterUserId],
            )
          ).map((r) => r.chat_id),
        )
      : new Set<string>();
    const options = chats
      .filter((c) => mine.has(c.id))
      .slice(0, MAX_OPTIONS)
      .map((c) => `#${c.title}`)
      .join(", ");
    const byId = chats.find((c) => c.id === ref);
    let hit = byId;
    if (!hit) {
      const want = ref.replace(/^#/, "").toLowerCase();
      const same = want ? chats.filter((c) => c.title.toLowerCase() === want) : [];
      if (same.length > 1) {
        throw new ArgsError(
          `More than one chat is called ${ref.slice(0, 60)}. Use the chat id: ${same
            .map((c) => `${c.id} (#${c.title})`)
            .join(", ")}`,
        );
      }
      hit = same[0];
    }
    if (!hit) {
      if (typeof args.chat !== "string" && typeof args.chat_id === "string") {
        throw new ArgsError("That chat is no longer one we both are in.");
      }
      throw new ArgsError(
        `No chat named ${ref.slice(0, 60)} that you and I are both in. Options: ${options}`,
      );
    }
    return { chat_id: hit.id, chat_title: hit.title, origin_chat_id: ctx.chatId, text: body };
  },
  preview(args) {
    const title = String(args.chat_title ?? "");
    return {
      title: `Post a message in #${title}`.slice(0, 200),
      target: `#${title}`.slice(0, 200),
      fields: [field("text", "Message", String(args.text ?? ""), true, true)],
      leaves_chat: args.chat_id !== args.origin_chat_id,
    };
  },
  async execute(args, ctx) {
    const post = ctx.agentHost.postAs;
    if (!post) throw new ExecError("I can't post right now.");
    const id = await post.call(
      ctx.agentHost,
      ctx.approval.agent_id,
      String(args.chat_id),
      String(args.text),
      { meta: { approved_by: ctx.approverName } },
    );
    if (!id) throw new ExecError("I am not in that chat any more");
    return `Posted in #${String(args.chat_title)}.`;
  },
  publicResult: () => "posted",
};

export const notesCreate: Executor = {
  editable: ["title", "body_md"],
  alwaysAllowed: true,
  stamp: true,
  async validate(args) {
    return {
      title: text(args.title, "title", 1, 200),
      body_md: text(args.body_md, "body_md", 1, 8000),
    };
  },
  preview(args, info) {
    return {
      title: `Save a note in #${info.chatTitle}`.slice(0, 200),
      target: String(args.title ?? "").slice(0, 200),
      fields: [
        field("title", "Title", String(args.title ?? ""), true),
        field("body_md", "Note", String(args.body_md ?? ""), true, true),
      ],
      leaves_chat: false,
    };
  },
  async execute(args, ctx) {
    const a = ctx.approval;
    const done = await ctx.db.query("select 1 from sa.notes where approval_id = $1", [a.id]);
    if (done.length > 0) throw new ExecError("That note was already saved.");
    await ctx.db.query(
      "insert into sa.notes (id, agent_id, chat_id, title, body_md, approval_id) values ($1,$2,$3,$4,$5,$6)",
      [randomBytes(10).toString("hex"), a.agent_id, a.chat_id, args.title, args.body_md, a.id],
    );
    return `Note "${String(args.title)}" saved in #${a.chat_title}.`;
  },
  publicResult: () => "saved",
};

export const emailSend: Executor = {
  editable: ["to", "subject", "body"],
  alwaysAllowed: false,
  stamp: true,
  async validate(args) {
    const to = text(args.to, "to", 1, 200);
    if (!isEmail(to)) throw new ArgsError("to must be one email address like name@example.com.");
    const subject = text(args.subject, "subject", 1, 200);
    if (hasControl(subject)) throw new ArgsError("subject must be a single line.");
    return { to, subject, body: text(args.body, "body", 1, 8000) };
  },
  preview(args) {
    return {
      title: "Save an email to the local outbox",
      target: String(args.to ?? "").slice(0, 200),
      fields: [
        field("to", "To", String(args.to ?? ""), true),
        field("subject", "Subject", String(args.subject ?? ""), true),
        field("body", "Message", String(args.body ?? ""), true, true),
      ],
      leaves_chat: true,
    };
  },
  async execute(args, ctx) {
    const a = ctx.approval;
    await saveToOutbox(ctx.db, {
      approvalId: a.id,
      agentId: a.agent_id,
      agentName: a.agent_name,
      to: String(args.to),
      subject: String(args.subject),
      body: String(args.body),
      approvedBy: ctx.approverName,
    });
    return "Saved to the local outbox (nothing left this Mac).";
  },
  publicResult: () => "Saved to the local outbox (nothing left this Mac).",
};

/** The ticket mock runs on this Mac; anything else is refused. */
function simBase(url: string): string {
  const u = new URL(url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
    throw new ExecError("The ticket system must run on this Mac.");
  }
  return url.replace(/\/$/, "");
}

export const ticketComment: Executor = {
  editable: ["body"],
  alwaysAllowed: false,
  stamp: true,
  async validate(args, ctx) {
    const id = typeof args.ticket_id === "string" ? args.ticket_id.trim() : "";
    const body = text(args.body, "body", 1, 4000);
    if (!TICKET_ID.test(id)) throw new ArgsError(`No ticket ${id.slice(0, 40)}.`);
    let status: number;
    try {
      const res = await fetch(`${simBase(ctx.opsSimUrl)}/sim/tickets/${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(SIM_TIMEOUT_MS),
        redirect: "error",
      });
      status = res.status;
    } catch (e) {
      if (e instanceof ExecError) throw new ArgsError(e.message);
      throw new ArgsError("The ticket system is not reachable right now.");
    }
    if (status === 404) throw new ArgsError(`No ticket ${id}.`);
    if (status !== 200) throw new ArgsError("The ticket system is not reachable right now.");
    return { ticket_id: id, body };
  },
  preview(args) {
    const id = String(args.ticket_id ?? "");
    return {
      title: `Comment on ${id}`.slice(0, 200),
      target: id,
      fields: [field("body", "Comment", String(args.body ?? ""), true, true)],
      leaves_chat: true,
    } satisfies ApprovalPreview;
  },
  async execute(args, ctx) {
    const id = String(args.ticket_id);
    let ok = false;
    try {
      const res = await fetch(
        `${simBase(ctx.opsSimUrl)}/sim/tickets/${encodeURIComponent(id)}/comments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ author: ctx.approval.agent_name, body: args.body }),
          signal: AbortSignal.timeout(SIM_TIMEOUT_MS),
          redirect: "error",
        },
      );
      ok = res.status === 201;
    } catch (e) {
      if (e instanceof ExecError) throw e;
    }
    if (!ok) throw new ExecError("The ticket system did not accept the comment.");
    return `Commented on ${id}.`;
  },
  publicResult: () => "commented",
};
