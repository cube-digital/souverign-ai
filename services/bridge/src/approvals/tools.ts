import { GATED_TOOLS } from "@sa/protocol/roster";
import { type RegisteredTool, registerTools } from "../mcp/registry.js";
import { requestApproval } from "./service.js";

const NEEDS_APPROVAL =
  " Needs approval: the person asking (or my owner) must approve before it happens.";
/** notes_create is offered to every template (it only writes into the current chat). */
const ALL_TEMPLATES = Object.keys(GATED_TOOLS);

type Def = Pick<RegisteredTool, "name" | "description" | "properties" | "required"> & {
  templates: readonly string[];
};

const DEFS: Def[] = [
  {
    name: "chat_send",
    description: `Post a message in another chat that you and I are both in.${NEEDS_APPROVAL}`,
    properties: {
      chat: { type: "string", minLength: 1, maxLength: 200 },
      text: { type: "string", minLength: 1, maxLength: 4000 },
    },
    required: ["chat", "text"],
    templates: templatesOf("chat_send"),
  },
  {
    name: "notes_create",
    description: `Save a note in this chat for everyone here to read.${NEEDS_APPROVAL}`,
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      body_md: { type: "string", minLength: 1, maxLength: 8000 },
    },
    required: ["title", "body_md"],
    templates: ALL_TEMPLATES,
  },
  {
    name: "email_send",
    description: `Save an email to the local outbox (nothing is sent over the network).${NEEDS_APPROVAL}`,
    properties: {
      to: { type: "string", minLength: 3, maxLength: 200 },
      subject: { type: "string", minLength: 1, maxLength: 200 },
      body: { type: "string", minLength: 1, maxLength: 8000 },
    },
    required: ["to", "subject", "body"],
    templates: templatesOf("email_send"),
  },
  {
    name: "ticket_comment",
    description: `Add a comment to a ticket.${NEEDS_APPROVAL}`,
    properties: {
      ticket_id: { type: "string", minLength: 1, maxLength: 40 },
      body: { type: "string", minLength: 1, maxLength: 4000 },
    },
    required: ["ticket_id", "body"],
    templates: templatesOf("ticket_comment"),
  },
];

function templatesOf(tool: string): string[] {
  return Object.entries(GATED_TOOLS)
    .filter(([, tools]) => tools.includes(tool))
    .map(([t]) => t);
}

function gatedTool(def: Def): RegisteredTool {
  return {
    name: def.name,
    description: def.description,
    properties: def.properties,
    ...(def.required ? { required: def.required } : {}),
    async run(ctx, args) {
      const turn = ctx.turn;
      if (!ctx.chatId || !turn) return "This needs a chat turn.";
      const r = await requestApproval({
        agentId: ctx.agentId,
        chatId: ctx.chatId,
        replyTo: turn.replyTo ?? turn.triggerMessageId,
        turnId: turn.turnId,
        requesterUserId: turn.requesterUserId,
        kind: "tool",
        tool: def.name,
        args,
      });
      return gateReply(r);
    },
  };
}

/** What the model reads after asking: pending names the approver; errors are plain text. */
export function gateReply(r: Awaited<ReturnType<typeof requestApproval>>): string {
  if (r.status === "error") return r.message;
  const a = r.approval;
  if (r.status === "pending") {
    return JSON.stringify({
      status: "pending",
      approval_id: a.id,
      approver: a.approver_name,
      message: `Waiting for ${a.approver_name} to approve. Tell them it is waiting for their approval in this thread. Do not call the tool again.`,
    });
  }
  if (r.status === "executed") {
    return JSON.stringify({ status: "executed", approval_id: a.id, message: a.result ?? "done" });
  }
  return `That did not work: ${a.result ?? "failed"}`;
}

/** Registers the gated MCP tools (idempotent: the registry replaces by name). */
export function registerGatedMcpTools(): void {
  for (const def of DEFS) registerTools(def.templates, [gatedTool(def)]);
}
