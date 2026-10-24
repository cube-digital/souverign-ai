const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves true once the relay answers /relay/healthz, false after timeoutMs. */
export async function waitForRelay(
  relayInternalUrl: string,
  { timeoutMs = 60_000, intervalMs = 500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const url = `${relayInternalUrl.replace(/\/$/, "")}/relay/healthz`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return true;
    } catch {}
    await sleep(intervalMs);
  }
  return false;
}
