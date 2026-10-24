import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentHostApi, BridgeHooks } from "./agents/api.js";
import type { Db } from "./db.js";
import type { RelayAdmin } from "./relay-admin.js";

export type Log = (msg: string, extra?: Record<string, unknown>) => void;
export type Authenticate = (req: FastifyRequest, reply: FastifyReply) => Promise<string | null>;
export type RouteDeps = {
  db: Db;
  authenticate: Authenticate;
  agentHost?: AgentHostApi | undefined;
  opsSimUrl: string;
  log: Log;
  /** merged hooks of all plugins */
  hooks: BridgeHooks;
};
export type PluginContext = {
  db: Db;
  relayAdmin: RelayAdmin;
  relayInternalUrl: string;
  /** A relay ticket for one of the bridge's own devices; the admin token itself is not shared. */
  ticketFor(deviceId: string): Promise<string>;
  opsSimUrl: string;
  agentHost: AgentHostApi;
  log: Log;
};
/** A bridge feature module: `export const plugin: BridgePlugin` in src/plugins/<name>.ts. */
export type BridgePlugin = {
  name: string;
  /** Runs before the HTTP server listens and before agents start; may seed data. Plugins init in name order. */
  init?(ctx: PluginContext): Promise<void>;
  routes?(app: FastifyInstance, deps: RouteDeps): void;
  hooks?: BridgeHooks;
  /** Runs after listen and after agentHost.start(). */
  start?(ctx: PluginContext): void;
  stop?(): void | Promise<void>;
};
