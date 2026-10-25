import { afterEach, expect, it } from "vitest";
import { decide } from "../src/approvals/service.js";
import { meetingTranscript } from "../src/calls/transcript.js";
import { type CallsWorld, callsWorld } from "./call-fixture.js";

let w: CallsWorld;
afterEach(async () => {
  await w.close();
});

const REMOVED = "They agreed on the Friday plan.";

it("after an edited approval, meeting_transcript in the call's chat returns only the approved text and its action items (D-3)", async () => {
  w = await callsWorld();
  const n = await w.finalNotes();
  const draft = String(n.args.text);
  expect(draft).toContain(REMOVED);
  const edited = draft
    .replace(`${REMOVED}\n`, "")
    .replace("- [ ] Ana: send the draft (due: Monday)", "- [ ] Bob: book the room (due: Thursday)");
  expect(edited).not.toContain(REMOVED);

  const r = await decide(n.approvalId, "ana", { decision: "approve", args: { text: edited } });
  expect(r).toMatchObject({ ok: true, approval: { status: "executed" } });

  for (const who of ["bob", "ana"]) {
    const out = await meetingTranscript(
      w.db,
      {
        db: w.db,
        agentId: "scribe",
        template: "scribe",
        chatId: "c1",
        requesterUserId: who,
        opsSimUrl: "",
      },
      {},
    );
    expect(out.call_id).toBe(n.callId);
    expect(out.published).toBe(true);
    expect(out.notes_md).toBe(edited);
    expect(out.action_items).toEqual([{ owner: "Bob", text: "book the room", due: "Thursday" }]);
    expect(JSON.stringify(out)).not.toContain(REMOVED);
    expect(JSON.stringify(out)).not.toContain("send the draft");
  }
});
