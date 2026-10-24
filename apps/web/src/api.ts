import type {
  ApiError,
  Chat,
  DevicePublic,
  DirectoryEntry,
  LoginResponse,
  UserSummary,
} from "@sa/protocol";

export const SESSION_KEY = "sa.session";

export type Session = LoginResponse;

export function getSession(): Session | null {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function setSession(s: Session | null): void {
  if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else sessionStorage.removeItem(SESSION_KEY);
}

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(`api ${status}: ${body.error}`);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const session = getSession();
  if (session) headers.set("Authorization", `Bearer ${session.token}`);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`/api${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err =
      body && typeof body === "object" && "error" in body
        ? (body as ApiError)
        : { error: `http_${res.status}` };
    throw new ApiFailure(res.status, err);
  }
  return body as T;
}

const json = (method: string, data?: unknown): RequestInit => ({
  method,
  ...(data === undefined ? {} : { body: JSON.stringify(data) }),
});

export const login = (user_id: string, pin: string) =>
  api<LoginResponse>("/login", json("POST", { user_id, pin }));
export const users = () => api<UserSummary[]>("/users");
export const directory = () => api<DirectoryEntry[]>("/directory");
export const chats = () => api<Chat[]>("/chats");
export const createChat = (title: string, member_user_ids: string[]) =>
  api<Chat>("/chats", json("POST", { title, member_user_ids }));
export const addMember = (chatId: string, user_id: string) =>
  api<Chat>(`/chats/${encodeURIComponent(chatId)}/members`, json("POST", { user_id }));
export const removeMember = (chatId: string, userId: string) =>
  api<Chat>(
    `/chats/${encodeURIComponent(chatId)}/members/${encodeURIComponent(userId)}`,
    json("DELETE"),
  );
export const registerDevice = (reg: DevicePublic) => api<unknown>("/devices", json("POST", reg));
