import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDb } from "../src/db.js";

it("caps a history window at the current seq and ignores windows on active members", () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "win-")), "r.sqlite"));
  db.addMember("chat-1", "dev-a", 9999);
  expect(db.sync("chat-1", "dev-a", 0, 10)).toEqual([]);
  db.addMember("chat-1", "dev-a", 9999);
  expect(db.activeSince("chat-1", "dev-a")).toBe(0);
  db.close();
});
