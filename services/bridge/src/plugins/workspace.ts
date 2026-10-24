import type { BridgePlugin } from "../plugin-api.js";
import { ensureWorkspace, NOOP_WORKSPACE, type Workspace } from "../workspace/seed.js";

let workspace: Workspace = NOOP_WORKSPACE;

/** D-12 seeded workspace and key custodian; `SA_WORKSPACE_SEED=0` turns it off. */
export const plugin: BridgePlugin = {
  name: "10-workspace",
  async init(ctx) {
    if (process.env.SA_WORKSPACE_SEED === "0") {
      ctx.log("workspace seed disabled");
      return;
    }
    try {
      workspace = await ensureWorkspace(ctx);
    } catch (e) {
      ctx.log("workspace init failed", { error: (e as Error).message });
    }
  },
  hooks: {
    onDeviceRegistered: (userId, deviceId) => workspace.hooks.onDeviceRegistered(userId, deviceId),
    onMemberAdded: (chatId, userId) => workspace.hooks.onMemberAdded(chatId, userId),
  },
  stop() {
    workspace.close();
    workspace = NOOP_WORKSPACE;
  },
};
