import type { PluginContext } from "../plugin-api.js";

const ROW_ID = "alert-watch";
const EVERY_MS = 60_000;

type SimAlert = { id?: string; at: string; severity: string; node: string; message: string };

const alertKey = (a: SimAlert) => a.id ?? `${a.node}:${a.message}`;

async function fetchAlerts(ctx: PluginContext): Promise<SimAlert[] | null> {
  try {
    const res = await fetch(`${ctx.opsSimUrl}/sim/alerts?hours=1`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = (await res.json()) as { alerts?: SimAlert[] };
    return (body.alerts ?? []).filter((a) => a.severity === "warning" || a.severity === "critical");
  } catch (e) {
    ctx.log("alert watch: sim unavailable", { error: (e as Error).message });
    return null;
  }
}

export async function startAlertWatch(
  ctx: PluginContext,
): Promise<{ tick(): Promise<void>; stop(): void }> {
  const { db } = ctx;
  let ready = false;
  let busy = false;

  const ensure = async (): Promise<boolean> => {
    const [ops] = await db.query<{ id: string }>(
      "select id from sa.agents where roster_id = 'ops' and scope = 'workspace'",
    );
    const [room] = await db.query<{ id: string }>("select id from sa.chats where seed_key = 'ops'");
    if (!ops || !room) return false;
    // no baseline without a sim answer: retry next tick and post nothing meanwhile
    const alerts = await fetchAlerts(ctx);
    if (!alerts) return false;
    await db.query(
      `insert into sa.routines (id, kind, agent_id, chat_id, prompt)
       values ($1, 'alert_watch', $2, $3, 'Watch alerts') on conflict (id) do nothing`,
      [ROW_ID, ops.id, room.id],
    );
    for (const a of alerts) {
      await db.query(
        `insert into sa.alert_posts values ($1, now())
         on conflict (alert_key) do update set posted_at = now()`,
        [alertKey(a)],
      );
    }
    return true;
  };

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      if (!ready) {
        ready = await ensure();
        return;
      }
      const [row] = await db.query<{ agent_id: string; chat_id: string; paused: boolean }>(
        "select agent_id, chat_id, paused from sa.routines where id = $1",
        [ROW_ID],
      );
      if (!row || row.paused) return;
      const alerts = await fetchAlerts(ctx);
      for (const a of alerts ?? []) {
        const claimed = await db.query(
          `insert into sa.alert_posts values ($1, now())
           on conflict (alert_key) do update set posted_at = now()
             where sa.alert_posts.posted_at < now() - interval '1 hour'
           returning alert_key`,
          [alertKey(a)],
        );
        if (claimed.length === 0) continue;
        ctx.log("alert watch: posting", { node: a.node, severity: a.severity });
        await ctx.agentHost.runProactive?.({
          agentId: row.agent_id,
          chatId: row.chat_id,
          prompt: `The monitoring system raised an alert: [${a.severity}] ${a.node}: ${a.message} at ${a.at}. Diagnose it with your tools and post one short message: what is happening, the evidence, the next action.`,
          kind: "alert",
        });
      }
    } catch (e) {
      ctx.log("alert watch tick failed", { error: (e as Error).message });
    } finally {
      busy = false;
    }
  };

  ready = await ensure().catch((e) => {
    ctx.log("alert watch init failed", { error: (e as Error).message });
    return false;
  });
  const timer = setInterval(() => void tick(), EVERY_MS);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
