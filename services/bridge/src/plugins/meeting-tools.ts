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
            return JSON.stringify(await meetingTranscript(db, ctx, args)).slice(0, 60_000);
          },
        },
      ],
    );
  },
};
