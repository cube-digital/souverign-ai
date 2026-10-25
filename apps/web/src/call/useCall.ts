import type { Agent, CallInfo, CallNotes, CallSegment } from "@sa/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { getSession } from "../api";
import { onBridgeEvent } from "../lib/bridge-events";
import { addAgentWithKey } from "../state/membership";
import { useSession } from "../state/session";
import { callApi } from "./api";
import type { MediaSession } from "./media";

export type MediaStatus = "connecting" | "connected" | "failed" | "off";

// A leave is deferred one tick so a StrictMode remount (or a quick re-entry) can cancel it.
const pendingLeave = new Map<string, ReturnType<typeof setTimeout>>();

/** Fire-and-forget leave that survives the page going away; sendBeacon cannot carry the header. */
function leaveKeepalive(callId: string): void {
  try {
    const headers: Record<string, string> = {};
    const s = getSession();
    if (s) headers.Authorization = `Bearer ${s.token}`;
    void fetch(`/api/calls/${encodeURIComponent(callId)}/leave`, {
      method: "POST",
      keepalive: true,
      headers,
    }).catch(() => {});
  } catch {
    /* nothing to do: the bridge also drops people whose connection ends */
  }
}

export function useCall(chatId: string, callId: string) {
  const { user, chats, messages, engine, refreshChats } = useSession();
  const [info, setInfo] = useState<CallInfo | null>(null);
  const [segments, setSegments] = useState<CallSegment[]>([]);
  const [notes, setNotes] = useState<CallNotes | null>(null);
  const [media, setMedia] = useState<MediaStatus>("connecting");
  const [speaking, setSpeaking] = useState<ReadonlySet<string>>(new Set());
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRef = useRef<MediaSession | null>(null);

  const e2ee = info?.e2ee ?? null;
  const mediaKey = (() => {
    for (const list of Object.values(messages)) {
      for (const m of list) {
        const c = m.body?.type === "text" ? m.body.meta?.call : undefined;
        if (c?.call_id === callId && c.media_key) return c.media_key;
      }
    }
    return undefined;
  })();

  const inviterId = info?.notetaker?.invited_by ?? null;
  const isInviter = inviterId !== null && inviterId === user.id;

  // Load the call and the lines captured so far.
  useEffect(() => {
    let live = true;
    callApi.get(callId).then(
      (i) => live && setInfo(i),
      () => live && setError("Could not load the call."),
    );
    callApi.segments(callId).then(
      (r) => live && setSegments(r.segments),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [callId]);

  // Notes exist for the inviter only; nobody else asks for them.
  const loadNotes = useCallback(() => {
    callApi.notes(callId).then(setNotes, () => {});
  }, [callId]);
  useEffect(() => {
    if (isInviter) loadNotes();
  }, [isInviter, loadNotes]);

  useEffect(
    () =>
      onBridgeEvent((ev) => {
        if (ev.type === "call.updated" && ev.call.id === callId) setInfo(ev.call);
        else if (ev.type === "call.segment" && ev.call_id === callId) {
          setSegments((cur) =>
            cur.some((s) => s.id === ev.segment.id) ? cur : [...cur, ev.segment],
          );
        } else if (ev.type === "call.notes" && ev.call_id === callId && isInviter) loadNotes();
      }),
    [callId, isInviter, loadNotes],
  );

  // Media: ask for a token, then connect (lazy) unless there is no call server. With end-to-end
  // audio the chat key arrives with the anchor message; never connect without it.
  useEffect(() => {
    if (e2ee === null) return;
    if (e2ee && !mediaKey) {
      setMedia("connecting");
      const t = setTimeout(() => setMedia("failed"), 10_000);
      return () => clearTimeout(t);
    }
    let live = true;
    let session: MediaSession | null = null;
    let unsub: Array<() => void> = [];
    (async () => {
      try {
        const tok = await callApi.token(callId);
        if (!live) return;
        if (!tok.available) {
          setMedia("off");
          return;
        }
        const { connectMedia } = await import("./media");
        const s = await connectMedia({
          url: tok.url,
          token: tok.token,
          ...(e2ee && mediaKey ? { e2eeKey: mediaKey } : {}),
        });
        if (!live) {
          void s.leave();
          return;
        }
        session = s;
        mediaRef.current = s;
        unsub = [
          s.onState(setMedia),
          s.onActiveSpeakers((ids) =>
            setSpeaking(new Set(ids.map((i) => i.replace(/^user:/, "")))),
          ),
        ];
      } catch {
        if (live) setMedia("failed");
      }
    })();
    return () => {
      live = false;
      for (const u of unsub) u();
      if (session) {
        void session.leave();
        if (mediaRef.current === session) mediaRef.current = null;
      }
    };
  }, [callId, e2ee, mediaKey]);

  // Leave when the tab goes away and on a real unmount (not a StrictMode remount).
  useEffect(() => {
    const pending = pendingLeave.get(callId);
    if (pending) {
      clearTimeout(pending);
      pendingLeave.delete(callId);
    }
    const onHide = () => leaveKeepalive(callId);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      pendingLeave.set(
        callId,
        setTimeout(() => {
          pendingLeave.delete(callId);
          leaveKeepalive(callId);
        }, 0),
      );
    };
  }, [callId]);

  const run = useCallback(async (fn: () => Promise<CallInfo | unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (r && typeof r === "object" && "participants" in r) setInfo(r as CallInfo);
    } catch {
      setError("That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }, []);

  const findMediaKey = useCallback(() => {
    const list = messages[chatId] ?? [];
    for (const m of list) {
      const c = m.body?.type === "text" ? m.body.meta?.call : undefined;
      if (c?.call_id === callId && c.media_key) return c.media_key;
    }
    return undefined;
  }, [messages, chatId, callId]);

  return {
    me: user,
    chat: chats.find((c) => c.id === chatId) ?? null,
    info,
    segments,
    notes,
    media,
    speaking,
    muted,
    busy,
    error,
    isInviter,
    consent: (answer: "accepted" | "declined") => run(() => callApi.consent(callId, answer)),
    stop: () => run(() => callApi.stop(callId)),
    end: () => run(() => callApi.end(callId)),
    leave: async () => {
      await callApi.leave(callId).catch(() => {});
      await mediaRef.current?.leave();
      mediaRef.current = null;
    },
    toggleMute: async () => {
      const next = !muted;
      await mediaRef.current?.mute(next);
      setMuted(next);
    },
    addNotetaker: () =>
      run(async () => {
        const chat = chats.find((c) => c.id === chatId);
        if (!chat || !engine) throw new Error("no chat");
        const scribe = chat.members.find(
          (m) => m.member_type === "agent" && m.display_name === "Scribe",
        );
        if (!scribe) {
          const { agents } = await import("../api");
          const all: Agent[] = await agents();
          const agent = all.find((a) => a.name === "Scribe");
          if (!agent) throw new Error("no scribe");
          await addAgentWithKey({ engine, chat, refresh: refreshChats, agent });
        }
        return callApi.invite(callId, findMediaKey());
      }),
  };
}
