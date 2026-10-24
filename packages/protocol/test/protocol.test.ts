import { describe, expect, it } from "vitest";
import {
  ActivityBody,
  Agent,
  ClientOp,
  CreateRoutineRequest,
  Envelope,
  MessageBody,
  RelayMemberChange,
  RelayOp,
  TextMeta,
} from "../src/index.js";

const base = {
  v: 1,
  id: "env_00000001",
  chat_id: "chat_0000001",
  sender_device: "dev_00000001",
  epoch: 1,
  nonce: "",
  ciphertext: "AAAA",
  ts: 1,
} as const;

describe("Envelope", () => {
  it("requires to_device exactly for key envelopes", () => {
    expect(Envelope.safeParse({ ...base, kind: "msg" }).success).toBe(true);
    expect(Envelope.safeParse({ ...base, kind: "key", to_device: "dev_00000002" }).success).toBe(
      true,
    );
    expect(Envelope.safeParse({ ...base, kind: "key" }).success).toBe(false);
    expect(Envelope.safeParse({ ...base, kind: "msg", to_device: "dev_00000002" }).success).toBe(
      false,
    );
  });
});

describe("signal ops", () => {
  it("carry ephemeral status envelopes that never target a single device", () => {
    const status = { ...base, kind: "status" } as const;
    expect(ClientOp.safeParse({ op: "signal", env: status }).success).toBe(true);
    expect(RelayOp.safeParse({ op: "signal", env: status }).success).toBe(true);
    expect(Envelope.safeParse({ ...base, kind: "status", to_device: "dev_00000002" }).success).toBe(
      false,
    );
  });
});

describe("teammates protocol", () => {
  it("accepts reactions and thread replies, rejects a bad reply_to, and lets members carry history_until_seq", () => {
    expect(
      MessageBody.safeParse({ type: "reaction", target: "msg_0000001", emoji: "👍", op: "add" })
        .success,
    ).toBe(true);
    expect(
      MessageBody.safeParse({ type: "reaction", target: "msg_0000001", emoji: "👍", op: "toggle" })
        .success,
    ).toBe(false);
    expect(
      MessageBody.safeParse({ type: "text", text: "hi", reply_to: "msg_0000001" }).success,
    ).toBe(true);
    expect(MessageBody.safeParse({ type: "text", text: "hi", reply_to: "bad id!" }).success).toBe(
      false,
    );
    const change = { chat_id: "chat_0000001", device_id: "dev_00000001", op: "add" };
    expect(RelayMemberChange.safeParse({ ...change, history_until_seq: 12 }).success).toBe(true);
    expect(RelayMemberChange.safeParse({ ...change, history_until_seq: -1 }).success).toBe(false);
  });

  it("fixes the shape of agents, routines and the roster", async () => {
    const agent = {
      id: "a1",
      name: "Ops",
      template: "ops",
      soul: "",
      owner_user_id: null,
      device_id: "dev_00000001",
      status: "online",
      scope: "workspace",
      roster_id: "ops",
    };
    expect(Agent.safeParse(agent).success).toBe(true);
    expect(Agent.safeParse({ ...agent, scope: "team" }).success).toBe(false);
    expect(Agent.safeParse({ ...agent, template: "nope" }).success).toBe(false);

    const routine = {
      agent_id: "a1",
      chat_id: "chat_0000001",
      days: [1, 2, 3],
      time: "09:30",
      prompt: "  standup  ",
    };
    expect(CreateRoutineRequest.parse(routine).prompt).toBe("standup");
    expect(CreateRoutineRequest.safeParse({ ...routine, time: "24:00" }).success).toBe(false);
    expect(CreateRoutineRequest.safeParse({ ...routine, days: [] }).success).toBe(false);
    expect(CreateRoutineRequest.safeParse({ ...routine, days: [7] }).success).toBe(false);

    const { ROSTER, SEED_CHANNELS, AUTONOMY, rosterEntry, TEMPLATE_INFO } = await import(
      "../src/roster.js"
    );
    expect(ROSTER.map((r) => r.id)).toEqual(["ops", "qa", "dev", "tech", "sales", "scribe"]);
    expect(SEED_CHANNELS.map((c) => c.key)).toEqual(["general", "ops", "release-7.4", "sales"]);
    expect(AUTONOMY).toBe("reads and drafts · no writes");
    expect(rosterEntry("qa")?.channels).toEqual(["general", "release-7.4"]);
    expect(rosterEntry("sales")?.warning).toEqual({
      outside: "sales",
      text: "Sales can read CRM accounts and deals.",
    });
    expect(rosterEntry("nobody")).toBeUndefined();
    expect(TEMPLATE_INFO.tech?.tools).toEqual(["chat_read", "docs_search", "doc_read"]);
    expect(TEMPLATE_INFO.general?.tools).toEqual(["chat_read", "image_generate"]);
  });

  it("fixes the shape of activity, queue state and receipts", () => {
    expect(
      ActivityBody.safeParse({
        type: "activity",
        phase: "queued",
        ahead: 2,
        count: 5,
        turn_id: "turn_0000001",
        reply_to: "msg_0000001",
        requester: "u1",
      }).success,
    ).toBe(true);
    expect(ActivityBody.safeParse({ type: "activity", phase: "stopped" }).success).toBe(true);
    expect(ActivityBody.safeParse({ type: "activity", phase: "queued", ahead: -1 }).success).toBe(
      false,
    );
    expect(ActivityBody.safeParse({ type: "activity", phase: "paused" }).success).toBe(false);

    expect(
      TextMeta.safeParse({ seeded: true, trigger: "welcome", chips: ["a", "b", "c"], local: true })
        .success,
    ).toBe(true);
    expect(TextMeta.safeParse({ chips: ["a", "b", "c", "d"] }).success).toBe(false);
    expect(TextMeta.safeParse({ chips: [""] }).success).toBe(false);
    expect(TextMeta.safeParse({ trigger: "cron" }).success).toBe(false);
    for (const trigger of [
      "mention",
      "followup",
      "dm",
      "access",
      "alert",
      "catchup",
      "routine",
      "welcome",
      "intro",
    ]) {
      expect(TextMeta.safeParse({ trigger }).success).toBe(true);
    }
  });
});
