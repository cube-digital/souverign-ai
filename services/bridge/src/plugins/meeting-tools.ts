import { meetingTranscript } from "../calls/transcript.js";
import { registerTools } from "../mcp/registry.js";
import type { BridgePlugin } from "../plugin-api.js";

/** meeting_transcript: published call notes in the call's chat, drafts and transcript for the inviter's DM. */
export const plugin: BridgePlugin = {
  name: "meeting-tools",
  async init({ db }) {
    registerTools(
      ["scribe"],
      [
        {
          name: "meeting_transcript",
          description:
            "Notes of a call held in this chat (published notes only). In your DM with the person who invited you, also their drafts and the transcript. Cite lines as [mm:ss Name].",
          properties: { call_id: { type: "string" }, query: { type: "string", maxLength: 200 } },
          async run(ctx, args) {
            const out = await meetingTranscript(db, ctx, args);
            let text = JSON.stringify(out);
            // shrink the data, never the serialized string, so the result stays valid JSON
            while (
              text.length > 60_000 &&
              Array.isArray(out.transcript) &&
              out.transcript.length > 0
            ) {
              out.transcript = out.transcript.slice(Math.ceil(out.transcript.length / 4));
              out.truncated = true;
              text = JSON.stringify(out);
            }
            if (text.length > 60_000) {
              out.notes_md = String(out.notes_md ?? "").slice(0, 20_000);
              out.action_items = [];
              text = JSON.stringify(out);
            }
            return text;
          },
        },
      ],
    );
  },
};
