export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const shortId = (id: string): string => `${id.slice(0, 4)}…${id.slice(-2)}`;

export const timeOf = (ts: number, seconds = false): string =>
  new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  });
