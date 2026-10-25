import type { Note } from "@sa/protocol";
import { chatSend, emailSend, notesCreate, ticketComment } from "../approvals/executors.js";
import { registerGatedTool } from "../approvals/service.js";
import { isHumanMember } from "../approvals/store.js";
import { registerGatedMcpTools } from "../approvals/tools.js";
import { forgetGatedTool, registerForgetTool } from "../memory/forget.js";
import type { BridgePlugin } from "../plugin-api.js";

const MAX_NOTES = 100;

/** chat_send, notes_create, email_send, ticket_comment and memory_forget, all behind approvals. */
export const plugin: BridgePlugin = {
  name: "gated-tools",
  async init() {
    registerGatedMcpTools();
    registerGatedTool("chat_send", { executor: chatSend });
    registerGatedTool("notes_create", { executor: notesCreate });
    registerGatedTool("email_send", { executor: emailSend });
    registerGatedTool("ticket_comment", { executor: ticketComment });
    registerForgetTool();
    registerGatedTool("memory_forget", forgetGatedTool);
  },
  routes(app, { db, authenticate }) {
    app.get("/api/chats/:id/notes", async (req, reply) => {
      const userId = await authenticate(req, reply);
      if (!userId) return;
      const chatId = (req.params as { id: string }).id;
      if (!(await isHumanMember(db, chatId, userId))) {
        return reply.code(404).send({ error: "not_found" });
      }
      const rows = await db.query<Omit<Note, "created_at"> & { created_ms: number }>(
        `select n.id, n.agent_id, a.name as agent_name, n.chat_id, n.title, n.body_md,
                (extract(epoch from n.created_at) * 1000)::float8 as created_ms
           from sa.notes n join sa.agents a on a.id = n.agent_id
          where n.chat_id = $1 order by n.created_at desc, n.id desc limit ${MAX_NOTES}`,
        [chatId],
      );
      return rows.map(
        ({ created_ms, ...n }): Note => ({ ...n, created_at: Math.round(Number(created_ms)) }),
      );
    });
  },
};
