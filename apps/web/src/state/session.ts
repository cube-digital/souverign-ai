import {
  ChatEngine,
  type ChatMessage,
  RelayClient,
  type RelayStatus,
  type StoredDevice,
} from "@sa/client";
import { cryptoReady, deviceIdFor, newDeviceKeys } from "@sa/crypto";
import type { ActivityBody, Chat, UserSummary } from "@sa/protocol";
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  chats as fetchChats,
  hello,
  registerDevice,
  relayTicket,
  type Session,
  SHARED_TICKET_KEY,
} from "../api";
import { IdbKeyStore } from "../lib/idb-keystore";
import { buildView, type ChatView } from "./threads";

export type ActivityState = Record<string, Record<string, { body: ActivityBody; ts: number }>>;
const ACTIVITY_TTL_MS = 90_000;

export type SessionValue = {
  user: UserSummary;
  phase: "starting" | "ready" | "error";
  /** Why the session is in the error phase. */
  error: string | null;
  /** Runs the connection again after an error. */
  retry(): void;
  /** A current relay ticket for the device (cached until shortly before it expires). */
  ticket(): Promise<string>;
  deviceId: string | null;
  publicKey: string | null;
  relayStatus: RelayStatus;
  engine: ChatEngine | null;
  chats: Chat[];
  messages: Record<string, ChatMessage[]>;
  unread: Record<string, number>;
  refreshChats(): Promise<Chat[]>;
  /** Threads and reactions of a chat, derived from its messages. */
  view(chatId: string): ChatView;
  /** Marks a chat as the one on screen (clears its unread count). */
  openChat(chatId: string | null): void;
};

const Ctx = createContext<SessionValue | null>(null);
// Live activity ticks often; it has its own context so message consumers do not re-render on it.
const ActivityCtx = createContext<ActivityState>({});

/** Live agent activity: chat id, then sender device. */
export function useActivity(): ActivityState {
  return useContext(ActivityCtx);
}

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession outside SessionProvider");
  return v;
}

// One device per user per browser, even when React mounts the provider twice (StrictMode).
const devices = new Map<string, Promise<StoredDevice>>();
function loadDevice(userId: string, store: IdbKeyStore): Promise<StoredDevice> {
  let p = devices.get(userId);
  if (!p) {
    p = (async () => {
      const existing = await store.getDevice();
      if (existing) return existing;
      const keys = newDeviceKeys();
      const device = { deviceId: deviceIdFor(keys.publicKey), keys };
      await store.putDevice(device);
      return device;
    })();
    devices.set(userId, p);
    p.catch(() => devices.delete(userId));
  }
  return p;
}

// The device registers once per page load, even when React mounts the provider twice (StrictMode).
// A failure drops the entry so Retry registers again.
const registered = new Map<string, Promise<unknown>>();
// The "hello" catch-up ping goes out once per page load per user.
const greeted = new Set<string>();

const EMPTY: ChatMessage[] = [];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const RETRIES = 3;
const CONNECT_TIMEOUT_MS = 8000;

async function withRetries<T>(job: () => Promise<T>, cancelled: () => boolean): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await job();
    } catch (e) {
      if (attempt >= RETRIES || cancelled()) throw e;
      await sleep(1000);
      if (cancelled()) throw e;
    }
  }
}

function reasonOf(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return "unknown error";
}

export function SessionProvider({ session, children }: { session: Session; children: ReactNode }) {
  const userId = session.user.id;
  const [phase, setPhase] = useState<SessionValue["phase"]>("starting");
  const [device, setDevice] = useState<StoredDevice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const ticketRef = useRef<{ device: string; value: string; expires: number } | null>(null);
  const deviceRef = useRef<string | null>(null);
  const [relayStatus, setRelayStatus] = useState<RelayStatus>("offline");
  const [engine, setEngine] = useState<ChatEngine | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [activity, setActivity] = useState<ActivityState>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const engineRef = useRef<ChatEngine | null>(null);
  const known = useRef(new Set<string>());
  const chatsRef = useRef<Chat[]>([]);
  const counted = useRef(new Set<string>());
  const active = useRef<string | null>(null);

  const clearActivity = useCallback((chatId: string, senderDevice: string) => {
    const key = `${chatId}|${senderDevice}`;
    const t = timers.current.get(key);
    if (t) clearTimeout(t);
    timers.current.delete(key);
    setActivity((prev) => {
      if (!prev[chatId]?.[senderDevice]) return prev;
      const { [senderDevice]: _gone, ...rest } = prev[chatId];
      const { [chatId]: _chat, ...others } = prev;
      return Object.keys(rest).length > 0 ? { ...others, [chatId]: rest } : others;
    });
  }, []);

  const refreshSeq = useRef(0);
  const refreshChats = useCallback(async () => {
    const seq = ++refreshSeq.current;
    const list = await fetchChats();
    // A newer refresh started while this one was in flight: its answer wins.
    if (seq !== refreshSeq.current) return chatsRef.current;
    known.current = new Set(list.map((c) => c.id));
    chatsRef.current = list;
    setChats(list);
    await engineRef.current?.start(list.map((c) => c.id));
    return list;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the connection on Retry
  useEffect(() => {
    let cancelled = false;
    let client: RelayClient | null = null;
    const offs: (() => void)[] = [];
    setPhase("starting");
    setError(null);
    (async () => {
      try {
        await cryptoReady();
        const store = new IdbKeyStore(userId);
        const dev = await loadDevice(userId, store);
        deviceRef.current = dev.deviceId;
        const fresh = async () => {
          const r = await relayTicket(dev.deviceId);
          ticketRef.current = { device: dev.deviceId, value: r.ticket, expires: r.expires_at };
          sessionStorage.setItem(SHARED_TICKET_KEY, r.ticket);
          return r.ticket;
        };
        let reg = registered.get(dev.deviceId);
        if (!reg) {
          reg = withRetries(
            () => registerDevice({ device_id: dev.deviceId, public_key: dev.keys.publicKey }),
            () => false,
          );
          registered.set(dev.deviceId, reg);
          reg.catch(() => registered.delete(dev.deviceId));
        }
        await reg;
        if (cancelled) return;
        const scheme = location.protocol === "https:" ? "wss" : "ws";
        client = await withRetries(
          async () => {
            const c = new RelayClient({
              url: `${scheme}://${location.host}/relay/ws`,
              deviceId: dev.deviceId,
              getTicket: fresh,
            });
            const off = c.onStatus((st) => {
              if (!cancelled) setRelayStatus(st);
            });
            offs.push(off);
            try {
              await Promise.race([
                c.connect(),
                sleep(CONNECT_TIMEOUT_MS).then(() => {
                  throw new Error("relay did not answer");
                }),
              ]);
            } catch (e) {
              off();
              c.close();
              throw e;
            }
            return c;
          },
          () => cancelled,
        );
        if (cancelled) {
          client.close();
          return;
        }
        const eng = new ChatEngine({
          link: client,
          store,
          device: dev,
          isTrustedKeySender: async (chatId, senderDevice) => {
            const isHumanMember = (list: Chat[]) =>
              list
                .find((c) => c.id === chatId)
                ?.members.some(
                  (m) =>
                    m.member_type === "user" && m.devices.some((d) => d.device_id === senderDevice),
                ) ?? false;
            // A new member device may postdate the cached chats: refresh once and recheck.
            return isHumanMember(chatsRef.current) || isHumanMember(await refreshChats());
          },
        });
        offs.push(
          eng.onMessage((m) => {
            setMessages((prev) => {
              const list = prev[m.chatId] ?? [];
              const i = list.findIndex((x) => x.id === m.id);
              const next =
                i >= 0
                  ? list.map((x, j) => (j === i ? m : x))
                  : [...list, m].sort((a, b) => a.seq - b.seq);
              return { ...prev, [m.chatId]: next };
            });
            if (m.status === "ok") clearActivity(m.chatId, m.senderDevice);
            const quiet = m.body?.type === "system" || m.body?.type === "reaction";
            if (
              !quiet &&
              m.senderDevice !== dev.deviceId &&
              m.chatId !== active.current &&
              !counted.current.has(m.id)
            ) {
              counted.current.add(m.id);
              setUnread((u) => ({ ...u, [m.chatId]: (u[m.chatId] ?? 0) + 1 }));
            }
            if (m.status === "ok" && m.body?.type === "system") void refreshChats().catch(() => {});
          }),
          eng.onActivity((a) => {
            if (a.body.phase === "done" || a.body.phase === "stopped") {
              clearActivity(a.chatId, a.senderDevice);
              return;
            }
            const key = `${a.chatId}|${a.senderDevice}`;
            const old = timers.current.get(key);
            if (old) clearTimeout(old);
            timers.current.set(
              key,
              setTimeout(() => clearActivity(a.chatId, a.senderDevice), ACTIVITY_TTL_MS),
            );
            setActivity((prev) => ({
              ...prev,
              [a.chatId]: { ...prev[a.chatId], [a.senderDevice]: { body: a.body, ts: a.ts } },
            }));
          }),
          eng.onKey((chatId) => {
            if (!known.current.has(chatId)) void refreshChats().catch(() => {});
          }),
        );
        engineRef.current = eng;
        setDevice(dev);
        setEngine(eng);
        await refreshChats();
        if (!cancelled) {
          setPhase("ready");
          if (!greeted.has(userId)) {
            greeted.add(userId);
            hello().catch(() => {});
          }
        }
      } catch (e) {
        if (!cancelled) {
          setError(reasonOf(e));
          setPhase("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      for (const off of offs) off();
      for (const t of timers.current.values()) clearTimeout(t);
      timers.current.clear();
      client?.close();
      engineRef.current = null;
    };
  }, [userId, refreshChats, clearActivity, attempt]);

  const openChat = useCallback((chatId: string | null) => {
    active.current = chatId;
    if (chatId) setUnread((u) => (u[chatId] ? { ...u, [chatId]: 0 } : u));
  }, []);

  const views = useRef(new Map<string, { src: ChatMessage[]; dev: string; view: ChatView }>());
  const view = useCallback(
    (chatId: string) => {
      const src = messages[chatId] ?? EMPTY;
      const dev = device?.deviceId ?? "";
      const hit = views.current.get(chatId);
      if (hit && hit.src === src && hit.dev === dev) return hit.view;
      const next = buildView(src, dev, hit?.view);
      views.current.set(chatId, { src, dev, view: next });
      return next;
    },
    [messages, device],
  );

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const ticket = useCallback(async () => {
    const t = ticketRef.current;
    if (t && t.device === deviceRef.current && t.expires - Date.now() > 60_000) return t.value;
    const id = deviceRef.current;
    if (!id) throw new Error("no device");
    const r = await relayTicket(id);
    ticketRef.current = { device: id, value: r.ticket, expires: r.expires_at };
    sessionStorage.setItem(SHARED_TICKET_KEY, r.ticket);
    return r.ticket;
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      user: session.user,
      phase,
      error,
      retry,
      ticket,
      deviceId: device?.deviceId ?? null,
      publicKey: device?.keys.publicKey ?? null,
      relayStatus,
      engine,
      chats,
      messages,
      unread,
      refreshChats,
      view,
      openChat,
    }),
    [
      session.user,
      phase,
      error,
      retry,
      ticket,
      device,
      relayStatus,
      engine,
      chats,
      messages,
      unread,
      refreshChats,
      view,
      openChat,
    ],
  );
  return createElement(
    Ctx.Provider,
    { value },
    createElement(ActivityCtx.Provider, { value: activity }, children),
  );
}
