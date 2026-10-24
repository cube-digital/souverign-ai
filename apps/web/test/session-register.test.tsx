import type { Chat } from "@sa/protocol";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  trust: null as null | ((chatId: string, dev: string) => Promise<boolean>),
}));

vi.mock("../src/api", () => ({
  SHARED_TICKET_KEY: "sa.relay-ticket",
  registerDevice: vi.fn(async () => ({})),
  relayTicket: vi.fn(async () => ({ ticket: "ticket-0123456789", expires_at: Date.now() + 9e6 })),
  chats: vi.fn(async () => []),
  hello: vi.fn(async () => ({ catchup: false })),
}));
vi.mock("../src/lib/idb-keystore", () => ({
  IdbKeyStore: class {
    constructor(private userId: string) {}
    async getDevice() {
      return { deviceId: `dev-${this.userId}`, keys: { publicKey: "pk", secretKey: "sk" } };
    }
    async putDevice() {}
  },
}));
vi.mock("@sa/crypto", () => ({
  cryptoReady: async () => {},
  deviceIdFor: () => "dev-x",
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
    constructor(opts: { isTrustedKeySender: (c: string, d: string) => Promise<boolean> }) {
      h.trust = opts.isTrustedKeySender;
    }
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

import * as api from "../src/api";
import { SessionProvider, useSession } from "../src/state/session";

const dev = (id: string) => ({ device_id: id, public_key: "k" });
const member = (id: string, type: "user" | "agent", role: "owner" | "member", d: string) => ({
  member_type: type,
  member_id: id,
  display_name: id,
  role,
  devices: [dev(d)],
});
const chatWith = (members: Chat["members"]): Chat => ({
  id: "chat-0001",
  title: "T",
  kind: "group",
  created_by: "ana",
  members,
});
const base = [
  member("ana", "user", "owner", "dev-ana"),
  member("nora", "agent", "member", "dev-nora"),
];

function Probe() {
  return <span>phase:{useSession().phase}</span>;
}
const mount = (id: string, strict: boolean) => {
  const tree = (
    <SessionProvider session={{ token: "t", user: { id, display_name: id } }}>
      <Probe />
    </SessionProvider>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
};

beforeEach(() => {
  vi.mocked(api.registerDevice).mockClear();
  vi.mocked(api.hello).mockClear();
  vi.mocked(api.chats).mockReset();
  h.trust = null;
});
afterEach(cleanup);

it("registers the device once and says hello once even when StrictMode mounts twice", async () => {
  vi.mocked(api.chats).mockResolvedValue([]);
  mount("strict-user", true);
  await screen.findByText("phase:ready");
  expect(api.registerDevice).toHaveBeenCalledTimes(1);
  expect(api.registerDevice).toHaveBeenCalledWith({
    device_id: "dev-strict-user",
    public_key: "pk",
  });
  await waitFor(() => expect(api.hello).toHaveBeenCalledTimes(1));
});

it("accepts chat keys from any active human member after a refresh, never from agents or strangers", async () => {
  const bob = member("bob", "user", "member", "dev-bob");
  vi.mocked(api.chats)
    .mockResolvedValueOnce([chatWith(base)])
    .mockResolvedValue([chatWith([...base, bob])]);
  mount("trust-user", false);
  await screen.findByText("phase:ready");
  expect(await h.trust?.("chat-0001", "dev-ana")).toBe(true);
  expect(await h.trust?.("chat-0001", "dev-bob")).toBe(true);
  expect(await h.trust?.("chat-0001", "dev-nora")).toBe(false);
  expect(await h.trust?.("chat-0001", "dev-stranger")).toBe(false);
  expect(await h.trust?.("other-chat", "dev-ana")).toBe(false);
});
