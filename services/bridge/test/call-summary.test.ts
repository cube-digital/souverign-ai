import { expect, it } from "vitest";
import {
  chunkLines,
  composeNotes,
  MAX_NOTES_CHARS,
  notesHeader,
  parseActionItems,
  transcriptLines,
} from "../src/calls/summary.js";

it("action items are parsed only from the Action items section, with owner, due and a cap of 30", () => {
  const md = [
    "## Summary",
    "- [ ] Zed: outside the section, ignored",
    "## Action items",
    "- [ ] Vlad: send the confirmation email (due: Friday)",
    "- [ ] **Ana**: update the contract",
    "- not a checkbox line",
    "## Open questions",
    "- [ ] Bob: also outside, ignored",
  ].join("\n");
  expect(parseActionItems(md)).toEqual([
    { owner: "Vlad", text: "send the confirmation email", due: "Friday" },
    { owner: "Ana", text: "update the contract" },
  ]);

  const many = [
    "## Action items",
    ...Array.from({ length: 31 }, (_, i) => `- [ ] Owner${i + 1}: task ${i + 1}`),
  ].join("\n");
  const items = parseActionItems(many);
  expect(items).toHaveLength(30);
  expect(items[29]).toEqual({ owner: "Owner30", text: "task 30" });
});

it("transcript lines carry mm:ss from the call start; chunks keep line boundaries; notes are capped at 7500 characters", () => {
  const start = 1_000_000;
  expect(
    transcriptLines([{ speakerName: "Ana", t0Ms: start + 65_000, text: "  hello  " }], start),
  ).toEqual(["[01:05] Ana: hello"]);

  const lines = Array.from({ length: 5 }, (_, i) => `${i}`.repeat(5000));
  const chunks = chunkLines(lines);
  expect(chunks).toHaveLength(3);
  expect(chunks.map((c) => c.split("\n").length)).toEqual([2, 2, 1]);
  expect(chunks.join("\n")).toBe(lines.join("\n"));
  expect(chunkLines(["x".repeat(13_000)])[0]).toHaveLength(12_000);

  expect(composeNotes("HEAD", "  body  ")).toBe("HEAD\n\nbody");
  const long = composeNotes("HEAD", "y".repeat(9000));
  expect(MAX_NOTES_CHARS).toBe(7500);
  expect(long.length).toBeLessThanOrEqual(7500);
  expect(long.startsWith("HEAD\n\nyyy")).toBe(true);
  expect(long.endsWith("(notes truncated)")).toBe(true);
});

it("the notes header lists captured speakers only, counts the others without names and pluralises", () => {
  const base = {
    chatTitle: "Project",
    startedAtMs: Date.UTC(2026, 9, 25, 10, 0),
    durationMs: 12 * 60_000,
    speakers: ["Ana", "Bob"],
  };
  const one = notesHeader({ ...base, notCaptured: 1 }).split("\n");
  expect(one[0]).toMatch(/^\*\*Call notes\*\* · Project · .+ · 12 min$/);
  expect(one.slice(1)).toEqual([
    "Speakers: Ana, Bob",
    "Not captured: 1 person who did not consent",
    "Draft by Scribe on this Mac.",
  ]);
  expect(notesHeader({ ...base, notCaptured: 3 })).toContain(
    "Not captured: 3 people who did not consent",
  );
  const none = notesHeader({ ...base, speakers: [], notCaptured: 0 });
  expect(none).toContain("Speakers: none");
  expect(none).not.toContain("Not captured");
});
