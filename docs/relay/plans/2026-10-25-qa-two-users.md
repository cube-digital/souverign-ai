# QA Campaign: Two Users, Every Feature Plan

**Goal:** QA agents simulate two people (Ana and Ben) and a late joiner, and test every feature of the app end to end on the live local stack. That covers every roster agent in every invocation mode, the proactive posts, the seeded workspace, memory and documents, the D-9 ACL cases, approvals, voice, meetings with the notetaker and the summaries people receive, Google sign-in (fake provider), and the privacy guarantees. Each check is recorded with its result, timings and screenshots, and every failure ends up in an issue list with repro steps plus a follow-up fix plan.
**Spec:** owner request of 2026-10-25 (this plan's Decisions are the spec). Behaviour under test is defined by the Decisions and "For later plans" sections of `docs/relay/plans/2026-10-24-agent-teammates.md` (T1), `2026-10-25-memory-approvals.md`, `2026-10-25-google-login.md` and `2026-10-25-voice-meetings.md`. This run starts from main after all four are merged.
**Architecture:** a Playwright harness in `e2e/qa/` (its own config, no webServer) drives the live stack: `make up` + `make dev`, started from the main checkout by `e2e/qa/stack.sh`, with the real local LLM and the prefix cache off. Each persona has three handles: a browser context (the UI), an `Api` session (REST + the `/api/events` SSE stream) and a Node `ChatEngine` device (it decrypts messages so checks can assert on `meta`: receipts, citations, `reply_to`, approvals). `check()` wraps every Playwright test. It retries an LLM check once, writes `<main checkout>/.handoff/qa/results/<ID>.json` plus screenshots, and the global teardown renders `.handoff/qa/report.md`. A Python sampler records every non-loopback connection of the stack's processes during the run.

## Decisions

- **Personas.** The demo seed has exactly `ana`, `vlad`, `rares` and `janosch` (`services/bridge/src/seed.ts`), and this plan adds no accounts. So the persona map is fixed in `e2e/qa/lib/env.ts`:
  - `ana` → account `ana` (label "Ana"): the main user, owner of most QA chats.
  - `ben` → account `vlad` (label "Ben"): the second user. The UI and stamps show the account's display name ("Vlad"), so assertions use `persona.displayName`, never the label.
  - `rares` → account `rares`: the third call participant (the decliner) and a non-member for visibility checks.
  - `late` → account `janosch`: the D-12 late joiner. Only the workspace suite uses him, and always in a **fresh** browser context, which means a new device.
- **Where things run.** The stack always runs from the **main checkout** (`QA_ROOT` = the parent of `git rev-parse --git-common-dir`). The reason: `.run/` holds the bridge master key, tokens and PINs, and a worktree would generate new ones that cannot decrypt the dev database. The harness code runs from wherever the task's worktree is, but it reads PINs from `$QA_ROOT/.run/demo-pins.txt` and writes results only to `$QA_ROOT/.handoff/qa/` (git-excluded). The live smokes from the earlier plans (`e2e/live/voice-smoke.ts`) are executed with `pnpm --dir "$QA_ROOT"`, so they find the main checkout's `.run/`.
- **Stack env.** `e2e/qa/stack.sh up` frees only the ports T1-plan T21 allows (`pkill -f "hermes -p sa_agent_"`, listeners on 5173/8647/8648/8649). It then runs `make up`, and runs `make dev` in the background with:
  - `SA_APPROVAL_TTL_MS=600000`;
  - `SA_NOTES_INTERVAL_MS=3600000` (no interim summaries compete for the LLM);
  - `SA_NOTETAKER=worker` when `livekit-server` is on PATH (then also `bash infra/scripts/livekit.sh start`), else `SA_NOTETAKER=fake`.

  In fake mode the harness posts the call segments itself through `/internal/calls/notetakers/:id/segments` with `X-Internal-Token` from `$QA_ROOT/.run/meeting.token`, exactly as `e2e/tests/call.spec.ts` does. Consent, the real-LLM summary, approval, notification, reminder and re-publish then all run live, and only the checks that need real call audio are `SKIPPED: livekit-server is not installed (human step: brew install livekit)`. The mode is written to `.handoff/qa/notetaker-mode` and `run.json`.
- **One live suite at a time.** The config uses `workers: 1` and `fullyParallel: false`, and suite files run in file-name order (`00-` … `90-`). The suite tasks run in parallel lanes, but they only write code and validate offline (typecheck + `--list`). Three chained live tasks (Q15 → Q16 → Q17) then run all suites against one stack that stays up between them. Q15 starts it and Q17 stops it, and Q16/Q17 set `QA_RESUME=1` so all three share one run id and one results folder.
- **Assertions are structural.** Checks assert on thread placement (`reply_to`), reactions (👀 → exactly one of ✅/⏹️/⚠️), receipts (`meta.local`, `meta.tools` ⊆ the agent's allowlist, `meta.model`), citations present with the right `source_type`/title prefix, approvals created for the right person, events received by the right people, files written or not, and ids and timings. Text is matched only against **facts the QA fixtures planted** (a number, a codename), with case-insensitive regexes. Model prose is never compared.
- **Retries.** `check(…, { llm: true })` runs the body at most twice, and a pass on the second attempt is recorded as `flaky`. A check that proves something is **not** revealed (ACL, D-3, privacy, requester-only) throws `LeakError` on the leak, and `check()` never retries a `LeakError`, because one leak is a failure. Non-LLM checks never retry.
- **Every check runs alone.** `--grep <ID>` must work, because `qa:failed` reruns only the failed checks. Shared setup goes through `once()` memoized helpers inside the suite file (create the chat, teach the document, …), never through side effects of an earlier check. When a setup fails, dependents `ctx.skip("blocked: <reason>")`.
- **Unique names per run.** QA chats are titled `qa <shortRun> <purpose>` (`shortRun()` = last 6 alphanumerics of the run id). Every planted string that must never reach the relay or logs is made by `marker(label)`, which appends it to `.handoff/qa/markers.txt` so the privacy suite can scan for it.
- **Shared state is restored.** A check that pauses the alert watch, changes `share_private_in_chats`, sets `pause_all`, creates a grant or adds a lesson undoes it in `finally`.
- **Database access (QA only).** `e2e/qa/lib/db.ts` runs `psql` inside the compose `postgres` container (`docker compose -f $QA_ROOT/infra/docker-compose.yaml exec -T postgres psql -U sa -d sa`). It is used only to rewind the clock: reset `sa.user_prefs.last_hello_day`, move `expires_at` of one pending approval into the past, and back-date the notes-approval request time for the reminder. It is also used to read `sa.turn_metrics`. Values go through `lit()` (allowlist `[A-Za-z0-9_.:-]`). Column names come from the migrations (`003`, `004`, `006`), read by the suite author and never guessed. If a needed column does not exist, the check is skipped with `no <column> column` and triage files it.
- **Personal agents** (the ACL suite) are reused across runs under fixed names `NoraQa`, `IrisQa` (Ana) and `MaxQa` (Ben), created only if they are missing. This keeps the personal-gateway ports within the three that T1 leaves free (8707–8709), even after repeated runs. Before teaching, the suite deletes the agent's existing knowledge items.
- **Google sign-in** is tested in two ways:
  - **Off.** On the live stack (no Google env): providers `{pin:true, oidc:[]}`, `/api/auth/oidc/google/start` → 404, no button, no badge.
  - **On, with a fake provider, on a side stack.** `e2e/qa/oidc/side-stack.sh` runs relay :8668, ops-sim :8669, a bridge :8667 (pglite, echo runtime, Google env set) and the web :5193. The bridge starts with `NODE_OPTIONS=--import=<abs>/e2e/qa/oidc/fetch-shim.mjs`. The shim replaces `globalThis.fetch` before any module loads, so the bridge's Google discovery, JWKS and token calls are answered in process with an RS256 key. In the browser, Playwright routes `https://accounts.google.com/**` to a stateless fake consent step, and all other Google hosts are aborted. No packet leaves the Mac, and the egress sampler covers the side bridge too. `createOidcPlugin` uses `opts.fetch ?? fetch`, which is why the global shim reaches it without product changes.
- **Egress.** `e2e/qa/egress_sampler.py` (sa_infra `egress.scan`) samples every 5 s, from global setup to teardown. It covers the pids in `$QA_ROOT/.run/*.pid` plus the listeners on 5173, 5193, 7880, 8000, 8081, 8645–8649, 8667–8669 and 8700–8709, children included, and writes `.handoff/qa/egress.jsonl`. The privacy suite requires 0 offending connections and ≥ 1 sample per 10 minutes.
- **Results and report.** One JSON per check (`CheckResult`, below) plus PNGs named `<ID>-<persona>.png` (and `<ID>-attempt1-<persona>.png` for a failed first attempt) for every persona page open at the end. `.handoff/qa/report.md` has these sections: summary per suite, agent × mode matrix, failures with repro steps, skipped with reasons, flaky, timings p50/p95/max, egress, memory headroom, and all checks. Results of a previous run are moved to `.handoff/qa/previous/<run_id>/` at the start of a fresh run.
- **Issue list and fix loop.** Triage writes the tracked `docs/qa/2026-10-25-qa-issues.md` (no screenshots, no absolute paths, fictional data only). The fix-loop task turns it into `docs/relay/plans/2026-10-26-qa-fixes.md`: one task per blocker/major product issue with an offline regression test, one harness task, and a last live task that runs `qa:failed`.

## Global Constraints

- Conventions: TypeScript ESM with NodeNext `.js` import suffixes (as in `e2e/live/*.ts`), Biome (`pnpm exec biome check --write <files>` before commit; line width 100, double quotes), Python formatted with `uv run ruff format`. Commits are `test(qa): …`, one per task.
- **No product code changes.** Nothing under `apps/`, `services/`, `packages/` or `infra/` changes, except the single new test file `services/bridge/test/qa-fixtures.test.ts` (Q3). A product bug becomes a failing check, never a fix in this plan. Never add `data-testid`s to the web app. Selectors come from the merged specs (`e2e/tests/teammates.spec.ts`, `memory-approvals.spec.ts`, `voice.spec.ts`, `call.spec.ts`) and from roles, labels and the UI copy fixed in the four plans' Decisions.
- Only Q1 changes `e2e/package.json`, `e2e/tsconfig.json`, `Makefile` and `.gitignore`. **No new dependencies** (the lockfile stays unchanged): `@playwright/test`, `tsx`, `@sa/client`, `@sa/crypto` and `@sa/protocol` are already in `e2e`, and Python uses the `live` group (`psutil`, `sa_infra`).
- Suite tasks own only the files listed for them. A helper that a suite needs and `lib/` lacks goes inside that suite's spec file. `lib/` is frozen after Q2, and only the live tasks (Q15–Q17) may fix harness bugs anywhere in `e2e/qa/`.
- The repo is public: no client company or product names, and no absolute paths of this machine in any file or commit message. All paths are computed at runtime from `git` and `import.meta.dirname`. `git grep -inE "real[t]yme|gate[x]"` must print nothing before every commit. Fixture content is fictional (`example.com`/`example.org`, "Harbor Logistics", "Northwind").
- Never print or store PINs, session tokens, the meeting token or OIDC codes in results, notes, screenshots' file names or logs. Results may hold the QA prompts and planted facts, which are fictional.
- Waits: an LLM reply gets `LLM_WAIT_MS = 240_000`. A "nothing happens" window is `QUIET_MS = 60_000` (30 s where a check says so). 👀 must arrive within `EYES_MS = 1_500` of the send (the spec says 1 s, plus a 0.5 s measuring margin; the raw value is recorded).
- Only one LLM-heavy action is in flight at a time, except in ROS-31 (the queue check).
- `make check` must stay green without models. The only offline addition is Q3's vitest file. `QA_PREFLIGHT=0` makes global setup a no-op, so `--list` and the OIDC side run work without the live stack.

## Review Focus

- Results land in the **main checkout's** `.handoff/qa/` even when the harness runs in a worktree, and nothing under `.handoff/` is committed.
- No retry can hide a leak: ACL, D-3, privacy and requester-only checks throw `LeakError`, which `check()` never retries.
- Ben's assertions use Ben's own `Api` and device, never Ana's token. A requester-only check really comes from the other user.
- Every skip carries a reason (`livekit-server`, `espeak-ng`/`ffmpeg`, `blocked: …`), and no missing prerequisite turns into a silent pass.
- Checks that change shared state (alert watch, sharing, `pause_all`, grants, lessons, Tech's knowledge) restore it in `finally`.
- The OIDC side stack never reaches Google (fetch shim + browser routes + sampler), and its `make seed` keeps the developer's `.run/demo-pins.txt` byte-identical (backup and restore, as `e2e/start-bridge.sh` does).
- `verify-run` counts every listed check, so a check whose result file is missing fails the live task.
- DB writes are limited to the three rewind statements, and all of them are scoped by id.
- Q16/Q17 run with `QA_RESUME=1`: a fresh global setup would archive Q15's results.

## Before the run (human)

- The main checkout is on `main` with the four plans merged, and its tree is clean. Docker is running. `make models` is done.
- `make seed` has been run once, so `.run/demo-pins.txt` lists `ana`, `vlad`, `rares` and `janosch`. Playwright Chromium is installed: `pnpm --filter @sa/e2e exec playwright install chromium`.
- Optional: `brew install livekit` (real call audio; otherwise those checks are SKIPPED) and `brew install espeak-ng ffmpeg` (voice fixtures; otherwise the voice suite is SKIPPED).
- Leave Google env out of `.env`. If it is set, OID-01 records "Google enabled in .env" and checks the D-14 copy instead.
- The campaign adds QA chats, the personal agents `NoraQa`/`IrisQa`/`MaxQa`, knowledge, approvals, notes and `.run/outbox/*.eml` to the dev database. Stop any manual `make dev`; Q15 frees its ports anyway.
- Persona note: "Ben" is played by the demo account `vlad`. Adding a real `ben` account would be a product change to the seed, which is out of scope.

## Tasks

Notes on the relay fields:
- A suite task's `tests` is the number of QA checks it writes. Those checks are the deliverable, so the lanes warnings "N tests for M behaviors" and "low risk with N new tests" are expected and stand. All suite tasks are `risk: low`, because they add test code only and no product behaviour. A test-author lane would write tests for tests. The DB rewinds they perform are reviewed under Review Focus instead.
- The live tasks Q15–Q17 own the tracked run log `docs/qa/2026-10-25-qa-run-log.md`. Each appends one section with the commands run, start and end times, stack mode (worker/fake), the `qa:verify` counts and every harness fix (file + one line why). They may also fix any file in `e2e/qa/**` without listing it: they run strictly after every suite task, one at a time, so no parallel lane can conflict. The log holds no absolute paths and no client names.

### Q1: Harness core — config, scripts, env, types, report, verify, rerun

**`e2e/package.json`**: add these scripts, keeping the existing ones:

```json
"qa": "playwright test -c qa/playwright.qa.config.ts",
"qa:report": "tsx qa/lib/report.ts",
"qa:verify": "tsx qa/lib/verify-run.ts",
"qa:failed": "tsx qa/lib/rerun-failed.ts",
"qa:selftest": "tsx qa/lib/report.selftest.ts"
```

**`e2e/tsconfig.json`**: add `"qa"` to `include`.

**`Makefile`**: add the target after `agents-smoke`, and add `qa` to `.PHONY`:

```make
qa: ## live QA campaign: two simulated users on the running stack (bash e2e/qa/stack.sh up first)
	pnpm --filter @sa/e2e run qa
```

**`.gitignore`**: append `.handoff/`.

**`e2e/qa/playwright.qa.config.ts`**:

```ts
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// QA campaign against the live stack (no webServer). See docs/relay/plans/2026-10-25-qa-two-users.md.
export default defineConfig({
  testDir: join(import.meta.dirname, "suites"),
  outputDir: join(import.meta.dirname, "..", "..", ".run", "qa-pw"),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 900_000,
  reporter: [["list"]],
  globalSetup: join(import.meta.dirname, "lib", "global-setup.ts"),
  globalTeardown: join(import.meta.dirname, "lib", "global-teardown.ts"),
  use: {
    baseURL: "http://127.0.0.1:5173",
    actionTimeout: 15_000,
    trace: "off",
    screenshot: "off",
    launchOptions: {
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
```

**`e2e/qa/lib/types.ts`**:

```ts
export type Status = "pass" | "fail" | "skip";

export type CheckResult = {
  run_id: string;
  id: string;
  suite: string;
  title: string;
  status: Status;
  /** passed only on the second attempt */
  flaky: boolean;
  attempts: number;
  started_at: string;
  ms: number;
  timings: Record<string, number>;
  notes: string[];
  repro: string[];
  /** paths relative to .handoff/qa/ */
  screenshots: string[];
  error?: string;
  skip_reason?: string;
  matrix?: { agent: string; mode: string };
};

export type RunInfo = {
  run_id: string;
  started_at: string;
  commit: string;
  model: string;
  prefix_cache_off: boolean;
  livekit: boolean;
  notetaker_mode: string;
  personas: Record<string, string>;
};

export type EgressSample = {
  ts: number;
  pids: number;
  offending: {
    pid: number;
    status: string;
    remote_ip: string | null;
    remote_port: number | null;
  }[];
  error: string | null;
};

export type MemSample = {
  ts: number;
  gateways_rss_kb: number;
  swap_used_mb: number;
  compressor_pages: number;
};
```

**`e2e/qa/lib/env.ts`**:

```ts
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The checkout that holds this harness (a relay worktree or the main checkout). */
export const HARNESS_ROOT = join(import.meta.dirname, "..", "..", "..");

function mainCheckout(): string {
  if (process.env.QA_ROOT) return process.env.QA_ROOT;
  const common = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: HARNESS_ROOT, encoding: "utf8" },
  ).trim();
  return dirname(common);
}

/** The main checkout: the live stack runs here; PINs and results live here. */
export const QA_ROOT = mainCheckout();
export const OUT = join(QA_ROOT, ".handoff", "qa");
export const RESULTS = join(OUT, "results");

export const URLS = {
  web: "http://127.0.0.1:5173",
  bridge: "http://127.0.0.1:8647",
  relay: "http://127.0.0.1:8648",
  relayWs: "ws://127.0.0.1:8648",
  opsSim: "http://127.0.0.1:8649",
  memory: "http://127.0.0.1:8646",
  audio: "http://127.0.0.1:8645",
  llm: "http://127.0.0.1:8000",
  livekit: "http://127.0.0.1:7880",
} as const;

export const PERSONAS = {
  ana: { account: "ana", label: "Ana" },
  ben: { account: "vlad", label: "Ben" },
  rares: { account: "rares", label: "Rareș" },
  late: { account: "janosch", label: "Late joiner" },
} as const;
export type PersonaKey = keyof typeof PERSONAS;

export const LLM_WAIT_MS = 240_000;
export const QUIET_MS = 60_000;
export const EYES_MS = 1_500;

export function runId(): string {
  if (process.env.QA_RUN_ID) return process.env.QA_RUN_ID;
  const f = join(OUT, "run.json");
  if (existsSync(f)) return (JSON.parse(readFileSync(f, "utf8")) as { run_id: string }).run_id;
  return "qa-offline";
}

/** Short, title-safe suffix of the run id, for chat titles. */
export function shortRun(): string {
  return runId()
    .replace(/[^a-z0-9]/gi, "")
    .slice(-6)
    .toLowerCase();
}

export function pinOf(account: string): string {
  const file = join(QA_ROOT, ".run", "demo-pins.txt");
  if (!existsSync(file)) throw new Error("no .run/demo-pins.txt in the main checkout: run make seed");
  const line = readFileSync(file, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${account}:`));
  if (!line) throw new Error(`no PIN for ${account} in .run/demo-pins.txt (run make seed)`);
  return line.slice(account.length + 1).trim();
}

/** A unique planted string; the privacy suite checks it never reaches the relay store or logs. */
export function marker(label: string): string {
  mkdirSync(OUT, { recursive: true });
  const tag = label
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);
  const m = `qm${randomBytes(4).toString("hex")}${tag}`;
  appendFileSync(join(OUT, "markers.txt"), `${m}\n`);
  return m;
}
```

**`e2e/qa/lib/db.ts`**:

```ts
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { QA_ROOT } from "./env.js";

const COMPOSE = join(QA_ROOT, "infra", "docker-compose.yaml");

/** Quotes a value for SQL. Only [A-Za-z0-9_.:-] pass, so nothing can break out of the literal. */
export function lit(v: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(v)) throw new Error(`unsafe SQL value: ${v.slice(0, 40)}`);
  return `'${v}'`;
}

/** QA only: runs SQL in the live Postgres container and returns non-empty output lines (-At). */
export function psql(sql: string): string[] {
  const out = execFileSync(
    "docker",
    [
      "compose", "-f", COMPOSE, "exec", "-T", "postgres",
      "psql", "-U", "sa", "-d", "sa", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql,
    ],
    { encoding: "utf8" },
  );
  return out.split("\n").filter((l) => l.length > 0);
}

/** Rows of a select as JSON objects. */
export function rows<T>(select: string): T[] {
  return psql(`select row_to_json(t) from (${select}) t`).map((l) => JSON.parse(l) as T);
}
```

**`e2e/qa/lib/report.ts`**:

```ts
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OUT, RESULTS } from "./env.js";
import type { CheckResult, EgressSample, MemSample, RunInfo } from "./types.js";

export type ReportInput = {
  run: RunInfo | null;
  results: CheckResult[];
  egress: EgressSample[];
  memory: MemSample[];
};

const PAGE_BYTES = 16384;
const GIB = 1024 ** 3;

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i] ?? 0;
}
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const count = (list: CheckResult[], st: string) => list.filter((r) => r.status === st).length;

export function buildReport({ run, results, egress, memory }: ReportInput): string {
  const rs = [...results].sort((a, b) => a.id.localeCompare(b.id));
  const L: string[] = ["# QA campaign report", ""];
  if (run) {
    L.push(
      `Run \`${run.run_id}\` · started ${run.started_at} · commit \`${run.commit}\` · model \`${run.model}\` · prefix cache ${run.prefix_cache_off ? "off" : "ON"} · LiveKit ${run.livekit ? "installed" : "not installed"} · notetaker ${run.notetaker_mode}`,
      "",
    );
  }
  const flaky = rs.filter((r) => r.flaky);
  L.push(
    `**${rs.length} checks: ${count(rs, "pass")} pass, ${count(rs, "fail")} fail, ${count(rs, "skip")} skipped, ${flaky.length} passed only on retry.**`,
    "",
    "## Summary",
    "",
    "| suite | pass | fail | skip | flaky |",
    "|---|---|---|---|---|",
  );
  for (const s of [...new Set(rs.map((r) => r.suite))]) {
    const l = rs.filter((r) => r.suite === s);
    L.push(
      `| ${s} | ${count(l, "pass")} | ${count(l, "fail")} | ${count(l, "skip")} | ${l.filter((r) => r.flaky).length} |`,
    );
  }
  L.push("");

  const mx = rs.filter((r) => r.matrix);
  if (mx.length > 0) {
    const modes = [...new Set(mx.map((r) => r.matrix?.mode ?? ""))];
    const agents = [...new Set(mx.map((r) => r.matrix?.agent ?? ""))];
    L.push(
      "## Agent × mode",
      "",
      `| agent | ${modes.join(" | ")} |`,
      `|---|${modes.map(() => "---|").join("")}`,
    );
    for (const a of agents) {
      const cells = modes.map((m) => {
        const r = mx.find((x) => x.matrix?.agent === a && x.matrix?.mode === m);
        return r ? `${r.status.toUpperCase()}${r.flaky ? " (retry)" : ""}` : "-";
      });
      L.push(`| ${a} | ${cells.join(" | ")} |`);
    }
    L.push("");
  }

  L.push("## Failures", "");
  const fails = rs.filter((r) => r.status === "fail");
  if (fails.length === 0) L.push("None.", "");
  for (const r of fails) {
    L.push(
      `### ${r.id} ${r.title}`,
      "",
      `- suite: ${r.suite} · attempts: ${r.attempts} · ${Math.round(r.ms / 1000)} s`,
    );
    if (r.screenshots.length > 0)
      L.push(`- screenshots: ${r.screenshots.map((s) => `\`${s}\``).join(", ")}`);
    for (const n of r.notes) L.push(`- ${n}`);
    if (r.repro.length > 0) {
      L.push("", "Repro:");
      r.repro.forEach((s, i) => {
        L.push(`${i + 1}. ${s}`);
      });
    }
    if (r.error) L.push("", "```text", ...r.error.split("\n").slice(0, 20), "```");
    L.push("");
  }

  L.push("## Skipped", "");
  const skips = rs.filter((r) => r.status === "skip");
  if (skips.length === 0) L.push("None.");
  for (const r of skips) L.push(`- ${r.id} ${r.title}: ${r.skip_reason ?? "no reason"}`);
  L.push("", "## Flaky (passed on retry)", "");
  if (flaky.length === 0) L.push("None.");
  for (const r of flaky) L.push(`- ${r.id} ${r.title}: ${r.notes[0] ?? ""}`);

  const byLabel = new Map<string, number[]>();
  for (const r of rs) {
    for (const [k, v] of Object.entries(r.timings)) {
      const list = byLabel.get(k) ?? [];
      list.push(v);
      byLabel.set(k, list);
    }
  }
  L.push("", "## Timings (ms)", "", "| label | n | p50 | p95 | max |", "|---|---|---|---|---|");
  for (const k of [...byLabel.keys()].sort()) {
    const v = (byLabel.get(k) ?? []).sort((a, b) => a - b);
    L.push(`| ${cell(k)} | ${v.length} | ${pct(v, 0.5)} | ${pct(v, 0.95)} | ${v[v.length - 1] ?? 0} |`);
  }

  L.push("", "## Egress", "");
  const first = egress[0];
  const last = egress[egress.length - 1];
  if (!first || !last) L.push("No egress samples were recorded.");
  else {
    const off = egress.flatMap((e) => e.offending);
    const errs = egress.filter((e) => e.error).length;
    const mins = Math.round((last.ts - first.ts) / 60000);
    L.push(
      `${off.length} non-loopback connections in ${egress.length} samples over ${mins} min (${errs} samples with errors).`,
    );
    for (const c of new Set(off.map((c) => `${c.remote_ip}:${c.remote_port} (pid ${c.pid}, ${c.status})`)))
      L.push(`- ${c}`);
  }

  L.push("", "## Memory", "");
  const m0 = memory[0];
  const m1 = memory[memory.length - 1];
  if (!m0 || !m1 || memory.length < 2) L.push("Fewer than two memory samples.");
  else {
    L.push(
      `- gateways RSS: ${((m1.gateways_rss_kb * 1024) / GIB).toFixed(2)} GiB (limit 2.5)`,
      `- swap used: ${m0.swap_used_mb.toFixed(0)} → ${m1.swap_used_mb.toFixed(0)} MB (growth limit 1024 MB)`,
      `- compressor: ${((m0.compressor_pages * PAGE_BYTES) / GIB).toFixed(2)} → ${((m1.compressor_pages * PAGE_BYTES) / GIB).toFixed(2)} GiB (growth limit 2 GiB)`,
    );
  }

  L.push("", "## All checks", "", "| id | suite | status | attempts | s |", "|---|---|---|---|---|");
  for (const r of rs) {
    L.push(
      `| ${r.id} | ${r.suite} | ${r.status}${r.flaky ? " (retry)" : ""} | ${r.attempts} | ${Math.round(r.ms / 1000)} |`,
    );
  }
  return `${L.join("\n")}\n`;
}

function jsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // a torn last line while the sampler is being stopped
    }
  }
  return out;
}

export function loadInput(): ReportInput {
  const runFile = join(OUT, "run.json");
  const run = existsSync(runFile) ? (JSON.parse(readFileSync(runFile, "utf8")) as RunInfo) : null;
  const results: CheckResult[] = [];
  if (existsSync(RESULTS)) {
    for (const f of readdirSync(RESULTS)) {
      if (!f.endsWith(".json")) continue;
      const r = JSON.parse(readFileSync(join(RESULTS, f), "utf8")) as CheckResult;
      if (!run || r.run_id === run.run_id) results.push(r);
    }
  }
  return {
    run,
    results,
    egress: jsonl<EgressSample>(join(OUT, "egress.jsonl")),
    memory: jsonl<MemSample>(join(OUT, "memory.jsonl")),
  };
}

export function writeReport(): string {
  const path = join(OUT, "report.md");
  writeFileSync(path, buildReport(loadInput()));
  return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(writeReport());
}
```

**`e2e/qa/lib/report.selftest.ts`**:

```ts
import assert from "node:assert/strict";
import { buildReport } from "./report.js";
import type { CheckResult } from "./types.js";

const base = {
  run_id: "qa-test",
  flaky: false,
  attempts: 1,
  started_at: "2026-10-25T10:00:00.000Z",
  ms: 1200,
  notes: [] as string[],
  repro: [] as string[],
  screenshots: [] as string[],
};
const results: CheckResult[] = [
  {
    ...base,
    id: "ROS-01",
    suite: "roster",
    title: "Ops answers a tag",
    status: "pass",
    timings: { reply_ms: 1000 },
    matrix: { agent: "Ops", mode: "tag" },
  },
  {
    ...base,
    id: "ROS-13",
    suite: "roster",
    title: "Ops answers a DM",
    status: "fail",
    attempts: 2,
    timings: { reply_ms: 3000 },
    notes: ["attempt 2 failed: no reply"],
    repro: ["Open the Ops DM", "Send hello"],
    error: "Error: no reply",
    matrix: { agent: "Ops", mode: "dm" },
  },
  {
    ...base,
    id: "VOX-02",
    suite: "voice",
    title: "Push-to-talk",
    status: "skip",
    skip_reason: "ffmpeg missing",
    timings: {},
  },
];
const md = buildReport({
  run: null,
  results,
  egress: [
    { ts: 0, pids: 5, offending: [], error: null },
    { ts: 600000, pids: 5, offending: [], error: null },
  ],
  memory: [],
});
assert.match(md, /\*\*3 checks: 1 pass, 1 fail, 1 skipped, 0 passed only on retry\.\*\*/);
assert.match(md, /\| roster \| 1 \| 1 \| 0 \| 0 \|/);
assert.match(md, /\| Ops \| PASS \| FAIL \|/);
assert.match(md, /### ROS-13 Ops answers a DM/);
assert.match(md, /2\. Send hello/);
assert.match(md, /- VOX-02 Push-to-talk: ffmpeg missing/);
assert.match(md, /\| reply_ms \| 2 \| 1000 \| 3000 \| 3000 \|/);
assert.match(md, /0 non-loopback connections in 2 samples over 10 min/);
console.log("report selftest ok");
```

**`e2e/qa/lib/verify-run.ts`**:

```ts
// Exits 0 when every listed QA check (optionally only those matching --grep) has a result
// for the current run. Also rewrites report.md.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_ROOT, OUT, RESULTS } from "./env.js";
import { writeReport } from "./report.js";
import type { CheckResult, RunInfo } from "./types.js";

const gi = process.argv.indexOf("--grep");
const grep = gi >= 0 ? process.argv[gi + 1] : undefined;
const listing = execFileSync(
  "pnpm",
  [
    "exec", "playwright", "test", "-c", "qa/playwright.qa.config.ts", "--list",
    ...(grep ? ["--grep", grep] : []),
  ],
  {
    cwd: join(HARNESS_ROOT, "e2e"),
    encoding: "utf8",
    env: { ...process.env, QA_PREFLIGHT: "0" },
    maxBuffer: 64 * 1024 * 1024,
  },
);
const expected = new Set([...listing.matchAll(/\b([A-Z]{3}-\d{2})\b/g)].map((m) => m[1] ?? ""));
const runFile = join(OUT, "run.json");
if (!existsSync(runFile)) {
  console.error("no .handoff/qa/run.json: the campaign has not run");
  process.exit(1);
}
const run = JSON.parse(readFileSync(runFile, "utf8")) as RunInfo;
const got = new Map<string, CheckResult>();
for (const f of existsSync(RESULTS) ? readdirSync(RESULTS) : []) {
  if (!f.endsWith(".json")) continue;
  const r = JSON.parse(readFileSync(join(RESULTS, f), "utf8")) as CheckResult;
  if (r.run_id === run.run_id) got.set(r.id, r);
}
const ids = [...expected].sort();
const missing = ids.filter((id) => !got.has(id));
const n = (s: string) => ids.filter((id) => got.get(id)?.status === s).length;
const path = writeReport();
console.log(
  `run ${run.run_id}: ${ids.length} checks, ${n("pass")} pass, ${n("fail")} fail, ${n("skip")} skip, ${missing.length} missing; report ${path}`,
);
if (ids.length === 0) {
  console.error("no checks matched");
  process.exit(1);
}
if (missing.length > 0) {
  console.error(`missing results: ${missing.join(", ")}`);
  process.exit(1);
}
```

**`e2e/qa/lib/rerun-failed.ts`**:

```ts
// Reruns only the checks that failed in the current run, keeping the run id (QA_RESUME=1).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_ROOT, OUT, RESULTS } from "./env.js";
import type { CheckResult, RunInfo } from "./types.js";

const runFile = join(OUT, "run.json");
if (!existsSync(runFile)) {
  console.error("no run.json: run the campaign first");
  process.exit(1);
}
const run = JSON.parse(readFileSync(runFile, "utf8")) as RunInfo;
const failed: string[] = [];
for (const f of existsSync(RESULTS) ? readdirSync(RESULTS) : []) {
  if (!f.endsWith(".json")) continue;
  const r = JSON.parse(readFileSync(join(RESULTS, f), "utf8")) as CheckResult;
  if (r.run_id === run.run_id && r.status === "fail") failed.push(r.id);
}
if (failed.length === 0) {
  console.log("no failed checks");
  process.exit(0);
}
const grep = `\\b(${failed.sort().join("|")})\\b`;
const r = spawnSync(
  "pnpm",
  ["exec", "playwright", "test", "-c", "qa/playwright.qa.config.ts", "--grep", grep],
  { cwd: join(HARNESS_ROOT, "e2e"), stdio: "inherit", env: { ...process.env, QA_RESUME: "1" } },
);
process.exit(r.status ?? 1);
```

**`e2e/qa/lib/global-setup.ts`**:

```ts
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_ROOT, OUT, PERSONAS, QA_ROOT, RESULTS, URLS, pinOf } from "./env.js";
import type { RunInfo } from "./types.js";

/** Plugin files that prove the four plans are merged in the main checkout. */
const REQUIRED = [
  "services/bridge/src/plugins/workspace.ts",
  "services/bridge/src/plugins/proactive.ts",
  "services/bridge/src/plugins/approvals.ts",
  "services/bridge/src/plugins/oidc.ts",
  "services/bridge/src/plugins/calls.ts",
];
const ARCHIVE = ["results", "egress.jsonl", "memory.jsonl", "markers.txt", "report.md", "run.json"];

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

async function get(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function startSampler(): void {
  const child = spawn(
    "uv",
    [
      "run", "--quiet", "--group", "live", "python", "-I",
      join(HARNESS_ROOT, "e2e", "qa", "egress_sampler.py"),
      "--run-dir", join(QA_ROOT, ".run"),
      "--out", join(OUT, "egress.jsonl"),
      "--interval", "5",
    ],
    { cwd: HARNESS_ROOT, detached: true, stdio: "ignore" },
  );
  child.unref();
  writeFileSync(join(OUT, "egress.pid"), String(child.pid));
}

export default async function globalSetup(): Promise<void> {
  if (process.env.QA_PREFLIGHT === "0") {
    process.env.QA_RUN_ID ??= "qa-offline";
    return;
  }
  mkdirSync(OUT, { recursive: true });
  const runFile = join(OUT, "run.json");
  if (process.env.QA_RESUME === "1" && existsSync(runFile)) {
    process.env.QA_RUN_ID = (JSON.parse(readFileSync(runFile, "utf8")) as RunInfo).run_id;
    mkdirSync(RESULTS, { recursive: true });
    sh("bash", [join(HARNESS_ROOT, "e2e", "qa", "stack.sh"), "mem"]);
    startSampler();
    return;
  }
  for (const f of REQUIRED) {
    if (!existsSync(join(QA_ROOT, f)))
      throw new Error(`main checkout lacks ${f}: merge the four plans into main first`);
  }
  const health = [
    `${URLS.bridge}/api/healthz`,
    `${URLS.relay}/relay/healthz`,
    `${URLS.audio}/healthz`,
    URLS.web,
  ];
  for (const u of health) {
    await get(u).catch((e: Error) => {
      throw new Error(`stack not ready (${e.message}); run bash e2e/qa/stack.sh up`);
    });
  }
  const mem = (await get(`${URLS.memory}/healthz`)) as { model_loaded?: boolean } | string;
  if (typeof mem !== "object" || mem.model_loaded !== true)
    throw new Error("memory service is not ready (model_loaded is not true)");
  for (const p of Object.values(PERSONAS)) pinOf(p.account);
  const models = (await get(`${URLS.llm}/v1/models`)) as { data?: { id: string }[] };
  const prefixOff = sh("pgrep", ["-f", "--", "--disable-prefix-cache"]).trim() !== "";
  const livekit = sh("sh", ["-c", "command -v livekit-server"]).trim() !== "";
  const modeFile = join(OUT, "notetaker-mode");
  const mode = existsSync(modeFile)
    ? readFileSync(modeFile, "utf8").trim()
    : livekit
      ? "worker"
      : "fake";

  if (existsSync(runFile)) {
    const prev = (JSON.parse(readFileSync(runFile, "utf8")) as RunInfo).run_id;
    const dest = join(OUT, "previous", prev);
    mkdirSync(dest, { recursive: true });
    for (const name of ARCHIVE) {
      if (existsSync(join(OUT, name))) renameSync(join(OUT, name), join(dest, name));
    }
  }
  mkdirSync(RESULTS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const run: RunInfo = {
    run_id: `qa-${stamp}`,
    started_at: new Date().toISOString(),
    commit: sh("git", ["-C", QA_ROOT, "rev-parse", "--short", "HEAD"]).trim(),
    model: models.data?.[0]?.id ?? "unknown",
    prefix_cache_off: prefixOff,
    livekit,
    notetaker_mode: mode,
    personas: Object.fromEntries(Object.entries(PERSONAS).map(([k, v]) => [k, v.account])),
  };
  writeFileSync(runFile, `${JSON.stringify(run, null, 2)}\n`);
  writeFileSync(join(OUT, "markers.txt"), "");
  process.env.QA_RUN_ID = run.run_id;
  sh("bash", [join(HARNESS_ROOT, "e2e", "qa", "stack.sh"), "mem"]);
  startSampler();
}
```

**`e2e/qa/lib/global-teardown.ts`**:

```ts
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_ROOT, OUT } from "./env.js";
import { writeReport } from "./report.js";

export default async function globalTeardown(): Promise<void> {
  if (process.env.QA_PREFLIGHT === "0") return;
  const pidFile = join(OUT, "egress.pid");
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // already gone
    }
    rmSync(pidFile, { force: true });
  }
  try {
    execFileSync("bash", [join(HARNESS_ROOT, "e2e", "qa", "stack.sh"), "mem"], { stdio: "ignore" });
  } catch {
    // the stack may already be down
  }
  console.log(`QA report: ${writeReport()}`);
}
```

### Q2: Harness personas — API, Node device, UI helpers, `check()`, harness suite

Build `e2e/qa/lib/{api,node-device,ui,fixtures,check}.ts` and `e2e/qa/suites/00-harness.spec.ts`. Read first:
- `e2e/live/roster-smoke.ts`, `e2e/live/agents-smoke.ts` and `e2e/live/memory-smoke.ts`: login, Node device registration, `RelayClient`/`ChatEngine` use, reading `meta`, activity signals, the SSE reader. Copy the minimum; do not import from `e2e/live`.
- `e2e/tests/teammates.spec.ts`, `memory-approvals.spec.ts`, `voice.spec.ts` and `call.spec.ts`: selectors for login, Welcome, sidebar, composer, threads, rails, approval cards, Knowledge tab, mic button and call page.

Fixed interfaces (the suites depend on these exact names):

```ts
// api.ts. Paths are relative to /api. base defaults to URLS.bridge.
export class ApiError extends Error {
  constructor(readonly status: number, readonly body: string, message: string);
}
export class Api {
  static login(account: string, opts?: { pin?: string; base?: string }): Promise<Api>;
  readonly base: string;
  readonly userId: string;
  readonly displayName: string;
  get<T>(path: string): Promise<T>; // throws ApiError when !ok
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
  raw(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>; // never throws on status
  upload(path: string, file: { name: string; mime: string; bytes: Uint8Array }): Promise<Response>; // octet-stream + x-file-name (URI-encoded) + x-file-type
  events(): EventTap; // GET /api/events, fetch streaming with Bearer
}
export class EventTap {
  readonly seen: ServerEvent[]; // @sa/protocol ServerEvent
  waitFor(pred: (e: ServerEvent) => boolean, ms: number): Promise<{ event: ServerEvent; ms: number }>; // checks seen first
  none(pred: (e: ServerEvent) => boolean, ms: number): Promise<void>; // throws LeakError if one arrives
  close(): void;
}
export function chatByTitle(api: Api, title: string): Promise<Chat>;
export function seedRoom(api: Api, seedKey: "general" | "ops" | "release-7.4" | "sales"): Promise<Chat>;
export function agentByRoster(api: Api, rosterId: "ops" | "qa" | "dev" | "tech" | "sales" | "scribe"): Promise<Agent>;
export function agentByName(api: Api, name: string): Promise<Agent>;

// node-device.ts
export class NodeUser {
  static connect(api: Api): Promise<NodeUser>; // registers a device; the custodian grants seeded rooms
  readonly deviceId: string;
  messages(chatId: string): ChatMessage[];
  waitMessage(chatId: string, pred: (m: ChatMessage) => boolean, ms: number): Promise<{ msg: ChatMessage; ms: number }>;
  waitNone(chatId: string, pred: (m: ChatMessage) => boolean, ms: number): Promise<void>; // throws LeakError if one arrives
  waitSignal(chatId: string, pred: (s: ActivitySignalLike) => boolean, ms: number): Promise<{ signal: ActivitySignalLike; ms: number }>;
  reactions(chatId: string, messageId: string): { emoji: string; agentId?: string; userId?: string }[]; // current set after add/remove
  waitReaction(chatId: string, messageId: string, pred: (r: { emoji: string; agentId?: string }) => boolean, ms: number): Promise<{ ms: number }>;
  send(chatId: string, text: string, opts?: { replyTo?: string }): Promise<{ id: string; at: number }>;
  sendFile(chatId: string, file: { name: string; mime: string; bytes: Uint8Array }, opts?: { replyTo?: string; voice?: { duration_ms: number } }): Promise<{ id: string; at: number }>;
  close(): Promise<void>;
}
export type ActivitySignalLike = { phase: string; turn_id?: string; reply_to?: string; requester?: string; ahead?: number; agentId?: string };
export function metaOf(m: ChatMessage): Record<string, unknown> & TextMeta; // never undefined
export function byAgent(agent: Agent): (m: ChatMessage) => boolean;
export function inThread(rootId: string): (m: ChatMessage) => boolean; // reply_to === rootId
export function textOf(m: ChatMessage): string;

// ui.ts. Every function waits for its own result, so callers need no sleeps.
export function login(page: Page, account: string, opts?: { keepWelcome?: boolean; base?: string; pin?: string }): Promise<void>;
export function getStarted(page: Page): Promise<void>; // Welcome → Get started (opens the Scribe DM)
export function openChat(page: Page, title: string): Promise<string>; // returns chatId from /c/:chatId
export function createGroup(page: Page, o: { title: string; people: string[]; agents: string[] }): Promise<string>; // display names; returns chatId
export function addAgent(page: Page, agentName: string): Promise<void>; // in the open chat
export function addPerson(page: Page, displayName: string): Promise<void>;
export function removePerson(page: Page, displayName: string): Promise<void>;
export function send(page: Page, text: string): Promise<void>; // the channel composer
export function openThread(page: Page, rootText: string): Promise<string>; // returns rootId from /c/:id/t/:root
export function sendInThread(page: Page, text: string): Promise<void>;
export function openRail(page: Page, rail: "members" | "activity" | "relay"): Promise<Locator>;
export function approvalCard(page: Page): Locator;
export function openAgent(page: Page, agentName: string, tab: "overview" | "activity" | "routines" | "knowledge"): Promise<void>;
export function teachDocument(page: Page, filePath: string): Promise<void>; // Knowledge tab → Teach a document
export function openDm(page: Page, agentName: string): Promise<string>; // /agents → Message; returns chatId
export function palette(page: Page): Promise<Locator>; // ⌘K
export function chatIdFromUrl(page: Page): string;
```

**`fixtures.ts`**: `export const test = base.extend<{}, { qa: Qa }>(…)` with a **worker-scoped** `qa` fixture, plus `export { expect }`.

```ts
export type Persona = {
  key: string;
  account: string;
  label: string;
  displayName: string;
  userId: string;
  context: BrowserContext;
  page: Page;
  api: Api;
  node: NodeUser;
};
export type Qa = {
  persona(key: PersonaKey): Promise<Persona>; // lazy, cached for the worker: browser login (skips Welcome) + Api + NodeUser
  fresh(key: PersonaKey, opts?: { launchArgs?: string[]; keepWelcome?: boolean }): Promise<Persona>; // new context (new device); launchArgs → own browser
  track(key: string, page: Page): void; // extra pages to screenshot (side stack)
  opened(): { key: string; page: Page }[];
};
```

The fixture teardown closes every NodeUser, EventTap, context and extra browser.

**`check.ts`** (complete; keep as is):

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESULTS, runId } from "./env.js";
import { type Qa, test } from "./fixtures.js";
import type { CheckResult } from "./types.js";

export class SkipCheck extends Error {}
/** A proven leak: never retried. */
export class LeakError extends Error {}

export type CheckCtx = {
  readonly attempt: number;
  step(text: string): void;
  note(text: string): void;
  time(label: string, ms: number): number;
  since(label: string, t0: number): number;
  skip(reason: string): never;
  leak(message: string): never;
};
export type CheckOpts = {
  suite: string;
  llm?: boolean;
  timeoutMs?: number;
  tags?: string[];
  matrix?: { agent: string; mode: string };
};

function ctxFor(r: CheckResult, attempt: number): CheckCtx {
  return {
    attempt,
    step: (text) => {
      r.repro.push(text);
    },
    note: (text) => {
      r.notes.push(text);
    },
    time: (label, ms) => {
      r.timings[label] = ms;
      return ms;
    },
    since: (label, t0) => {
      const ms = Date.now() - t0;
      r.timings[label] = ms;
      return ms;
    },
    skip: (reason) => {
      throw new SkipCheck(reason);
    },
    leak: (message) => {
      throw new LeakError(message);
    },
  };
}

async function shoot(qa: Qa, name: string): Promise<string[]> {
  const out: string[] = [];
  for (const p of qa.opened()) {
    if (p.page.isClosed()) continue;
    const file = `${name}-${p.key}.png`;
    try {
      await p.page.screenshot({ path: join(RESULTS, file), timeout: 5000 });
      out.push(`results/${file}`);
    } catch {
      // page navigating or gone
    }
  }
  return out;
}

export function check(
  id: string,
  title: string,
  opts: CheckOpts,
  fn: (ctx: CheckCtx, qa: Qa) => Promise<void>,
): void {
  const tags = [opts.suite, ...(opts.tags ?? [])].map((t) => `@${t}`).join(" ");
  test(`${id} ${title} ${tags}`, async ({ qa }) => {
    test.setTimeout(opts.timeoutMs ?? (opts.llm ? 900_000 : 300_000));
    const t0 = Date.now();
    const r: CheckResult = {
      run_id: runId(),
      id,
      suite: opts.suite,
      title,
      status: "fail",
      flaky: false,
      attempts: 0,
      started_at: new Date(t0).toISOString(),
      ms: 0,
      timings: {},
      notes: [],
      repro: [],
      screenshots: [],
      ...(opts.matrix ? { matrix: opts.matrix } : {}),
    };
    const max = opts.llm ? 2 : 1;
    try {
      for (let a = 1; a <= max; a++) {
        r.attempts = a;
        r.repro = [];
        try {
          await fn(ctxFor(r, a), qa);
          r.status = "pass";
          r.flaky = a > 1;
          delete r.error;
          break;
        } catch (e) {
          if (e instanceof SkipCheck) {
            r.status = "skip";
            r.skip_reason = e.message;
            delete r.error;
            break;
          }
          const msg = e instanceof Error ? e.message : String(e);
          r.status = "fail";
          r.error = e instanceof Error ? (e.stack ?? msg) : msg;
          r.notes.push(`attempt ${a} failed${e instanceof LeakError ? " (leak)" : ""}: ${msg.split("\n")[0]}`);
          if (e instanceof LeakError) break;
          if (a < max) r.screenshots.push(...(await shoot(qa, `${id}-attempt${a}`)));
        }
      }
    } finally {
      r.ms = Date.now() - t0;
      r.screenshots.push(...(await shoot(qa, id)));
      mkdirSync(RESULTS, { recursive: true });
      writeFileSync(join(RESULTS, `${id}.json`), `${JSON.stringify(r, null, 2)}\n`);
    }
    test.skip(r.status === "skip", r.skip_reason ?? "");
    if (r.status === "fail") throw new Error(`${id} failed: ${r.notes[r.notes.length - 1] ?? r.error}`);
  });
}

/** Memoized async setup; a failure clears the cache so the next check retries it. */
export function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => {
    if (!p) {
      p = fn().catch((e: unknown) => {
        p = null;
        throw e;
      });
    }
    return p;
  };
}

/** Skips the calling check when a prerequisite is missing. */
export function need<T>(v: T | null | undefined, why: string): T {
  if (v === null || v === undefined) throw new SkipCheck(`blocked: ${why}`);
  return v;
}
```

`node-device.ts` and `api.ts` import `LeakError` from `check.ts`. Do not create an import cycle with `fixtures.ts`: move `SkipCheck`/`LeakError` to `lib/errors.ts` if one appears, and re-export them from `check.ts`.

**`suites/00-harness.spec.ts`** (suite `harness`):
- HAR-01 **Personas sign in.** `qa.persona("ana")` and `("ben")`. The browser lands on a channel page, `GET /me` returns the account id, and each NodeUser has a device id. Record `login_ms`.
- HAR-02 **E2E chat baseline.** Ana creates the group `qa <run> baseline` with Ben (UI) and sends `marker("baseline")`. Ben's page and Ben's NodeUser both show it within 20 s, and Ben's reply reaches Ana. Record `deliver_ms`.
- HAR-03 **Event stream.** `ana.api.events()` gets `hello` within 5 s.

### Q3: Document fixtures and the extraction check

**`e2e/qa/fixtures/make_fixtures.py`** (complete). Run it once to write the files, and commit the outputs: `handbook.txt`, `warehouse.docx`, `recovery.pdf`, `nora-brief.txt`, `shipping-note.txt`. `--check` rebuilds them in memory and compares bytes.

```python
"""QA fixtures: small fictional documents with one checkable fact each.

Run to regenerate the files next to this script; --check verifies they are current.
"""

from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
ZIP_DATE = (1980, 1, 1, 0, 0, 0)

DOCS: dict[str, list[str]] = {
    "handbook.txt": [
        "Field operations handbook (fictional, for QA)",
        "",
        "The on-call rotation hands over every Tuesday at 09:30.",
        "Escalations go to the duty lead within 15 minutes.",
    ],
    "warehouse.docx": [
        "Warehouse facts (fictional, for QA)",
        "The north warehouse keeps 312 pallets of spare parts.",
        "Stock is counted on the first Monday of each month.",
    ],
    "recovery.pdf": [
        "Recovery plan (fictional, for QA)",
        "The disaster recovery drill is on 14 May.",
        "The target recovery time is 38 minutes.",
    ],
    "nora-brief.txt": [
        "Private brief (fictional, for QA)",
        "",
        "The partner discount ceiling is 23 percent.",
    ],
    "shipping-note.txt": [
        "Shipping note (fictional, for QA)",
        "",
        "The pallet weight limit is 870 kg.",
    ],
}

CT = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" '
    'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" ContentType="application/'
    'vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    "</Types>"
)
RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
    'relationships/officeDocument" Target="word/document.xml"/>'
    "</Relationships>"
)
DOC_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    "</Relationships>"
)
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def docx(lines: list[str]) -> bytes:
    paras = "".join(
        f'<w:p><w:r><w:t xml:space="preserve">{escape(line)}</w:t></w:r></w:p>'
        for line in lines
    )
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{W}"><w:body>{paras}</w:body></w:document>'
    )
    parts = {
        "[Content_Types].xml": CT,
        "_rels/.rels": RELS,
        "word/_rels/document.xml.rels": DOC_RELS,
        "word/document.xml": document,
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        for name, text in parts.items():
            info = zipfile.ZipInfo(name, ZIP_DATE)
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o644 << 16
            z.writestr(info, text.encode("utf-8"))
    return buf.getvalue()


def pdf(lines: list[str]) -> bytes:
    def esc(s: str) -> str:
        return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")

    ops = ["BT", "/F1 12 Tf", "16 TL", "72 720 Td"]
    for line in lines:
        ops += [f"({esc(line)}) Tj", "T*"]
    ops.append("ET")
    stream = "\n".join(ops).encode("latin-1")
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n".encode() + b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def build(name: str, lines: list[str]) -> bytes:
    if name.endswith(".docx"):
        return docx(lines)
    if name.endswith(".pdf"):
        return pdf(lines)
    return ("\n".join(lines) + "\n").encode("utf-8")


def main(argv: list[str]) -> int:
    check = "--check" in argv
    stale = []
    for name, lines in DOCS.items():
        data = build(name, lines)
        path = HERE / name
        if check:
            if not path.exists() or path.read_bytes() != data:
                stale.append(name)
        else:
            path.write_bytes(data)
    if stale:
        print("stale fixtures:", ", ".join(stale))
        return 1
    print("fixtures ok" if check else f"wrote {len(DOCS)} files")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
```

**`e2e/qa/fixtures/facts.ts`** (complete):

```ts
import { join } from "node:path";

export type Fact = {
  file: string;
  path: string;
  mime: string;
  use: "teach-tech" | "teach-personal" | "chat-file";
  /** asked after "@<Agent> " */
  question: string;
  /** what a correct answer contains */
  answer: RegExp;
};

const dir = import.meta.dirname;
const f = (file: string) => join(dir, file);

export const FACTS = {
  handbook: {
    file: "handbook.txt",
    path: f("handbook.txt"),
    mime: "text/plain",
    use: "teach-tech",
    question: "according to the handbook we taught you, when does the on-call rotation hand over?",
    answer: /0?9[:.]30/,
  },
  warehouse: {
    file: "warehouse.docx",
    path: f("warehouse.docx"),
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    use: "teach-tech",
    question:
      "according to the warehouse document we taught you, how many pallets of spare parts does the north warehouse keep?",
    answer: /\b312\b/,
  },
  recovery: {
    file: "recovery.pdf",
    path: f("recovery.pdf"),
    mime: "application/pdf",
    use: "teach-tech",
    question: "according to the recovery plan we taught you, what is the target recovery time?",
    answer: /\b38\b/,
  },
  nora: {
    file: "nora-brief.txt",
    path: f("nora-brief.txt"),
    mime: "text/plain",
    use: "teach-personal",
    question: "what is the partner discount ceiling?",
    answer: /\b23\s?(%|percent)/i,
  },
  shipping: {
    file: "shipping-note.txt",
    path: f("shipping-note.txt"),
    mime: "text/plain",
    use: "chat-file",
    question: "what is the pallet weight limit in the shipping note?",
    answer: /\b870\b/,
  },
} as const satisfies Record<string, Fact>;

/** From the memory + approvals plan (e2e/fixtures/contract.txt). */
export const CONTRACT: Fact = {
  file: "contract.txt",
  path: join(dir, "..", "..", "fixtures", "contract.txt"),
  mime: "text/plain",
  use: "teach-tech",
  question: "according to the contract we taught you, what is the termination notice period?",
  answer: /\b47\b/,
};
```

**`services/bridge/test/qa-fixtures.test.ts`** (complete; it uses the bridge's real extractor from the memory plan, `src/memory/extract.ts`):

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extract } from "../src/memory/extract.js";

const dir = join(import.meta.dirname, "..", "..", "..", "e2e", "qa", "fixtures");
const CASES: [file: string, mime: string, has: string][] = [
  ["handbook.txt", "text/plain", "09:30"],
  ["warehouse.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "312 pallets"],
  ["recovery.pdf", "application/pdf", "38 minutes"],
  ["nora-brief.txt", "text/plain", "23 percent"],
  ["shipping-note.txt", "text/plain", "870 kg"],
];

describe("QA fixtures extract with the bridge extractor", () => {
  for (const [file, mime, has] of CASES) {
    it(file, async () => {
      const bytes = new Uint8Array(readFileSync(join(dir, file)));
      const out = await extract(bytes, file, mime);
      expect(out.segments.map((s) => s.text).join("\n")).toContain(has);
    });
  }
});
```

### Q4: Live stack script and egress sampler

**`e2e/qa/stack.sh`** (complete):

```bash
#!/usr/bin/env bash
# QA live stack: make up + make dev from the main checkout, with the QA env.
# Usage: stack.sh up|down|status|mem
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${QA_ROOT:-$(cd "$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)}"
OUT="$ROOT/.handoff/qa"
RUN="$ROOT/.run"
mkdir -p "$OUT" "$RUN"

wait_http() { # name url seconds [substring]
  local name=$1 url=$2 secs=$3 pat=${4:-} body
  for ((i = 0; i < secs; i++)); do
    if body=$(curl -fsS --max-time 2 "$url" 2>/dev/null); then
      if [[ -z $pat || $body == *"$pat"* ]]; then
        echo "ok: $name"
        return 0
      fi
    fi
    sleep 1
  done
  echo "timeout: $name ($url)" >&2
  return 1
}

gateways() { pgrep -f "hermes -p sa_agent_" | wc -l | tr -d ' '; }

mem() {
  local pids rss=0 swap comp
  pids=$(pgrep -f "hermes -p sa_agent_" | paste -sd, - || true)
  if [[ -n $pids ]]; then rss=$(ps -o rss= -p "$pids" | awk '{s+=$1} END {print s+0}'); fi
  swap=$(sysctl -n vm.swapusage | sed -E 's/.*used = ([0-9.]+)M.*/\1/')
  comp=$(vm_stat | awk '/Pages occupied by compressor/ {gsub("\\.", "", $5); print $5}')
  printf '{"ts":%s000,"gateways_rss_kb":%s,"swap_used_mb":%s,"compressor_pages":%s}\n' \
    "$(date +%s)" "${rss:-0}" "${swap:-0}" "${comp:-0}" >>"$OUT/memory.jsonl"
}

up() {
  cd "$ROOT"
  pkill -f "hermes -p sa_agent_" || true
  for p in 5173 8647 8648 8649; do
    pids=$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t || true)
    if [[ -n $pids ]]; then kill $pids || true; fi
  done
  make up
  if command -v livekit-server >/dev/null 2>&1; then
    export SA_NOTETAKER=worker
    bash infra/scripts/livekit.sh start
  else
    export SA_NOTETAKER=fake
  fi
  export SA_APPROVAL_TTL_MS=600000 SA_NOTES_INTERVAL_MS=3600000
  set -m
  nohup make dev >"$RUN/qa-dev.log" 2>&1 &
  echo $! >"$RUN/qa-dev.pid"
  set +m
  wait_http bridge http://127.0.0.1:8647/api/healthz 240
  wait_http relay http://127.0.0.1:8648/relay/healthz 60
  wait_http ops-sim http://127.0.0.1:8649/sim/healthz 60
  wait_http memory http://127.0.0.1:8646/healthz 120 model_loaded
  wait_http audio http://127.0.0.1:8645/healthz 120
  wait_http web http://127.0.0.1:5173/ 120
  local n=0
  for ((i = 0; i < 300; i++)); do
    n=$(gateways)
    if ((n >= 6)); then break; fi
    sleep 1
  done
  if ((n < 6)); then
    echo "timeout: roster gateways ($n/6)" >&2
    exit 1
  fi
  echo "$SA_NOTETAKER" >"$OUT/notetaker-mode"
  mem
  echo "qa stack up (notetaker: $SA_NOTETAKER)"
}

down() {
  cd "$ROOT"
  if [[ -f $RUN/qa-dev.pid ]]; then
    kill -TERM -- "-$(cat "$RUN/qa-dev.pid")" 2>/dev/null || true
    rm -f "$RUN/qa-dev.pid"
  fi
  if command -v livekit-server >/dev/null 2>&1 && [[ -f infra/scripts/livekit.sh ]]; then
    bash infra/scripts/livekit.sh stop || true
  fi
  make down
}

status() {
  local bad=0
  for u in http://127.0.0.1:8647/api/healthz http://127.0.0.1:8648/relay/healthz \
    http://127.0.0.1:8646/healthz http://127.0.0.1:8645/healthz http://127.0.0.1:5173/; do
    if curl -fsS --max-time 2 "$u" >/dev/null 2>&1; then echo "up:   $u"; else
      echo "down: $u"
      bad=1
    fi
  done
  echo "roster gateways: $(gateways)"
  return $bad
}

case "${1:-}" in
up) up ;;
down) down ;;
status) status ;;
mem) mem ;;
*)
  echo "usage: stack.sh up|down|status|mem" >&2
  exit 2
  ;;
esac
```

**`e2e/qa/egress_sampler.py`** (complete):

```python
"""QA egress sampler: records every non-loopback connection of the stack's processes."""

from __future__ import annotations

import argparse
import dataclasses
import json
import signal
import subprocess
import sys
import time
from pathlib import Path

from sa_infra import egress, runfiles

PORTS = (
    5173, 5193, 7880, 8000, 8081, 8645, 8646, 8647, 8648, 8649, 8667, 8668, 8669,
    *range(8700, 8710),
)


def listeners(ports: tuple[int, ...]) -> set[int]:
    pids: set[int] = set()
    for port in ports:
        out = subprocess.run(
            ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
            capture_output=True,
            text=True,
            check=False,
        ).stdout
        pids.update(int(p) for p in out.split() if p.isdigit())
    return pids


def sample(run_dir: Path) -> dict:
    pids = set(runfiles.service_pids(run_dir).values()) | listeners(PORTS)
    error = None
    bad: list = []
    try:
        bad = egress.scan(pids)
    except RuntimeError as e:
        error = str(e)
    return {
        "ts": int(time.time() * 1000),
        "pids": len(pids),
        "offending": [dataclasses.asdict(c) for c in bad],
        "error": error,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run-dir", type=Path, required=True)
    ap.add_argument("--out", required=True, help="jsonl file, or - for stdout")
    ap.add_argument("--interval", type=float, default=5.0)
    ap.add_argument("--once", action="store_true")
    args = ap.parse_args()
    stop = False

    def on_term(_sig, _frm):
        nonlocal stop
        stop = True

    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, on_term)
    out = sys.stdout if args.out == "-" else open(args.out, "a", encoding="utf-8")  # noqa: SIM115
    try:
        while not stop:
            out.write(json.dumps(sample(args.run_dir)) + "\n")
            out.flush()
            if args.once:
                break
            time.sleep(args.interval)
    finally:
        if out is not sys.stdout:
            out.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

### Q5: Suite — roster agents × invocation modes

`e2e/qa/suites/10-roster.spec.ts`, suite `roster`. Agents come from `ROSTER` in `@sa/protocol/roster`: display name, channels, example prompts and MCP tool allowlist (read the field names there). Matrix checks pass `matrix: { agent, mode }`. Every LLM check is `llm: true`. Before each wait, record repro steps with `ctx.step`. Base assertions for an agent reply R to a question Q (call them **R-ok**), read from Ana's NodeUser:
- `R.reply_to` is as specified;
- `metaOf(R).local === true`;
- `meta.model` is a non-empty string and not `echo`;
- `meta.tools` is an array and every entry is in the agent's allowlist;
- the reactions on Q end with exactly one of ✅/⏹️/⚠️ from that agent, and no 👀 remains.

Record `eyes_ms` (send → 👀) and `reply_ms`.

- ROS-01..06 **Tag in channel**, one check per agent (Ops, QA, Dev, Tech, Sales, Scribe), in the agent's first `ROSTER` channel. Ana sends `@<Name> <examples[0]>` via the UI. 👀 arrives within `EYES_MS`. R-ok with `reply_to = Q.id`, and `meta.tools.length ≥ 1` (first tool forced). The UI thread shows the reply with a receipts footer containing `local`. Ben's NodeUser also receives R. Mode `tag`.
- ROS-07..12 **Thread follow-up**, per agent. The setup (`once`) is that agent's tagged thread, made fresh if ROS-0x did not run. Ana posts the untagged `And what should we check next?` in the thread. The same agent replies with `reply_to = root` (R-ok, tools may be 0), and no other agent posts in the thread within 30 s. Mode `follow-up`.
- ROS-13..18 **DM**, per agent. Ana opens the DM via `/agents` → Message (`openDm`) and sends `examples[1]` with no `@`. The reply is top-level (`reply_to` empty), R-ok, tools ≥ 1. For Scribe, ignore a welcome message that arrives first (match the reply to the question's time). Mode `dm`.
- ROS-19 **Another user's untagged follow-up does not trigger.** Ben posts an untagged reply in Ana's Ops thread, and no agent posts in that thread within `QUIET_MS` (`waitNone`, LeakError).
- ROS-20 **Tag inside someone else's thread.** Ben sends `@Ops …` in Ana's Ops thread. Ops answers with `reply_to = root`, and the 👀 is on Ben's message.
- ROS-21 **Two agents, one message.** In `#release-7.4`, Ana sends `@Ops @QA is 7.4 ready to ship, and is the cluster healthy enough to roll it out?`. Two replies arrive with `reply_to = Q.id`: Ops with tools ∩ {`cluster_health`, `metric_trend`, `db_sync_status`} ≠ ∅, and QA with tools ∩ {`release_status`, `test_runs`} ≠ ∅. Both have ✅.
- ROS-22 **"Ask an agent…"** Find the entry with `git grep -n "Ask an agent" apps/web/src` (composer or ⌘K palette). Pick Tech, ask `examples[0]`, and expect Tech's reply in a thread. If the string is absent from the web source, `ctx.skip("no 'Ask an agent' entry in apps/web/src")`.
- ROS-23 **`/summarize` in a channel.** In `#release-7.4`, Ana's message reads `@Scribe summarize this chat` on Ben's page (the client-side expansion everyone sees), and Scribe replies in the thread.
- ROS-24 **`/summarize` in a thread** expands to `… this thread`, and Scribe replies in that thread.
- ROS-25 **`/catchup` in Ana's Scribe DM** → `@Scribe what did I miss?`, and the reply's tools include `chat_digest`.
- ROS-26 **`/standup`** in `#release-7.4` → the expansion text `@Scribe write a standup for today from this chat: done, next, blockers`, and Scribe replies.
- ROS-27 **`/ask qa <text>`** → `@QA <text>`, and QA replies.
- ROS-28 **`/access ops`** in `#ops` → `@Ops what can you access here?`. A deterministic reply arrives within 15 s, names at least one Ops tool, and has no LLM tool calls (`meta.tools` empty or absent).
- ROS-29 **`/access` with no agent** in `#release-7.4` → one deterministic reply per agent member of the room within 30 s.
- ROS-30 **Stop is requester-only.**
  1. Ana sends `@Dev why did the nightly fail? Go through every pipeline and test run in detail.`
  2. Take `turn_id` from the `thinking` signal.
  3. Ben's `POST /api/turns/:id/stop` → 403 or 404 (`LeakError` if 2xx), and Ben's page shows no Stop control in that thread.
  4. Ana clicks Stop in the UI within 3 s of `thinking`. `Stopped by <Ana>.` appears within 15 s with `meta.stopped_by`, the reaction is ⏹️, and no further Dev message arrives in the thread within 30 s.
- ROS-31 **Queue with two users** (llm, timeout 1 200 s). Within 1 s: Ana tags Ops in `#ops`, Ana tags QA in `#release-7.4`, and Ben tags Dev in `#release-7.4`.
  - Each question gets 👀 within `EYES_MS` (record all three).
  - At least one requester's NodeUser sees a `queued` signal with `ahead ≥ 1`. If none appears, note `SA_LLM_CONCURRENCY ≥ 3?` and fail only the queued assertion.
  - All three end ✅ within 600 s. Record the order of completion.
- ROS-32 **Join line and intro chips.** Ana creates `qa <run> join` with Ben, and Ben (not the owner) adds QA via the UI.
  - Both pages show `QA joined · new chat key · sees messages from now on`.
  - Exactly one intro message from QA arrives, with `meta.chips` of length 3.
  - Ben clicks the first chip: his message equals the chip text, and QA replies in its thread.
- ROS-33 **Removal hides later messages.** In the join group, Ana removes Ben → `<Ana> removed <Ben>.`. Ana then posts `marker("removed")`, and Ben's NodeUser does not receive it within 20 s (LeakError). Ben's page does not show it either.
- ROS-34 **Feedback.** Ana clicks 👍 on the receipts footer of ROS-01's reply. Within 10 s, the `sa.turn_metrics` row of that `turn_id` has the 👍 recorded (column names from `003_teammates.sql`, via `rows()`). Then 👎 opens `What should it have said?`; close it without sending.
- ROS-35 **Receipts content.** Expanding ROS-01's receipts footer shows the tool names, `local` and the model basename.
- ROS-36 **Agents never trigger agents.** Ana sends `@Ops reply with exactly this line: @QA hello from ops`. Ops replies, and QA posts nothing in that thread within `QUIET_MS` (LeakError).
- ROS-37 **Seeded and old messages never trigger.** After the suite, no 👀 from any agent exists on a message with `meta.seeded` in the four rooms (scan Ana's NodeUser).

### Q6: Suite — proactive: alert watch, catch-up, routines, pause

`e2e/qa/suites/20-proactive.spec.ts`, suite `proactive`. Find the alert-watch id (`alert-watch`) and the routine body shapes in T1-plan T11. Raise alerts with `POST ${URLS.opsSim}/sim/admin/alerts {node, severity, message}`.
- PRO-01 **Alert posts once** (llm, timeout 600 s). Make sure the watch is not paused (`PATCH /api/routines/alert-watch {paused:false}`). Raise `{node:"node-3", severity:"critical", message:"QA <marker> disk pressure"}`. Within 200 s, Ops posts a top-level message in `#ops` (no `reply_to`) with `meta.local` and tools ≥ 1, and no 👀 reaction is attached to it. Record `alert_to_post_ms`.
- PRO-02 **Same alert again.** Raising the same alert again posts nothing within 150 s (LeakError).
- PRO-03 **Any user can pause** (timeout 600 s). Ben pauses the watch → 200, and `GET /api/routines?agent_id=<ops>` shows `paused: true`. A new alert posts nothing within 150 s. `finally`: resume.
- PRO-04 **Deleting the alert watch** → 403 for Ana and Ben.
- PRO-05 **Catch-up on first hello** (llm).
  1. Make sure Ana has a Scribe DM (`POST /api/agents/<scribe>/dm`) and `pause_all` is false (`PUT /api/me/prefs`).
  2. `psql("update sa.user_prefs set last_hello_day = null where user_id = " + lit(ana.userId))`.
  3. `POST /api/me/hello` → `{catchup:true}`, and within 240 s Scribe posts top-level in the DM with tools ⊇ `chat_digest`.
  4. A second hello → `{catchup:false}`.
- PRO-06 **`pause_all` stops catch-up.** Set `pause_all` true, reset the day, and hello → `{catchup:false}`. No Scribe message arrives within `QUIET_MS`. `finally`: `pause_all` false.
- PRO-07 **Catch-up scope (D-9).** Ben creates `qa <run> ben-only` with Rareș and Scribe and posts `Our secret word is <marker>`. Then reset Ana's day and trigger her catch-up: the catch-up text does not contain the marker (LeakError), and no citation points at that chat.
- PRO-08 **Routine fires** (llm, timeout 600 s). Ana creates a routine in `qa <run> routines` (Ana + Scribe) through the Routines tab of Scribe's profile. Prompt `Post a one-line status of this chat`, today's weekday, time = local now + 2 min (`HH:MM`; if that crosses midnight, use tomorrow and skip with a reason). Within 210 s after the slot, Scribe posts top-level in that chat, and `GET /api/routines` shows `last_run_at` set. Record the `time_zone` from `GET /api/me/prefs`.
- PRO-09 **Paused routine does not fire.** Same as PRO-08, but `PATCH {paused:true}` right after creating it. Nothing arrives within 210 s after the slot (LeakError).
- PRO-10 **Routine in a chat the caller is not in** → 403 (Ben targeting Ana's routines chat).
- PRO-11 **Ben cannot pause or delete Ana's routine** → 403 or 404.
- PRO-12 **Routines UI.** Scribe's profile Routines tab lists Ana's routine with its time and shows the time zone.
- PRO-13 **Human turns first** (observational, llm). Raise an alert and, within 1 s, have Ana tag Tech in `#general`. Tech's 👀 arrives within `EYES_MS`, and Tech's reply is not later than the Ops alert post by more than 120 s. Note the order.

### Q7: Suite — seeded workspace, D-12 late joiner, directory, palette

`e2e/qa/suites/30-workspace.spec.ts`, suite `workspace`. Seeded texts come from `services/bridge/src/workspace/seed-data.ts` (pick exact lines there).
- WSP-01 **Four rooms.** Ana's sidebar lists general, ops, release-7.4 and sales.
- WSP-02 **Seeded history renders.** `#general` shows ≥ 8 messages, seeded agent messages carry the `example history` label, and seed colleagues are labelled `demo colleague · hosted on this Mac`.
- WSP-03 **History never triggers.** While Ana and Ben open all four rooms, no new 👀 appears on any seeded message within 30 s (LeakError).
- WSP-04 **D-12 late joiner** (timeout 600 s).
  1. Ana posts `marker("between")` in `#general` and waits until Ben's NodeUser has it.
  2. `qa.fresh("late", { keepWelcome: true })` signs Janosch in on a new device.
  3. In `#general` he sees a known seeded line within 30 s, and does **not** see the marker within 20 s (LeakError: the window delivers only seq ≤ `history_until_seq` plus seq > his device's `added_seq`).
  4. Ana posts `marker("after")`, and Janosch sees it within 20 s.
- WSP-05 **Welcome for the late joiner.** On first sign-in in a fresh context the page shows Welcome. Get started opens the Scribe DM. When the DM was created now (`POST …/dm` `created`), a Scribe welcome arrives within 240 s (llm); otherwise note "existing DM".
- WSP-06 **Try this.** In `#general`, the Try this card has an `@Ops …` button. Clicking it sends the prompt, and Ops replies in a thread with a receipts footer (llm).
- WSP-07 **Members rail.** In each room it lists the roster agents per `ROSTER.channels` and the seed colleagues.
- WSP-08 **Activity rail.** After WSP-06, the activity rail of `#general` lists the Ops turn.
- WSP-09 **Agents directory.** `/agents` shows six roster cards with a role, a status dot and three example prompts. Tech's profile Overview lists its tools with `free` and `needs approval` badges.
- WSP-10 **⌘K palette.** It opens and jumps to `#sales`, and the URL changes to its chat.
- WSP-11 **E2E file between people.** In `qa <run> files` (Ana + Ben), Ana attaches `shipping-note.txt`. Ben downloads it and the bytes equal the fixture.

### Q8: Suite — memory, documents, citations, lessons, ask gate, forget, ask_user

`e2e/qa/suites/40-memory.spec.ts`, suite `memory`. Fixtures: `FACTS` and `CONTRACT` from `e2e/qa/fixtures/facts.ts`. Tech is the taught workspace agent. A setup `once` deletes Tech's knowledge items whose name equals a fixture file (left over from earlier runs) before teaching. **Cite-ok** for a reply R means: R matches the fact's `answer` regex, `meta.citations` contains an entry with `source_type` as specified and a title starting with the file name, and the UI shows a citation chip with that name. Record `cited` (true/false) as a note; do not assert it.
- MEM-01..03 **Teach TXT/DOCX/PDF on the Knowledge tab** (UI `teachDocument`, Ana): the list shows the file name and `Taught by <Ana>`.
- MEM-04 **Teach through the API.** `POST /api/agents/<tech>/knowledge` with `contract.txt` → 200 `KnowledgeItem`.
- MEM-05..07 **Ask about each document** (llm). In `#general`: `@Tech <question>` → Cite-ok with `source_type: "doc"`.
- MEM-08 **Citation chip opens the source.** Clicking the chip of MEM-05 opens the viewer (`/agents/<tech>?tab=knowledge&item=…`), and it shows `09:30`.
- MEM-09 **Chat file** (llm). In `qa <run> memory` (Ana, Ben, Tech), Ben attaches `shipping-note.txt`, then asks `@Tech <shipping question>` → Cite-ok with `source_type: "file"`.
- MEM-10 **Lesson** (llm). Ana adds the lesson `End every answer with the word Roger.` to Tech: it is listed with `taught by <Ana>`. The next `@Tech` answer ends with `roger` (case-insensitive). `finally`: delete the lesson.
- MEM-11 **Correction.** 👎 on the MEM-05 reply → `What should it have said?` → `The handover is at 09:30 sharp.` → the Knowledge tab lists a correction.
- MEM-12 **"What do you remember about…"** (llm). `@Tech what do you remember about the on-call rotation?` → the tools include `memory_recall` and ≥ 1 citation.
- MEM-13 **Note visibility** (llm).
  1. In the memory group, Ana sends `@Tech remember that the QA codename is <marker>`. The tools include `memory_remember`, and Ana's Knowledge tab lists a note.
  2. `qa.fresh("rares")`: Rareș is not in the group, and `GET /api/agents/<tech>/knowledge` as Rareș contains no item with the marker (LeakError).
- MEM-14 **Ask gate approve: private preview to the requester** (llm, timeout 900 s).
  1. `PUT /api/agents/<tech>/sharing {share_private_in_chats:"ask"}` as Ana.
  2. Ben in `#general`: `@Tech <handbook question>`.
  3. Within 240 s, Ben's EventTap gets `approval` with `tool: "share_answer"`, and the thread shows the notice `Tech prepared an answer that uses what <Ana> taught it. Waiting for <Ben> to approve.`
  4. Ana's tap gets no `approval` for that id within 10 s (LeakError), only `approval_public`.
  5. Neither NodeUser sees a message matching the fact before the decision (LeakError).
  6. Ben clicks `Approve and post`, and the answer posts with `meta.approved_by`.
  - `finally`: sharing back to `always`.
- MEM-15 **Ask gate deny** (llm). As MEM-14, but Ben denies (or Cancels, per the card). A retry answer posts in the thread with no `doc` citation of the handbook (LeakError if one is present).
- MEM-16 **`never`** (llm). Set sharing to `never` and ask Ben's question: no handbook `doc` citation and no fact (LeakError). `finally`: `always`.
- MEM-17 **`/forget` your own teaching** (llm). In Ana's Tech DM: `/forget the on-call rotation handover`. The expansion `@Tech forget the on-call rotation handover` is visible, the tools include `memory_forget`, and `handbook.txt` is gone from the Knowledge list within 30 s.
- MEM-18 **`/forget` someone else's teaching** (llm). Ben in his Tech DM: `/forget the north warehouse pallets`. Ana's tap gets `approval` with `tool: "memory_forget"` within 240 s, Ana approves, and `warehouse.docx` is gone. Re-teach it in `finally`.
- MEM-19 **`ask_user` card, requester-only** (llm).
  1. In `#release-7.4`, Ana sends `@Dev before you look anything up, use ask_user to ask me which branch to check, with the options main and release-7.4.`
  2. A Dev message with `meta.question.options` = [main, release-7.4] arrives.
  3. Ben's `POST /api/questions/:id/answer {option:1}` → 404 (LeakError if 2xx).
  4. Ana clicks `release-7.4`. `Answered by <Ana>: release-7.4` appears, followed by a new Dev reply in the thread.
- MEM-20 **Deleting a document removes it from recall** (llm). Delete `contract.txt` (Knowledge tab), then ask the contract question: no `contract.txt` citation and no `47` (LeakError).
- MEM-21 **Upload errors.** A `.bin` file → 415 `unsupported`, and an empty `.txt` → 422 `empty`.

### Q9: Suite — D-9 ACL cases a–f and D-13, end to end

`e2e/qa/suites/45-acl.spec.ts`, suite `acl`. Every negative assertion throws `LeakError`, and none of these checks is `llm: true` (no retry; a missing reply is a plain failure). Order in the file: ACL-01, 02 (b), 03 (a), 04 (c), 05 (d), 06 (f), 07 (e), 08, 09, 10, so the (e) answer, once posted, cannot contaminate the earlier cases. A personal agent can only be added by its owner when that owner also owns the chat, so the cases use these chats:
- **Project** = `qa <run> project`, owned by Ana, with Ben. Agents: `NoraQa` (Ana) and the workspace agent Dev as "another agent".
- **ProjectB** = `qa <run> project-b`, owned by Ben, with Ana. Agent: `MaxQa`.
- **OpsB** = `qa <run> ops-b`, owned by Ben, with Rareș. Agent: `MaxQa`.

Create personal agents with `POST /api/agents` (reuse by name; see Decisions), and teach Nora `nora-brief.txt` on her Knowledge tab as Ana.
- ACL-01 **Setup is visible.** The three agents exist. Nora's Knowledge lists `nora-brief.txt` taught by Ana. Project exists with Nora.
- ACL-02 **(b) An agent added after message M never gets M.** In Project, Ana posts `The parking code for the QA garage is 4417.`, and then Ana adds Dev. Ben asks `@Dev what is the parking code for the QA garage?`. The reply contains no `4417`, and no citation points at M.
- ACL-03 **(a) Another agent never returns Nora's chunks.** Ben asks `@Dev <nora question>` in Project. The reply does not match `23 percent`, and no citation has the title `nora-brief.txt`.
- ACL-04 **(c) Nothing crosses chats.** In ProjectB:
  - Ben sends `@MaxQa remember that the release codename is <marker>`;
  - Ana posts `The vendor hotline is 0700-<4 digits>`.

  In OpsB, Ben asks MaxQa for the codename and the vendor hotline. Neither appears, and no citation points into ProjectB.
- ACL-05 **(d) Agent namespaces stay apart, even in a DM.** In Ana's DM with `IrisQa`, the Nora question gets no `23 percent` and no `nora-brief.txt` citation.
- ACL-06 **(f) `never`.** Nora's sharing is set to `never`. Ben asks `@NoraQa <nora question>` in Project: no fact and no `doc` citation. `finally`: `always`.
- ACL-07 **(e) `ask` holds until the owner approves.**
  1. Set Nora's sharing to `ask`, and Ben asks the Nora question in Project.
  2. Ana's tap gets `approval` (`share_answer`), and Ben's tap gets no `approval` for it.
  3. The thread shows the held notice, and neither NodeUser sees a message matching `23 percent` before the decision.
  4. Ana approves, and the answer posts with `meta.approved_by`.
  - `finally`: `always`.
- ACL-08 **D-13.** In `qa <run> d13` (Ana, Rareș, Scribe), Ana sends `@Scribe remember that the offsite venue is <marker>`. Then in Ben's Scribe DM, `what is the offsite venue?` must not reveal the marker.
- ACL-09 **Ben cannot add Ana's personal agent.** `POST /api/chats/<a Ben-owned chat>/agents {agent_id: NoraQa}` → 403 or 404.
- ACL-10 **Ben cannot read Nora's knowledge.** `GET /api/agents/<nora>/knowledge` as Ben → 404.

### Q10: Suite — approvals: chat_send, email_send, notes_create, ticket_comment

`e2e/qa/suites/50-approvals.spec.ts`, suite `approvals`. Workspace agent ⇒ the requester approves (D-10). All prompts are planted, for example `@Scribe post this exact message in #general: "QA <marker> standup moves to 10:00"`. Ana's EventTap stays open for the whole suite. Card actions use the labels in `memory-approvals.spec.ts` (`Approve and send`, `Deny`, `Cancel`, `Always approve`, the editable field). The outbox is `$QA_ROOT/.run/outbox` (count `.eml` files before and after).
- APR-01 **chat_send approve** (llm). From `#release-7.4`:
  - Ana's tap gets `approval` (`chat_send`) within 240 s, the card is in the thread, and the top bar shows `1 action waiting for you` (or `N actions`).
  - Ana approves, and `#general` gets a Scribe message containing the marker with `meta.approved_by`.
  - The thread gets the stamp `Approved by <Ana> · chat_send`.
- APR-02 **Requester-only** (no retry once the approval exists). Ana makes a fresh chat_send request.
  - Ben's tap gets `approval_public` for that id and never `approval` (LeakError).
  - Ben's page shows `Waiting for <Ana>` and no approve button.
  - Ben's `POST /api/approvals/:id/decision {decision:"approve"}` → 404 (LeakError if 2xx).
  - Then Ana denies.
- APR-03 **chat_send deny** → `Declined by <Ana> · chat_send`, and `#general` has no marker after 10 s (LeakError).
- APR-04 **Edited args.** Approve with the text edited to `QA <marker2> edited`. The posted text contains marker2 and not the original marker.
- APR-05 **Cancel** (Sales `email_send`): `Canceled by <Ana> · email_send`, and no new `.eml`.
- APR-06 **email_send approve.** `@Sales save a short follow-up email to buyer@northwind.example confirming the 7.4 date.` → approve → exactly one new `.eml` whose headers contain `buyer@northwind.example`, and the stamp contains `Saved to the local outbox (nothing left this Mac)`.
- APR-07 **email_send deny** → no new `.eml` after 15 s, and the stamp `Declined by <Ana>`.
- APR-08 **notes_create approve** (Tech in `qa <run> notes`, Ana + Ben + Tech). `GET /api/chats/:id/notes` lists the title, and the Notes rail shows it.
- APR-09 **Always approve.** On a notes_create card, choose `Always approve`. The next notes_create executes at once with `Auto-approved for <Ana> · notes_create`, and `GET /api/approval-grants` lists it. The chat_send and email_send cards offer no `Always approve`. `finally`: `DELETE /api/approval-grants/<tech>/notes_create`.
- APR-10 **Expiry.** Make an email_send approval, then expire it with `psql("update sa.approvals set expires_at = now() - interval '1 second' where id = " + lit(id) + " and status = 'pending'")` (check the table name in `004`). Within 120 s the stamp starts with `Expired after` and `GET /api/approvals?status=all` shows `expired`. A decision after that → 409 `expired`.
- APR-11 **First decision wins.** Two concurrent `POST …/decision {approve}` from Ana's Api → exactly one 200 and one 409 `already_decided`, and exactly one stamp.
- APR-12 **ticket_comment** (Dev): `@Dev add a comment to the ticket for the E2E_CallReconnect flake saying "QA <marker> retest scheduled"` → approve → `GET ${opsSim}/sim/tickets/<id>` shows the comment.
- APR-13 **Actions log.** Ana's actions log (memory plan T13) lists the decisions of APR-01, 03 and 06.

### Q11: Suite — voice push-to-talk round trip and latency

`e2e/qa/suites/60-voice.spec.ts`, suite `voice`. A `once` prerequisite:
- audio-api `/healthz` answers;
- `espeak-ng` and `ffmpeg` are on PATH;
- `bash e2e/live/voice-fixtures.sh` has run in `$QA_ROOT`, writing `.run/fixtures/ask.webm` and `ana.wav`;
- `ffmpeg -y -i ask.webm -ar 48000 -ac 1 ask-48k.wav` has made the Chromium fake-capture file.

If any piece is missing, every VOX check `ctx.skip(<reason>)`.
- VOX-01 **Prerequisites** (records the tool versions; skips with the reason).
- VOX-02 **Push-to-talk in the UI** (llm).
  1. `qa.fresh("ana", { launchArgs: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--use-file-for-fake-audio-capture=<abs ask-48k.wav>"] })`.
  2. Open the Ops DM and hold the mic button for 4 s.
  3. A voice bubble with a duration appears, then `Transcript · on this Mac` containing `cluster` (case-insensitive).
  4. The Ops reply has a player (`audio` element), and the pill matches `/voice to voice \d/`.
  - Record the pill's seconds, plus `stt_ms`, `first_token_ms`, `first_audio_ms` and `total_ms` from `meta.latency` (via that persona's NodeUser).
- VOX-03 **Voice smoke through the API.** `pnpm --dir "$QA_ROOT" --filter @sa/e2e exec tsx live/voice-smoke.ts`, with exit code 0 required. Parse the per-run `stt / first token / first audio / total` lines into timings, and note `first_audio_ms < 2000 on fast: PASS|MISS` (a MISS is a note, not a failure).
- VOX-04 **Voice in a group that names no agent.** In `qa <run> voice` (Ana, Ben, Ops), Ana's NodeUser sends `ana.wav` as a voice file. No Ops reply arrives within `QUIET_MS`, and no transcript message either (LeakError).
- VOX-05 **Voice that names the agent in a group** (llm). Sending `ask.webm` (starts with "Ops, …") makes Ops answer in the group, with a transcript (`meta.transcript_of`).
- VOX-06 **One STT per voice message.** In a group with Ops and QA, one `ask.webm` produces exactly one transcript message within 60 s.
- VOX-07 **Voice events go only to the requester.** During VOX-05, Ana's tap gets `voice.chunk` and `latency.sample`, and Ben's tap gets neither (LeakError).

### Q12: Suite — meetings: consent, notetaker, summary approval, notification, reminder, re-publish

`e2e/qa/suites/70-meetings.spec.ts`, suite `meetings`. The mode comes from `run.json` `notetaker_mode`.
- `fake`: segments are posted by the harness to `/internal/calls/notetakers/:id/segments` with `X-Internal-Token: <$QA_ROOT/.run/meeting.token>`. The body shape is the one in `e2e/tests/call.spec.ts`, and the notetaker id comes from `GET /api/calls/:id`.
- `worker`: run `uv run sa-meeting synth` speakers as `e2e/live/call-smoke.ts` does, with the fixtures `ana.wav`, `vlad.wav` and `rares.wav`.

Sentences:
- Ana: `We agreed to move the delivery to the twentieth of March.`
- Ben: `I will send the confirmation email by Friday.`
- Rareș: `The secret budget is ninety thousand euros.`

Personas: Ana (inviter), Ben (accepts) and `qa.fresh("rares")` (declines). The group `qa <run> call` contains all three plus Scribe, and Ana adds Scribe in the UI.
- MTG-01 **Call card.** Ana starts a call, and the call card appears for Ben and Rareș, who join. In fake mode all three see `Call audio is off: the call server is not running on this Mac. Consent and notes still work.`
- MTG-02 **Consent.** Ana clicks `Add notetaker`, and Ben and Rareș see the banner naming Ana. Ben accepts, Rareș declines. The lists show Ana and Ben `captured` and Rareș `not captured`. Ana's own consent POST → 409 `inviter_always_consents`.
- MTG-03 **Decliners are never captured.**
  - Fake mode: Ana's and Ben's segments → 201, and their lines show on all three pages. Rareș's segment → 403 `not_consented` and shows nowhere (LeakError).
  - Worker mode: within 120 s there are ≥ 2 segments, only from {ana, vlad}, and nothing matching `ninety|budget` (LeakError).
- MTG-04 **Notes stay private.** `GET /api/calls/:id/notes` as Ben and as Rareș → 403 `notes_private`.
- MTG-05 **Anyone can stop the notes.** Rareș clicks `Stop notes`, and all pages show `<Rareș> stopped the notes.`
- MTG-06 **Summary approval goes to the inviter's DM** (llm, timeout 900 s).
  - Within 300 s, Ana's tap gets `approval` with `tool: "call_notes_publish"`, and its chat is Ana's DM with Scribe, not the call chat.
  - Ben's and Rareș's taps get neither `approval` nor `approval_public` for it (LeakError).
  - In Ana's DM, the card reads `Post call notes in #qa <run> call`.
  - The preview text contains `**Call notes**`, `## Summary`, `## Decisions`, `## Action items`, `## Open questions` and `Not captured: 1`, and does not match `ninety|budget` (LeakError).
- MTG-07 **Approve posts to the call thread.** After Ana approves, Scribe's reply lands in the call's thread (`reply_to` = the anchor), with `meta.meeting.call_id`, and all three see it.
- MTG-08 **Members are notified.** Ben's and Rareș's taps get `call.notes_published` for the chat, Ben's page shows the toast `Notes from … are ready`, and the group shows an unread mention in Ben's sidebar.
- MTG-09 **Asking about the call** (llm). Ben in the group: `@Scribe what did we decide in the call?`. The tools include `meeting_transcript`, and the text matches `/march|delivery/i`. Note any `source_type: "meeting"` citation.
- MTG-10 **The transcript stays with the inviter.** In Ben's DM, `@Scribe show me the transcript of the last call`: the `meeting_transcript` result in `meta.trace` holds no `transcript` lines (LeakError).
- MTG-11 **The inviter's DM has the transcript** (llm). In Ana's DM, the same question gets a `meta.trace` result with transcript lines.
- MTG-12 **Reminder, once** (timeout 600 s). A second call is set up with `once`: invite, segments, stop, then wait for the pending approval. Back-date the approval request for those notes by 20 h 1 min: find the column the reminder sweep in `plugins/calls.ts` compares, and use `psql` + `lit`. Within 120 s Ana's Scribe DM gets `…are still waiting for your approval…` with a `Review notes` button. A second back-date produces no second reminder within 120 s (LeakError).
- MTG-13 **Deny, then publish again.** Ana denies call 2's approval. Her DM gets `The notes from the call in #… were not published.` with `Publish notes again`. Clicking it brings a new approval card, Ana approves, and the notes post in call 2's thread.
- MTG-14 **Expiry.** A third call's approval is expired via `psql` (`expires_at` in the past). Within 120 s the `not_published` DM arrives, exactly once.
- MTG-15 **Only the inviter can re-publish.** Ben's `POST /api/calls/notes/:notesId/republish` → 403 or 404.
- MTG-16 **The call ends after the last person leaves.** All three leave, and within 60 s `GET /api/calls/:id` shows it ended. The card shows the end or the duration.
- MTG-17 **One call per chat.** A second `POST /api/chats/:id/calls` while one is active → 200 with the same call id.
- MTG-18 **(worker only) Stop is immediate.** After Stop, no new segment arrives later than 2 s. In fake mode: `ctx.skip("livekit-server is not installed (human step: brew install livekit)")`.
- MTG-19 **(worker only) Chat voice during a call.** One VOX-03-style voice round while the synth tracks play: record its latency. Skips like MTG-18.

### Q13: Suite — Google sign-in: off on the live stack, on with a fake provider

Files: `e2e/qa/suites/80-oidc.spec.ts` (suite `oidc`; side-stack checks also carry the tag `oidc-side`), `e2e/qa/oidc/fetch-shim.mjs`, `e2e/qa/oidc/side-stack.sh` and `e2e/qa/oidc/google-route.ts`.

**`e2e/qa/oidc/fetch-shim.mjs`** (complete):

```js
// QA only: answers the bridge's Google OIDC calls in process, so nothing leaves the Mac.
// Loaded with NODE_OPTIONS=--import=<this file> by e2e/qa/oidc/side-stack.sh.
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const LOG = process.env.QA_OIDC_SHIM_LOG;
const ISS = "https://accounts.google.com";
const DISCOVERY = "https://accounts.google.com/.well-known/openid-configuration";
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const HOSTS = new Set(["accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com"]);
const KID = "qa1";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
const realFetch = globalThis.fetch;

const b64u = (b) => Buffer.from(b).toString("base64url");
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function log(url) {
  if (!LOG) return;
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, `${JSON.stringify({ ts: Date.now(), url })}\n`);
}

function sign(claims) {
  const head = b64u(JSON.stringify({ alg: "RS256", kid: KID, typ: "JWT" }));
  const body = b64u(JSON.stringify(claims));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey);
  return `${head}.${body}.${b64u(sig)}`;
}

function token(init) {
  const raw = init?.body;
  const form = raw instanceof URLSearchParams ? raw : new URLSearchParams(String(raw ?? ""));
  let g;
  try {
    g = JSON.parse(Buffer.from(form.get("code") ?? "", "base64url").toString("utf8"));
  } catch {
    return json({ error: "invalid_grant" }, 400);
  }
  const challenge = createHash("sha256")
    .update(form.get("code_verifier") ?? "")
    .digest("base64url");
  if (challenge !== g.challenge) return json({ error: "invalid_grant", error_description: "pkce" }, 400);
  if (
    form.get("client_id") !== process.env.GOOGLE_CLIENT_ID ||
    form.get("client_secret") !== process.env.GOOGLE_CLIENT_SECRET
  )
    return json({ error: "invalid_client" }, 401);
  if (form.get("redirect_uri") !== g.redirect_uri) return json({ error: "invalid_grant" }, 400);
  const now = Math.floor(Date.now() / 1000);
  const id_token = sign({
    iss: ISS,
    aud: g.client_id,
    azp: g.client_id,
    sub: g.sub,
    email: g.email,
    email_verified: g.email_verified ?? true,
    name: g.name,
    hd: g.hd,
    nonce: g.nonce,
    iat: now,
    exp: now + 3600,
  });
  return json({ access_token: "qa-access", token_type: "Bearer", expires_in: 3600, id_token });
}

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    return realFetch(input, init);
  }
  if (!HOSTS.has(host)) return realFetch(input, init);
  const bare = url.split("?")[0];
  log(bare);
  if (bare === DISCOVERY)
    return json({
      issuer: ISS,
      authorization_endpoint: AUTH,
      token_endpoint: TOKEN,
      jwks_uri: JWKS,
      id_token_signing_alg_values_supported: ["RS256"],
    });
  if (bare === JWKS) return json({ keys: [jwk] });
  if (bare === TOKEN && String(init?.method ?? "GET").toUpperCase() === "POST") return token(init);
  return json({ error: "not_found" }, 404);
};
```

**`e2e/qa/oidc/google-route.ts`** (complete):

```ts
import type { BrowserContext } from "@playwright/test";

export type GoogleUser = {
  sub: string;
  email: string;
  name?: string;
  hd?: string;
  email_verified?: boolean;
};
export type GoogleChoice = GoogleUser | "cancel";

/** Fakes Google's consent step in the browser. The code carries the grant to the bridge's fetch shim. */
export async function routeGoogle(context: BrowserContext, pick: () => GoogleChoice): Promise<void> {
  // Later routes win, so the catch-all abort goes first.
  await context.route(/^https:\/\/([a-z0-9-]+\.)*(google|googleapis|gstatic)\.com\//, (r) => r.abort());
  await context.route("https://accounts.google.com/**", async (route) => {
    const u = new URL(route.request().url());
    const redirect = u.searchParams.get("redirect_uri") ?? "";
    const back = new URL(redirect);
    back.searchParams.set("state", u.searchParams.get("state") ?? "");
    const choice = pick();
    if (choice === "cancel") back.searchParams.set("error", "access_denied");
    else {
      const grant = {
        ...choice,
        nonce: u.searchParams.get("nonce"),
        challenge: u.searchParams.get("code_challenge"),
        redirect_uri: redirect,
        client_id: u.searchParams.get("client_id"),
      };
      back.searchParams.set("code", Buffer.from(JSON.stringify(grant)).toString("base64url"));
    }
    await route.fulfill({ status: 302, headers: { location: back.toString() } });
  });
}
```

**`e2e/qa/oidc/side-stack.sh`** (complete; foreground, and the spec spawns and kills it as a process group):

```bash
#!/usr/bin/env bash
# QA side stack with Google sign-in on and a fake provider: relay :8668, ops-sim :8669,
# bridge :8667 (pglite, echo runtime), web :5193. Foreground; kill the process group to stop.
set -euo pipefail
cd "$(dirname "$0")/../../.."
RUN="$PWD/.run/qa-oidc"
SHIM="$PWD/e2e/qa/oidc/fetch-shim.mjs"
rm -rf "$RUN"
mkdir -p "$RUN"
trap 'kill 0' EXIT

PORT=8668 RELAY_DB="$RUN/relay.sqlite" RELAY_ADMIN_TOKEN=qa-oidc-token \
  pnpm --filter @sa/relay start >"$RUN/relay.log" 2>&1 &
PORT=8669 pnpm --filter @sa/ops-sim start >"$RUN/ops-sim.log" 2>&1 &

export DATABASE_URL="pglite://$RUN/pg" PORT=8667
export RELAY_INTERNAL_URL=http://127.0.0.1:8668 RELAY_ADMIN_TOKEN=qa-oidc-token
export AGENT_RUNTIME=echo BRIDGE_MASTER_KEY=qa-oidc-master OPS_SIM_URL=http://127.0.0.1:8669
export SA_DEMO_PINS=ana:111111,vlad:222222,rares:333333,janosch:444444
export SA_DEMO_EMAILS=ana:ana@example.com
export SA_FORCE_FIRST_TOOL=0 SA_NOTETAKER=off LIVEKIT_URL=ws://127.0.0.1:9
export LIVEKIT_API_SECRET=qa-oidc-livekit-secret-0123456789abcdef0123 MEETING_TOKEN=qa-oidc-meeting
unset MEMORY_TOKEN MEMORY_URL AUDIO_URL AUDIO_TOKEN
export GOOGLE_CLIENT_ID=qa-cid GOOGLE_CLIENT_SECRET=qa-csec PUBLIC_BASE_URL=http://127.0.0.1:5193
export AUTH_ALLOWED_EMAILS=ana@example.com,newcomer@example.com AUTH_ALLOWED_DOMAINS=corp.example
export QA_OIDC_SHIM_LOG="$RUN/shim-calls.jsonl"

pnpm --filter @sa/bridge run migrate
# seed writes .run/demo-pins.txt; keep the developer's demo PINs byte-identical
PINS=.run/demo-pins.txt
if [[ -f $PINS ]]; then cp "$PINS" "$RUN/demo-pins.bak"; fi
pnpm --filter @sa/bridge run seed >/dev/null
if [[ -f $RUN/demo-pins.bak ]]; then mv "$RUN/demo-pins.bak" "$PINS"; else rm -f "$PINS"; fi

NODE_OPTIONS="--import=$SHIM" pnpm --filter @sa/bridge run start >"$RUN/bridge.log" 2>&1 &
SA_WEB_PORT=5193 SA_BRIDGE_URL=http://127.0.0.1:8667 SA_RELAY_URL=http://127.0.0.1:8668 \
  pnpm --filter @sa/web dev >"$RUN/web.log" 2>&1 &
wait
```

**The spec.**
- `beforeAll` for the `oidc-side` checks:
  - spawn `bash e2e/qa/oidc/side-stack.sh` with `detached: true`;
  - wait for `http://127.0.0.1:8667/api/healthz`, `http://127.0.0.1:8668/relay/healthz` and `http://127.0.0.1:5193` (120 s);
  - store `sha256` of `$HARNESS_ROOT/.run/demo-pins.txt` (or "absent").
- `afterAll`: `process.kill(-pid, "SIGTERM")`, then assert the PIN file hash is unchanged.
- Side-stack pages are new contexts on `browser` with `routeGoogle`, registered for screenshots via `qa.track`. The `pick` variable is set per check. Side-stack PINs are `ana:111111` and the others from the script.
- OID-01 **(live stack) Google is off.**
  - `GET /api/auth/providers` → `{pin:true, oidc:[]}`;
  - `GET /api/auth/oidc/google/start` → 404;
  - the login page has no `Sign in with Google` and shows the usual trust line;
  - `/presenter` has no `Google sign-in on`.

  If the providers list Google (`.env` sets it), note "Google enabled in .env" and assert the D-14 copy instead.
- OID-02 **(side) No egress at boot.** After the side stack is healthy and before any sign-in, `shim-calls.jsonl` is absent or empty.
- OID-03 **(side) The D-14 copy.** The login page shows `Sign in with Google` and `Sign-in uses Google · chats and AI stay on this Mac`, and `/presenter` shows `Google sign-in on`.
- OID-04 **(side) A newcomer gets the seeded workspace.**
  1. pick `{sub:"qa-new-<run>", email:"newcomer@example.com", name:"Newcomer QA"}`, then click the button.
  2. No navigated URL has a `token` or `sa_login` in its **query** (record with `page.on("framenavigated")`).
  3. The page lands on `/welcome`; Get started.
  4. `#general` shows a seeded line within 30 s.
- OID-05 **(side) Linking.** `ana@example.com` signs in as Ana: `GET /api/me` has id `ana`.
- OID-06 **(side) Not allowed.** `out@example.org` → the `not_allowed` error copy, and the user count in `GET /api/users` (PIN session) is unchanged.
- OID-07 **(side) Domain rule needs `hd`.** `lee@corp.example` without `hd` → not allowed; with `hd:"corp.example"` → signed in.
- OID-08 **(side) Cancel.** pick `"cancel"` → the cancelled error copy and no session.
- OID-09 **(side) One-time code.** Capture the `#sa_login=<code>` fragment from `framenavigated`. After the SPA has used it, `POST http://127.0.0.1:8667/api/auth/oidc/exchange {code}` → 401.
- OID-10 **(side) Unverified email.** `email_verified:false` → error copy, no session.
- OID-11 **(side) PIN still works.** PIN login as `ana` / `111111` on the side web succeeds while Google is on.

### Q14: Suite — privacy: relay ciphertext, logs, metrics, egress, memory headroom

`e2e/qa/suites/90-privacy.spec.ts`, suite `privacy`. It runs last. "Markers" = every line of `.handoff/qa/markers.txt`.
- PRV-01 **The relay view shows ciphertext only.** In `#general`, Ana opens the Relay rail (`openRail(page,"relay")`). It has ≥ 1 row, and its text contains no marker and no known seeded line (LeakError).
- PRV-02 **The relay store holds no plaintext.** The bytes of `$QA_ROOT/.run/relay.sqlite`, `-wal` and `-shm` contain no marker (`Buffer.indexOf`, utf8). Report the file and hit count only, never the content (LeakError).
- PRV-03 **Logs hold no plaintext.** Every `*.log` under `$QA_ROOT/.run/` (recursive: `agents/`, `notetakers/`, `qa-dev.log`, `qa-oidc/`) and `$HARNESS_ROOT/.run/qa-oidc/` contains no marker. Report the file and line numbers only (LeakError).
- PRV-04 **Turn metrics hold ids and timings only.** `rows()` of `sa.turn_metrics` since `run.started_at` (column names from `003`): no field value contains a marker (LeakError). Record p50/p95 of trigger→👀, →first token and →done as timings `metrics_eyes_ms`, `metrics_first_token_ms` and `metrics_done_ms`.
- PRV-05 **Zero egress.** `egress.jsonl` since the run start has ≥ 1 sample per 10 min, 0 offending connections and no sampler `error`.
- PRV-06 **Memory headroom.** Run `bash e2e/qa/stack.sh mem`, then compare the first and last lines of `memory.jsonl`: swap growth ≤ 1024 MB, compressor growth ≤ 2 GiB (pages × 16384) and gateway RSS ≤ 2.5 GiB.
- PRV-07 **Run facts.** `run.json` has `prefix_cache_off: true` and a non-empty `model`.
- PRV-08 **Loopback-only listeners.** `lsof -nP -iTCP -sTCP:LISTEN` for ports 5173, 8000, 8645–8649 and 7880: every listener binds 127.0.0.1 or ::1.

### Q15: Live part 1 — start the stack; harness, roster, proactive, workspace

Runs from the task's worktree. The stack runs from the main checkout (Decisions).
1. `bash e2e/qa/stack.sh up` (it frees only the T21-allowed ports). On failure, read `$QA_ROOT/.run/qa-dev.log` and stop with NEEDS_CONTEXT if the cause is outside the harness (missing models, Docker down).
2. `pnpm --filter @sa/e2e exec playwright test -c qa/playwright.qa.config.ts --grep "@harness|@roster|@proactive|@workspace"` (expect about 110 min).
3. For each failure, read its result JSON and screenshots and decide:
   - **Harness bug** (wrong selector or label that exists differently in `apps/web/src`, a wrong body shape, a wrong wait): fix it in `e2e/qa/**` and rerun those ids with `QA_RESUME=1 … --grep "\b(ID1|ID2)\b"`. At most two fix rounds per suite.
   - **Product behaviour** that differs from the plans' Decisions: leave it failing. Never edit product code or anything in `$QA_ROOT`. `make dev` uses `tsx watch`, so an edit there would restart the bridge mid-run.
4. Leave the stack **up** for Q16.
5. Hand over the counts printed by `qa:verify` and the list of harness fixes made.

### Q16: Live part 2 — memory, ACL, approvals

1. `bash e2e/qa/stack.sh status`; if it reports down, `bash e2e/qa/stack.sh up` and note the gap.
2. `QA_RESUME=1 pnpm --filter @sa/e2e exec playwright test -c qa/playwright.qa.config.ts --grep "@memory|@acl|@approvals"` (about 90 min). **`QA_RESUME=1` is mandatory**: without it, global setup archives part 1.
3. Same failure rules as Q15. Leave the stack up.

### Q17: Live part 3 — voice, meetings, OIDC, privacy; stop the stack

1. Check status as in Q16.
2. `QA_RESUME=1 pnpm --filter @sa/e2e exec playwright test -c qa/playwright.qa.config.ts --grep "@voice|@meetings|@oidc|@privacy"` (about 70 min).
3. Same failure rules. The privacy suite must run after the others in this part (file order guarantees it).
4. `bash e2e/qa/stack.sh down`.
5. `pnpm --filter @sa/e2e run qa:verify` must pass for the **whole** run, so every check has a result. Hand over the report's summary table.

### Q18: Triage — issue list with repro steps

Write `docs/qa/2026-10-25-qa-issues.md` from `$QA_ROOT/.handoff/qa/report.md`, the run log `docs/qa/2026-10-25-qa-run-log.md`, `results/*.json`, the screenshots (open them), `run.json`, and the logs around each failure's `started_at` (ids and error codes only). Classify each failure as one of:
- `product`: the behaviour differs from a Decision in one of the four plans; quote the plan and the bullet;
- `harness`: the check is wrong;
- `environment`: a missing tool or model;
- `spec`: the plans are ambiguous or contradictory.

Group failures that share one root cause into one issue. Severity:
- **blocker**: a leak (any `LeakError`), an ACL/D-3/D-9 violation, an action executed without a decision, data loss, or egress > 0;
- **major**: a feature or flow does not work;
- **minor**: copy, timing over target, cosmetic.

Format, numbered from QA-001:

```markdown
## QA-001 <one-line title>
- severity: blocker · class: product · checks: MEM-14, MEM-15 · run: qa-…
- expected: <behaviour> (memory-approvals plan, Decisions, "The ask gate …")
- actual: <what the results show>
- repro:
  1. <persona> signs in; opens <chat>
  2. sends `<exact prompt>`
  3. …
- evidence: `.handoff/qa/results/MEM-14-ben.png`; qa-dev.log lines with ids only
- suspected area: `services/bridge/src/approvals/share-gate.ts` (why)
- re-check: `QA_RESUME=1 pnpm --filter @sa/e2e exec playwright test -c qa/playwright.qa.config.ts --grep "\b(MEM-14|MEM-15)\b"`
```

End with these sections:
- `## Flaky` (pass after retry, with the note);
- `## Skipped` (reason; environment items name the human step);
- `## Timing vs targets` (👀 ≤ 1 s, voice-to-voice < 2 s on fast, LLM reply p50/p95);
- `## Harness fixes made during the run` (from the run log `docs/qa/2026-10-25-qa-run-log.md`).

Use scout subagents to locate suspected areas. Do not edit code. No absolute paths and no client names; content is fictional.

### Q19: Fix-loop scaffold — the follow-up relay plan

Write `docs/relay/plans/2026-10-26-qa-fixes.md` in plan-with-tiers format (same conventions as this plan and `2026-10-24-agent-teammates.md`) from the issue list:
- one task per **blocker** or **major** `product` issue. Each task's `files` are the suspected area (scout to confirm). Each adds an offline regression test (echo runtime/fakes, as in the original plan's tests), and its `done` is that test plus a typecheck of the package.
- one task for all **minor** product issues that share a package; others get one task each.
- one task `harness` for the `harness` issues, with files in `e2e/qa/**`.
- a last task `Live re-verify` that depends on all the others. It runs `bash e2e/qa/stack.sh up`, `pnpm --filter @sa/e2e run qa:failed` and `bash e2e/qa/stack.sh down`, and its done is `pnpm --filter @sa/e2e run qa:verify`.
- `spec` and `environment` issues are listed under "Before the run (human)" as decisions or steps, not tasks.
- With no issues, the plan holds only the re-verify task.

Validate with `relay lanes` and fix every error.

```relay-plan
{
  "slug": "sa-qa-two-users",
  "suite": "make check",
  "setup": "pnpm install --frozen-lockfile && uv sync",
  "tasks": [
    {
      "id": "Q1",
      "title": "Harness core: config, scripts, env, types, report, verify, rerun",
      "tier": "cheap",
      "code": "complete",
      "risk": "low",
      "files": [
        "e2e/package.json",
        "e2e/tsconfig.json",
        "Makefile",
        ".gitignore",
        "e2e/qa/playwright.qa.config.ts",
        "e2e/qa/lib/types.ts",
        "e2e/qa/lib/env.ts",
        "e2e/qa/lib/db.ts",
        "e2e/qa/lib/report.ts",
        "e2e/qa/lib/report.selftest.ts",
        "e2e/qa/lib/verify-run.ts",
        "e2e/qa/lib/rerun-failed.ts",
        "e2e/qa/lib/global-setup.ts",
        "e2e/qa/lib/global-teardown.ts"
      ],
      "deps": [],
      "behaviors": [
        "results and the report go to the main checkout's .handoff/qa even from a worktree",
        "report.md summarises per suite, matrix, failures with repro, skips, flaky, timings, egress, memory",
        "verify-run fails when any listed check lacks a result for the run",
        "QA_PREFLIGHT=0 skips the live preflight; QA_RESUME=1 keeps the run id"
      ],
      "tests": 1,
      "done": "pnpm --filter @sa/e2e typecheck && pnpm --filter @sa/e2e run qa:selftest"
    },
    {
      "id": "Q2",
      "title": "Harness personas: API, Node device, UI helpers, check(), harness suite",
      "tier": "mid",
      "code": "prose",
      "risk": "low",
      "files": [
        "e2e/qa/lib/api.ts",
        "e2e/qa/lib/node-device.ts",
        "e2e/qa/lib/ui.ts",
        "e2e/qa/lib/fixtures.ts",
        "e2e/qa/lib/check.ts",
        "e2e/qa/lib/errors.ts",
        "e2e/qa/suites/00-harness.spec.ts"
      ],
      "deps": [
        "Q1"
      ],
      "behaviors": [
        "each persona has a browser session, an API session with an event stream, and a decrypting Node device",
        "check() records result, timings, repro steps and screenshots; LLM checks retry once; leaks never retry",
        "two users exchange an E2E message through the live stack"
      ],
      "tests": 3,
      "done": "pnpm --filter @sa/e2e typecheck && QA_PREFLIGHT=0 pnpm --filter @sa/e2e exec playwright test -c qa/playwright.qa.config.ts --list --grep @harness | grep -cE 'HAR-[0-9]{2}' | awk '{exit !($1 >= 3)}'"
    },
    {
      "id": "Q3",
      "title": "Document fixtures and the extraction check",
      "tier": "cheap",
      "code": "complete",
      "risk": "low",
      "files": [
        "e2e/qa/fixtures/make_fixtures.py",
        "e2e/qa/fixtures/facts.ts",
        "e2e/qa/fixtures/handbook.txt",
        "e2e/qa/fixtures/warehouse.docx",
        "e2e/qa/fixtures/recovery.pdf",
        "e2e/qa/fixtures/nora-brief.txt",
        "e2e/qa/fixtures/shipping-note.txt",
        "services/bridge/test/qa-fixtures.test.ts"
      ],
      "deps": [],
      "behaviors": [
        "each fixture carries one fictional fact that the bridge extractor reads back"
      ],
      "tests": 1,
      "done": "uv run python -I e2e/qa/fixtures/make_fixtures.py --check && uv run ruff check e2e/qa/fixtures && pnpm --filter @sa/bridge exec vitest run test/qa-fixtures.test.ts"
    },
    {
      "id": "Q4",
      "title": "Live stack script and egress sampler",
      "tier": "cheap",
      "code": "complete",
      "risk": "low",
      "files": [
        "e2e/qa/stack.sh",
        "e2e/qa/egress_sampler.py"
      ],
      "deps": [],
      "behaviors": [
        "stack.sh starts make up + make dev from the main checkout with the QA env and waits for every service",
        "the sampler records non-loopback connections of the stack's processes every 5 s"
      ],
      "tests": 0,
      "done": "bash -n e2e/qa/stack.sh && uv run ruff check e2e/qa/egress_sampler.py && uv run ruff format --check e2e/qa/egress_sampler.py && uv run --group live python -I e2e/qa/egress_sampler.py --once --run-dir .run --out - | grep -q offending"
    },
    {
      "id": "Q5",
      "title": "Suite: roster agents x invocation modes",
      "tier": "mid",
      "code": "prose",
      "risk": "low",
      "files": [
        "e2e/qa/suites/10-roster.spec.ts"
      ],
      "deps": [
        "Q2"
      ],
      "behaviors": [
        "every roster agent answers a tag, a thread follow-up and a DM with honest receipts",
        "slash commands, Ask an agent, /access, Stop, the queue, join intros, removal and feedback work for two users"
      ],
      "tests": 37,
      "done": "pnpm --filter @sa/e2e typecheck && QA_PREFLIGHT=0 pnpm --filter @sa/e2e exec playwright test -c qa/playwright.qa.config.ts --list --grep @roster | grep -cE 'ROS-[0-9]{2}' | awk '{exit !($1 >= 37)}'"
    },
    {
      "id": "Q6",
      "title": "Suite: proactive alert watch, catch-up, routines, pause",
      "tier": "mid",
      "code": "prose",
      "risk": "low",
      "files": [
        "e2e/qa/suites/20-proactive.spec.ts"
      ],
      "deps": [
        "Q2"
      ],
      "behaviors": [
        "an alert posts once in #ops and not while paused",
        "catch-up fires on the first hello of the day, respects pause_all and D-9 scope",
        "routines fire at their slot and not when paused; only owners change them"
      ],
      "tests": 13,
      "done": "pnpm --filter @sa/e2e typecheck && QA_PREFLIGHT=0 pnpm --filter @sa/e2e exec playwright test -c qa/playwright.qa.config.ts --list --grep @proactive | grep -cE 'PRO-[0-9]{2}' | awk '{exit !($1 >= 13)}'"
    },
    {
      "id": "Q7",
      "title": "Suite: seeded workspace, D-12 late joiner, directory, palette",
      "tier": "mid",
      "code": "prose",
      "risk": "low",
      "files": [
        "e2e/qa/suites/30-workspace.spec.ts"
      ],
      "deps": [
        "Q2"
      ],
      "behaviors": [
        "a late joiner's new device gets seeded history but not messages between the window and its join",
        "seeded rooms, labels, rails, directory and palette render for both users"
      ],
      "tests": 11,
      "done": "pnpm --filter @sa/e2e typecheck && QA_PREFLIGHT=0 pnpm --filter @sa/e2e exec playwright test -c qa/playwright.qa.config.ts --list --grep @workspace | grep -cE 'WSP-[0-9]{2}' | awk '{exit !($1 >= 11)}'"
    },
    {
      "id": "Q8",
      "title": "Suite: memory, documents, citations, lessons, ask gate, forget, ask_user",
      "tier": "mid",
      "code": "prose",
      "risk": "low",
      "files": [
        "e2e/qa/suites/40-memory.spec.ts"
      ],
      "deps": [
        "Q2",
        "Q3"
      ],
      "behaviors": [
        "taught PDF, DOCX and TXT documents are recalled with citation chips",
        "the ask gate sends a private preview to the requester and leaks nothing before approval",
        "/forget deletes own teaching at once and asks the teacher otherwise; ask_user is requester-only"
      ],
      "tests": 21,
      "done": "pnpm --filter @sa/e2e typecheck && QA_PREFLIGHT=0 pnpm --filter @sa/e2e exec playwright test -c qa/playwright.qa.config.ts --list --grep @memory | grep -cE 'MEM-[0-9]{2}' | awk '{exit !($1 >= 21)}'"
    },
    {
      "id": "Q9",
      "title": "Suite: D-9 ACL cases a-f and D-13 end to end",
      "tier": "mid",
      "code": "prose",
      "risk": "low",
      "files": [
        "e2e/qa/suites/45-acl.spec.ts"
      ],
      "deps": [
        "Q2",
        "Q3"
      ],
      "behaviors": [
        "D-9 cases a-f and D-13 hold with the real LLM and two users; any leak fails without retry"
      ],
      "tests": 10,
      "done": "pnpm --filter @sa/e2e typecheck && QA_PREFLIGHT=0 pnpm --filter @sa/e2e exec playwright test -c qa/playwright.qa.config.ts --list --grep @acl | grep -cE 'ACL-[0-9]{2}' | awk '{exit !($1 >= 10)}'"
    },
    {
      "id": "Q10",
      "title": "Suite: approvals for chat_send, email_send, notes_create, ticket_comment",
      "tier": "mid",
      "code": "prose",
      "risk": "low",
      "files": [
        "e2e/qa/suites/50-approvals.spec.ts"
      ],
      "deps": [
        "Q2"
      ],
      "behaviors": [
        "approve, deny, cancel, edit and expiry behave per the state machine with stamps",
        "only the requester sees and decides the card; first decision wins; grants only where allowed"
      ],
      "tests": 13,
      "done": "pnpm --filter @sa/e2e typecheck && QA_PREFLIGHT=0 pnpm --filter @sa/e2e exec playwright test -c qa/playwright.qa.config.ts --list --grep @approvals | grep -cE 'APR-[0-9]{2}' | awk '{exit !($1 >= 13)}'"
    },
    {
      "id": "Q11",
      "title": "Suite: voice push-to-talk round trip and latency",
      "tier": "mid",
      "code": "prose",
      "risk": "low",
      "files": [
        "e2e/qa/suites/60-voice.spec.ts"
      ],
      "deps": [
        "Q2"
      ],
      "behaviors": [
        "push-to-talk gets a transcript, a spoken reply and a latency pill; voice events reach only the requester"
      ],
      "tests": 7,
      "done": "pnpm --filter @sa/e2e typecheck && QA_PREFLIGHT=0 pnpm --filter @sa/e2e exec playwright test -c qa/playwright.qa.config.ts --list --grep @voice | grep -cE 'VOX-[0-9]{2}' | awk '{exit !($1 >= 7)}'"
    },
    {
      "id": "Q12",
      "title": "Suite: meetings consent, notetaker, summary approval, notification, reminder, re-publish",
      "tier": "mid",
      "code": "prose",
      "risk": "low",
      "files": [
        "e2e/qa/suites/70-meetings.spec.ts"
      ],
      "deps": [
        "Q2"
      ],
      "behaviors": [
        "decliners are never captured and notes stay with the inviter until approval",
        "approved notes post in the call thread and notify members; reminder once; publish again works for the inviter only",
        "audio-only checks skip cleanly without livekit-server"
      ],
      "tests": 19,
      "done": "pnpm --filter @sa/e2e typecheck && QA_PREFLIGHT=0 pnpm --filter @sa/e2e exec playwright test -c qa/playwright.qa.config.ts --list --grep @meetings | grep -cE 'MTG-[0-9]{2}' | awk '{exit !($1 >= 19)}'"
    },
    {
      "id": "Q13",
      "title": "Suite: Google sign-in off on the live stack, on with a fake provider",
      "tier": "mid",
      "code": "prose",
      "risk": "low",
      "files": [
        "e2e/qa/suites/80-oidc.spec.ts",
        "e2e/qa/oidc/fetch-shim.mjs",
        "e2e/qa/oidc/google-route.ts",
        "e2e/qa/oidc/side-stack.sh"
      ],
      "deps": [
        "Q2"
      ],
      "behaviors": [
        "with Google off there is no route, button or egress",
        "with the fake provider: newcomer gets seeded rooms, linking, allowlist and hd rules, cancel, one-time code",
        "no request reaches Google and the developer's PIN file is untouched"
      ],
      "tests": 11,
      "done": "pnpm --filter @sa/e2e typecheck && bash -n e2e/qa/oidc/side-stack.sh && QA_PREFLIGHT=0 pnpm --filter @sa/e2e exec playwright test -c qa/playwright.qa.config.ts --grep @oidc-side"
    },
    {
      "id": "Q14",
      "title": "Suite: privacy, relay ciphertext, logs, metrics, egress, memory headroom",
      "tier": "mid",
      "code": "prose",
      "risk": "low",
      "files": [
        "e2e/qa/suites/90-privacy.spec.ts"
      ],
      "deps": [
        "Q2"
      ],
      "behaviors": [
        "no planted text appears in the relay view, relay store, logs or turn metrics",
        "zero non-loopback connections and memory within the T21 thresholds"
      ],
      "tests": 8,
      "done": "pnpm --filter @sa/e2e typecheck && QA_PREFLIGHT=0 pnpm --filter @sa/e2e exec playwright test -c qa/playwright.qa.config.ts --list --grep @privacy | grep -cE 'PRV-[0-9]{2}' | awk '{exit !($1 >= 8)}'"
    },
    {
      "id": "Q15",
      "title": "Live part 1: start the stack; harness, roster, proactive, workspace",
      "tier": "mid",
      "code": "prose",
      "risk": "medium",
      "files": [
        "docs/qa/2026-10-25-qa-run-log.md"
      ],
      "deps": [
        "Q4",
        "Q5",
        "Q6",
        "Q7",
        "Q8",
        "Q9",
        "Q10",
        "Q11",
        "Q12",
        "Q13",
        "Q14"
      ],
      "behaviors": [
        "the first live part runs on one stack and every check records a result"
      ],
      "tests": 0,
      "done": "pnpm --filter @sa/e2e exec tsx qa/lib/verify-run.ts --grep '@harness|@roster|@proactive|@workspace'"
    },
    {
      "id": "Q16",
      "title": "Live part 2: memory, ACL, approvals",
      "tier": "mid",
      "code": "prose",
      "risk": "medium",
      "files": [
        "docs/qa/2026-10-25-qa-run-log.md"
      ],
      "deps": [
        "Q15"
      ],
      "behaviors": [
        "the second live part runs on the same stack and run id"
      ],
      "tests": 0,
      "done": "pnpm --filter @sa/e2e exec tsx qa/lib/verify-run.ts --grep '@memory|@acl|@approvals'"
    },
    {
      "id": "Q17",
      "title": "Live part 3: voice, meetings, OIDC, privacy; stop the stack",
      "tier": "mid",
      "code": "prose",
      "risk": "medium",
      "files": [
        "docs/qa/2026-10-25-qa-run-log.md"
      ],
      "deps": [
        "Q16"
      ],
      "behaviors": [
        "the last live part runs, the stack stops, and the whole run has a result for every check"
      ],
      "tests": 0,
      "done": "pnpm --filter @sa/e2e run qa:verify"
    },
    {
      "id": "Q18",
      "title": "Triage: issue list with repro steps",
      "tier": "strong",
      "code": "prose",
      "risk": "low",
      "files": [
        "docs/qa/2026-10-25-qa-issues.md"
      ],
      "deps": [
        "Q17"
      ],
      "behaviors": [
        "every failed check maps to a classified, severity-ranked issue with repro steps and a re-check command"
      ],
      "tests": 0,
      "done": "test -s docs/qa/2026-10-25-qa-issues.md && ! git grep -inE 'real[t]yme|gate[x]' && ! grep -nE '/Users/|/home/' docs/qa/2026-10-25-qa-issues.md"
    },
    {
      "id": "Q19",
      "title": "Fix-loop scaffold: the follow-up relay plan",
      "tier": "mid",
      "code": "prose",
      "risk": "low",
      "files": [
        "docs/relay/plans/2026-10-26-qa-fixes.md"
      ],
      "deps": [
        "Q18"
      ],
      "behaviors": [
        "each blocker or major product issue becomes a tiered task with a regression test, ending in a live re-verify"
      ],
      "tests": 0,
      "done": "${RELAY_BIN:-relay} lanes docs/relay/plans/2026-10-26-qa-fixes.md"
    }
  ]
}
```
