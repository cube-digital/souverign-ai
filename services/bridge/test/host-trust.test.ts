import { cryptoReady } from "@sa/crypto";
import { expect, it, vi } from "vitest";
import { AgentHost } from "../src/agents/host.js";

type Trust = (chatId: string, sender: string) => Promise<boolean>;
const captured: { trust?: Trust } = {};

vi.mock("@sa/client", async (orig) => {
  const mod = await orig<typeof import("@sa/client")>();
  class SpyEngine extends mod.ChatEngine {
    constructor(opts: ConstructorParameters<typeof mod.ChatEngine>[0]) {
      super(opts);
      captured.trust = opts.isTrustedKeySender as Trust;
    }
  }
  return { ...mod, ChatEngine: SpyEngine };
});

import { FakeRelay } from "../../../packages/client/test/fake-relay.js";
import { EchoRuntime } from "../src/agents/echo.js";
import { openDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";

process.env.BRIDGE_MASTER_KEY = "test-master-key";

it("accepts epoch keys only from the chat owner's devices, not other members", async () => {
  await cryptoReady();
  const db = await openDb("pglite://memory");
  await migrate(db);
  for (const u of ["ana", "bob"])
    await db.query("insert into sa.users (id, display_name, pin_hash) values ($1,$1,'x')", [u]);
  for (const [id, u] of [
    ["dev-ana", "ana"],
    ["dev-bob", "bob"],
  ])
    await db.query(
      "insert into sa.devices (id, owner_type, owner_id, public_key) values ($1,'user',$2,$1)",
      [id, u],
    );
  await db.query(
    "insert into sa.chats (id, title, kind, created_by) values ('c1','T','group','ana')",
  );
  await db.query(
    "insert into sa.chat_members (chat_id, member_type, member_id, role) values ('c1','user','ana','owner'), ('c1','user','bob','member')",
  );
  await db.query(
    "insert into sa.agents (id, owner_user_id, name, template) values ('ag1','ana','Scout','general')",
  );
  await db.query(
    "insert into sa.devices (id, owner_type, owner_id, public_key) values ('dev-ag','agent','ag1','k')",
  );
  await db.query(
    "insert into sa.agent_devices (device_id, agent_id, enc_secret_key) values ('dev-ag','ag1','x')",
  );
  const { encrypt } = await import("../src/agents/secrets.js");
  const { newDeviceKeys } = await import("@sa/crypto");
  const keys = newDeviceKeys();
  await db.query("update sa.devices set public_key = $1 where id = 'dev-ag'", [keys.publicKey]);
  await db.query("update sa.agent_devices set enc_secret_key = $1", [encrypt(keys.secretKey)]);

  const relay = new FakeRelay();
  const host = new AgentHost({
    db,
    runtime: new EchoRuntime(),
    relayInternalUrl: "http://127.0.0.1:1",
    adminToken: "t",
    linkFactory: (d: string) => relay.link(d),
  });
  await host.onAgentAdded("c1", "ag1");
  expect(await captured.trust?.("c1", "dev-ana")).toBe(true);
  expect(await captured.trust?.("c1", "dev-bob")).toBe(false);
  await host.stopAll();
  await db.close();
});
