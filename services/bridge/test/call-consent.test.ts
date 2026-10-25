import type { CallInfo } from "@sa/protocol";
import { expect, it } from "vitest";
import { capturable, consentOf, notCapturedCount } from "../src/calls/consent.js";

type P = CallInfo["participants"][number];
const p = (user_id: string, in_call: boolean, consent: P["consent"]): P => ({
  user_id,
  name: user_id,
  in_call,
  consent,
});
const call = (status: "active" | "stopped", participants: P[]): CallInfo => ({
  id: "call0001",
  chat_id: "c1",
  room: "call-call0001",
  started_by: "ana",
  started_at: 1_000,
  ended_at: null,
  anchor_message_id: null,
  e2ee: false,
  participants,
  notetaker: {
    id: "nt000001",
    agent_id: "scribe",
    agent_name: "Scribe",
    invited_by: "ana",
    invited_by_name: "ana",
    invited_at: 1_000,
    status,
    worker: "fake",
    stopped_by_name: null,
  },
});
const people = [
  p("ana", true, "accepted"),
  p("bob", true, "accepted"),
  p("dan", true, "declined"),
  p("eve", true, "pending"),
  p("fay", false, "accepted"),
];

it("only an accepted person who is in the call is capturable while the notetaker is active; the inviter always consents", () => {
  expect(consentOf("ana", "ana", {})).toBe("accepted");
  expect(consentOf("bob", "ana", {})).toBe("pending");
  expect(consentOf("bob", "ana", { bob: "declined" })).toBe("declined");
  expect(consentOf("bob", "ana", { bob: "accepted" })).toBe("accepted");

  const active = call("active", people);
  expect(["ana", "bob", "dan", "eve", "fay", "ghost"].map((u) => capturable(u, active))).toEqual([
    true,
    true,
    false, // declined
    false, // never answered
    false, // accepted but left
    false, // not in the call at all
  ]);
  const stopped = call("stopped", people);
  expect(["ana", "bob"].map((u) => capturable(u, stopped))).toEqual([false, false]);

  // joined five, three accepted (fay left but had accepted): two not captured
  expect(notCapturedCount(active)).toBe(2);
});
