// Acceptance test for T12 session wiring. Assumed contracts:
//   - SessionProvider subscribes to onBridgeEvent (src/lib/bridge-events) and, on call.notes_published,
//     sets unread[chat_id] += 1 and mentions[chat_id] = true (new SessionValue field
//     `mentions: Record<string, boolean>`, the flag an @mention sets) and pushes the toast
//     "Notes from <title> are ready".
//   - The ToastProvider is an ancestor of SessionProvider.
import type { Chat } from "@sa/protocol";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

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
    onMessage() {
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
  const s = useSession() as ReturnType<typeof useSession> & {
    mentions?: Record<string, boolean>;
  };
  return (
    <span>
      {`phase:${s.phase} unread:${s.unread["chat-0001"] ?? 0} mention:${String(s.mentions?.["chat-0001"] === true)}`}
    </span>
  );
}

afterEach(cleanup);

it("call.notes_published marks the chat unread with a mention and shows the notes-ready toast", async () => {
  render(
    <ToastProvider>
      <SessionProvider session={{ token: "t", user: { id: "ana", display_name: "Ana" } }}>
        <Probe />
      </SessionProvider>
    </ToastProvider>,
  );
  await screen.findByText("phase:ready unread:0 mention:false");

  act(() =>
    dispatchBridgeEvent({
      type: "call.notes_published",
      call_id: "call-0001",
      chat_id: "chat-0001",
      message_id: "msg-0001",
      title: "Weekly sync",
    }),
  );

  expect(await screen.findByText("phase:ready unread:1 mention:true")).toBeTruthy();
  expect(screen.getByText("Notes from Weekly sync are ready")).toBeTruthy();
});
