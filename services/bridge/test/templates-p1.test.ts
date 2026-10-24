import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { accessSummary, agentTools } from "../src/agents/access.js";
import { renderSoul } from "../src/agents/hermes.js";

const soulOf = (template: string) =>
  renderSoul({
    id: "agent-t16-00000000",
    name: "Scout",
    template,
    soul: "",
    ownerName: "Ana",
  } as Parameters<typeof renderSoul>[0]);

describe("memory and approval guidance", () => {
  it("templates cite memory as [n], carry approval etiquette and /access lists gated tools", () => {
    const templates = readdirSync(new URL("../../../infra/hermes/templates", import.meta.url)).map(
      (f) => f.replace(/\.md$/, ""),
    );
    for (const t of templates) {
      const soul = soulOf(t);
      expect(soul, t).toContain("memory_recall");
      expect(soul, t).toContain("[n]");
    }
    expect(soulOf("sales")).toContain("local outbox");
    expect(soulOf("scribe")).toContain("chat_send");
    for (const t of ["sales", "dev", "scribe", "tech", "general"])
      expect(soulOf(t), t).toContain("untrusted data");
    expect(soulOf("ops")).toContain("ask_user");
    expect(soulOf("ops")).toContain("memory_forget");

    const text = accessSummary({
      agentName: "Sales",
      chatTitle: "sales",
      joinedAt: new Date(),
      seen: 0,
      tools: agentTools("sales", "sales"),
    });
    expect(text).toMatch(/- email_send: .*\(needs approval\)/);
    expect(text).toContain("- memory_recall:");
  });
});
