import { AccessToken, TrackSource } from "livekit-server-sdk";

export const API_KEY = "sa-dev";
const TTL = "2h";

export const roomName = (callId: string): string => `call-${callId}`;

const secret = (given?: string): string => {
  const s = given ?? process.env.LIVEKIT_API_SECRET;
  if (!s) throw new Error("LIVEKIT_API_SECRET is not set");
  return s;
};

/** A person: microphone only, no data channel. */
export function userToken(a: { callId: string; userId: string; name: string }): Promise<string> {
  const t = new AccessToken(API_KEY, secret(), {
    identity: `user:${a.userId}`,
    name: a.name,
    ttl: TTL,
  });
  t.addGrant({
    room: roomName(a.callId),
    roomJoin: true,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE],
    canPublishData: false,
    canSubscribe: true,
  });
  return t.toJwt();
}

/** The notetaker never publishes audio, video or data (D-4). */
export function notetakerToken(a: {
  callId: string;
  agentId: string;
  invitedByName: string;
  /** defaults to LIVEKIT_API_SECRET */
  secret?: string;
}): Promise<string> {
  const t = new AccessToken(API_KEY, secret(a.secret), {
    identity: `agent:${a.agentId}`,
    name: "Scribe · taking notes",
    metadata: JSON.stringify({ purpose: "notes", invited_by: a.invitedByName }),
    ttl: TTL,
  });
  t.addGrant({
    room: roomName(a.callId),
    roomJoin: true,
    canPublish: false,
    canPublishData: false,
    canSubscribe: true,
    hidden: false,
  });
  return t.toJwt();
}
