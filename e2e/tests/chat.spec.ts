import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";

const USERS = [
  { id: "Ana", pin: "111111", word: "AMBERFOX" },
  { id: "Vlad", pin: "222222", word: "BLUEHERON" },
  { id: "Rareș", pin: "333333", word: "CEDARMOTH" },
  { id: "Janosch", pin: "444444", word: "DUNEWOLF" },
] as const;
const REMOVED_WORD = "EMBERLYNX";
const FILE_TEXT = "quarterly notes for the project";

type Person = { name: string; word: string; context: BrowserContext; page: Page };

async function signIn(browser: Browser, u: (typeof USERS)[number]): Promise<Person> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: u.id }).click();
  await page.getByLabel("PIN").fill(u.pin);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Pick a chat or start a new one")).toBeVisible();
  return { name: u.id, word: u.word, context, page };
}

const composer = (p: Page) => p.getByLabel("Message # Project");

async function say(p: Page, text: string) {
  await composer(p).fill(text);
  await composer(p).press("Enter");
}

test("four people chat in a group, share a file, and a removed member stops receiving", async ({
  browser,
}) => {
  // 1. everyone signs in
  const people: Person[] = [];
  for (const u of USERS) people.push(await signIn(browser, u));
  const [ana, vlad, , janosch] = people as [Person, Person, Person, Person];

  // 2. Ana creates "Project" with the other three
  await ana.page.getByRole("button", { name: "New chat" }).click();
  const dialog = ana.page.getByRole("dialog", { name: "New chat" });
  await dialog.getByLabel("Title").fill("Project");
  for (const other of people.slice(1)) await dialog.getByLabel(other.name).check();
  await dialog.getByRole("button", { name: "Create" }).click();
  for (const p of people) {
    await p.page
      .getByRole("navigation", { name: "Chats" })
      .getByRole("button", { name: /Project/ })
      .click();
    await expect(p.page.getByText("Ana created this chat")).toBeVisible();
  }

  // 3. everybody speaks, everybody hears everybody
  for (const p of people) await say(p.page, `hello from ${p.name} ${p.word}`);
  for (const p of people) {
    for (const q of people) await expect(p.page.getByText(q.word)).toBeVisible();
  }

  // 4. Vlad shares a file, Janosch downloads it
  await vlad.page.getByTestId("file-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(FILE_TEXT),
  });
  await expect(janosch.page.getByText("notes.txt")).toBeVisible();
  const [download] = await Promise.all([
    janosch.page.waitForEvent("download"),
    janosch.page.getByRole("button", { name: "Download" }).click(),
  ]);
  const path = await download.path();
  expect(readFileSync(path, "utf8")).toBe(FILE_TEXT);

  // 5. the relay panel shows rows and never a sentinel
  const aside = ana.page.getByRole("complementary", { name: "What the relay sees" });
  await expect(aside.getByTestId("relay-row").first()).toBeVisible();
  const panelText = (await aside.textContent()) ?? "";
  for (const w of [...USERS.map((u) => u.word), REMOVED_WORD]) expect(panelText).not.toContain(w);

  // 6. Ana removes Janosch; Vlad still hears her, Janosch does not
  await ana.page.getByRole("button", { name: "Members" }).click();
  await ana.page.getByRole("button", { name: "Remove Janosch" }).click();
  await expect(ana.page.getByText("Ana removed Janosch.")).toBeVisible();
  await ana.page.getByRole("button", { name: "Close" }).click();
  await say(ana.page, `after the change ${REMOVED_WORD}`);
  await expect(vlad.page.getByText(REMOVED_WORD)).toBeVisible();
  await janosch.page.waitForTimeout(3000);
  await expect(janosch.page.getByText(REMOVED_WORD)).toHaveCount(0);

  // 7. nothing the relay stored contains a sentinel
  for (const p of people) await p.context.close();
  const dir = join(import.meta.dirname, "..", "..", ".run", "e2e");
  const files = readdirSync(dir).filter((f) => f.startsWith("relay.sqlite"));
  expect(files).toContain("relay.sqlite");
  const stored = Buffer.concat(files.map((f) => readFileSync(join(dir, f))));
  expect(stored.length).toBeGreaterThan(0);
  for (const w of [...USERS.map((u) => u.word), REMOVED_WORD]) {
    expect(stored.includes(Buffer.from(w)), `${w} found in relay store`).toBe(false);
  }
});
