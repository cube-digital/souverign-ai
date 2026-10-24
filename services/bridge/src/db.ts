import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";

export type Db = {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
};

export async function openDb(
  url: string = process.env.DATABASE_URL ?? "postgres://sa:sa_dev_only@127.0.0.1:5433/sa",
): Promise<Db> {
  if (url.startsWith("pglite://")) {
    const target = url.slice("pglite://".length);
    const pg = target === "memory" ? new PGlite() : new PGlite(target);
    await pg.waitReady;
    return {
      async query<T>(sql: string, params?: unknown[]) {
        if (params === undefined) {
          // exec allows multi-statement scripts (migrations)
          const results = await pg.exec(sql);
          return (results.at(-1)?.rows ?? []) as T[];
        }
        return (await pg.query<T>(sql, params)).rows;
      },
      close: () => pg.close(),
    };
  }
  const sql = postgres(url, { onnotice: () => {} });
  return {
    async query<T>(text: string, params?: unknown[]) {
      const rows = await sql.unsafe(text, (params ?? []) as never[]);
      return [...rows] as T[];
    },
    close: () => sql.end(),
  };
}
