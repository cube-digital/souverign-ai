import {
  GATED_TOOLS,
  INTERACTION_TOOLS,
  MEMORY_TOOLS,
  rosterEntry,
  TEMPLATE_INFO,
} from "@sa/protocol/roster";

/** Text that asks an agent what it can see; answered by the bridge, never by the model. */
export const ACCESS_RE = /what can you access here\??/i;

/** One line per tool the bridge MCP server can expose. */
const TOOL_INFO: Record<string, string> = {
  chat_read: "The latest messages of this chat",
  chat_digest: "A digest of the chats you share with me (only in our DM)",
  cluster_health: "Health of every cluster node",
  raft_status: "Raft leader and term",
  db_sync_status: "Database replication lag",
  metric_trend: "Trend of one metric on one node",
  recent_alerts: "Alerts raised in the last hours",
  user_last_seen: "When a user was last seen online",
  test_runs: "Most recent test runs",
  flaky_tests: "Tests that fail intermittently",
  release_status: "Release readiness",
  open_tickets: "Open tickets",
  merge_requests: "Open merge requests",
  pipeline_status: "CI pipeline runs",
  build_log: "The log of one build",
  docs_search: "Search the runbooks and architecture notes",
  doc_read: "Read one runbook or architecture note",
  crm_accounts: "Accounts in the CRM",
  crm_deal: "One deal in the CRM",
  crm_activities: "Recent activities on an account",
  memory_recall: "Search what I was taught and this chat since I joined",
  memory_remember: "Save a note for this chat",
  memory_forget:
    "Forget what I was taught about something (needs approval if someone else taught it)",
  ask_user: "Ask you a question with options",
  chat_send: "Post a message in a chat we share",
  notes_create: "Save a note in this chat",
  email_send: "Save an email to the local outbox",
  ticket_comment: "Comment on a ticket",
  image_generate: "Generate an image (not available in this setup)",
};

const GATED = new Set(Object.values(GATED_TOOLS).flat());

/** The tools an agent has: roster agents from the roster, personal agents from their template. */
export function agentTools(rosterId: string | null | undefined, template: string): string[] {
  const base = rosterEntry(rosterId)?.tools ?? TEMPLATE_INFO[template]?.tools ?? ["chat_read"];
  return [...base, ...MEMORY_TOOLS, ...INTERACTION_TOOLS, ...(GATED_TOOLS[template] ?? [])];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "24 Oct, 09:12" in the Mac's local time zone. */
export const formatJoined = (d: Date): string =>
  `${d.getDate()} ${MONTHS[d.getMonth()]}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** The deterministic answer to "what can you access here?". */
export function accessSummary(a: {
  agentName: string;
  chatTitle: string;
  joinedAt: Date;
  seen: number;
  tools: string[];
}): string {
  return [
    `In "${a.chatTitle}" I can read the messages posted since I joined on ${formatJoined(a.joinedAt)} (${a.seen} so far) and the images posted here (described by the local model). I cannot read other chats, earlier messages, or anything outside my tools.`,
    "Tools:",
    ...a.tools.map(
      (t) =>
        `- ${t}: ${TOOL_INFO[t] ?? "A read-only tool"}${GATED.has(t) ? " (needs approval)" : ""}`,
    ),
    "Everything runs on this Mac.",
  ].join("\n");
}
