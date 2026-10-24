import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlugins, mergeHooks } from "../src/plugin-loader.js";

const here = dirname(fileURLToPath(import.meta.url));
let dir: string;
const dirs: string[] = [];
afterEach(() => {
  for (const d of [dir, ...dirs.splice(0)]) rmSync(d, { recursive: true, force: true });
});

const plugin = (name: string, body: string) =>
  `export const plugin = { name: ${JSON.stringify(name)}, hooks: { onMemberAdded: async (chatId, userId) => { ${body} } } };\n`;

describe("bridge plugin loader", () => {
  it("loads plugins in name order, skips type and test files, and calls every merged hook even when one throws", async () => {
    dir = mkdtempSync(join(here, ".plugins-"));
    const calls: string[] = [];
    (globalThis as { __pluginCalls?: string[] }).__pluginCalls = calls;
    // file order is the opposite of name order
    writeFileSync(
      join(dir, "1-zeta.js"),
      plugin("zeta", "globalThis.__pluginCalls.push(`zeta:${chatId}:${userId}`);"),
    );
    writeFileSync(
      join(dir, "2-alpha.js"),
      plugin("alpha", "globalThis.__pluginCalls.push('alpha'); throw new Error('boom');"),
    );
    writeFileSync(join(dir, "ignored.d.ts"), "export const nothing: number;\n");
    writeFileSync(join(dir, "ignored.test.js"), "throw new Error('tests are not plugins');\n");

    const plugins = await loadPlugins(dir);
    const hooks = mergeHooks(plugins);
    await hooks.onMemberAdded?.("chat-1", "ana");

    expect(plugins.map((p) => p.name)).toEqual(["alpha", "zeta"]);
    expect(calls).toEqual(["alpha", "zeta:chat-1:ana"]);
    expect(await loadPlugins(join(dir, "missing"))).toEqual([]);

    const broken = mkdtempSync(join(here, ".plugins-"));
    dirs.push(broken);
    writeFileSync(join(broken, "fine.js"), plugin("fine", ""));
    writeFileSync(join(broken, "broken-one.js"), "export const other = 1;\n");
    await expect(loadPlugins(broken)).rejects.toThrow(/broken-one/);
  });
});
