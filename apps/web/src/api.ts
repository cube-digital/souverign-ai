import type {
  Agent,
  AgentTemplate,
  ApiError,
  Approval,
  ApprovalDecision,
  ApprovalGrant,
  ApprovalPublic,
  AuthProviders,
  Chat,
  DevicePublic,
  DirectoryEntry,
  KnowledgeItem,
  KnowledgeItemDetail,
  Lesson,
  LoginResponse,
  Note,
  Prefs,
  Question,
  Routine,
  SharePolicy,
  UserSummary,
} from "@sa/protocol";

/** Presenter view loads each user in an iframe with ?slot=N, so sessions must not collide. */
export function sessionKey(): string {
  const slot = new URLSearchParams(location.search).get("slot");
  return slot && /^\d+$/.test(slot) ? `sa.session.${slot}` : "sa.session";
}

/** Latest relay ticket of any pane; the presenter view's relay strip reads it. */
export const SHARED_TICKET_KEY = "sa.relay-ticket";

export type Session = LoginResponse;

export function getSession(): Session | null {
  const raw = sessionStorage.getItem(sessionKey());
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function setSession(s: Session | null): void {
  if (s) sessionStorage.setItem(sessionKey(), JSON.stringify(s));
  else sessionStorage.removeItem(sessionKey());
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
    if (res.status === 401 && path !== "/login" && !path.startsWith("/auth/")) {
      setSession(null);
      location.reload();
    }
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
export const authProviders = () => api<AuthProviders>("/auth/providers");
export const oidcExchange = (code: string) =>
  api<LoginResponse>("/auth/oidc/exchange", json("POST", { code }));
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
export const relayTicket = (device_id: string) =>
  api<{ ticket: string; expires_at: number }>("/relay-ticket", json("POST", { device_id }));
export const agents = () => api<Agent[]>("/agents");
export const createAgent = (name: string, template: AgentTemplate, soul: string) =>
  api<Agent>("/agents", json("POST", { name, template, soul }));
export const updateAgent = (id: string, soul: string) =>
  api<Agent>(`/agents/${encodeURIComponent(id)}`, json("PATCH", { soul }));
export const addAgentToChat = (chatId: string, agent_id: string) =>
  api<Chat>(`/chats/${encodeURIComponent(chatId)}/agents`, json("POST", { agent_id }));
export const removeAgentFromChat = (chatId: string, agentId: string) =>
  api<Chat>(
    `/chats/${encodeURIComponent(chatId)}/agents/${encodeURIComponent(agentId)}`,
    json("DELETE"),
  );

export const claimEpoch = (chatId: string, min: number) =>
  api<{ epoch: number }>(`/chats/${encodeURIComponent(chatId)}/epoch`, json("POST", { min }));
export const agentDm = (agentId: string) =>
  api<Chat>(`/agents/${encodeURIComponent(agentId)}/dm`, json("POST", {}));
export const stopTurn = (turnId: string) =>
  api<{ stopped: true }>(`/turns/${encodeURIComponent(turnId)}/stop`, json("POST", {}));
export const hello = () => api<{ catchup: boolean }>("/me/hello", json("POST", {}));
export const getPrefs = () => api<Prefs>("/me/prefs");
export const setPrefs = (p: Prefs) => api<Prefs>("/me/prefs", json("PUT", p));
export const routines = (agentId?: string) =>
  api<Routine[]>(`/routines${agentId ? `?agent_id=${encodeURIComponent(agentId)}` : ""}`);
export const createRoutine = (r: {
  agent_id: string;
  chat_id: string;
  days: number[];
  time: string;
  prompt: string;
}) => api<Routine>("/routines", json("POST", r));
export const updateRoutine = (id: string, paused: boolean) =>
  api<Routine>(`/routines/${encodeURIComponent(id)}`, json("PATCH", { paused }));
export const deleteRoutine = (id: string) =>
  api<{ ok: true }>(`/routines/${encodeURIComponent(id)}`, json("DELETE"));

const e = encodeURIComponent;
export const knowledge = (agentId: string) =>
  api<KnowledgeItem[]>(`/agents/${e(agentId)}/knowledge`);
export const knowledgeItem = (agentId: string, itemId: string) =>
  api<KnowledgeItemDetail>(`/agents/${e(agentId)}/knowledge/${e(itemId)}`);
export const teachDocument = (agentId: string, file: File) =>
  api<KnowledgeItem>(`/agents/${e(agentId)}/knowledge`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(file.name),
      "x-file-type": file.type || "application/octet-stream",
    },
    body: file,
  });
export const deleteKnowledge = (agentId: string, itemId: string) =>
  api<{ ok: true }>(`/agents/${e(agentId)}/knowledge/${e(itemId)}`, json("DELETE"));
export const lessons = (agentId: string) => api<Lesson[]>(`/agents/${e(agentId)}/lessons`);
export const addLesson = (agentId: string, text: string) =>
  api<Lesson>(`/agents/${e(agentId)}/lessons`, json("POST", { text }));
export const deleteLesson = (agentId: string, lessonId: string) =>
  api<{ ok: true }>(`/agents/${e(agentId)}/lessons/${e(lessonId)}`, json("DELETE"));
export const sendCorrection = (
  agentId: string,
  c: { chat_id: string; message_id: string; text: string },
) => api<KnowledgeItem>(`/agents/${e(agentId)}/corrections`, json("POST", c));
export const setSharing = (agentId: string, share_private_in_chats: SharePolicy) =>
  api<{ share_private_in_chats: SharePolicy }>(
    `/agents/${e(agentId)}/sharing`,
    json("PUT", { share_private_in_chats }),
  );
export const approvals = (q: { status?: "pending" | "all"; agent_id?: string } = {}) =>
  api<Approval[]>(
    `/approvals?status=${q.status ?? "pending"}${q.agent_id ? `&agent_id=${e(q.agent_id)}` : ""}`,
  );
export const approvalPublic = (id: string) => api<ApprovalPublic>(`/approvals/${e(id)}/public`);
export const decideApproval = (id: string, d: ApprovalDecision) =>
  api<Approval>(`/approvals/${e(id)}/decision`, json("POST", d));
export const approvalGrants = () => api<ApprovalGrant[]>("/approval-grants");
export const revokeGrant = (agentId: string, tool: string) =>
  api<{ ok: true }>(`/approval-grants/${e(agentId)}/${e(tool)}`, json("DELETE"));
export const chatNotes = (chatId: string) => api<Note[]>(`/chats/${e(chatId)}/notes`);
export const cancelApproval = (id: string) =>
  api<Approval | ApprovalPublic>(`/approvals/${e(id)}/cancel`, json("POST", {}));
export const getQuestion = (id: string) => api<Question>(`/questions/${e(id)}`);
export const answerQuestion = (id: string, a: { option?: number; text?: string }) =>
  api<Question>(`/questions/${e(id)}/answer`, json("POST", a));
/** Path of the server-sent event stream; read it with lib/sse.ts (fetch + Bearer). */
export const EVENTS_PATH = "/api/events";
