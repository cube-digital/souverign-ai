import type { PluginContext } from "../plugin-api.js";
import { isDue } from "./schedule.js";

const EVERY_MS = 30_000;

type Row = {
  id: string;
  user_id: string;
  agent_id: string;
  chat_id: string;
  days: number[];
  time_hhmm: string;
  prompt: string;
  last_run_at: Date | string | null;
  display_name: string;
};

export function startRoutines(ctx: PluginContext): {
  tick(now?: Date): Promise<void>;
  stop(): void;
} {
  const { db } = ctx;
  let busy = false;

  const tick = async (now: Date = new Date()) => {
    if (busy) return;
    busy = true;
    try {
      const rows = await db.query<Row>(
        `select r.id, r.user_id, r.agent_id, r.chat_id, r.days, r.time_hhmm, r.prompt, r.last_run_at,
                u.display_name
           from sa.routines r
           join sa.users u on u.id = r.user_id
           left join sa.user_prefs p on p.user_id = r.user_id
          where r.kind = 'routine' and not r.paused and coalesce(p.pause_all, false) = false`,
      );
      for (const r of rows) {
        const last = r.last_run_at ? new Date(r.last_run_at) : null;
        if (!isDue({ days: r.days, time: r.time_hhmm, lastRunAt: last }, now)) continue;
        // claim the slot before running so it fires once, also across restarts
        const claimed = await db.query(
          `update sa.routines set last_run_at = $2::timestamptz
            where id = $1 and (last_run_at is null or last_run_at < $2::timestamptz) returning id`,
          [r.id, now.toISOString()],
        );
        if (claimed.length === 0) continue;
        const members = await db.query(
          `select 1 from sa.chat_members
            where chat_id = $1 and removed_at is null
              and ((member_type = 'user' and member_id = $2) or (member_type = 'agent' and member_id = $3))`,
          [r.chat_id, r.user_id, r.agent_id],
        );
        if (members.length < 2) continue;
        ctx.log("routine firing", { routineId: r.id });
        await ctx.agentHost.runProactive?.({
          agentId: r.agent_id,
          chatId: r.chat_id,
          prompt: `Routine set by ${r.display_name}: ${r.prompt}`,
          kind: "routine",
          requesterUserId: r.user_id,
        });
      }
    } catch (e) {
      ctx.log("routines tick failed", { error: (e as Error).message });
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tick(), EVERY_MS);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
