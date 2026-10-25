import type { MessageBody, TextMeta } from "@sa/protocol";
import type { ChatMessage } from "./runtime.js";

export type ProactiveKind = "alert" | "catchup" | "routine" | "welcome" | "retry" | "answer";
export type ProactiveRequest = {
  agentId: string;
  chatId: string;
  prompt: string;
  kind: ProactiveKind;
  requesterUserId?: string;
  /** reply in this thread instead of top-level */
  replyTo?: string | null;
  /** retry after a denied private preview: recall must skip taught knowledge */
  noTaught?: boolean;
};
export type StopResult = "stopped" | "forbidden" | "not_found";
export interface AgentHostApi {
  onAgentAdded(chatId: string, agentId: string): void | Promise<void>;
  onAgentRemoved(chatId: string, agentId: string): void | Promise<void>;
  onAgentUpdated?(agentId: string): void | Promise<void>;
  /** One unprompted turn; the agent posts top-level in chatId. False when skipped. */
  runProactive?(req: ProactiveRequest): Promise<boolean>;
  /** Posts as the agent when it is an active member holding a chat key; returns the message id. */
  postAs?(
    agentId: string,
    chatId: string,
    text: string,
    opts?: { replyTo?: string | null; meta?: TextMeta },
  ): Promise<string | null>;
  stopTurn?(turnId: string, userId: string): StopResult;
  /** Sends one message from the agent's device in chatId; resolves the message id. */
  sendAs?(agentId: string, chatId: string, body: MessageBody): Promise<string>;
  /** One tool-less background completion for this agent on the shared LLM queue (proactive class). */
  complete?(agentId: string, sessionKey: string, messages: ChatMessage[]): Promise<string>;
}
export type BridgeHooks = {
  onDeviceRegistered?(userId: string, deviceId: string): Promise<void>;
  onMemberAdded?(chatId: string, userId: string): Promise<void>;
  onAgentDm?(userId: string, agentId: string, chatId: string, created: boolean): Promise<void>;
};
