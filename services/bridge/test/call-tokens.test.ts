import { jwtVerify } from "jose";
import { afterEach, beforeEach, expect, it } from "vitest";
import { notetakerToken, roomName, userToken } from "../src/calls/tokens.js";
import { LK_SECRET } from "./call-fixture.js";

const saved = process.env.LIVEKIT_API_SECRET;
beforeEach(() => {
  process.env.LIVEKIT_API_SECRET = LK_SECRET;
});
afterEach(() => {
  if (saved === undefined) delete process.env.LIVEKIT_API_SECRET;
  else process.env.LIVEKIT_API_SECRET = saved;
});

const decode = async (token: string) =>
  (await jwtVerify(token, new TextEncoder().encode(LK_SECRET), { issuer: "sa-dev" })).payload as {
    sub: string;
    name: string;
    metadata?: string;
    exp: number;
    video: Record<string, unknown>;
  };

it("user tokens can only publish the microphone; the notetaker token cannot publish anything (D-4); both are scoped to one room and identity", async () => {
  expect(roomName("abc12345")).toBe("call-abc12345");

  const user = await decode(await userToken({ callId: "abc12345", userId: "bob", name: "Bob" }));
  expect(user.sub).toBe("user:bob");
  expect(user.name).toBe("Bob");
  expect(user.video).toMatchObject({
    room: "call-abc12345",
    roomJoin: true,
    canPublish: true,
    canPublishSources: ["microphone"],
    canPublishData: false,
    canSubscribe: true,
  });
  // TTL is 2 h
  expect(user.exp * 1000 - Date.now()).toBeGreaterThan(7190_000);
  expect(user.exp * 1000 - Date.now()).toBeLessThanOrEqual(7201_000);

  const nt = await decode(
    await notetakerToken({ callId: "abc12345", agentId: "scribe", invitedByName: "Ana" }),
  );
  expect(nt.sub).toBe("agent:scribe");
  expect(nt.name).toBe("Scribe · taking notes");
  expect(JSON.parse(nt.metadata ?? "{}")).toEqual({ purpose: "notes", invited_by: "Ana" });
  expect(nt.video).toMatchObject({
    room: "call-abc12345",
    roomJoin: true,
    canPublish: false,
    canPublishData: false,
    canSubscribe: true,
  });
  expect(nt.video.hidden).not.toBe(true);
});
