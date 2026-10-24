import {
  ChatEngine,
  type ChatMessage,
  RelayClient,
  type RelayStatus,
  type StoredDevice,
} from "@sa/client";
import { cryptoReady, deviceIdFor, newDeviceKeys } from "@sa/crypto";
import type { Chat, UserSummary } from "@sa/protocol";
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
import { chats as fetchChats, registerDevice, type Session } from "../api";
import { IdbKeyStore } from "../lib/idb-keystore";

export type SessionValue = {
  user: UserSummary;
  phase: "starting" | "ready" | "error";
  deviceId: string | null;
  publicKey: string | null;
  relayStatus: RelayStatus;
  engine: ChatEngine | null;
  chats: Chat[];
  messages: Record<string, ChatMessage[]>;
  unread: Record<string, number>;
  refreshChats(): Promise<Chat[]>;
  /** Marks a chat as the one on screen (clears its unread count). */
  openChat(chatId: string | null): void;
};

const Ctx = createContext<SessionValue | null>(null);

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
  }
  return p;
}

export function SessionProvider({ session, children }: { session: Session; children: ReactNode }) {
  const userId = session.user.id;
  const [phase, setPhase] = useState<SessionValue["phase"]>("starting");
  const [device, setDevice] = useState<StoredDevice | null>(null);
  const [relayStatus, setRelayStatus] = useState<RelayStatus>("offline");
  const [engine, setEngine] = useState<ChatEngine | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const engineRef = useRef<ChatEngine | null>(null);
  const known = useRef(new Set<string>());
  const counted = useRef(new Set<string>());
  const active = useRef<string | null>(null);

  const refreshChats = useCallback(async () => {
    const list = await fetchChats();
    known.current = new Set(list.map((c) => c.id));
    setChats(list);
    await engineRef.current?.start(list.map((c) => c.id));
    return list;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let client: RelayClient | null = null;
    const offs: (() => void)[] = [];
    (async () => {
      try {
        await cryptoReady();
        const store = new IdbKeyStore(userId);
        const dev = await loadDevice(userId, store);
        await registerDevice({ device_id: dev.deviceId, public_key: dev.keys.publicKey });
        if (cancelled) return;
        const scheme = location.protocol === "https:" ? "wss" : "ws";
        client = new RelayClient({
          url: `${scheme}://${location.host}/relay/ws`,
          deviceId: dev.deviceId,
          // TODO(sp2): fetch a signed ticket from the bridge once its endpoint lands.
          getTicket: async () => "unsigned-placeholder",
        });
        offs.push(client.onStatus(setRelayStatus));
        await client.connect();
        if (cancelled) return;
        const eng = new ChatEngine({ link: client, store, device: dev });
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
            const isSystem = m.body?.type === "system";
            if (
              !isSystem &&
              m.senderDevice !== dev.deviceId &&
              m.chatId !== active.current &&
              !counted.current.has(m.id)
            ) {
              counted.current.add(m.id);
              setUnread((u) => ({ ...u, [m.chatId]: (u[m.chatId] ?? 0) + 1 }));
            }
            if (m.status === "ok" && isSystem) void refreshChats().catch(() => {});
          }),
          eng.onKey((chatId) => {
            if (!known.current.has(chatId)) void refreshChats().catch(() => {});
          }),
        );
        engineRef.current = eng;
        setDevice(dev);
        setEngine(eng);
        await refreshChats();
        if (!cancelled) setPhase("ready");
      } catch {
        if (!cancelled) setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
      for (const off of offs) off();
      client?.close();
      engineRef.current = null;
    };
  }, [userId, refreshChats]);

  const openChat = useCallback((chatId: string | null) => {
    active.current = chatId;
    if (chatId) setUnread((u) => (u[chatId] ? { ...u, [chatId]: 0 } : u));
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      user: session.user,
      phase,
      deviceId: device?.deviceId ?? null,
      publicKey: device?.keys.publicKey ?? null,
      relayStatus,
      engine,
      chats,
      messages,
      unread,
      refreshChats,
      openChat,
    }),
    [
      session.user,
      phase,
      device,
      relayStatus,
      engine,
      chats,
      messages,
      unread,
      refreshChats,
      openChat,
    ],
  );
  return createElement(Ctx.Provider, { value }, children);
}
