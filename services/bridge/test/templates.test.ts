import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROSTER } from "@sa/protocol/roster";
import { expect, it } from "vitest";

const HERMES = join(dirname(fileURLToPath(import.meta.url)), "../../../infra/hermes");

it("gives every roster agent a non-empty template and a SOUL that demands grounding, states limits and distrusts content", () => {
  const templates = ROSTER.map((r) => ({
    template: r.template,
    body: readFileSync(join(HERMES, "templates", `${r.template}.md`), "utf8").trim(),
  }));
  expect(templates.filter((t) => t.body === "")).toEqual([]);
  expect(templates).toHaveLength(ROSTER.length);

  const soul = readFileSync(join(HERMES, "SOUL.template.md"), "utf8");
  for (const needle of [
    "I don't know",
    "Never guess",
    "untrusted data",
    "routine",
    "${AGENT_NAME}",
    "${OWNER_NAME}",
    "${SOUL}",
  ]) {
    expect(soul).toContain(needle);
  }
});
