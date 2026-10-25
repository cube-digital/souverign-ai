import type { Chat } from "@sa/protocol";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ agentDm: vi.fn() }));
vi.mock("../src/api", () => api);

import { openAgentDm } from "../src/state/agentDm";

const device = { device_id: "dev-agent", public_key: "pk" };
const dm = (key_epoch: number): Chat =>
  ({
    id: "dm-1",
    title: "Scribe",
    kind: "dm",
    created_by: "ana",
    key_epoch,
    members: [{ member_type: "agent", member_id: "ag-scribe", role: "member", devices: [device] }],
  }) as unknown as Chat;

it("mints the unspent epoch the bridge hands out for a DM another device keyed, never a second epoch 1", async () => {
  api.agentDm.mockResolvedValueOnce(dm(3));
  const engine = { latestEpoch: vi.fn(async () => 0), createEpoch: vi.fn(async () => 3) };
  await openAgentDm({ engine, refreshChats: async () => [] }, "ag-scribe");
  expect(engine.createEpoch).toHaveBeenCalledExactlyOnceWith("dm-1", [device], 3);
});
