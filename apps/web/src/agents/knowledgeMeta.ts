import type { KnowledgeItem } from "@sa/protocol";

export const shortDate = (ms: number) =>
  new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** "Taught by Ana · 24 Oct", "Noted in #ops", "Correction in #ops by Vlad". */
export function knowledgeMeta(i: KnowledgeItem): string {
  const date = shortDate(i.created_at);
  const chat = i.origin_chat_title ? `#${i.origin_chat_title}` : "a chat";
  if (i.kind === "note") return `Noted in ${chat}`;
  if (i.kind === "correction") {
    return `Correction in ${chat}${i.taught_by_name ? ` by ${i.taught_by_name}` : ""}`;
  }
  return i.taught_by_name ? `Taught by ${i.taught_by_name} · ${date}` : `Taught · ${date}`;
}

export function knowledgeParts(i: KnowledgeItem): string | null {
  if (i.kind !== "document" || i.parts < 1) return null;
  const n = i.parts;
  if (i.mime?.includes("pdf")) return `${n} ${n === 1 ? "page" : "pages"}`;
  if (i.mime?.includes("spreadsheet")) return `${n} ${n === 1 ? "sheet" : "sheets"}`;
  return `${n} ${n === 1 ? "part" : "parts"}`;
}
