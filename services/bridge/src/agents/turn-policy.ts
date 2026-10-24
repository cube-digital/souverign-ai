const force = new Map<string, boolean>();

/** Whether the next first model round of this agent's turn must call a tool (bug 4). */
export function setForceFirstTool(agentId: string, on: boolean): void {
  force.set(agentId, on);
}
export function forceFirstTool(agentId: string): boolean {
  return force.get(agentId) ?? true;
}
