import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";

const OUTBOX = join(import.meta.dirname, "..", "..", ".run", "e2e-outbox");
const CONTRACT = join(import.meta.dirname, "..", "fixtures", "contract.txt");
const emlCount = () => readdirSync(OUTBOX).filter((f) => f.endsWith(".eml")).length;

const details = (p: Page) => p.getByRole("complementary", { name: "Details" });
const EMAIL =
  '@Sales !tool email_send {"to":"buyer@northwind.example","subject":"7.4 date","body":"Hello from the e2e"}';
const RECALL = '@Tech !tool memory_recall {"query":"termination notice period"}';

async function signIn(browser: Browser, name: string, pin: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  await page.getByRole("button", { name }).click();
  await page.getByLabel("PIN").fill(pin);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Meet your team")).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();
  return page;
}

/** In-app navigation: a full page load would drop the in-memory session. */
async function openKnowledge(p: Page) {
  await p
    .getByRole("navigation", { name: "Chats" })
    .getByRole("button", { name: /^Tech\b/ })
    .click();
  await p.getByRole("tab", { name: "Knowledge" }).click();
}

async function openChat(p: Page, title: RegExp, label: string) {
  await p
    .getByRole("navigation", { name: "Chats" })
    .getByRole("button", { name: title })
    .first()
    .click();
  await expect(p.getByLabel(label)).toBeVisible();
}

async function send(p: Page, label: string, text: string) {
  const box = p.getByLabel(label);
  await box.fill(text);
  await p.getByRole("button", { name: "Send", exact: true }).click();
}

async function openThread(p: Page, text: string) {
  await p
    .getByRole("listitem")
    .filter({ hasText: text })
    .getByRole("button", { name: /\d+ repl/i })
    .first()
    .click();
}

async function teach(p: Page) {
  await openKnowledge(p);
  await p.getByLabel("Teach a document").setInputFiles(CONTRACT);
  await expect(p.getByText("contract.txt").first()).toBeVisible({ timeout: 30_000 });
}

async function recall(p: Page) {
  await openChat(p, /^general( \d+)?$/, "Message # general");
  await send(p, "Message # general", RECALL);
  await openThread(p, RECALL);
}

test.describe.configure({ mode: "serial" });

test("teach a document, recall it in chat: the citation chip opens the source", async ({
  browser,
}) => {
  const ana = await signIn(browser, "Ana", "111111");
  await teach(ana);
  await expect(ana.getByText("contract.txt").first()).toBeVisible();
  await expect(ana.getByText(/Taught by Ana/)).toBeVisible();

  await recall(ana);
  const chip = details(ana)
    .getByRole("list", { name: "Sources" })
    .getByRole("button", {
      name: /contract\.txt/,
    });
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.click();
  await expect(ana.getByText("47 days").first()).toBeVisible();
});

test("approve: the card is shown, the pill counts it, approving writes one .eml and stamps", async ({
  browser,
}) => {
  const before = emlCount();
  const ana = await signIn(browser, "Ana", "111111");
  await openChat(ana, /^sales( \d+)?$/, "Message # sales");
  await send(ana, "Message # sales", EMAIL);
  await openThread(ana, EMAIL);

  const card = details(ana).getByRole("region", { name: "Approval" });
  await expect(card).toBeVisible({ timeout: 30_000 });
  const approve = card.getByRole("button", { name: "Approve and send" });
  await expect(approve).toBeVisible();
  await expect(ana.getByRole("button", { name: "1 action waiting for you" })).toBeVisible();

  await approve.click();
  await expect(
    details(ana)
      .getByText(/Approved by Ana/)
      .first(),
  ).toBeVisible({ timeout: 30_000 });
  await expect.poll(emlCount).toBe(before + 1);
});

test("deny: a personal agent asked by Vlad needs Ana, who declines; the text never reaches #ops", async ({
  browser,
}) => {
  const ana = await signIn(browser, "Ana", "111111");
  const vlad = await signIn(browser, "Vlad", "222222");

  // Ana owns the agent Pia and a chat with Vlad where Pia is a member
  await ana.getByRole("button", { name: "All agents" }).click();
  await ana.getByRole("button", { name: "+ New agent" }).click();
  await ana.getByLabel("Name").fill("Pia");
  await ana.getByRole("button", { name: "Create agent" }).click();
  await expect(ana.getByRole("region", { name: "Pia" })).toBeVisible();
  await ana.getByRole("button", { name: "New chat" }).click();
  const dialog = ana.getByRole("dialog", { name: "New chat" });
  await dialog.getByLabel("Title").fill("Deny room");
  await dialog.getByLabel("Vlad").check();
  await dialog.getByRole("button", { name: "Create" }).click();
  await openChat(ana, /Deny room/, "Message # Deny room");
  await ana.getByRole("button", { name: "Members" }).click();
  await ana.getByRole("button", { name: "Add agent Pia" }).click();
  await expect(ana.getByText(/Pia joined/).first()).toBeVisible();
  await ana.getByRole("button", { name: "Close panel" }).click();

  // Vlad asks; Ana (the approver, not the requester) sees Deny
  const cmd = '@Pia !tool chat_send {"chat":"ops","text":"e2e-deny-marker"}';
  await openChat(vlad, /Deny room/, "Message # Deny room");
  await send(vlad, "Message # Deny room", cmd);
  await openThread(ana, cmd);
  const card = details(ana).getByRole("region", { name: "Approval" });
  await card.getByRole("button", { name: "Deny" }).click({ timeout: 30_000 });
  await expect(
    details(ana)
      .getByText(/Declined by Ana/)
      .first(),
  ).toBeVisible();

  await vlad.waitForTimeout(3000);
  await openChat(vlad, /^ops( \d+)?$/, "Message # ops");
  await expect(vlad.getByText("e2e-deny-marker")).toHaveCount(0);
});

test("requester-only: another member sees Waiting for Ana and no approve button", async ({
  browser,
}) => {
  const before = emlCount();
  const ana = await signIn(browser, "Ana", "111111");
  const vlad = await signIn(browser, "Vlad", "222222");
  await openChat(ana, /^sales( \d+)?$/, "Message # sales");
  await send(ana, "Message # sales", EMAIL);
  await openThread(ana, EMAIL);
  const anaCard = details(ana).getByRole("region", { name: "Approval" });
  await expect(anaCard.getByRole("button", { name: "Approve and send" })).toBeVisible({
    timeout: 30_000,
  });

  await openChat(vlad, /^sales( \d+)?$/, "Message # sales");
  await openThread(vlad, EMAIL);
  await expect(details(vlad).getByText(/Waiting for Ana/)).toBeVisible({ timeout: 30_000 });
  await expect(vlad.getByRole("button", { name: "Approve and send" })).toHaveCount(0);

  await anaCard.getByRole("button", { name: "Cancel" }).click();
  await expect(
    details(ana)
      .getByText(/Canceled by Ana/)
      .first(),
  ).toBeVisible();
  expect(emlCount()).toBe(before);
});

test("correct and forget: a correction is listed; after deleting the document recall finds nothing", async ({
  browser,
}) => {
  const ana = await signIn(browser, "Ana", "111111");
  await recall(ana);
  const reply = details(ana).getByRole("listitem").filter({ hasText: "contract.txt" }).first();
  await expect(reply).toBeVisible({ timeout: 30_000 });
  await reply.getByRole("button", { name: "Not helpful" }).click();
  await ana
    .getByPlaceholder("What should it have said?")
    .fill("The notice period is 47 calendar days.");
  await ana.getByRole("button", { name: "Send correction" }).click();

  await openKnowledge(ana);
  await expect(ana.getByText("The notice period is 47 calendar days.")).toBeVisible();

  await ana
    .getByRole("listitem")
    .filter({ hasText: "contract.txt" })
    .getByRole("button", { name: "Delete" })
    .click();
  await ana.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(ana.getByText("Taught by Ana")).toHaveCount(0);

  await recall(ana);
  await expect(
    details(ana)
      .getByText(/No memories matched\.|47 calendar days/)
      .first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(details(ana).getByRole("button", { name: /contract\.txt/ })).toHaveCount(0);
});

test("ask_user: the answer click stamps and the agent replies with the choice", async ({
  browser,
}) => {
  const ana = await signIn(browser, "Ana", "111111");
  const cmd = '@Dev !tool ask_user {"question":"Which branch?","options":["main","release-7.4"]}';
  await openChat(ana, /^release-7\.4( \d+)?$/, "Message # release-7.4");
  await send(ana, "Message # release-7.4", cmd);
  await openThread(ana, cmd);

  const card = details(ana).getByRole("region", { name: "Question" });
  await expect(card.getByRole("button", { name: "main" })).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: "release-7.4" }).click();
  await expect(details(ana).getByText("Answered by Ana: release-7.4").first()).toBeVisible();
  await expect(
    details(ana)
      .getByText(/echo:.*release-7\.4/)
      .first(),
  ).toBeVisible({ timeout: 30_000 });
});

test("cancel: the requester cancels and no new .eml is written", async ({ browser }) => {
  const before = emlCount();
  const ana = await signIn(browser, "Ana", "111111");
  await openChat(ana, /^sales( \d+)?$/, "Message # sales");
  await send(ana, "Message # sales", EMAIL);
  await openThread(ana, EMAIL);
  const card = details(ana).getByRole("region", { name: "Approval" });
  await card.getByRole("button", { name: "Cancel" }).click({ timeout: 30_000 });
  await expect(
    details(ana)
      .getByText(/Canceled by Ana/)
      .first(),
  ).toBeVisible();
  await ana.waitForTimeout(2000);
  expect(emlCount()).toBe(before);
});
