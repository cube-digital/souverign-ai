import type { Chat } from "@sa/protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ onMessage: (_m: unknown) => {} }));

vi.mock("../src/api", () => ({
  SHARED_TICKET_KEY: "sa.relay-ticket",
  registerDevice: vi.fn(async () => ({})),
  relayTicket: vi.fn(async () => ({ ticket: "ticket-0123456789", expires_at: Date.now() + 9e6 })),
  chats: vi.fn(async () => [
    {
      id: "chat-0001",
      title: "T",
      kind: "group",
      created_by: "ana",
      members: [],
    } satisfies Chat,
  ]),
  hello: vi.fn(async () => ({ catchup: false })),
}));
vi.mock("../src/lib/idb-keystore", () => ({
  IdbKeyStore: class {
    async getDevice() {
      return { deviceId: "dev-ana", keys: { publicKey: "pk", secretKey: "sk" } };
    }
    async putDevice() {}
  },
}));
vi.mock("@sa/crypto", () => ({
  cryptoReady: async () => {},
  deviceIdFor: () => "dev-ana",
  newDeviceKeys: () => ({ publicKey: "pk", secretKey: "sk" }),
}));
vi.mock("@sa/client", () => ({
  RelayClient: class {
    onStatus() {
      return () => {};
    }
    async connect() {}
    close() {}
  },
  ChatEngine: class {
    onMessage(cb: (m: unknown) => void) {
      h.onMessage = cb;
      return () => {};
    }
    onActivity() {
      return () => {};
    }
    onKey() {
      return () => {};
    }
    async start() {}
  },
}));

import { ToastProvider } from "../src/ds";
import { dispatchBridgeEvent } from "../src/lib/bridge-events";
import { SessionProvider, useSession } from "../src/state/session";

function Probe() {
  const s = useSession();
  return <span>{`phase:${s.phase} unread:${s.unread["chat-0001"] ?? 0}`}</span>;
}

afterEach(cleanup);

it("published call notes count once, and the toast's Open goes to the call thread they sit in", async () => {
  render(
    <ToastProvider>
      <SessionProvider session={{ token: "t", user: { id: "ana", display_name: "Ana" } }}>
        <Probe />
      </SessionProvider>
    </ToastProvider>,
  );
  await screen.findByText("phase:ready unread:0");

  act(() =>
    h.onMessage({
      id: "msg-notes",
      chatId: "chat-0001",
      seq: 5,
      senderDevice: "dev-scribe",
      ts: Date.now(),
      status: "ok",
      body: {
        type: "text",
        text: "Call notes",
        reply_to: "msg-call-root",
        meta: { meeting: { call_id: "call-0001", notes_id: "n1" } },
      },
    }),
  );
  act(() =>
    dispatchBridgeEvent({
      type: "call.notes_published",
      call_id: "call-0001",
      chat_id: "chat-0001",
      message_id: "msg-notes",
      title: "Weekly sync",
    }),
  );
  expect(await screen.findByText("phase:ready unread:1")).toBeTruthy();
  expect(screen.getByText("Notes from Weekly sync are ready")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(window.location.pathname).toBe("/c/chat-0001/t/msg-call-root");
});
