const TIMEOUT_MS = 1000;
const CACHE_MS = 5000;

type Check = () => Promise<boolean>;
let override: Check | undefined;
let cache: { at: number; ok: boolean } | undefined;

export const livekitUrl = (): string => process.env.LIVEKIT_URL ?? "ws://127.0.0.1:7880";

async function probe(): Promise<boolean> {
  try {
    const url = livekitUrl().replace(/^ws/, "http");
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.arrayBuffer().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** True when the call server answers HTTP within 1 s (cached 5 s). */
export async function livekitAvailable(): Promise<boolean> {
  if (override) return override();
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.ok;
  const ok = await probe();
  cache = { at: Date.now(), ok };
  return ok;
}

/** Tests only. */
export function setLivekitHealthForTests(fn: Check | undefined): void {
  override = fn;
  cache = undefined;
}
