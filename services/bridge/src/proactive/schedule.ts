const LATE_MS = 30 * 60 * 1000;

/** Local-time check: is this routine's slot open now and not yet served? */
export function isDue(
  r: { days: number[]; time: string; lastRunAt: Date | null },
  now: Date,
): boolean {
  if (!r.days.includes(now.getDay())) return false;
  const [h = "0", m = "0"] = r.time.split(":");
  const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(h), Number(m));
  const late = now.getTime() - slot.getTime();
  if (late < 0 || late >= LATE_MS) return false;
  return r.lastRunAt === null || r.lastRunAt.getTime() < slot.getTime();
}
