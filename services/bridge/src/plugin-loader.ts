import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BridgeHooks } from "./agents/api.js";
import type { BridgePlugin } from "./plugin-api.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Imports every plugin file in `dir` (default `src/plugins/`), sorted by plugin name. */
export async function loadPlugins(dir: string = join(here, "plugins")): Promise<BridgePlugin[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const plugins: BridgePlugin[] = [];
  for (const f of files.sort()) {
    if (!/\.(ts|js)$/.test(f) || f.endsWith(".d.ts") || f.includes(".test.")) continue;
    const mod = (await import(pathToFileURL(join(dir, f)).href)) as { plugin?: BridgePlugin };
    if (!mod.plugin?.name) throw new Error(`plugin file ${f} does not export a plugin`);
    plugins.push(mod.plugin);
  }
  return plugins.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** One set of hooks that calls every plugin's hook in order; a failing hook is logged and skipped. */
export function mergeHooks(plugins: BridgePlugin[]): BridgeHooks {
  const run =
    <A extends unknown[]>(name: keyof BridgeHooks) =>
    async (...args: A) => {
      for (const p of plugins) {
        const hook = p.hooks?.[name] as ((...a: A) => Promise<void>) | undefined;
        if (!hook) continue;
        try {
          await hook.apply(p.hooks, args);
        } catch (e) {
          console.error(
            JSON.stringify({
              level: "error",
              msg: "plugin hook failed",
              plugin: p.name,
              hook: name,
              error: (e as Error).message,
            }),
          );
        }
      }
    };
  return {
    onDeviceRegistered: run<[string, string]>("onDeviceRegistered"),
    onMemberAdded: run<[string, string]>("onMemberAdded"),
    onAgentDm: run<[string, string, string, boolean]>("onAgentDm"),
  };
}
