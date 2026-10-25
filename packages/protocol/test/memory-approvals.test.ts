import { describe, expect, it } from "vitest";
import { AnswerRequest, Approval, MessageBody, ServerEvent } from "../src/index.js";

const approval = {
  id: "apr_1",
  agent_id: "agent-1",
  agent_name: "Ops",
  chat_id: "chat_0000001",
  chat_title: "Ops",
  reply_to: null,
  kind: "tool",
  tool: "notes_publish",
  args: { title: "t" },
  preview: { title: "Publish", target: "chat", fields: [], leaves_chat: false },
  status: "pending",
  requester_user_id: "u1",
  approver_user_id: "u1",
  approver_name: "Ana",
  decided_by: null,
  decided_at: null,
  created_at: 1,
  expires_at: 2,
  result: null,
  auto: false,
  always_allowed: true,
};

describe("memory and approvals protocol", () => {
  it("accepts citations, approval meta and the new server events", () => {
    const citation = (extra: object) => ({
      n: 1,
      kind: "knowledge",
      title: null,
      ts: 5,
      cited: true,
      ...extra,
    });
    const text = MessageBody.safeParse({
      type: "text",
      text: "see [1] [2]",
      meta: {
        citations: [
          citation({
            space: "chat",
            source_type: "message",
            source_id: "m1",
            chat_id: "chat_0000001",
            message_id: "msg_0000001",
          }),
          citation({
            n: 2,
            space: "agent",
            source_type: "doc",
            source_id: "k1",
            agent_id: "agent-1",
            item_id: "k1",
            page: 3,
            taught_by: "Ana",
          }),
        ],
        approvals: ["apr_1"],
        approval: { id: "apr_1", status: "canceled" },
        held: "apr_1",
        approved_by: "Ana",
        question: { id: "q1", options: ["a", "b"] },
      },
    });
    expect(text.success).toBe(true);
    const pub = ServerEvent.safeParse({
      type: "approval_public",
      approval: {
        id: "apr_1",
        chat_id: "chat_0000001",
        agent_name: "Ops",
        tool: "notes_publish",
        status: "pending",
        approver_name: "Ana",
        requester_user_id: null,
      },
    });
    expect(pub.success).toBe(true);
    const q = ServerEvent.safeParse({
      type: "question",
      question: {
        id: "q1",
        agent_id: "agent-1",
        agent_name: "Ops",
        chat_id: "chat_0000001",
        reply_to: null,
        requester_user_id: "u1",
        requester_name: "Ana",
        question: "Which?",
        options: ["a", "b"],
        status: "open",
        answer: null,
        created_at: 1,
        expires_at: 2,
      },
    });
    expect(q.success).toBe(true);
  });

  it("treats gated tool names as an open registry and rejects unknown statuses", () => {
    expect(Approval.safeParse(approval).success).toBe(true);
    expect(Approval.safeParse({ ...approval, tool: "call_notes_publish" }).success).toBe(true);
    expect(Approval.safeParse({ ...approval, status: "canceled" }).success).toBe(true);
    expect(Approval.safeParse({ ...approval, status: "maybe" }).success).toBe(false);
    expect(Approval.safeParse({ ...approval, tool: "Bad-Name" }).success).toBe(false);
  });

  it("requires exactly one of option or text in an answer", () => {
    expect(AnswerRequest.safeParse({ option: 1 }).success).toBe(true);
    expect(AnswerRequest.safeParse({ text: "yes" }).success).toBe(true);
    expect(AnswerRequest.safeParse({ option: 1, text: "yes" }).success).toBe(false);
    expect(AnswerRequest.safeParse({}).success).toBe(false);
  });
});
