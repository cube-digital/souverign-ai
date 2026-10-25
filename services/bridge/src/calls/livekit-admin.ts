import { RoomServiceClient } from "livekit-server-sdk";
import type { Log } from "../plugin-api.js";
import { livekitAvailable, livekitUrl } from "./livekit-health.js";
import { API_KEY, roomName } from "./tokens.js";

export interface RoomAdmin {
  removeParticipant(room: string, identity: string): Promise<void>;
  deleteRoom(room: string): Promise<void>;
}
let override: RoomAdmin | undefined;
/** Tests only. */
export function setRoomAdminForTests(a: RoomAdmin | undefined): void {
  override = a;
}

async function admin(): Promise<RoomAdmin | null> {
  if (override) return override;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!secret || !(await livekitAvailable())) return null;
  const c = new RoomServiceClient(livekitUrl().replace(/^ws/, "http"), API_KEY, secret);
  return {
    removeParticipant: (r, i) => c.removeParticipant(r, i),
    deleteRoom: (r) => c.deleteRoom(r),
  };
}

const TIMEOUT_MS = 5000;

/**
 * True when the action happened or there is nothing to do (no call server running);
 * false when the call server failed or timed out, so the caller can try again later.
 */
async function run(log: Log, code: string, fn: (a: RoomAdmin) => Promise<void>): Promise<boolean> {
  try {
    if (!process.env.LIVEKIT_API_SECRET && !override) {
      // The call server is not configured at all: there is no room to act on.
      log("livekit admin skipped", { code: "livekit_not_configured", action: code });
      return true;
    }
    const a = await admin();
    if (!a) {
      // Configured but not answering: report failure so the caller tries again.
      log("livekit admin skipped", { code: "livekit_unavailable", action: code });
      return false;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
    });
    try {
      await Promise.race([fn(a), timeout]);
    } finally {
      clearTimeout(timer);
    }
    return true;
  } catch (e) {
    const err = e as { status?: number; code?: string };
    // The participant or room is already gone: nothing left to do.
    if (err.status === 404 || err.code === "not_found") return true;
    log("livekit admin failed", { code, error: (e as Error).name });
    return false;
  }
}

/** Removes a person from the room. */
export const kickFromRoom = (callId: string, userId: string, log: Log): Promise<boolean> =>
  run(log, "kick", (a) => a.removeParticipant(roomName(callId), `user:${userId}`));

/** Deletes the room so an old token cannot keep it alive. */
export const closeRoom = (callId: string, log: Log): Promise<boolean> =>
  run(log, "close", (a) => a.deleteRoom(roomName(callId)));
