import { describe, expect, it } from "vitest";
import { Envelope, RelayOp, ClientOp } from "../src/index.js";

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
    expect(
      Envelope.safeParse({ ...base, kind: "status", to_device: "dev_00000002" }).success,
    ).toBe(false);
  });
});
