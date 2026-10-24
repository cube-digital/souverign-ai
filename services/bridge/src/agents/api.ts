export type ProactiveKind = "alert" | "catchup" | "routine" | "welcome";
export type ProactiveRequest = {
  agentId: string;
  chatId: string;
  prompt: string;
  kind: ProactiveKind;
  requesterUserId?: string;
};
export type StopResult = "stopped" | "forbidden" | "not_found";
export interface AgentHostApi {
  onAgentAdded(chatId: string, agentId: string): void | Promise<void>;
  onAgentRemoved(chatId: string, agentId: string): void | Promise<void>;
  onAgentUpdated?(agentId: string): void | Promise<void>;
  /** One unprompted turn; the agent posts top-level in chatId. False when skipped. */
  runProactive?(req: ProactiveRequest): Promise<boolean>;
  stopTurn?(turnId: string, userId: string): StopResult;
}
export type BridgeHooks = {
  onDeviceRegistered?(userId: string, deviceId: string): Promise<void>;
  onMemberAdded?(chatId: string, userId: string): Promise<void>;
  onAgentDm?(userId: string, agentId: string, chatId: string, created: boolean): Promise<void>;
};
