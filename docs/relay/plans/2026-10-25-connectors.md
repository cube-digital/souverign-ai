# Connectors Plan (P2)

**Goal:** agents read the team's own Jira, Confluence, GitLab (GitHub optional), CRM and calendar through the bridge MCP, with per-agent toggles on the Agent page. Every write (create issue, comment, transition, trigger pipeline, edit page, create or answer a calendar event, CRM note/task/stage/activity) waits for the requester's approval. For the demo, the bridge talks to local mock servers seeded with the 7.4 story. Real self-hosted instances are switched on in `config/connectors.yaml`, and so are the optional cloud egresses D-15 (Google/Microsoft calendar) and D-16 (HubSpot), both off by default.
**Spec:** `.handoff/plans/remaining-plans.md` § "P2: Connectors"; `docs/superpowers/specs/2026-10-24-agent-teammates-design.md` (§3 constraints, §5 roster, §6 `/access`, D-10 requester-only approvals); `docs/superpowers/specs/decisions.md` (D-1, D-8, D-9); D-14 in `docs/relay/plans/2026-10-25-google-login.md`; `.handoff/research_notes/AI teammates in team chat/our_architecture_constraints.md`; the user's answers of 2026-10-25 (D-15 and D-16 confirmed, toggle rule, calendar privacy, versions).
**Runs after:** memory + approvals (merged, `c540455`). It runs alongside the voice plan (`docs/relay/plans/2026-10-25-voice-meetings.md`, migration `006_calls.sql`). This plan's migration is `007_connectors.sql`.
**Architecture:** connectors are thin REST adapters inside the bridge (`services/bridge/src/connectors/`). They are not separate MCP processes. The bridge MCP server stays the only server Hermes talks to. Each connector contributes a small, curated set of tools named `<connector id>_<tool>` (`jira_search`, `gitlab_trigger_pipeline`, `calendar_free_busy`, `crm_create_note`). The tools are added per agent through a new seam in `mcp/registry.ts`, so `ToolLog`, the turn-scoped `x-sa-turn` check, receipts and the echo runtime keep working unchanged. Read tools run directly. Write tools go through `requestApproval`, are registered with `registerGatedTool`, and have executors that re-validate at execute time.

The mocks are not a separate fake API. They implement a small subset of each vendor's real API (Jira/Confluence Data Center REST, GitLab v4, CalDAV, HubSpot CRM v3) inside the existing `ops-sim` process under `/mock/<kind>/…`. So the **same adapter code** talks to the mock and to the real system, and the mocks share one mutable store with the existing `/sim/*` routes, which keeps the 7.4 story consistent everywhere. Calendar tools sit on a `CalendarBackend` interface with three backends: CalDAV (the default; mock and self-hosted), Google Calendar (D-15) and Microsoft Graph (D-15).

## Decisions

- **Target versions (Claude's call, per the user):**
  - Jira Data Center REST **v2** and Confluence Data Center REST **v1** (`/rest/api/…`), small subsets.
  - GitLab self-managed CE/EE REST **v4**.
  - Generic **CalDAV** (RFC 4791 subset), tested against a Radicale-compatible mock.
  - GitHub Enterprise Server REST (`/api/v3`).
  - HubSpot CRM **v3** objects, pipelines and owners.
  - Google Calendar API **v3**.
  - Microsoft Graph **v1.0** calendar.
- **REST adapters, not third-party MCP servers (for now).** Those servers expose 30–90 tools with long descriptions, which breaks the ≤ 15 direct tools budget for the 4-bit 9B model now that Hermes `tool_search` is off. They also add runtimes (Go, Python via `uvx`) that would each need a licence and egress audit, and they cannot give typed, execute-time re-validation of gated writes. A `kind: mcp` passthrough is a follow-up, to be added only after a per-server licence and no-telemetry check.
- **Mocks live in ops-sim.** ops-sim already runs in `make dev`, `make demo` and e2e (port 8649, 8659 in e2e), so this adds no process, port or RAM, and no edits to `Makefile` or `infra/scripts/*` (voice owns them). It adds no new npm dependency either, so `pnpm-lock.yaml` stays out of this plan.
- **Tool names** are `<connector id>_<tool>`. The connector id comes from config (`^[a-z][a-z0-9]{1,15}$`); the suffix comes from the catalog in `packages/protocol/src/connectors.ts`. The shipped ids are `jira`, `confluence`, `gitlab`, `calendar` and `crm`. Swapping the calendar backend (CalDAV → Google/Microsoft) or the CRM mock → real HubSpot changes only the `kind`/`mock`/`auth` of the `calendar`/`crm` entry, so tool names and template defaults stay the same.
- **Supersede rule.** A connector that is enabled in config with status `ok` and listed for the agent's template in `templates:` hides the built-in sim tools it replaces. It hides them even when all of its tools are toggled off, because off means no access, not a fallback. Jira hides `open_tickets` and `ticket_comment`. GitLab and GitHub hide `merge_requests`, `pipeline_status` and `build_log`. Confluence hides `docs_search` and `doc_read`. HubSpot hides `crm_accounts`, `crm_deal` and `crm_activities` and serves them again under the same names. With no `config/connectors.yaml`, every agent keeps today's tools exactly. That is why `services/bridge/test/mcp.test.ts` (buildMcpApp without plugins) stays unchanged.
- **Config is the ceiling; the Agent page is the switch.** `templates.<template>.<connector>` lists `default` tools (on unless toggled off) and `allow` tools (can be toggled on). Nothing else can be enabled from the UI. Per-agent choices are stored in `sa.agent_connectors(agent_id, connector, tools, updated_by, updated_at)`; with no row, the template default applies.
- **Who toggles (user decision 2):**
  - **Workspace agents:** any member of the workspace, meaning any `sa.users.kind = 'person'`. This is the same rule as the sharing setting (`knowledge/routes.ts` `canTeach`).
  - **Personal agents:** only the owner.
  - The Agent page shows, per connector, **who changed it last and when** ("Changed by Vlad · 25 Oct, 14:02"), or "Template default" when there is no row.
- **Tool budget:** `MAX_AGENT_TOOLS = 15` per agent counts everything `tools/list` returns. Template defaults fit with all plugins loaded:

  | Agent | Count | Tools |
  |---|---|---|
  | Dev | 15 | `chat_read`, `release_status`, `memory_*`×3, `ask_user`, `notes_create`, plus `gitlab_merge_requests\|pipelines\|job_log\|trigger_pipeline` and `jira_search\|issue\|comment\|create_issue` |
  | QA | 15 | `chat_read`, `test_runs`, `flaky_tests`, `release_status`, memory×3, `ask_user`, `notes_create`, plus `jira_search\|issue\|create_issue\|transition` and `gitlab_pipelines\|trigger_pipeline` |
  | Tech | 9 | base 6 (`chat_read`, memory×3, `ask_user`, `notes_create`) plus `confluence_search\|page\|edit_page` |
  | Ops | 15 | base 6, the 6 ops tools, plus `gitlab_pipelines` and `confluence_search\|page` |
  | Sales | 14 | base 6, `email_send`, `crm_accounts\|deal\|activities\|create_note` and `calendar_free_busy\|events\|create_event` |
  | Scribe | 13 | base 6, `chat_digest`, `chat_send`, voice's `meeting_transcript`, plus `calendar_free_busy\|events\|create_event\|respond` |

  `PUT /api/agents/:id/connectors` refuses a selection that would exceed 15 (`409 too_many_tools`). The existing silent cap of 20 in `mcp/server.ts` stays.
- **Credentials.**
  - `auth.*_env` fields name environment variables of the bridge process. The bridge reads the values at request time and uses them only in the outgoing request, or in the OAuth token request for D-15.
  - Values are never stored in the DB or on disk by the bridge, and are never logged, returned, put in tool results, approval args or previews, or sent to the web.
  - OAuth access tokens for D-15 are cached in memory only, until 60 s before expiry.
  - The UI shows only the variable *name* when it is missing ("Set JIRA_TOKEN in the bridge env").
  - Connector logs carry `connector`, `method`, `status` and `ms`. They carry no path, query or body, because JQL/CQL and search bodies contain chat text.
- **Network guard (self-hosted).**
  - At plugin init each enabled self-hosted connector's host is resolved. If any address is not loopback, private (RFC 1918, fc00::/7), CGNAT/tailnet (100.64.0.0/10) or link-local, the connector gets `status: public_address` and is not used. The exception is `allow_public_address: true`, an explicit operator decision that is logged once.
  - Every fetch uses `redirect: "error"`, an 8 s timeout and a 1 MiB response cap.
  - The model can never choose a host: adapters build paths from validated ids.
  - Jira Cloud, Confluence Cloud, github.com and GitLab.com are out of scope.
- **D-15 (confirmed 2026-10-25): Google/Microsoft calendars are an optional egress, off by default, like D-14.**
  - **Allowed hosts.** Only the calendar connector contacts them, and only when the `calendar` entry has `kind: google-calendar` or `kind: microsoft-graph`, `enabled: true` and its credential env set. The hosts are exactly `www.googleapis.com` + `oauth2.googleapis.com` (Google) or `graph.microsoft.com` + `login.microsoftonline.com` (Microsoft), over HTTPS. `base_url` is fixed in code and is not configurable for these kinds.
  - **Host allowlist in code.** `http.ts` refuses any request whose URL host is not in the kind's fixed list.
  - **Copy, badge and smoke guard.** While it is on, the trust strip reads "Uses Google Calendar · chats and AI stay on this Mac" (C17), the Presenter shows a "Google Calendar on" / "Microsoft 365 calendar on" badge, and `make smoke` allowlists exactly those hosts.
  - **Data flow.** Event data flows in to the local model. Outbound requests carry only the free/busy queries and the created or answered events.
  - **Credentials.**
    - Google uses a Workspace service account with domain-wide delegation: `auth: {type: google-service-account, credentials_env}` holds the key JSON, and the `token_uri` inside the key is ignored.
    - Microsoft uses an app registration with application permission `Calendars.ReadWrite`: `auth: {type: ms-client-credentials, tenant_id, client_id_env, client_secret_env}`.
- **D-16 (confirmed 2026-10-25): HubSpot is the CRM; the real HubSpot is an optional egress, off by default.**
  - **The demo** uses `crm` with `kind: hubspot, mock: true` against the ops-sim HubSpot v3 mock, seeded with the 7.4 story.
  - **Real HubSpot** means `mock: false`, `enabled: true` and `auth: {type: bearer, token_env: HUBSPOT_TOKEN}`, a private-app token in the bridge env only. Egress then goes only to HubSpot's official API host `api.hubapi.com` over HTTPS. The C15 task verifies the exact host list against HubSpot's current API docs (including whether EU-hosted accounts need another host) and records the result in the ledger.
  - **Copy, badge and smoke guard** are the same as D-14/D-15: "Uses HubSpot · chats and AI stay on this Mac", a "HubSpot on" badge, and the `make smoke` allowlist.
  - **Tools.** Reads are free: `accounts`, `deal`, `activities`. Writes are gated: `create_note`, `create_task`, `update_deal_stage`, `log_activity`.
- **Approvals.**
  - Every connector write is `alwaysAllowed: false` and `stamp: true`. It uses the default approver rule (requester for workspace agents, owner for personal ones), which is already what `resolveApprover` does.
  - Executors re-validate at execute time (`service.ts` `run()` calls `validate` again). They also check that the connector is still `ok` and the tool still selected for that agent.
  - Created content carries an audit line `— <agent name> for <approver name>, approved in chat`.
  - Issue, comment and CRM bodies are plain text. Confluence text is HTML-escaped and converted to storage XHTML by the adapter, so the model never injects macros or raw XHTML.
- **Calendar privacy (user decision 4).**
  - **Access.** One service account (CalDAV) or delegated service identity (D-15) reads calendars.
  - **Other people.** `calendar_free_busy` returns **busy intervals and common free slots only**, never titles, descriptions, locations or attendees. It covers anyone in the workspace (`kind in ('person','seed')`).
  - **The requester's own events.** `calendar_events` returns titles, descriptions and attendees **only from the requester's own calendar, and only in the requester's DM with the agent**. Anywhere else it returns `{error:"events_only_in_dm"}`, so no one else in a chat sees them, in the reply or in the receipts trace.
  - **Approval cards.** The approval preview of `calendar_create_event` / `calendar_respond` is requester-only, as every approval card is. The public thread stamp says only `created event` / `answered invitation`.
  - **New events** go into the approver's calendar with attendees; the server's scheduling invites the others (the mock simulates it).
- **GitHub:** adapter only, disabled in the shipped config, unit-tested with fixtures and without a seeded mock. It has no job-log tool, because GHES serves Actions logs through a redirect to blob storage that can be a third-party host.

## Merge overlap with other plans

- `services/bridge/src/agents/host.ts`: **one line** in C6 (the `/access` call passes `dev.agent.id` to `agentTools`). This is the only file shared with the voice plan, and also with the earlier realtime-agents plan (`2026-10-24-realtime-agents.md`) if that one is not merged yet. Resolve by keeping both changes.
- **New web files touched (no overlap):** `apps/web/src/shell/TopBar.tsx` and `apps/web/src/pages/PresenterPage.tsx` (C17). Neither the voice nor the realtime plan lists them. The Google-login plan (merged) created them; C17 keeps its D-14 behaviour.
- Intentionally **not** touched, because voice or realtime own them:
  - `Makefile`, `infra/scripts/*`, `.env.example`
  - `e2e/package.json`, `e2e/start-bridge.sh`, `e2e/playwright.config.ts`
  - every `package.json` except `packages/protocol/package.json` (one `exports` line), and `pnpm-lock.yaml`
  - `packages/protocol/src/index.ts`, `packages/protocol/src/roster.ts`
  - `infra/hermes/templates/scribe.md`
  - `services/bridge/test/mcp.test.ts`
  - `apps/web/src/state/session.ts`, `apps/web/src/approvals/*`, `apps/web/src/app/routes.tsx`

  The live smoke runs through `pnpm --filter @sa/e2e exec tsx …`, so there is no new script or Makefile target. Add `make connectors-smoke` after both plans merge.
- Migrations: `006_calls.sql` (voice) and `007_connectors.sql` (here) are independent tables, and `migrate.ts` applies any missing file in sort order.
- Scribe's count assumes voice's `meeting_transcript` (13 with it, 12 without). C10's budget test counts whatever is registered.

## Global Constraints

- **Conventions:** TS `@sa/*`, NodeNext `.js` imports in services and packages (web: Bundler, no extension), Biome, vitest. Commits are `feat(connectors): …` / `test(connectors): …`, one per task.
- **No new npm or Python dependencies.** Use the existing ones:
  - YAML: the bridge's `yaml` package.
  - Validation: `zod`.
  - JWT signing (D-15 Google): the bridge's `jose`.
  - Python: PyYAML, already in `infra/py`.
  - iCalendar, CalDAV multistatus XML and storage XHTML: small hand-written helpers in this plan's files.
- **Public repo:** no client company or product names and no absolute paths of this machine. `git grep -inE "real[t]yme|gate[x]"` must print nothing before every commit (messages included). Hosts in docs and examples are `*.example.internal` or `example.com`; vendor API hosts appear only where D-15/D-16 name them.
- **Local by default.** In the shipped config every connector points at `${OPS_SIM_URL}/mock/<kind>` (the bridge's resolved `opsSimUrl`, default `http://127.0.0.1:8649`), and no cloud connector is enabled. Runtime code contacts the D-15/D-16 hosts only through `connectors/http.ts` with the fixed-host check.
- **Secrets:** no token, password, client secret, key JSON or OAuth access token in logs, ToolLog results, approval rows, previews, API responses, memory or e2e artifacts. Tests assert this with the sentinels `tok-SENTINEL-9f3a` (and `-----BEGIN PRIVATE KEY-----SENTINEL` for D-15).
- **Tests run offline.** `make check` passes without models, without a running ops-sim and without network. Bridge tests use `AGENT_RUNTIME=echo` or call tools directly. They start ops-sim in-process when they need the mock, and they use an injected `fetchImpl` for Google, Microsoft, GitHub and real HubSpot. Only C13 starts `make up` / `make dev` and the LLM, and it runs alone in the last wave.
- **Protected tests stay unchanged and green:** `services/bridge/test/mcp.test.ts`, `templates.test.ts`, `gated-tools.test.ts`, `apps/web/test/shell.test.tsx` (the D-14 trust strip), `services/ops-sim/test/*.test.ts` and `packages/protocol/test/protocol.test.ts`. New tests go in new files. If a protected test goes red, report BLOCKED. Exception: C12 may change an existing e2e spec only where it names a superseded tool, and must record it in the ledger.
- **Tests never load the shipped connector config by accident.** The connectors plugin reads `SA_CONNECTORS_CONFIG` if set. Otherwise it reads `<repo>/config/connectors.yaml`, **except under vitest (`process.env.VITEST` set), where no connectors load unless `SA_CONNECTORS_CONFIG` is set.**
- **UI copy** is English and states mock, self-hosted or cloud plainly ("Mock Jira on this Mac", "Your Jira · jira.example.internal", "HubSpot · cloud").

## Review Focus

- A secret can never reach the model, logs, UI or DB, error paths included: a fetch failure must not echo headers, and a 401 maps to "<Label> rejected the bridge's token". This also covers D-15 OAuth responses (an access token is never logged or returned).
- D-15/D-16 hosts:
  - They are contacted only when the connector is enabled with credentials, and never by any other code path.
  - A request to any other host from a cloud connector throws before fetch.
  - The trust strip, the Presenter badge and the smoke allowlist all derive from the same `GET /api/connectors/cloud` / config.
- Execute-time re-validation. Each of these must fail with a human-readable `ExecError` and change nothing:
  - an approval executed after the toggle was switched off or the connector disabled;
  - a Confluence page version that changed;
  - a calendar event version (ETag, Graph `changeKey`, Google `etag`) that changed;
  - a HubSpot deal stage that moved;
  - a GitLab trigger name removed from config.
- The supersede/hide set is applied identically in `tools/list`, `tools/call`, `invokeTool` (echo) and `/access`. A hidden built-in cannot be called by name.
- Calendar privacy: free/busy never carries titles or attendees from any backend. `calendar_events` works only in the requester's DM with the agent and reads only the requester's calendar. A turn with no requester gets `needs_a_person`.
- Model-controlled strings never become URL hosts or raw query syntax: JQL/CQL are quoted and escaped, ids are regex-checked, and paths are percent-encoded.
- The tool count per roster agent is ≤ 15 with all plugins, and the PUT refuses selections above it. "Changed by" names the person who last saved.

## Tasks

### C1: Protocol types, catalog, migration

`packages/protocol/src/connectors.ts` (new):

```ts
import { z } from "zod";

export const CONNECTOR_ID_RE = /^[a-z][a-z0-9]{1,15}$/;
export const MAX_AGENT_TOOLS = 15;

export type ConnectorKind =
  | "jira"
  | "confluence"
  | "gitlab"
  | "github"
  | "caldav"
  | "google-calendar"
  | "microsoft-graph"
  | "hubspot";
export const CONNECTOR_KINDS: readonly ConnectorKind[] = [
  "jira",
  "confluence",
  "gitlab",
  "github",
  "caldav",
  "google-calendar",
  "microsoft-graph",
  "hubspot",
];
export type CatalogTool = { tool: string; write: boolean; summary: string };
export type CatalogKind = {
  label: string;
  tools: readonly CatalogTool[];
  supersedes: readonly string[];
  /** D-15/D-16: the vendor and service names used in trust copy when not a mock */
  cloud?: { vendor: string; service: string; decision: "D-15" | "D-16" };
};

const r = (tool: string, summary: string): CatalogTool => ({ tool, write: false, summary });
const w = (tool: string, summary: string): CatalogTool => ({ tool, write: true, summary });

const CALENDAR_TOOLS: readonly CatalogTool[] = [
  r("free_busy", "When people are busy, and common free slots (no titles)"),
  r("events", "Your own events in a date range (only in your DM with the agent)"),
  w("create_event", "Create an event in your calendar and invite people"),
  w("respond", "Accept, decline or tentatively accept an invitation"),
];

export const CONNECTOR_CATALOG: Record<ConnectorKind, CatalogKind> = {
  jira: {
    label: "Jira",
    tools: [
      r("search", "Search issues by text, status, fix version or age"),
      r("issue", "Read one issue with its latest comments"),
      w("create_issue", "Create an issue"),
      w("comment", "Comment on an issue"),
      w("transition", "Move an issue to another status"),
    ],
    supersedes: ["open_tickets", "ticket_comment"],
  },
  confluence: {
    label: "Confluence",
    tools: [
      r("search", "Search pages in the configured spaces"),
      r("page", "Read one page"),
      w("edit_page", "Append to or replace the text of a page"),
    ],
    supersedes: ["docs_search", "doc_read"],
  },
  gitlab: {
    label: "GitLab",
    tools: [
      r("merge_requests", "Merge requests of the project"),
      r("pipelines", "Recent pipelines and their failed jobs"),
      r("job_log", "The last lines of one job's log"),
      w("trigger_pipeline", "Start one of the configured pipelines"),
      w("mr_comment", "Comment on a merge request"),
    ],
    supersedes: ["merge_requests", "pipeline_status", "build_log"],
  },
  github: {
    label: "GitHub",
    tools: [
      r("pull_requests", "Pull requests of the repository"),
      r("workflow_runs", "Recent workflow runs and their failed jobs"),
      w("dispatch_workflow", "Start one of the configured workflows"),
      w("pr_comment", "Comment on a pull request"),
    ],
    supersedes: ["merge_requests", "pipeline_status", "build_log"],
  },
  caldav: { label: "Calendar", tools: CALENDAR_TOOLS, supersedes: [] },
  "google-calendar": {
    label: "Google Calendar",
    tools: CALENDAR_TOOLS,
    supersedes: [],
    cloud: { vendor: "Google", service: "Google Calendar", decision: "D-15" },
  },
  "microsoft-graph": {
    label: "Microsoft 365 calendar",
    tools: CALENDAR_TOOLS,
    supersedes: [],
    cloud: { vendor: "Microsoft", service: "Microsoft 365 calendar", decision: "D-15" },
  },
  hubspot: {
    label: "HubSpot",
    tools: [
      r("accounts", "Companies in the CRM, with their deals"),
      r("deal", "One deal with its stage, amount and notes"),
      r("activities", "Recent notes, calls, meetings and emails of a company"),
      w("create_note", "Add a note to a company or deal"),
      w("create_task", "Create a follow-up task"),
      w("update_deal_stage", "Move a deal to another stage"),
      w("log_activity", "Log a call or meeting"),
    ],
    supersedes: ["crm_accounts", "crm_deal", "crm_activities"],
    cloud: { vendor: "HubSpot", service: "HubSpot", decision: "D-16" },
  },
};

export const connectorToolName = (connectorId: string, tool: string): string =>
  `${connectorId}_${tool}`;

export const ConnectorStatus = z.enum([
  "ok",
  "disabled",
  "not_configured",
  "invalid_config",
  "public_address",
  "unresolvable",
]);
export type ConnectorStatus = z.infer<typeof ConnectorStatus>;

export const ConnectorToolInfo = z.object({
  name: z.string(),
  tool: z.string(),
  write: z.boolean(),
  summary: z.string(),
  /** on for this agent */
  enabled: z.boolean(),
  /** on by default for this agent's template */
  default: z.boolean(),
});
export type ConnectorToolInfo = z.infer<typeof ConnectorToolInfo>;

export const ConnectorInfo = z.object({
  id: z.string().regex(CONNECTOR_ID_RE),
  kind: z.enum(CONNECTOR_KINDS as [ConnectorKind, ...ConnectorKind[]]),
  label: z.string(),
  mode: z.enum(["mock", "self-hosted", "cloud"]),
  /** hostname only, never a URL with credentials */
  host: z.string(),
  status: ConnectorStatus,
  /** short human text, e.g. "Set JIRA_TOKEN in the bridge env" */
  status_text: z.string(),
  /** for /api/agents/:id/connectors: the tools this agent's template may use; [] in /api/connectors */
  tools: z.array(ConnectorToolInfo),
  /** last change of this agent's selection; null = template default */
  changed_by: z.object({ user_id: z.string(), name: z.string(), at: z.number() }).nullable(),
});
export type ConnectorInfo = z.infer<typeof ConnectorInfo>;

export const AgentConnectors = z.object({
  agent_id: z.string(),
  can_edit: z.boolean(),
  max_tools: z.number().int(),
  /** what tools/list returns for this agent right now */
  tool_count: z.number().int(),
  /** built-in tools hidden because a connector replaces them */
  hidden_builtins: z.array(z.string()),
  connectors: z.array(ConnectorInfo),
});
export type AgentConnectors = z.infer<typeof AgentConnectors>;

export const SetAgentConnectorsRequest = z.object({
  connector: z.string().regex(CONNECTOR_ID_RE),
  /** catalog tool suffixes, e.g. ["search", "issue"]; [] turns the connector off for this agent */
  tools: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,31}$/)).max(10),
});
export type SetAgentConnectorsRequest = z.infer<typeof SetAgentConnectorsRequest>;

/** GET /api/connectors/cloud (no auth): enabled D-15/D-16 egresses, for trust copy and badges */
export const CloudConnectors = z.object({
  cloud: z.array(
    z.object({
      connector: z.string(),
      vendor: z.string(),
      service: z.string(),
      decision: z.enum(["D-15", "D-16"]),
      hosts: z.array(z.string()),
    }),
  ),
});
export type CloudConnectors = z.infer<typeof CloudConnectors>;
```

`packages/protocol/package.json`: add `"./connectors": "./src/connectors.ts"` to `exports` after `"./roster"`.

`services/bridge/src/migrations/007_connectors.sql`:

```sql
create table if not exists sa.agent_connectors (
  agent_id text not null references sa.agents on delete cascade,
  connector text not null check (connector ~ '^[a-z][a-z0-9]{1,15}$'),
  tools jsonb not null default '[]'::jsonb check (jsonb_typeof(tools) = 'array'),
  updated_by text references sa.users,
  updated_at timestamptz not null default now(),
  primary key (agent_id, connector)
);
```

Test `services/bridge/test/migration-007.test.ts` (C6 exercises the catalog names, because `registerGatedTool` throws on an invalid name). Migrate on pglite, then check that a bad connector id fails, `tools = '{}'` fails, and deleting the agent cascades.

### C2: ops-sim store + Jira and Confluence mocks

Move the mutable state of ops-sim into `services/ops-sim/src/store.ts`: `buildStore(now: () => number)` returns `{issues, comments, pipelines, pages, events, crm}` plus mutators (C3 and C14 add `pipelines`, `events` and `crm`). `data.ts` `tickets/ticket/addComment` and `mock.ts` `pipelines/pipelineLog/docsSearch/doc` read from it. **The `/sim/*` output for seeded data must not change** (the protected ops-sim tests guard this). Export the seed constants from `mock.ts` so `store.ts` can seed from them.

Issues (`store.issues`, Jira-shaped internally: `key, summary, type, priority, status ("Open"|"In Progress"|"Done"), created (ms), updated, reporter, assignee|null, fix_version, severity, description`):
- The existing three, unchanged for `/sim/tickets`:
  - OPS-1412: Bug, Highest, blocker; Open, 5 d ago; reporter and assignee `janosch`; fix 7.4.
  - OPS-1419: Bug, High, major; Open, 2 d; fix 7.4.
  - OPS-1423: Task, Low, minor; Open, 1 d; reporter `vlad`; fix 7.4.
- New, for "new tickets for 7.4":
  - OPS-1427: Bug, High, major, "Android: push notifications arrive late after resume"; 6 h; reporter `lea`.
  - OPS-1428: Bug, Medium, minor, "7.4 rc2: login screen flickers in dark mode"; 3 h; reporter `tom`.
  - OPS-1430: Task, High, major, "Confirm Northwind 15 Nov go-live depends on OPS-1412"; 40 min; reporter `mira`.
  - All three are Open with fix 7.4.
- Older:
  - OPS-1405: Bug, High, "Refresh tokens before expiry on resume"; Done, 8 d; assignee `ana`; fix 7.4.
  - OPS-1398: Bug, Medium, "Typing indicator stuck after reconnect"; Open, 12 d; fix 7.3.2.
- `/sim/tickets?status=open` = issues whose status ≠ Done, mapped to today's `{id, title, severity, status: "open", opened_at}`; Done maps to `"closed"`. Comments are shared between `/sim/tickets/:id/comments` and Jira comments.

Mounting: `server.ts` gets **one** delegation before the `/sim` GET dispatch. `if (parts[0] === "mock") return handleMock(req, res, parts.slice(1), u, sim)` comes from the new `src/mock-routes.ts`.
- `handleMock` routes on `parts[0]`. This task adds `jira` and `confluence`; C3 adds `gitlab` and `caldav`, and C14 adds `hubspot`.
- It reads bodies ≤ 64 KiB (`413` above) and requires `application/json` for JSON POST/PUT/PATCH (`415`).
- Unknown routes get 404 in the vendor's error shape.
- The mock ignores auth headers.

Jira mock (`src/mock-jira.ts`, prefix `/mock/jira`):
- `GET /rest/api/2/myself` → `{"name":"svc-bridge","displayName":"Bridge service"}`.
- `GET /rest/api/2/search?jql=&maxResults=&fields=`. The JQL subset parser accepts exactly clauses joined by ` AND `:
  - `project = "<KEY>"`
  - `statusCategory != Done` and `statusCategory = Done`
  - `fixVersion = "<v>"`
  - `created >= -<n>d`
  - `text ~ "<q>"`: case-insensitive substring in summary + description
  - `assignee = "<u>"`
  - an optional trailing `ORDER BY created DESC`

  String literals use `\"` and `\\` escapes. Anything else → `400 {"errorMessages":["unsupported JQL"]}`. The response is `{startAt:0, maxResults, total, issues:[{key, fields:{summary, status:{name, statusCategory:{key}}, priority:{name}, issuetype:{name}, created, updated, reporter:{name}, assignee:{name}|null, fixVersions:[{name}]}}]}`. Dates are ISO strings with `+0000`.
- `GET /rest/api/2/issue/{key}` → the same fields plus `description` and `comment:{comments:[{id, author:{name}, body, created}], total}`. Unknown → 404 `{"errorMessages":["Issue does not exist"]}`.
- `POST /rest/api/2/issue` → `201 {id, key: "OPS-<next>", self}`; the next key = max + 1, starting at OPS-1431. Validation 400 → `{"errors":{field: msg}}`.
- `POST /rest/api/2/issue/{key}/comment {body}` → `201 {id, body, author:{name:"svc-bridge"}, created}`; ≤ 200 comments per issue, else 429.
- `GET /rest/api/2/issue/{key}/transitions` returns these transitions (`{id, name, to:{name}}`):

  | From | Offered |
  |---|---|
  | Open | 11 "Start progress" → In Progress; 31 "Done" → Done |
  | In Progress | 21 "Stop progress" → Open; 31 "Done" → Done |
  | Done | 41 "Reopen" → Open |

  `POST …/transitions {transition:{id}}` → 204, or 400 when the id is not offered.
- `GET /rest/api/2/project/{key}/versions` → `[{name:"7.3.2", released:true},{name:"7.4", released:false},{name:"7.5", released:false}]`.

Confluence mock (`src/mock-confluence.ts`, prefix `/mock/confluence`):
- **Pages.** The six DOCS become pages `10001`… in DOCS order. Spaces: failover, node-3 disk and replication lag → `OPS`; E2EE → `ENG`; the release checklist and upgrade guide → `REL`.
- **Storage body.** It is generated from the plain text:
  - paragraphs are split on blank lines;
  - runs of `^\d+\. ` lines become `<ol><li>`, and `^- ` lines become `<ul><li>`;
  - text is HTML-escaped;
  - the first line is the title and is not repeated.
- **`/sim/docs`** keeps the original plain bodies until a page is edited; afterwards `/sim/docs/:id` returns the storage→text of the new body.
- `GET /rest/api/search?cql=&limit=` uses a CQL subset: `type = page`, `space in ("A","B")` or `space = "A"`, `text ~ "<q>"`, joined by ` AND `. It scores like `docsSearch` and returns `{results:[{content:{id, type:"page", title, space:{key}}, excerpt (≤160 chars plain), lastModified}], size}`. Anything else → 400.
- `GET /rest/api/content/{id}?expand=body.storage,version,space` → `{id, type, title, space:{key}, version:{number, when}, body:{storage:{value, representation:"storage"}}}`.
- `PUT /rest/api/content/{id}`: `version.number` must equal current + 1, else `409 {"message":"Version must be incremented"}`. Success → 200 with the new page.

Test `services/ops-sim/test/mock-atlassian.test.ts` (createSim on port 0):
1. The JQL `project = "OPS" AND statusCategory != Done AND fixVersion = "7.4" AND created >= -2d ORDER BY created DESC` → OPS-1430, OPS-1428, OPS-1427, OPS-1423.
2. A created issue appears in `/sim/tickets?status=open`.
3. A Jira comment appears in `/sim/tickets/OPS-1412`.
4. Transition to Done closes the sim ticket, and an unoffered id → 400.
5. Unsupported JQL → 400.
6. A CQL search for `failover` → 10001 first.
7. A page PUT with a stale version → 409; with current + 1 → 200, and `/sim/docs/doc-node-failover` changes.

### C3: GitLab and CalDAV mocks

GitLab mock (`src/mock-gitlab.ts`, prefix `/mock/gitlab/api/v4`):
- **Project.** `{id: 42, path_with_namespace: "platform/server"}`. `:id` accepts `42` or `platform%2Fserver`; anything else → `404 {"message":"404 Project Not Found"}`.
- `GET /projects/:id` → `{id, path_with_namespace, default_branch:"main"}`.
- `GET /projects/:id/merge_requests?state=opened|merged|all&target_branch=&per_page=` maps MRS to `{iid: 482, title, author:{username}, state: "opened"|"merged", source_branch (the pipeline ref; "docs/7.4-upgrade-guide" for 476), target_branch, updated_at}`, newest first.
- `GET /projects/:id/merge_requests/:iid` adds `head_pipeline:{id, status}`.
- `POST /projects/:id/merge_requests/:iid/notes {body}` → `201 {id, body, author:{username:"svc-bridge"}, created_at}`.
- `GET /projects/:id/pipelines?ref=&status=&per_page=` → `[{id, ref, status: "failed"|"success"|"running", created_at, updated_at}]`; sim `passed` = GitLab `success`.
- **Jobs.** Every pipeline has jobs `build` (`<pid>01`), `unit` (`<pid>02`) and `e2e-ios` (`<pid>03`); the failed job carries the sim `failed_job` name.
  - `GET /projects/:id/pipelines/:pid/jobs?scope[]=failed` → `[{id, name, stage, status}]`.
  - `GET /projects/:id/jobs/:job_id/trace` → `text/plain`: the LOGS lines for a failed job, else `$ make ci` / `Job succeeded`.
- **Triggering.** `POST /projects/:id/pipeline {ref, variables?}` → `201 {id, ref, status:"running", created_at}`.
  - Ids start at 9940. The new pipeline also shows in `/sim/dev/pipelines` as `running`.
  - After 90 s, refs `nightly` and `release/7.4` turn `failed` (`e2e-ios`, the 9921 trace); other refs turn `success`.
  - An unknown ref → `400 {"message":{"base":["Reference not found"]}}`.
- `GET /projects/:id/repository/branches/:name` → 200 `{name}` or 404 for anything other than main, nightly, release/7.4 and the MR source branches.

CalDAV mock (`src/mock-caldav.ts`, prefix `/mock/caldav`, Radicale-compatible subset):
- **Calendars.** One per person, at `/calendars/<user>/default/`, for `ana, vlad, rares, janosch, mira, tom, lea`. Each stores `{uid, etag, ics}`.
- **Seed times** are local `Europe/Zurich`. Copy `zonedToUtc` from C8 into the mock as a private helper. `workday(n)` = the n-th Mon–Fri from today.
- **Seed events:**
  - "Daily standup": 09:30–09:45 for the next 10 workdays, attendees ana, vlad, rares and janosch, as individual instances.
  - "7.4 go/no-go": `workday(1)` 14:00–14:30. Organizer ana; attendees vlad, janosch and mira. DESCRIPTION "Agenda: OPS-1412 status, nightly pipeline, Northwind go-live date".
  - "Focus: release notes": `workday(1)` 10:00–12:00, vlad.
  - "Northwind weekly sync": `workday(2)` 11:00–11:45. Organizer mira; attendees ana and tom. DESCRIPTION "Customer: Northwind Logistics. Topics: firm 7.4 date, iOS call quality, legal review"; LOCATION "Video".
  - "Baltic Freight pilot review": `workday(2)` 15:00–16:00, tom and lea.
  - "Architecture review: call reconnect": `workday(3)` 15:00–15:45. Organizer janosch; ana `PARTSTAT=NEEDS-ACTION`.
- **Attendees** are `mailto:<user>@team.example`, and every event is copied into each attendee's calendar with the same UID (implicit scheduling).
- **`REPORT /calendars/<user>/default/`**:
  - Read `<C:time-range start end/>` from the body with a regex.
  - Return `207` multistatus with one `<d:response>` per overlapping event. Each holds the href `/mock/caldav/calendars/<user>/default/<uid>.ics`, `<d:getetag>` and XML-escaped `<cal:calendar-data>`.
- **`GET …/<uid>.ics`** returns `text/calendar` with an `ETag`.
- **`PUT …/<uid>.ics`**:
  - `If-None-Match: *` on an existing uid → 412; an `If-Match` that does not match → 412.
  - Create → 201; update → 204. Both return the new `ETag`.
  - A PUT into the organizer's calendar syncs attendees into their calendars: their own PARTSTAT is kept if they already have the event, else NEEDS-ACTION.
  - An attendee PUT that changes only their PARTSTAT is copied into the organizer's copy.
- **Unknown user** → 404.

Tests:
- `services/ops-sim/test/mock-gitlab.test.ts`:
  1. The failed pipelines list includes 9934 and 9921, and 9921's failed job is 992103 with the reconnect trace.
  2. A triggered nightly pipeline is `running` in GitLab and in `/sim/dev/pipelines`.
  3. An unknown ref → 400.
  4. An MR note → 201.
- `services/ops-sim/test/mock-caldav.test.ts`:
  1. Ana's REPORT includes "7.4 go/no-go" with an ETag.
  2. A new event with attendee vlad shows in vlad's calendar as NEEDS-ACTION.
  3. A stale `If-Match` → 412.
  4. Ana accepting the architecture review updates janosch's copy.

### C14: HubSpot CRM v3 mock

`src/mock-hubspot.ts`, prefix `/mock/hubspot`, plus `store.crm`.
- **Seeding.** `store.crm` is seeded from `mock.ts` ACCOUNTS, DEALS and ACTIVITIES so `/sim/crm/*` output stays unchanged.
- **Companies:** `5001` Northwind Logistics, `5002` Helvetia Health, `5003` Baltic Freight. Properties: `name`, `domain` (`northwind.example`, …), `industry`, `annualrevenue` (= arr_eur), `lifecyclestage` (Northwind `opportunity`, Helvetia `customer`, Baltic `opportunity`) and `hubspot_owner_id` (Mira `101`, Tomas `102`).
- **Deals:** `7001` "Northwind Logistics 7.4 rollout", dealstage `contractsent`; `7002` Helvetia renewal, `closedwon`; `7003` Baltic pilot, `presentationscheduled`. Properties: `dealname`, `dealstage`, `amount`, `closedate`, `pipeline: "default"`, and `description` (depends_on + risks joined).
- **Activities.** Each ACTIVITIES entry becomes an object of type `calls`/`emails`/`meetings`/`notes`, with `hs_timestamp` and a body or title property:

  | type | properties |
  |---|---|
  | calls | `hs_call_title`, `hs_call_body` |
  | emails | `hs_email_subject` |
  | meetings | `hs_meeting_title`, `hs_meeting_body` |
  | notes | `hs_note_body` |

  Each is associated with its company.
- `POST /crm/v3/objects/companies/search`:
  - Body: `{filterGroups?: [{filters: [{propertyName: "name", operator: "CONTAINS_TOKEN", value}]}], properties, limit}`. Any other filter → `400 {status:"error", category:"VALIDATION_ERROR", message}`.
  - Response: `{total, results:[{id, properties, createdAt, updatedAt}]}`.
- `GET /crm/v3/objects/companies/{id}?properties=&associations=deals,notes,calls,meetings,emails` → `{id, properties, associations:{deals:{results:[{id, type}]}, …}}`.
- `GET /crm/v3/objects/deals/{id}?properties=&associations=companies` works the same way.
- `PATCH /crm/v3/objects/deals/{id} {properties:{dealstage}}` → 200. An unknown stage → 400.
- `POST /crm/v3/objects/{notes|calls|meetings|emails}/batch/read {properties, inputs:[{id}]}` → `{status:"COMPLETE", results:[…]}`.
- `POST /crm/v3/objects/{notes|tasks|calls|meetings} {properties, associations:[{to:{id}, types:[{associationCategory:"HUBSPOT_DEFINED", associationTypeId}]}]}` → `201 {id, properties}`. The type ids the mock accepts are listed in C15; it returns 400 for any other.
- `GET /crm/v3/pipelines/deals` → `{results:[{id:"default", label:"Sales Pipeline", stages:[…]}]}`. The stages, in order: `appointmentscheduled`, `qualifiedtobuy`, `presentationscheduled`, `decisionmakerboughtin`, `contractsent`, `closedwon`, `closedlost`, with HubSpot's default labels.
- `GET /crm/v3/owners` → `{results:[{id:"101", firstName:"Mira", lastName:"Novak", email:"mira@team.example"}, {id:"102", firstName:"Tomas", …}]}`.
- **Errors:** a missing object → `404 {status:"error", category:"OBJECT_NOT_FOUND", message}`.
- **Consistency:** notes, calls and meetings created through the mock appear in `/sim/crm/accounts/:id/activities` (shared store), and a stage change shows in `/sim/crm/deals/:id` as the stage label.

Test `services/ops-sim/test/mock-hubspot.test.ts`:
1. A company search for "north" → 5001.
2. Company associations list deal 7001 and four activities.
3. A created note associated with 5001 shows in `/sim/crm/accounts/acc-northwind/activities`.
4. PATCH dealstage `closedwon` → 200, and an unknown stage → 400.
5. A wrong association type id → 400.

### C4: Bridge connector core: types, config, network and egress guard, HTTP (test-author first)

New files in `services/bridge/src/connectors/`.

`types.ts`:
```ts
import type { ConnectorKind } from "@sa/protocol/connectors";
import type { Executor } from "../approvals/service.js";
import type { ToolCtx } from "../mcp/registry.js";
import type { ConnectorConfig } from "./config.js";
import type { ConnectorHttp } from "./http.js";

export type ConnectorRuntime = {
  id: string;
  kind: ConnectorKind;
  cfg: ConnectorConfig;
  http: ConnectorHttp;
  /** IANA zone from the config's top-level `timezone` */
  timezone: string;
  /** is the tool (suffix) still enabled in config and selected for this agent? used by executors */
  allowed(agentId: string, tool: string): boolean;
};
export type ToolSchema = {
  tool: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
};
export type ReadTool = ToolSchema & {
  run(rt: ConnectorRuntime, ctx: ToolCtx, args: Record<string, unknown>): Promise<unknown>;
};
export type WriteTool = ToolSchema & { executor(rt: ConnectorRuntime): Executor };
export type KindModule = {
  kind: ConnectorKind;
  read: readonly ReadTool[];
  write: readonly WriteTool[];
  /** kind-specific config check; returns a short error or null */
  checkConfig?(cfg: ConnectorConfig): string | null;
};
```

`egress.ts`:
```ts
/** D-15/D-16: the only non-local hosts any connector may contact, and their fixed API bases. */
export const CLOUD_HOSTS = {
  "google-calendar": ["www.googleapis.com", "oauth2.googleapis.com"],
  "microsoft-graph": ["graph.microsoft.com", "login.microsoftonline.com"],
  hubspot: ["api.hubapi.com"],
} as const;
export const CLOUD_BASE = {
  "google-calendar": "https://www.googleapis.com/calendar/v3",
  "microsoft-graph": "https://graph.microsoft.com/v1.0",
  hubspot: "https://api.hubapi.com",
} as const;
export type CloudKind = keyof typeof CLOUD_HOSTS;
export const isCloudKind = (k: string): k is CloudKind => Object.hasOwn(CLOUD_HOSTS, k);
```
C15 verifies the HubSpot host list against HubSpot's docs and edits only this constant (plus C11's Python test, which reads it).

`config.ts`: `loadConnectorsConfig({path, opsSimUrl, env}): LoadedConfig`, validated with zod.
- **Top level:**
  - `version: 1`
  - `timezone`: IANA, checked with `Intl.DateTimeFormat`; default `Europe/Zurich`
  - `connectors: Record<id, ConnectorConfig>`
  - `templates: Record<template, Record<connectorId, {default: string[], allow?: string[]}>>`
- **`ConnectorConfig` common fields:**
  - `kind`: one of `CONNECTOR_KINDS`.
  - `enabled`: defaults to **true for self-hosted and mock kinds, and false for cloud kinds without `mock: true`** (D-15/D-16 are off by default).
  - `mock`: default false. Only `hubspot` and the self-hosted kinds may set it, and a mock's host must be the ops-sim host.
  - `base_url`: http/https without userinfo or a trailing slash. Required for self-hosted kinds and mocks; forbidden for cloud non-mock kinds, which use `CLOUD_BASE`.
  - `allow_public_address`: self-hosted only.
  - `tools`: a subset of the catalog; default all.
- **`auth`** is one of:
  - `{type:"none"}`
  - `{type:"bearer", token_env}`
  - `{type:"basic", user_env, token_env}`
  - `{type:"private-token", token_env}`
  - `{type:"google-service-account", credentials_env}`: `google-calendar` only.
  - `{type:"ms-client-credentials", tenant_id (GUID), client_id_env, client_secret_env}`: `microsoft-graph` only.

  Env names match `^[A-Z][A-Z0-9_]{1,63}$`.
- **Kind fields:**

  | kind | fields |
  |---|---|
  | jira | `project` (`^[A-Z][A-Z0-9]{1,9}$`) |
  | confluence | `spaces` (1–10 keys) |
  | gitlab | `project`; `triggers: [{name: ^[a-z0-9-]{1,32}$, ref, variables?}]` |
  | github | `repo` (`owner/name`); `workflows: [{name, file, ref}]` |
  | caldav | `calendar_path` (contains `{user}`) |
  | all calendar kinds | `email_domain`; `users?: Record<userId, {principal?, email?}>`; `working_hours?: {start:"09:00", end:"17:00"}` |
  | hubspot | `pipeline` (default `"default"`) |

- **Interpolation.** `${OPS_SIM_URL}` in `base_url` is replaced by `opsSimUrl`; no other interpolation.
- **Load failures.**
  - A missing file → `{connectors: [], templates: {}}` plus an info log. Invalid YAML → the same plus an error log.
  - A single invalid connector → `invalid_config` with a short `status_text`; the others proceed.
  - Template entries naming an unknown connector or tool → dropped with a warn log.
- **Status:** `disabled` (not enabled); `not_configured` (a named env var is unset or empty → "Set JIRA_TOKEN in the bridge env"); otherwise `ok` until the network guard runs.
- **`mode`:** `mock` if `mock: true`; `cloud` for cloud kinds; else `self-hosted`. **`host`** is the hostname.
- **Path resolution:** `SA_CONNECTORS_CONFIG`; else none under vitest; else `<repo>/config/connectors.yaml`. Find the repo root the way `agents/hermes.ts` finds `ROOT` (verify in task).

`netguard.ts`:
- `isPrivateAddress(ip)` covers IPv4 127/8, 10/8, 172.16/12, 192.168/16, 100.64/10 and 169.254/16; IPv6 ::1, fc00::/7 and fe80::/10; and IPv4-mapped addresses.
- `checkConnectorHost(url, allowPublic, lookup = dns.lookup)` returns `"ok" | "public_address" | "unresolvable"`. `localhost` and IP literals need no DNS. It applies only to self-hosted and mock connectors; cloud connectors are checked by host allowlist instead.

`http.ts`:
- `ConnectorError extends Error` with `code: "not_configured"|"unreachable"|"timeout"|"rejected_token"|"not_found"|"conflict"|"bad_request"|"upstream"|"too_large"|"host_not_allowed"`. Messages are written for people and name only the connector label.
- `makeHttp(cfg, env = process.env, fetchImpl = fetch, auth?: () => Promise<Record<string,string>>): ConnectorHttp`:

  ```ts
  export type HttpResult = { status: number; headers: Headers; text: string; json<T = unknown>(): T };
  export type ConnectorHttp = {
    request(
      method: "GET" | "POST" | "PUT" | "PATCH" | "REPORT",
      path: string,
      opts?: {
        query?: Record<string, string | number | undefined>;
        json?: unknown;
        body?: string;
        contentType?: string;
        headers?: Record<string, string>;
        /** statuses returned instead of thrown, e.g. [404, 409, 412] */
        accept?: number[];
      },
    ): Promise<HttpResult>;
    /** D-15 token endpoints only: absolute https URL whose host must be in CLOUD_HOSTS[kind] */
    postForm(url: string, form: Record<string, string>): Promise<HttpResult>;
  };
  ```

- **URL rules:** `path` must start with `/` and must not contain `//`, `..` or `://`. The URL is base + path. For cloud kinds, base = `CLOUD_BASE`, and every final URL host must be in `CLOUD_HOSTS[kind]` with `https:`, else `host_not_allowed` is thrown before fetch. `postForm` applies the same host check.
- **Auth** is built at call time: bearer → `Authorization: Bearer <v>`; basic → `Basic base64(user:token)`; private-token → `PRIVATE-TOKEN: <v>`. The two OAuth types use the injected `auth()` callback, which C16 provides.
- **Fetch settings:** `redirect: "error"`, `AbortSignal.timeout(8000)`, `Accept: application/json` unless given, and a 1 MiB body cap.
- **Status mapping:** 401/403 → `rejected_token`; 404 → `not_found`; 409/412 → `conflict`; 400/422 → `bad_request`; ≥500 → `upstream`, except statuses listed in `opts.accept`.
- **Logging:** one line `{level:"info", msg:"connector call", connector, method, status, ms}` only.

`config/connectors.yaml` (new, shipped):

```yaml
# Connectors: systems the agents can use through the bridge.
# Tokens are never written here: auth names an environment variable of the bridge process.
# The demo points every connector at the local mocks inside ops-sim. Nothing leaves this Mac.
version: 1
timezone: Europe/Zurich
connectors:
  jira:
    kind: jira
    mock: true
    base_url: ${OPS_SIM_URL}/mock/jira
    auth: { type: none }
    project: OPS
  confluence:
    kind: confluence
    mock: true
    base_url: ${OPS_SIM_URL}/mock/confluence
    auth: { type: none }
    spaces: [OPS, ENG, REL]
  gitlab:
    kind: gitlab
    mock: true
    base_url: ${OPS_SIM_URL}/mock/gitlab
    auth: { type: none }
    project: platform/server
    triggers:
      - { name: nightly, ref: nightly }
      - { name: release-7.4, ref: release/7.4 }
  calendar:
    kind: caldav
    mock: true
    base_url: ${OPS_SIM_URL}/mock/caldav
    auth: { type: none }
    calendar_path: /calendars/{user}/default/
    email_domain: team.example
  crm:
    kind: hubspot
    mock: true
    base_url: ${OPS_SIM_URL}/mock/hubspot
    auth: { type: none }
  # Self-hosted example (docs/connectors.md):
  # github:
  #   kind: github
  #   base_url: https://github.example.internal/api/v3
  #   auth: { type: bearer, token_env: GITHUB_TOKEN }
  #   repo: platform/server
  #   workflows:
  #     - { name: nightly, file: nightly.yml, ref: main }
  # D-15, off by default. Replace the calendar entry above with one of these:
  # calendar:
  #   kind: google-calendar
  #   enabled: true
  #   auth: { type: google-service-account, credentials_env: GOOGLE_CALENDAR_CREDENTIALS }
  #   email_domain: example.com
  # calendar:
  #   kind: microsoft-graph
  #   enabled: true
  #   auth: { type: ms-client-credentials, tenant_id: 00000000-0000-0000-0000-000000000000,
  #           client_id_env: MS_CALENDAR_CLIENT_ID, client_secret_env: MS_CALENDAR_CLIENT_SECRET }
  #   email_domain: example.com
  # D-16, off by default. Replace the crm entry above with:
  # crm:
  #   kind: hubspot
  #   enabled: true
  #   auth: { type: bearer, token_env: HUBSPOT_TOKEN }
templates:
  dev:
    gitlab: { default: [merge_requests, pipelines, job_log, trigger_pipeline], allow: [mr_comment] }
    jira: { default: [search, issue, comment, create_issue], allow: [transition] }
    github: { default: [pull_requests, workflow_runs, dispatch_workflow], allow: [pr_comment] }
  qa:
    jira: { default: [search, issue, create_issue, transition], allow: [comment] }
    gitlab: { default: [pipelines, trigger_pipeline], allow: [job_log] }
  tech:
    confluence: { default: [search, page, edit_page] }
    jira: { default: [], allow: [search, issue] }
  ops:
    gitlab: { default: [pipelines], allow: [job_log, trigger_pipeline] }
    confluence: { default: [search, page] }
  sales:
    crm: { default: [accounts, deal, activities, create_note], allow: [create_task, update_deal_stage, log_activity] }
    calendar: { default: [free_busy, events, create_event], allow: [respond] }
  scribe:
    calendar: { default: [free_busy, events, create_event, respond] }
  general:
    confluence: { default: [], allow: [search, page] }
    calendar: { default: [], allow: [free_busy, events, create_event] }
  devops:
    gitlab: { default: [], allow: [pipelines, job_log] }
    confluence: { default: [], allow: [search, page] }
```

Tests (the test author writes them first).

`services/bridge/test/connectors-config.test.ts`:
1. The shipped file loads five `ok` mock connectors with `${OPS_SIM_URL}` replaced, and none is `cloud`.
2. A bearer connector without its env var is `not_configured`, and the text names the variable.
3. A bad kind is isolated as `invalid_config`.
4. `kind: hubspot` without `mock` and without `enabled: true` → `disabled`; with `enabled: true` and `HUBSPOT_TOKEN` set → `ok`, `mode: cloud`, and a `base_url` given for it → `invalid_config`.
5. Template tools outside the catalog are dropped.
6. Under vitest with no `SA_CONNECTORS_CONFIG`, nothing loads.

`services/bridge/test/connectors-net.test.ts`:
1. The private/public table: 10.1.2.3, 100.100.1.1, ::1 and fd00::1 are private; 8.8.8.8 and 2001:4860::1 are public.
2. A public host → `public_address` unless `allow_public_address`.
3. The sentinel bearer reaches a local test server, while a 401 error message and every log line lack it.
4. A redirect fails.
5. `..` in a path throws.
6. A 2 MiB body → `too_large`.
7. A cloud hubspot http object with a fake fetch:
   - a request goes to `https://api.hubapi.com/...`;
   - `postForm("https://evil.example/token")` → `host_not_allowed`, and fetch is never called.

### C5: Jira and Confluence adapters (test-author first)

`services/bridge/src/connectors/jira.ts`, `confluence.ts` and `storage.ts`. Each exports `kindModule: KindModule`.
- Results are compact JSON objects; C6's factory stringifies them and truncates at 6000 chars.
- Argument handling: trim strings, fall back to the enum default, and clamp numbers (as `num()` in `mcp/server.ts`).

Jira (the project comes from `cfg.project`):
- `search` `{text?: ≤100, status?: "open"|"done"|"any" (open), fix_version?: ≤20, created_within_days?: 1–90, assignee?: ≤40, limit?: 1–20 (10)}`.
  - It builds JQL from these clauses, joined by ` AND ` and followed by ` ORDER BY created DESC`: `project = "<P>"`; `statusCategory != Done` (open) or `statusCategory = Done` (done); `fixVersion = "<v>"`; `created >= -<n>d`; `assignee = "<u>"`; `text ~ "<q>"`.
  - Escaping: values are quoted, `\` → `\\` and `"` → `\"`, and control characters are stripped.
  - It returns `{jql, total, issues:[{key, summary, status, priority, type, created, reporter, assignee, fix_versions}]}`.
  - Description: "Search Jira issues. For 'new tickets for 7.4' use fix_version 7.4 and created_within_days 7."
- `issue` `{key: ^[A-Z][A-Z0-9]{1,9}-\d{1,7}$}` returns those fields plus `description` (≤ 2000) and `comments` (the last 10, each body ≤ 500).
- `create_issue` (W) `{summary 1–200, description? ≤4000, type?: Bug|Task|Story (Bug), priority?: Highest|High|Medium|Low (Medium), fix_version?}`.
  - validate: the fix version exists (`GET /rest/api/2/project/<P>/versions`).
  - preview: title `Create Jira issue in <P>`, target `<P> · <type> · <priority>`; fields summary and description are editable.
  - execute: POST with the audit line appended to the description. Result `Created OPS-1431: <summary>`; public `created OPS-1431`.
- `comment` (W) `{key, body 1–4000}`. validate: the issue exists, else `ArgsError("No issue <key>.")`. The body is editable. Result `Commented on <key>.`
- `transition` (W) `{key, to: 1–40}`.
  - validate: GET the transitions and match `to.name` case-insensitively; store `transition_id` and the canonical `to`. No match → `ArgsError("<key> can't move to <to>; it can move to: A, B.")`.
  - execute: POST. Result `Moved <key> to <to>.`

Confluence (the spaces come from `cfg.spaces`):
- `search` `{query 1–200, space?, limit 1–10 (5)}` sends the CQL `type = page AND space in (…) AND text ~ "<q>"`. It returns `{results:[{page_id, title, space, updated, excerpt}]}`.
- `page` `{page_id: ^\d{1,12}$}` returns `{page_id, title, space, version, updated, text (≤8000)}`. A page outside the configured spaces returns `{error:"page_outside_spaces"}`.
- `edit_page` (W) `{page_id, mode: append|replace (append), text 1–8000, summary? ≤200}`.
  - validate: the page exists and is in the spaces; set `base_version` only when it is absent.
  - preview: title `Edit "<title>"`, target `<space> · version <base> → <base+1>`; the text is editable.
  - execute: GET the page again. If its version ≠ `base_version`, throw `ExecError("The page changed after the request; ask again.")`. Otherwise PUT the old storage + `textToStorage(text)` (append) or `textToStorage(text)` (replace), plus the audit paragraph. Result `Updated "<title>" to version N.`
- `storage.ts`:
  - `storageToText(xhtml)`: `<li>` → `- `, `</p>`/`<br/>` → newline, strip the remaining tags, decode `&amp; &lt; &gt; &quot; &#39; &nbsp;`, and collapse 3+ newlines.
  - `textToStorage(text)`: escape `& < > "`, turn blank-line paragraphs into `<p>`, `- ` runs into `<ul>` and `\d+. ` runs into `<ol>`, and nothing else.

Test `services/bridge/test/connectors-atlassian.test.ts`. Start ops-sim in-process with `const { createSim } = await import(SIM)`, where `const SIM: string = new URL("../../ops-sim/src/server.ts", import.meta.url).href`, so tsc does not follow it (verify in task). Call `run`/`executor` with a stub `ConnectorRuntime` built from `makeHttp`.
1. `search` with fix 7.4 and 2 days → 4 issues, newest first.
2. Quotes and a backslash in `text` give valid escaped JQL.
3. `create_issue` → OPS-1431 with the audit line, and an unknown fix version → ArgsError.
4. `transition` "done" → id 31, and "Blocked" → an ArgsError listing the options.
5. `edit_page` after the page changed → ExecError and no PUT.
6. `textToStorage("<script>")` is escaped.
7. `page` outside the spaces → error.

### C15: HubSpot adapter (D-16; test-author first)

`services/bridge/src/connectors/hubspot.ts`. The same code serves the mock (`mock: true`, `base_url` = ops-sim) and the real API (cloud, `CLOUD_BASE.hubspot`, Bearer `HUBSPOT_TOKEN`).
- **Verify the hosts.** Before coding, check HubSpot's current API docs for the official host(s) (`api.hubapi.com`; check whether EU-hosted accounts need another host) and the default association type ids below. Update `CLOUD_HOSTS.hubspot` in `egress.ts` if needed, and record the source URL and date in the ledger.
- **Default association type ids** (HubSpot-defined; verify):

  | object | → company | → deal |
  |---|---|---|
  | note | 190 | 214 |
  | task | 192 | 216 |
  | call | 182 | 206 |
  | meeting | 188 | 212 |

- **Owner names** come from `GET /crm/v3/owners` (cached in memory for 10 min).
- `accounts` `{query? ≤100}`: a companies search (`CONTAINS_TOKEN` on `name` when a query is given, else no filter), limit 10. For up to 5 results it also GETs each company with `associations=deals` and returns `{accounts:[{account_id, name, domain, industry, lifecycle, annual_revenue, owner, deal_ids}]}`.
- `deal` `{deal_id: ^\d{1,15}$}`: GET the deal with `properties=dealname,dealstage,amount,closedate,pipeline,description` and `associations=companies`. The stage label comes from `GET /crm/v3/pipelines/deals` (cached 10 min). It returns `{deal_id, name, stage, amount, close_date, description (≤1000), account_ids}`.
- `activities` `{account_id}`: the company's associations for notes, calls, meetings and emails, then a `batch/read` per type. It returns `{activities:[{at, kind, summary (≤300)}]}`, newest first, ≤ 15.
- **Writes.** All take `account_id?` and/or `deal_id?`, and at least one is required. validate checks that every target exists (404 → `ArgsError("No company <id>.")` or `ArgsError("No deal <id>.")`). The preview names the target names, and the bodies are editable.
  - `create_note` (W) `{body 1–4000}` → POST notes `{hs_note_body: body + audit, hs_timestamp: now}`. Result `Added a note to <name>.`
  - `create_task` (W) `{subject 1–200, body? ≤4000, due: YYYY-MM-DD (today…+365 d), priority?: LOW|MEDIUM|HIGH}` → POST tasks with `hs_task_subject`, `hs_task_body`, `hs_timestamp` (due, 09:00 local), `hs_task_status: "NOT_STARTED"` and `hs_task_priority`.
  - `update_deal_stage` (W) `{deal_id, stage}`.
    - validate: resolve `stage` by label or id in the deal's pipeline, and store `stage_id` and `from_stage` (`from_stage` only when absent). No match → `ArgsError` listing the stage labels. Idempotent.
    - preview: `Move "<deal>" from <A> to <B>`.
    - execute: GET the deal. If its `dealstage` ≠ `from_stage`, throw `ExecError("The deal moved since the request; ask again.")`. Otherwise PATCH. Result `Moved "<deal>" to <B>.`
  - `log_activity` (W) `{kind: call|meeting, title 1–200, body? ≤4000, at?: "YYYY-MM-DD HH:mm" local or ISO (default now; not in the future), duration_min? 1–480}`.
    - A call is POSTed to calls with `hs_call_title`, `hs_call_body`, `hs_timestamp`, `hs_call_duration` (ms) and `hs_call_status: "COMPLETED"`.
    - A meeting is POSTed to meetings with `hs_meeting_title`, `hs_meeting_body`, `hs_meeting_start_time`, `hs_meeting_end_time` and `hs_timestamp`.
- **HubSpot errors** `{category, message}` map to `ConnectorError` without echoing `message` when the status is 401/403.

Test `services/bridge/test/connectors-hubspot.test.ts`:
1. Against the in-process mock (as in C5):
   1. `accounts "north"` → Northwind with `deal_ids [7001]` and owner "Mira Novak".
   2. `deal 7001` → stage "Contract sent" and the description mentions OPS-1412.
   3. `create_note` on 5001 → shows in `activities`.
   4. `update_deal_stage` to "closed won" after the mock stage changed → ExecError and no PATCH.
   5. Unknown targets → ArgsError.
2. Against a fake `fetchImpl` in cloud mode with `HUBSPOT_TOKEN=tok-SENTINEL-9f3a`:
   1. URLs are `https://api.hubapi.com/crm/v3/...` with Bearer.
   2. A 401 → `rejected_token`, and the message has no sentinel.

### C7: GitLab and GitHub adapters (test-author first)

`services/bridge/src/connectors/gitlab.ts` (project = `encodeURIComponent(cfg.project)`):
- `merge_requests` `{state?: opened|merged|all (opened), target_branch?, limit 1–20 (10)}` → `{merge_requests:[{iid:"!482", title, author, state, source_branch, target_branch, updated_at}]}`.
- `pipelines` `{ref?, status?: failed|success|running|any (any), limit 1–10 (5)}`. For up to 3 failed pipelines it also GETs jobs `scope[]=failed`. It returns `{pipelines:[{id, ref, status, created_at, failed_jobs:[{job_id, name, stage}]}]}`. Description: "For a failed job's log call gitlab_job_log with its job_id."
- `job_log` `{job_id: ^\d{1,12}$, lines 10–200 (60)}`: the trace with ANSI codes (`\x1b\[[0-9;]*[A-Za-z]`) and section markers (`section_(start|end):\d+:[\w.-]+\r?`) stripped, as the last N lines, each ≤ 300 chars.
- `trigger_pipeline` (W) `{pipeline: one of cfg.triggers[].name}`. The description lists the names; the model never sends a ref or variables.
  - validate: the name is in config, `GET /repository/branches/<ref>` → 200 (else `ArgsError("Branch <ref> was not found.")`), and the tool is `allowed`.
  - preview: `Start the <name> pipeline`, target `<project> · <ref>`, nothing editable.
  - execute: `POST /projects/:id/pipeline {ref, variables}`. Result `Started pipeline <id> on <ref> (<name>).`; public `started pipeline <id>`.
- `mr_comment` (W) `{iid: ^!?\d{1,7}$, body 1–4000}`: validate that the MR exists, then POST a note with the audit line.

`services/bridge/src/connectors/github.ts` (`cfg.repo`; headers `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`):
- `pull_requests` → `GET /repos/<o>/<r>/pulls`.
- `workflow_runs` → `GET /repos/<o>/<r>/actions/runs`, plus failed jobs of up to 3 runs.
- `dispatch_workflow` (W) `{workflow: one of cfg.workflows[].name}`: validate with `GET /actions/workflows/<file>`, then `POST …/dispatches {ref}` → 204.
- `pr_comment` (W) `{number, body}`: validate with `GET /pulls/<n>`, then `POST /issues/<n>/comments`.

Tests:
- `services/bridge/test/connectors-gitlab.test.ts` (in-process ops-sim):
  1. Failed pipelines → 9934 and 9921 with job ids.
  2. `job_log` strips ANSI codes.
  3. An unknown trigger name → ArgsError with no request; `nightly` → `Started pipeline 9940 on nightly (nightly).`
  4. A trigger removed from config before execute → failure and no POST.
- `services/bridge/test/connectors-github.test.ts` (fake `fetchImpl`):
  1. Lists map their fields.
  2. Dispatch uses the configured file and ref.
  3. A 401 → `rejected_token` without the token.

### C8: Calendar tools + CalDAV backend (test-author first)

`services/bridge/src/connectors/calendar-tools.ts` defines the four calendar tools once, on top of this interface:

```ts
export type Busy = { start: number; end: number };
export type CalAttendee = { email: string; name?: string; response: "accepted" | "declined" | "tentative" | "needs_action" };
export type CalEvent = {
  id: string; title: string; description: string; location: string;
  start: number; end: number; allDay: boolean;
  organizer?: string; attendees: CalAttendee[];
  /** ETag / changeKey / etag: compared at execute time */
  version: string;
};
export type NewEvent = { title: string; description: string; location: string; start: number; end: number; attendees: { email: string; name: string }[] };
export interface CalendarBackend {
  busy(emails: string[], from: number, to: number): Promise<Map<string, Busy[]>>;
  events(email: string, from: number, to: number): Promise<CalEvent[]>;
  get(email: string, id: string): Promise<CalEvent | null>;
  /** idempotent on `key` (an already-created event counts as success) */
  create(organizerEmail: string, ev: NewEvent, key: string): Promise<{ id: string }>;
  /** throws ConnectorError("conflict") when `version` no longer matches */
  respond(email: string, id: string, response: "accept" | "decline" | "tentative", version: string): Promise<void>;
}
export function calendarKind(kind: ConnectorKind, makeBackend: (rt: ConnectorRuntime) => CalendarBackend): KindModule;
```

- **Identity.**
  - Workspace people are `sa.users` with `kind in ('person','seed')`.
  - A person's email is `cfg.users[id]?.email ?? users.email ?? <id>@<email_domain>`.
  - Names from the model resolve case-insensitively by id, by display name or by the first name of the display name. Ambiguous or unknown names are listed in `unknown`.
- **`free_busy`** `{people?: string[] ≤12 (default: the active human members of the current chat), from?: YYYY-MM-DD (today in tz), days?: 1–14 (5), duration_min?: 15–240 (30)}`.
  - Returns `{timezone, from, to, people:[{name, busy:[{start,end}]}], free_slots:[{start,end}], unknown:[]}`, with local `YYYY-MM-DD HH:mm` times.
  - **Only intervals: never titles, descriptions, locations or attendees.**
  - Description: "To find a time for everyone in this chat, call with no people. To schedule a follow-up from call notes, take the attendees from the notes, call calendar_free_busy, then calendar_create_event."
- **`events`** `{from?, days? 1–14 (7), query?}`:
  - With no requester → `{error:"needs_a_person"}`.
  - When the current chat is not the requester's DM with this agent → `{error:"events_only_in_dm", message:"I can show your own events only in our direct message. Here I can only see when people are busy."}`. The DM test is the same as `chat_digest` in `mcp/server.ts`: a `dm` chat with exactly the agent and the requester active.
  - Otherwise it returns `{timezone, events:[{event_id, title, start, end, location, organizer, attendees:[name], my_response, description (≤500)}]}` from the requester's calendar only.
  - Description: "For an agenda, read the event's description and attendees."
- **`create_event`** (W) `{title 1–200, start: "YYYY-MM-DD HH:mm" local or ISO with offset, duration_min 15–240 (30), attendees: string[] ≤20, description? ≤4000, location? ≤200}`.
  - validate:
    - start is ≥ now + 5 min and ≤ now + 90 days;
    - every attendee resolves, else `ArgsError("I don't know <names>.")`;
    - the organizer is the approver;
    - the tool is `allowed`;
    - `start` is normalised to local `YYYY-MM-DD HH:mm`, and `duration_min` is accepted as a number or a numeric string (approver edits; verify in task).
  - preview: title `Create "<title>"`, target `<Wed 29 Oct 14:00–14:30> (<tz>) · <n> people`; title, start, duration_min and description are editable; attendees are not.
  - execute: `backend.create(approverEmail, …, key = "sa-" + approval id)`, with the audit line in the description. Result `Created "<title>" on <date time> and invited <names>.`; public `created event`.
- **`respond`** (W) `{event_id 1–1024, response: accept|decline|tentative}`.
  - validate: the event is in the approver's calendar and starts in the future, and the approver is an attendee and not the organizer. Store `version` (only when absent).
  - execute: `backend.respond(…, version)`. A conflict → `ExecError("The event changed; ask again.")`. Result `Accepted "<title>".`; public `answered invitation`.
- **`freeSlots(busy, from, to, durationMin, tz, hours = {start:"09:00", end:"17:00"}, max = 8)`**: Mon–Fri working windows in tz; candidate starts on 30-minute boundaries no earlier than `max(from, now rounded up)`; no overlap with any busy interval.

`services/bridge/src/connectors/ics.ts` (pure):
- **`parseIcs(text, defaultTz): ParsedEvent[]`:**
  - Unfold CRLF + space/tab.
  - Times: `Z` (UTC), `TZID=` (via `zonedToUtc`), floating (`defaultTz`), and `VALUE=DATE` (all-day; the end defaults to +1 day).
  - `DURATION` `P…T…H…M`; with no end, end = start.
  - `RRULE` → `recurring: true`, base instance only (the server expands recurrences).
  - `TRANSP:TRANSPARENT` and `STATUS:CANCELLED` are excluded from busy.
  - Unescape `\\ \; \, \n`.
- **`buildEvent(...)`** writes VCALENDAR 2.0 with `PRODID:-//sovereign-agents//connectors//EN`, UTC times, `ATTENDEE;CN=…;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:…`, escaped text and lines folded at 75 octets.
- **`setPartstat(raw, email, partstat)`** changes the matching ATTENDEE line only, and throws when that email is not an attendee.
- **`zonedToUtc`**:
  ```ts
  function tzOffsetMs(utcMs: number, tz: string): number {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit",
        day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
        .formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]),
    );
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return asUtc - utcMs;
  }
  export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    const first = guess - tzOffsetMs(guess, tz);
    return guess - tzOffsetMs(first, tz);
  }
  ```

`services/bridge/src/connectors/caldav.ts` exports `kindModule = calendarKind("caldav", rt => new CalDavBackend(rt))`.
- A person's principal = `cfg.users[id]?.principal ?? id`, and their collection = `calendar_path` with `{user}` replaced.
- **Reads** send `REPORT` with `Depth: 1` and a calendar-query on VEVENT with `<C:time-range>` and `<C:calendar-data><C:expand start end/></C:calendar-data>`. The `<d:response>` blocks are parsed with regexes (href, getetag, calendar-data, XML-unescaped).
- **`busy`** is one REPORT per person.
- **`create`** PUTs `<key>.ics` with `If-None-Match: *` (a 412 counts as success).
- **`respond`** does a GET, compares the ETag with `version`, applies `setPartstat` and PUTs with `If-Match`.

Tests:
- `services/bridge/test/connectors-ics.test.ts` (pure):
  1. Folding, TZID and all-day events parse to the right UTC, across the late-October DST change.
  2. `buildEvent` round-trips through `parseIcs`, and `,;\n` survive.
  3. `freeSlots` skips weekends and busy intervals and keeps to 09:00–17:00.
  4. `setPartstat` touches only the matching attendee.
- `services/bridge/test/connectors-caldav.test.ts` (in-process ops-sim + pglite with users ana, vlad, mira, and a DM chat between ana and the agent):
  1. `free_busy` for ana and vlad over workday(1) excludes 10:00–12:00 and 14:00–14:30, and the output contains neither "go/no-go" nor "Focus" nor any attendee address.
  2. `events` in ana's DM returns "Northwind weekly sync"; in a group chat → `events_only_in_dm`; with no requester → `needs_a_person`.
  3. `create_event`: an unknown attendee → ArgsError; after approval the event is in vlad's mock calendar as NEEDS-ACTION.
  4. `respond` accept updates janosch's copy, and a stale ETag → ExecError.
  5. A start in the past → ArgsError.

### C16: Google Calendar and Microsoft Graph backends (D-15)

`services/bridge/src/connectors/oauth.ts`. Access tokens are cached in memory per (connector, subject) until 60 s before expiry and are never logged.
- `googleToken(rt, subjectEmail)`:
  - Parse the key JSON from `env[credentials_env]` (`client_email`, `private_key`), and ignore `token_uri`.
  - Sign a JWT with `jose` `SignJWT` RS256 (`importPKCS8`): `{iss: client_email, sub: subjectEmail, scope: "https://www.googleapis.com/auth/calendar", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600}`.
  - `rt.http.postForm("https://oauth2.googleapis.com/token", {grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion})` returns `access_token` and `expires_in`.
- `msToken(rt)`: `postForm("https://login.microsoftonline.com/<tenant_id>/oauth2/v2.0/token", {grant_type: "client_credentials", client_id, client_secret, scope: "https://graph.microsoft.com/.default"})`.

`services/bridge/src/connectors/google-calendar.ts`: `calendarKind("google-calendar", …)`, base `CLOUD_BASE`, auth header from `googleToken(rt, <the user acted for>)`.
- **busy:** `POST /freeBusy {timeMin, timeMax, items:[{id: email}]}` as the requester → `calendars[email].busy`.
- **events:** `GET /calendars/primary/events?timeMin&timeMax&singleEvents=true&orderBy=startTime&maxResults=50`, impersonating the user.
- **get:** `GET /calendars/primary/events/<id>`.
- **create:**
  - `POST /calendars/primary/events?sendUpdates=all`, impersonating the organizer, with a client event `id` = base32hex(lowercase) of the key. Google's allowed alphabet is `a-v0-9` and the length 5–1024; verify in task.
  - A 409 counts as success.
- **respond:**
  - GET the event; its `etag` must equal `version`.
  - PATCH `attendees` with the user's `responseStatus` (`accepted`/`declined`/`tentative`), sending `If-Match: <etag>` and `sendUpdates=all`. A 412 → conflict.

`services/bridge/src/connectors/msgraph-calendar.ts`: `calendarKind("microsoft-graph", …)`, Bearer `msToken`.
- **busy:** `POST /users/<requester>/calendar/getSchedule {schedules: emails, startTime:{dateTime, timeZone:"UTC"}, endTime, availabilityViewInterval: 30}` → `scheduleItems` with status `busy|tentative|oof|workingElsewhere`. `free` items are ignored, and `subject` is never read.
- **events:** `GET /users/<email>/calendarView?startDateTime&endDateTime&$select=id,subject,bodyPreview,location,start,end,isAllDay,organizer,attendees,changeKey,responseStatus&$top=50` with header `Prefer: outlook.timezone="UTC"`.
- **create:** `POST /users/<organizer>/events` with `transactionId` = key (Graph de-duplicates on it).
- **respond:** GET the event and compare `changeKey`, then `POST /users/<email>/events/<id>/accept|decline|tentativelyAccept {sendResponse: true}`.
- **Event ids** are percent-encoded in paths.

Tests (fake `fetchImpl` only; no network), `services/bridge/test/connectors-cloud-calendar.test.ts`:
1. Google:
   1. The token request goes to `oauth2.googleapis.com` with a JWT whose `sub` is the requester and whose `aud` is fixed, even when the key's `token_uri` is `https://evil.example`.
   2. A free/busy result exposes no summary even when the fake returns one.
   3. Create sends the derived id and `sendUpdates=all`, and a 409 → success.
2. Microsoft:
   1. The token request goes to `login.microsoftonline.com/<tenant>`.
   2. getSchedule maps busy items and drops `free`.
   3. respond with a changed `changeKey` → ExecError and no POST.
3. Logs and errors never contain the private-key sentinel, the client secret sentinel or the access token returned by the fake.

### C6: Bridge proxy: registry seam, MCP, store, routes, plugin, /access (test-author first)

`services/bridge/src/mcp/registry.ts`:

```ts
export type AgentToolSet = { add: RegisteredTool[]; hide: ReadonlySet<string> };
const EMPTY: AgentToolSet = { add: [], hide: new Set() };
let agentProvider: ((agentId: string, template: string) => AgentToolSet) | null = null;
/** The connectors plugin sets this; synchronous (backed by an in-memory cache). */
export function setAgentToolProvider(p: typeof agentProvider): void {
  agentProvider = p;
}
export function agentToolSet(agentId: string, template: string): AgentToolSet {
  return agentProvider?.(agentId, template) ?? EMPTY;
}
```

`invokeTool` looks a tool up as `set.add.find(t => t.name === name) ?? (set.hide.has(name) ? undefined : byTemplate.get(template)?.get(name))`.

`services/bridge/src/mcp/server.ts` `toolsFor`:
- Filter `builtIn` and `registeredTools(template)` by `!set.hide.has(name)`, then append `set.add` as raw extras before the cap. `hide` always includes every name in `add`.
- Export `listedToolNames(agentId, template): string[]`.

`services/bridge/src/agents/access.ts`:
- Add `setAccessExtras(fn: ((agentId: string) => {tools: {name; summary; gated}[]; hide: string[]}) | null)`.
- `agentTools(rosterId, template, agentId?)` removes `hide` and appends the extras when `agentId` is given. `accessSummary` uses their summaries and gated flags.
- `services/bridge/src/agents/host.ts`: `tools: agentTools(row.roster_id, row.template, dev.agent.id)`. This is the one shared line.

Connector modules:
- `connectors/kinds.ts`: `KINDS: Record<ConnectorKind, KindModule>`, importing jira, confluence, gitlab, github, caldav, google-calendar, msgraph-calendar and hubspot.
- `connectors/store.ts`: `ConnectorStore`.
  - `load(db)` reads every row with `updated_by`, `updated_at` and the user's `display_name`.
  - `selection(agentId, template, id)` = the row ∩ eligible, else the template default.
  - `eligible(template, id)` = (default ∪ allow) ∩ the connector's `tools`, and empty unless the status is `ok`.
  - `changedBy(agentId, id)` → `{user_id, name, at} | null`.
  - `set(db, agentId, id, tools, userId)` upserts and refreshes the cache.
- `connectors/tools.ts`: `buildAgentToolSet(runtimes, store, agentId, template)`.
  - For each connector in `templates[template]` with status `ok`: add its `supersedes` to `hide`, and add one tool per selected suffix, named `connectorToolName`.
  - Read tools: `JSON.stringify(result).slice(0, 6000)`. A `ConnectorError` → `{error: code, message}`.
  - Write tools: the description ends with ` Needs approval: the person asking (or my owner) must approve before it happens.`, and they call `requestApproval` → `gateReply` (import it from `approvals/tools.ts`, unedited).
  - Write executors first check `rt.allowed(agentId, tool)`, else throw `ArgsError("<Label> <tool> is turned off for this agent.")`.
  - The per-agent set is cached and invalidated on `store.set`.

`services/bridge/src/plugins/connectors.ts` (`name: "connectors"`):
- `init`:
  1. Load the config and run the host check on self-hosted and mock connectors.
  2. Build the runtimes. Cloud kinds get `makeHttp(cfg, env, fetch, auth)`, where `auth` comes from `oauth.ts`.
  3. `store.load`.
  4. Call `registerGatedTool(connectorToolName(id, w.tool), {executor: wrapped})` for every write of every `ok` connector.
  5. Call `setAgentToolProvider` and `setAccessExtras`.
  6. Log `connectors ready {ok, not_ok, cloud}` (ids only), and log one `warn` line per enabled cloud connector naming its D-15/D-16 hosts.
- `routes` → `registerConnectorRoutes`; `stop` clears the providers.

`services/bridge/src/connectors/routes.ts`:
- **`GET /api/connectors/cloud`** (no auth, like `/api/auth/providers`) → `CloudConnectors`: the `ok` cloud connectors with vendor, service, decision and `CLOUD_HOSTS`.
- **`GET /api/connectors`** (signed in) → `ConnectorInfo[]` with `tools: []` and `changed_by: null`.
- **`GET /api/agents/:id/connectors`** (signed in; 404 for an unknown agent) → `AgentConnectors`:
  - eligible tools with their `enabled` and `default` flags;
  - `changed_by` from the store;
  - `can_edit` = the owner (personal agent) or any `kind='person'` (workspace agent);
  - `tool_count` = `listedToolNames(...).length`.
- **`PUT /api/agents/:id/connectors`** (`SetAgentConnectorsRequest`):
  - 404 unless `can_edit`.
  - 400 `unknown_connector` | `tool_not_allowed`.
  - 409 `connector_unavailable`.
  - 409 `too_many_tools {count, max}`, computed with the candidate selection before saving.
  - 200 → the new `AgentConnectors`, with `changed_by` = this user.
  - Logs `connector tools changed {agent, connector, user, count}`.

Test `services/bridge/test/connectors-proxy.test.ts`. Use pglite, in-process ops-sim, `SA_CONNECTORS_CONFIG` = a temp copy of the shipped config, plugins loaded as in `gated-tools.test.ts` (verify in task), and MCP clients as in `mcp.test.ts`.
1. Workspace Dev's `tools/list` = the 15 names in the table; `merge_requests`, `open_tickets` and `ticket_comment` are absent, and calling `merge_requests` → unknown tool.
2. `jira_search` is logged inside a turn and refused without one.
3. A PUT `gitlab: []` by vlad removes `gitlab_*`, `merge_requests` stays hidden, and `changed_by.name` = "Vlad".
4. Dev + `mr_comment` → 409 `too_many_tools`.
5. A tool outside allow → 400, and a personal agent edited by a non-owner → 404.
6. `gitlab_trigger_pipeline {pipeline:"nightly"}` → pending with approver = requester. Approve → a running pipeline in the mock and the stamp `… · gitlab_trigger_pipeline · started pipeline 9940`.
7. Approve after the tool was toggled off → failed, and the mock was not hit.
8. `/access` lists connector tools with "(needs approval)".
9. `GET /api/connectors/cloud` → `{cloud: []}` with the shipped config. With a temp config enabling HubSpot and `HUBSPOT_TOKEN` set → one entry with `hosts: ["api.hubapi.com"]` (the C15 list).
10. With the sentinel bearer, no ToolLog record, approval row, API response or log line contains the token.

### C9: Web "Connected tools" on the Agent page

- `apps/web/src/api.ts`: add `agentConnectors(agentId)` and `setAgentConnectors(agentId, req)`. Follow `approvalGrants()`/`setSharing()` (verify in task). Errors carry `code`.
- `apps/web/src/agents/ConnectedTools.tsx` (new), `<ConnectedTools agent onChange?>`:
  - **Card header** per connector: the label, the mode chip (`Mock · on this Mac`, `Self-hosted · <host>`, or `Cloud · <host>` in warn tone), the status, and the line `Changed by <name> · <d Mon, HH:mm>` or `Template default`.
  - **Non-`ok` status:** `status_text` in warn tone, with the toggles disabled.
  - **Tool rows:** a `Toggle` (ds) labelled with the mono tool name plus its summary; a warn `Chip` "needs approval" on writes; a muted "default" chip when `default`.
  - **Header:** `"<tool_count> of <max_tools> tools in use"`.
  - **Saving:** a toggle sends the full new list for that connector, optimistically, and reverts on error. A 409 `too_many_tools` shows `"This agent already has <max> tools. Turn one off first."`; anything else shows "Couldn't save." A successful save updates `changed_by`.
  - **`can_edit` false:** toggles disabled, with the hint "Only the agent's owner can change this."
  - **Footer:** "Agents use connected tools through this Mac's bridge. Tokens stay in the bridge; agents never see them."
- `apps/web/src/agents/AgentProfilePage.tsx`: render `<ConnectedTools>` under Tools, and filter `tiers` by `hidden_builtins` (`onChange` lifts the data).
- `apps/web/src/agents/toolTiers.ts`: `toolTiers(template, grants, hidden: string[] = [])`.
- Test `apps/web/test/connected-tools.test.tsx` (mock `api.ts` like the other web tests):
  1. The mode, needs-approval and default chips, the count and "Changed by Vlad" render.
  2. A toggle sends the full list and reverts on rejection.
  3. A 409 shows the max-tools text.
  4. `can_edit: false` disables the toggles.
  5. Hidden built-ins are not listed under Tools.

### C17: Web trust line and Presenter badges for D-15/D-16

- `apps/web/src/lib/cloudTrust.ts` (new):
  - `useCloudConnectors()` fetches `GET /api/connectors/cloud` once per page load. It follows the pattern of `useAuthProviders` in `apps/web/src/auth/oidc.ts`: any failure means `[]`.
  - `cloudTrustLine(googleSignIn: boolean, services: string[]): string | null`:
    - no services → `null`, so the caller keeps today's text: the D-14 `GOOGLE_TRUST_LINE` or the default strip;
    - otherwise `` `Uses ${[googleSignIn ? "Google sign-in" : null, ...services].filter(Boolean).join(", ")} · chats and AI stay on this Mac` ``.
- `apps/web/src/shell/TopBar.tsx`: the trust span shows `cloudTrustLine(google, services) ?? (google ? GOOGLE_TRUST_LINE : <default>)`.
- `apps/web/src/pages/PresenterPage.tsx`: next to the "Google sign-in on" chip, add one warn `Chip role="status"` per cloud service: text `<service> on`, title `"<service> is reached over the internet (<decision>); chats and AI stay on this Mac"`.
- Test `apps/web/test/cloud-trust.test.tsx`:
  1. With no cloud connectors, TopBar shows exactly today's strings (the D-14 tests in `shell.test.tsx` stay green).
  2. `[Google Calendar]` with Google sign-in shows "Uses Google sign-in, Google Calendar · chats and AI stay on this Mac".
  3. The Presenter shows "HubSpot on" when HubSpot is listed.
  4. A failed fetch shows nothing new.

### C10: Templates and the tool budget

- `infra/hermes/templates/dev.md`:
  - Line 2: "Use the GitLab tools (`gitlab_merge_requests`, `gitlab_pipelines`, `gitlab_job_log`) for code, builds and failures, and the Jira tools (`jira_search`, `jira_issue`) for scope; when they are not available use `merge_requests`, `pipeline_status`, `build_log` and `open_tickets`. `release_status` gives release readiness."
  - Line 4: "You suggest changes; you never push or merge."
  - Line 5: "To comment on an issue call `jira_comment`, to file one `jira_create_issue`, to rerun a pipeline `gitlab_trigger_pipeline`; each happens only after approval."
- `qa.md`: "Use `release_status`, `test_runs`, `flaky_tests`, and `jira_search` (or `open_tickets`) before answering. For new tickets in a release call `jira_search` with `fix_version` and `created_within_days`. `jira_create_issue`, `jira_transition` and `gitlab_trigger_pipeline` happen only after approval."
- `tech.md`: "`confluence_search` and `confluence_page` (or `docs_search`/`doc_read`)", plus "To update a runbook call `confluence_edit_page`; it changes the page only after approval."
- `ops.md`: append "For CI state use `gitlab_pipelines`; for procedures search the runbooks with `confluence_search` and read them with `confluence_page`."
- `sales.md`: replace the `crm_*` line with "Use `crm_accounts`, `crm_deal` and `crm_activities` before answering about a customer. `crm_create_note`, `crm_create_task`, `crm_update_deal_stage` and `crm_log_activity` change the CRM only after approval. For meetings use `calendar_free_busy`; your own events (`calendar_events`) only in a direct message; `calendar_create_event` invites people after approval."
- `scribe.md` is **not edited** (voice owns it). The calendar guidance lives in the tool descriptions (C8).
- Test `services/bridge/test/connectors-budget.test.ts`:
  1. With all plugins and the shipped config, each roster workspace agent has ≤ 15 tools (Dev, QA and Ops exactly 15; Sales 14).
  2. Every backticked tool name in `infra/hermes/templates/*.md` exists among the catalog names, the built-ins or the registry.

### C11: Egress allowlist (self-hosted + D-15/D-16), docs

- `infra/py/src/sa_infra/egress.py`: add `connector_hosts(config_path, env) -> set[str]` (PyYAML). It returns:
  - the hostnames of enabled, non-mock, non-loopback self-hosted connectors;
  - the fixed hosts of enabled cloud connectors whose credential env is set: `www.googleapis.com` and `oauth2.googleapis.com`; `graph.microsoft.com` and `login.microsoftonline.com`; and the C15-verified HubSpot host list.

  Keep `CLOUD_HOSTS` here identical to `services/bridge/src/connectors/egress.ts`.
- `infra/py/tests/live/test_90_guards.py`: `allow |= egress.resolve_ips(egress.connector_hosts(...))`, and print `egress allowlist: N connector IPs`.
- Test `infra/py/tests/test_egress_connectors.py`:
  1. The shipped config → empty.
  2. A temp config with one enabled self-hosted connector and one disabled → only the first host.
  3. HubSpot enabled with `HUBSPOT_TOKEN` in env → exactly the HubSpot hosts; without the token → empty.
  4. The Python `CLOUD_HOSTS` equals the host strings regex-extracted from `services/bridge/src/connectors/egress.ts`.
- `docs/connectors.md` (new), with these sections:
  - What connects to what
  - Defaults per agent (the table)
  - Jira/Confluence Data Center (PAT, permissions)
  - GitLab self-managed (project access token `api`, triggers)
  - GitHub Enterprise Server
  - CalDAV (service account, `calendar_path`, implicit scheduling)
  - Calendar privacy (free/busy only for others; own events only in DM)
  - D-15 Google/Microsoft (service account with domain-wide delegation scope `https://www.googleapis.com/auth/calendar`; app registration with `Calendars.ReadWrite`; exact hosts; trust line; badge; smoke allowlist)
  - D-16 HubSpot (private app scopes `crm.objects.companies.read`, `crm.objects.deals.read`, `crm.objects.deals.write`, `crm.objects.contacts.read`, plus the notes/tasks scopes the C15 task verifies; host)
  - Network guard
  - Secrets
  - Version targets (from Decisions)

  Hosts in examples are `*.example.internal`.
- `docs/superpowers/specs/decisions.md`: append rows **D-15** and **D-16** to the table, in the file's language (Romanian), stating the decision as in this plan's Decisions section, with the date 2026-10-25 and "confirmat de utilizator".

### C12: E2E with the mocks (echo runtime)

`e2e/tests/connectors.spec.ts` uses the existing webServers. The bridge reads the shipped config, and `${OPS_SIM_URL}` = 8659 from `start-bridge.sh`. Reuse the helper style of `memory-approvals.spec.ts`.
1. Ana in `#release-7.4`: `@QA !tool jira_search {"fix_version":"7.4","created_within_days":2}`. The thread reply contains OPS-1430 and OPS-1427, and the receipts name `jira_search`.
2. `@Dev !tool gitlab_trigger_pipeline {"pipeline":"nightly"}` shows the approval card to Ana only (Vlad sees none). Approve → the stamp `… gitlab_trigger_pipeline · started pipeline 9940`, and the mock lists a running nightly pipeline.
3. `@Sales !tool crm_create_note {"account_id":"5001","body":"Asked for the 7.4 date again"}` in `#sales`. Approve → `GET /mock/hubspot/crm/v3/objects/companies/5001?associations=notes` lists a new note.
4. Dev's Agent page shows "Mock · on this Mac" and the needs-approval chip. Ana turns `trigger_pipeline` off → the card says "Changed by Ana", and `@Dev !tool gitlab_trigger_pipeline …` → `unknown tool`. Turn it back on.
5. `@Scribe !tool calendar_free_busy {}` in `#general` → `free_slots` and no seeded titles. `@Scribe !tool calendar_events {}` in `#general` → `events_only_in_dm`.
6. The Presenter page has no cloud badge, and the TopBar has today's trust strip.

First run `grep -rn "ticket_comment\|open_tickets\|merge_requests\|docs_search\|doc_read\|crm_accounts\|crm_deal\|crm_activities" e2e/tests`. Where an existing spec calls a hidden tool through `!tool` with ids that changed, update only that call and record it in the ledger.

### C13: Live smoke on the local 4-bit model

`e2e/live/connectors-smoke.ts` runs against `make up` + `make dev` with the shipped config. Copy the helpers from `e2e/live/roster-smoke.ts`, and take the approval decide route from `services/bridge/src/approvals/routes.ts` (verify).
1. "@QA summarize the new tickets for 7.4" → ≥ 2 of OPS-1427/1428/1430, with `jira_search` in the trace.
2. "@Dev trigger the nightly pipeline" → a pending `gitlab_trigger_pipeline` approval with `pipeline: nightly`. Approve → the stamp says `started pipeline`, and the mock shows it.
3. "@Scribe when are Ana and Vlad both free tomorrow for 30 minutes?" → `calendar_free_busy` in the trace, and a time between 09:00 and 17:00.
4. "@Sales brief me on Northwind" → `crm_accounts` or `crm_activities`, with OPS-1412 or 15 Nov mentioned.
5. "@Tech how do we fail over node-1?" → `confluence_search` or `confluence_page`.

The smoke prints one line per check with seconds and tool calls, and exits 1 on any failure. It runs on `fast` (Qwen3.5 9B 4-bit, D-1) and reports misses honestly. Run it with `pnpm --filter @sa/e2e exec tsx live/connectors-smoke.ts`, then `make smoke` (shipped config → empty connector allowlist).

```relay-plan
{
  "slug": "sa-connectors",
  "suite": "make check",
  "setup": "pnpm install --frozen-lockfile && uv sync",
  "tasks": [
    {
      "id": "C1",
      "title": "Protocol types, catalog, migration",
      "tier": "cheap",
      "code": "complete",
      "risk": "low",
      "files": [
        "packages/protocol/src/connectors.ts",
        "packages/protocol/package.json",
        "services/bridge/src/migrations/007_connectors.sql",
        "services/bridge/test/migration-007.test.ts"
      ],
      "deps": [],
      "behaviors": [
        "sa.agent_connectors rejects bad ids and non-array tools, cascades on agent delete"
      ],
      "tests": 1,
      "done": "pnpm --filter @sa/protocol typecheck && pnpm --filter @sa/bridge exec vitest run test/migration-007.test.ts"
    },
    {
      "id": "C2",
      "title": "ops-sim store + Jira and Confluence mocks",
      "tier": "mid",
      "code": "prose",
      "risk": "medium",
      "files": [
        "services/ops-sim/src/store.ts",
        "services/ops-sim/src/data.ts",
        "services/ops-sim/src/mock.ts",
        "services/ops-sim/src/server.ts",
        "services/ops-sim/src/mock-routes.ts",
        "services/ops-sim/src/mock-jira.ts",
        "services/ops-sim/src/mock-confluence.ts",
        "services/ops-sim/test/mock-atlassian.test.ts"
      ],
      "deps": [],
      "behaviors": [
        "JQL subset search returns the 7.4 story issues newest first",
        "created Jira issues appear in /sim/tickets",
        "Jira comments appear on /sim/tickets/:id",
        "transition to Done closes the sim ticket; unoffered transition is 400",
        "unsupported JQL is 400",
        "CQL search ranks the failover runbook first",
        "versioned page edits; stale version is 409"
      ],
      "tests": 7,
      "done": "pnpm --filter @sa/ops-sim typecheck && pnpm --filter @sa/ops-sim exec vitest run test/mock-atlassian.test.ts"
    },
    {
      "id": "C3",
      "title": "GitLab and CalDAV mocks",
      "tier": "mid",
      "code": "prose",
      "risk": "medium",
      "files": [
        "services/ops-sim/src/mock-routes.ts",
        "services/ops-sim/src/store.ts",
        "services/ops-sim/src/mock-gitlab.ts",
        "services/ops-sim/src/mock-caldav.ts",
        "services/ops-sim/test/mock-gitlab.test.ts",
        "services/ops-sim/test/mock-caldav.test.ts"
      ],
      "deps": [
        "C2"
      ],
      "behaviors": [
        "failed pipelines list failed job ids and traces",
        "triggered pipeline runs and shows in /sim/dev/pipelines",
        "unknown ref is 400",
        "MR notes are stored",
        "REPORT time-range returns seeded events with ETags",
        "organizer PUT invites attendees as NEEDS-ACTION",
        "stale If-Match is 412",
        "attendee PARTSTAT syncs to the organizer"
      ],
      "tests": 8,
      "done": "pnpm --filter @sa/ops-sim typecheck && pnpm --filter @sa/ops-sim exec vitest run test/mock-gitlab.test.ts test/mock-caldav.test.ts"
    },
    {
      "id": "C14",
      "title": "HubSpot CRM v3 mock",
      "tier": "mid",
      "code": "prose",
      "risk": "medium",
      "files": [
        "services/ops-sim/src/mock-routes.ts",
        "services/ops-sim/src/store.ts",
        "services/ops-sim/src/mock-hubspot.ts",
        "services/ops-sim/test/mock-hubspot.test.ts"
      ],
      "deps": [
        "C3"
      ],
      "behaviors": [
        "company search by name token",
        "company associations list deals and activities",
        "created notes show in /sim/crm activities",
        "deal stage PATCH; unknown stage is 400",
        "wrong association type id is 400"
      ],
      "tests": 5,
      "done": "pnpm --filter @sa/ops-sim typecheck && pnpm --filter @sa/ops-sim exec vitest run test/mock-hubspot.test.ts"
    },
    {
      "id": "C4",
      "title": "Bridge connector core: config, network and egress guard, HTTP",
      "tier": "mid",
      "code": "prose",
      "risk": "high",
      "files": [
        "services/bridge/src/connectors/types.ts",
        "services/bridge/src/connectors/egress.ts",
        "services/bridge/src/connectors/config.ts",
        "services/bridge/src/connectors/netguard.ts",
        "services/bridge/src/connectors/http.ts",
        "config/connectors.yaml",
        "services/bridge/test/connectors-config.test.ts",
        "services/bridge/test/connectors-net.test.ts"
      ],
      "deps": [
        "C1"
      ],
      "behaviors": [
        "shipped config loads five ok mock connectors and no cloud",
        "missing token env gives not_configured naming the variable",
        "invalid kinds are isolated as invalid_config",
        "cloud kinds are off unless enabled with credentials; base_url forbidden",
        "template tools outside the catalog are dropped",
        "no config under vitest unless SA_CONNECTORS_CONFIG",
        "private/public address table is exact",
        "public addresses refused unless allow_public_address",
        "token only in the outgoing header, never in errors or logs",
        "redirects refused",
        "path traversal refused",
        "oversize bodies refused",
        "cloud connectors cannot reach hosts outside CLOUD_HOSTS"
      ],
      "tests": 13,
      "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/connectors-config.test.ts test/connectors-net.test.ts"
    },
    {
      "id": "C5",
      "title": "Jira and Confluence adapters",
      "tier": "mid",
      "code": "prose",
      "risk": "high",
      "files": [
        "services/bridge/src/connectors/jira.ts",
        "services/bridge/src/connectors/confluence.ts",
        "services/bridge/src/connectors/storage.ts",
        "services/bridge/test/connectors-atlassian.test.ts"
      ],
      "deps": [
        "C4",
        "C2"
      ],
      "behaviors": [
        "jira_search builds JQL from structured args",
        "JQL values are escaped",
        "create_issue executes with the audit line; unknown fix version refused",
        "transition resolves by name or lists options",
        "edit_page refuses when the page changed",
        "storage conversion escapes model text",
        "pages outside configured spaces refused"
      ],
      "tests": 7,
      "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/connectors-atlassian.test.ts"
    },
    {
      "id": "C15",
      "title": "HubSpot adapter (D-16)",
      "tier": "mid",
      "code": "prose",
      "risk": "high",
      "files": [
        "services/bridge/src/connectors/hubspot.ts",
        "services/bridge/src/connectors/egress.ts",
        "services/bridge/test/connectors-hubspot.test.ts"
      ],
      "deps": [
        "C4",
        "C14"
      ],
      "behaviors": [
        "accounts include deal ids and owner names",
        "deal shows stage label and description",
        "create_note lands on the company",
        "update_deal_stage refuses a deal that moved",
        "unknown targets refused before approval",
        "cloud mode calls only api.hubapi.com with Bearer",
        "401 hides the token"
      ],
      "tests": 7,
      "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/connectors-hubspot.test.ts"
    },
    {
      "id": "C7",
      "title": "GitLab and GitHub adapters",
      "tier": "mid",
      "code": "prose",
      "risk": "high",
      "files": [
        "services/bridge/src/connectors/gitlab.ts",
        "services/bridge/src/connectors/github.ts",
        "services/bridge/test/connectors-gitlab.test.ts",
        "services/bridge/test/connectors-github.test.ts"
      ],
      "deps": [
        "C4",
        "C3"
      ],
      "behaviors": [
        "pipelines list failed jobs",
        "job_log strips ANSI and section markers",
        "trigger only configured names; unknown name makes no request",
        "trigger removed before execute fails without a POST",
        "GitHub lists map fields",
        "GitHub dispatch uses configured file and ref",
        "GitHub 401 hides the token"
      ],
      "tests": 7,
      "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/connectors-gitlab.test.ts test/connectors-github.test.ts"
    },
    {
      "id": "C8",
      "title": "Calendar tools + CalDAV backend",
      "tier": "strong",
      "code": "prose",
      "risk": "high",
      "files": [
        "services/bridge/src/connectors/calendar-tools.ts",
        "services/bridge/src/connectors/ics.ts",
        "services/bridge/src/connectors/caldav.ts",
        "services/bridge/test/connectors-ics.test.ts",
        "services/bridge/test/connectors-caldav.test.ts"
      ],
      "deps": [
        "C4",
        "C3"
      ],
      "behaviors": [
        "ICS parse handles folding, TZID, all-day and DST",
        "buildEvent round-trips",
        "free slots skip weekends and busy time within working hours",
        "setPartstat touches only the matching attendee",
        "free_busy returns intervals only, no titles or attendees",
        "events only in the requester's DM, needs a person",
        "create_event invites attendees after approval; unknown attendee refused",
        "respond refuses a changed event",
        "start in the past refused"
      ],
      "tests": 9,
      "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/connectors-ics.test.ts test/connectors-caldav.test.ts"
    },
    {
      "id": "C16",
      "title": "Google Calendar and Microsoft Graph backends (D-15)",
      "tier": "strong",
      "code": "prose",
      "risk": "high",
      "files": [
        "services/bridge/src/connectors/oauth.ts",
        "services/bridge/src/connectors/google-calendar.ts",
        "services/bridge/src/connectors/msgraph-calendar.ts",
        "services/bridge/test/connectors-cloud-calendar.test.ts"
      ],
      "deps": [
        "C8"
      ],
      "behaviors": [
        "Google token JWT has fixed aud and requester sub; token_uri ignored",
        "Google free/busy exposes no summaries",
        "Google create is idempotent on the derived id",
        "Microsoft token from the tenant endpoint",
        "Microsoft getSchedule maps busy and drops free",
        "Microsoft respond refuses a changed changeKey",
        "no key, secret or access token in logs or errors"
      ],
      "tests": 7,
      "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/connectors-cloud-calendar.test.ts"
    },
    {
      "id": "C6",
      "title": "Bridge proxy: registry seam, MCP, store, routes, plugin, /access",
      "tier": "strong",
      "code": "prose",
      "risk": "high",
      "files": [
        "services/bridge/src/mcp/registry.ts",
        "services/bridge/src/mcp/server.ts",
        "services/bridge/src/agents/access.ts",
        "services/bridge/src/agents/host.ts",
        "services/bridge/src/connectors/kinds.ts",
        "services/bridge/src/connectors/store.ts",
        "services/bridge/src/connectors/tools.ts",
        "services/bridge/src/connectors/routes.ts",
        "services/bridge/src/plugins/connectors.ts",
        "services/bridge/test/connectors-proxy.test.ts"
      ],
      "deps": [
        "C1",
        "C4",
        "C5",
        "C7",
        "C8",
        "C15",
        "C16"
      ],
      "behaviors": [
        "per-agent tools/list adds selected connector tools and hides superseded built-ins",
        "ToolLog records connector calls only inside a turn",
        "toggle by a workspace member applies and records changed_by",
        "15-tool cap enforced on PUT",
        "allow ceiling and owner rule enforced",
        "writes create requester-only approvals and execute on the mock",
        "execute fails when the tool was toggled off",
        "/access lists connector tools with needs-approval",
        "/api/connectors/cloud lists only enabled cloud egresses",
        "no token in ToolLog, approvals, API or logs"
      ],
      "tests": 10,
      "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/connectors-proxy.test.ts test/mcp.test.ts test/gated-tools.test.ts"
    },
    {
      "id": "C9",
      "title": "Web Connected tools on the Agent page",
      "tier": "mid",
      "code": "prose",
      "risk": "medium",
      "files": [
        "apps/web/src/api.ts",
        "apps/web/src/agents/ConnectedTools.tsx",
        "apps/web/src/agents/AgentProfilePage.tsx",
        "apps/web/src/agents/toolTiers.ts",
        "apps/web/test/connected-tools.test.tsx"
      ],
      "deps": [
        "C1"
      ],
      "behaviors": [
        "cards show mode, needs-approval, default chips, count and changed-by",
        "toggle saves the full list and reverts on error",
        "409 shows the max-tools message",
        "non-editors see disabled toggles",
        "Overview hides superseded built-ins"
      ],
      "tests": 5,
      "done": "pnpm --filter @sa/web typecheck && pnpm --filter @sa/web exec vitest run test/connected-tools.test.tsx"
    },
    {
      "id": "C17",
      "title": "Web trust line and Presenter badges for D-15/D-16",
      "tier": "mid",
      "code": "prose",
      "risk": "medium",
      "files": [
        "apps/web/src/lib/cloudTrust.ts",
        "apps/web/src/shell/TopBar.tsx",
        "apps/web/src/pages/PresenterPage.tsx",
        "apps/web/test/cloud-trust.test.tsx"
      ],
      "deps": [
        "C1"
      ],
      "behaviors": [
        "no cloud connectors keeps today's trust strings",
        "cloud services extend the trust line",
        "Presenter shows one badge per cloud service",
        "fetch failure shows nothing new"
      ],
      "tests": 4,
      "done": "pnpm --filter @sa/web typecheck && pnpm --filter @sa/web exec vitest run test/cloud-trust.test.tsx test/shell.test.tsx"
    },
    {
      "id": "C10",
      "title": "Templates and the tool budget",
      "tier": "mid",
      "code": "prose",
      "risk": "medium",
      "files": [
        "infra/hermes/templates/dev.md",
        "infra/hermes/templates/qa.md",
        "infra/hermes/templates/tech.md",
        "infra/hermes/templates/ops.md",
        "infra/hermes/templates/sales.md",
        "services/bridge/test/connectors-budget.test.ts"
      ],
      "deps": [
        "C6"
      ],
      "behaviors": [
        "roster agents stay within 15 tools",
        "templates name only tools that exist"
      ],
      "tests": 2,
      "done": "pnpm --filter @sa/bridge typecheck && pnpm --filter @sa/bridge exec vitest run test/connectors-budget.test.ts test/templates.test.ts"
    },
    {
      "id": "C11",
      "title": "Egress allowlist (self-hosted + D-15/D-16), docs, decisions",
      "tier": "mid",
      "code": "prose",
      "risk": "medium",
      "files": [
        "infra/py/src/sa_infra/egress.py",
        "infra/py/tests/live/test_90_guards.py",
        "infra/py/tests/test_egress_connectors.py",
        "docs/connectors.md",
        "docs/superpowers/specs/decisions.md"
      ],
      "deps": [
        "C4",
        "C15"
      ],
      "behaviors": [
        "shipped mock config adds no egress allowance",
        "enabled self-hosted hosts allowlisted, disabled ones not",
        "cloud hosts allowlisted only when enabled with credentials",
        "Python and TS cloud host lists stay identical"
      ],
      "tests": 4,
      "done": "uv run ruff check infra/py && uv run pytest infra/py/tests/test_egress_connectors.py"
    },
    {
      "id": "C12",
      "title": "E2E with the mocks",
      "tier": "mid",
      "code": "prose",
      "risk": "medium",
      "files": [
        "e2e/tests/connectors.spec.ts"
      ],
      "deps": [
        "C6",
        "C9",
        "C10",
        "C17"
      ],
      "behaviors": [
        "QA reads new 7.4 tickets via jira_search",
        "trigger pipeline shows a requester-only card and executes on the mock",
        "CRM note approval lands in the HubSpot mock",
        "toggle off shows changed-by and removes the tool",
        "free/busy has no titles; events refused outside DM",
        "no cloud badge or line by default"
      ],
      "tests": 6,
      "done": "pnpm --filter @sa/e2e exec playwright test tests/connectors.spec.ts"
    },
    {
      "id": "C13",
      "title": "Live smoke on the local 4-bit model",
      "tier": "mid",
      "code": "prose",
      "risk": "medium",
      "files": [
        "e2e/live/connectors-smoke.ts"
      ],
      "deps": [
        "C12",
        "C11"
      ],
      "behaviors": [],
      "tests": 0,
      "done": "pnpm --filter @sa/e2e exec tsx live/connectors-smoke.ts && make smoke"
    }
  ]
}
```
