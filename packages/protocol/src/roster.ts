import type { AgentTemplate } from "./index.js";

export type RosterId = "ops" | "qa" | "dev" | "tech" | "sales" | "scribe";
export type SeedChannelKey = "general" | "ops" | "release-7.4" | "sales";
export type RosterEntry = {
  id: RosterId;
  name: string;
  template: AgentTemplate;
  role: string;
  sees: string;
  tools: string[];
  examples: [string, string, string];
  /** two-letter avatar glyph */
  glyph: string;
  /** OKLCH hue for the avatar; brand colour stays for AI surfaces */
  hue: number;
  channels: SeedChannelKey[];
  /** autonomy badge; in T1 every roster agent reads and drafts only */
  autonomy: string;
  /** shown by the add-agent prompt when it is added outside `outside` */
  warning?: { outside: SeedChannelKey; text: string };
};

export const AUTONOMY = "reads and drafts · no writes";

/** Memory tools every template gets (registered by the memory-tools plugin). */
export const MEMORY_TOOLS = ["memory_recall", "memory_remember", "memory_forget"] as const;
/** Free interaction tools every template gets (registered by the approvals plugin). */
export const INTERACTION_TOOLS = ["ask_user"] as const;
/** Extra wording for tools whose tier depends on the target. */
export const TOOL_TIER_NOTES: Record<string, string> = {
  memory_forget: "needs approval if someone else taught it",
};
/** Gated write tools per template (registered by the gated-tools plugin); each needs approval. */
export const GATED_TOOLS: Record<string, readonly string[]> = {
  general: ["chat_send", "notes_create"],
  devops: [],
  qa: [],
  ops: [],
  dev: ["ticket_comment"],
  tech: ["notes_create"],
  sales: ["email_send"],
  scribe: ["chat_send", "notes_create"],
};

export const ROSTER: readonly RosterEntry[] = [
  {
    id: "ops",
    name: "Ops",
    template: "ops",
    role: "SRE on call: cluster, raft, replication, alerts, forecasts",
    sees: "Cluster health, raft, DB replication, metrics and alerts from the ops backend, plus this chat since it joined.",
    tools: [
      "chat_read",
      "cluster_health",
      "raft_status",
      "db_sync_status",
      "metric_trend",
      "recent_alerts",
      "user_last_seen",
    ],
    examples: [
      "Is anything about to go wrong?",
      "Why is db-2 lagging?",
      "When will node-3 run out of disk?",
    ],
    glyph: "OP",
    hue: 33,
    channels: ["general", "ops", "release-7.4"],
    autonomy: AUTONOMY,
  },
  {
    id: "qa",
    name: "QA",
    template: "qa",
    role: "Release quality: test runs, flaky tests, go/no-go",
    sees: "Test runs, flaky tests, release status and open tickets, plus this chat since it joined.",
    tools: ["chat_read", "test_runs", "flaky_tests", "release_status", "open_tickets"],
    examples: [
      "Is 7.4 ready to ship?",
      "Which tests are flaky this week?",
      "What blocks the release?",
    ],
    glyph: "QA",
    hue: 150,
    channels: ["general", "release-7.4"],
    autonomy: AUTONOMY,
  },
  {
    id: "dev",
    name: "Dev",
    template: "dev",
    role: "Engineer: merge requests, pipelines, review of pasted diffs, errors",
    sees: "Merge requests, pipelines and build logs, tickets and release status, plus this chat since it joined.",
    tools: [
      "chat_read",
      "merge_requests",
      "pipeline_status",
      "build_log",
      "open_tickets",
      "release_status",
    ],
    examples: ["Review this diff", "Why did the nightly fail?", "Which merge requests target 7.4?"],
    glyph: "DV",
    hue: 255,
    channels: ["general", "release-7.4"],
    autonomy: AUTONOMY,
  },
  {
    id: "tech",
    name: "Tech",
    template: "tech",
    role: "Solution architect: architecture, runbooks, how-to, trade-offs",
    sees: "The runbooks and architecture notes in the docs library, plus this chat since it joined.",
    tools: ["chat_read", "docs_search", "doc_read"],
    examples: [
      "How do we fail over node-1?",
      "Explain how E2EE works here",
      "What is the upgrade path to 7.4?",
    ],
    glyph: "TC",
    hue: 200,
    channels: ["general", "ops"],
    autonomy: AUTONOMY,
  },
  {
    id: "sales",
    name: "Sales",
    template: "sales",
    role: "Account exec: account briefs, pipeline, follow-up drafts",
    sees: "Accounts, deals and activities in the CRM, plus this chat since it joined. Drafts only; it sends nothing.",
    tools: ["chat_read", "crm_accounts", "crm_deal", "crm_activities"],
    examples: [
      "Brief me on Northwind before the call",
      "Draft a follow-up to Northwind",
      "Which deals depend on 7.4?",
    ],
    glyph: "SA",
    hue: 75,
    channels: ["general", "sales"],
    autonomy: AUTONOMY,
    warning: { outside: "sales", text: "Sales can read CRM accounts and deals." },
  },
  {
    id: "scribe",
    name: "Scribe",
    template: "scribe",
    role: "Chief of staff: summaries, catch-up, action items, standups",
    sees: "Chats it is a member of, from the moment it joined. In your DM it can digest the chats you share with it.",
    tools: ["chat_read", "chat_digest"],
    examples: ["What did I miss?", "Action items from this thread", "Write today's standup"],
    glyph: "SC",
    hue: 300,
    channels: ["general", "ops", "release-7.4", "sales"],
    autonomy: AUTONOMY,
  },
];

export const SEED_CHANNELS: readonly { key: SeedChannelKey; title: string; topic: string }[] = [
  { key: "general", title: "general", topic: "Everyone, everything. Try tagging an agent." },
  { key: "ops", title: "ops", topic: "Cluster, alerts and on-call for the test environment" },
  { key: "release-7.4", title: "release-7.4", topic: "Getting 7.4 out the door" },
  { key: "sales", title: "sales", topic: "Accounts and deals; Northwind is waiting on 7.4" },
];

export const rosterEntry = (id: string | null | undefined): RosterEntry | undefined =>
  ROSTER.find((r) => r.id === id);

/** Tools and example prompts of the templates personal agents can use. */
export const TEMPLATE_INFO: Record<
  string,
  { tools: string[]; examples: [string, string, string] }
> = {
  general: {
    tools: ["chat_read", "image_generate"],
    examples: ["Summarize this chat", "What did we decide?", "Draft a reply"],
  },
  devops: {
    tools: [
      "chat_read",
      "cluster_health",
      "raft_status",
      "db_sync_status",
      "metric_trend",
      "recent_alerts",
      "user_last_seen",
    ],
    examples: ["Is anything about to go wrong?", "Why is db-2 lagging?", "Any alerts today?"],
  },
  qa: {
    tools: ["chat_read", "test_runs", "flaky_tests", "release_status", "open_tickets"],
    examples: ["Is 7.4 ready to ship?", "Which tests are flaky?", "What blocks the release?"],
  },
  ...Object.fromEntries(ROSTER.map((r) => [r.template, { tools: r.tools, examples: r.examples }])),
};
