import { type Browser, expect, type Page, test } from "@playwright/test";

async function enterGeneral(browser: Browser, name: string, pin: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  await page.getByRole("button", { name }).click();
  await page.getByLabel("PIN").fill(pin);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Meet your team")).toBeVisible();
  await page.getByRole("button", { name: "Get started" }).click();
  await expect(page.getByLabel("Message # general")).toBeVisible();
  return page;
}

const send = async (p: Page, text: string) => {
  const box = p.getByLabel("Message # general");
  await box.fill(text);
  await box.press("Enter");
};
const details = (p: Page) => p.getByRole("complementary", { name: "Details" });
const openThread = (p: Page, root: string) =>
  p
    .getByRole("listitem")
    .filter({ hasText: root })
    .getByRole("button", { name: /\d+ repl/i })
    .click();

test("one message tags Ops and QA: both reply in the thread with receipts, the other user sees them, only the asker can Stop", async ({
  browser,
}) => {
  const ana = await enterGeneral(browser, "Ana", "111111");
  const vlad = await enterGeneral(browser, "Vlad", "222222");

  // 1. Ana tags two workspace agents in one message
  const ask = "@Ops @QA status check ZEBRA-ONE";
  await send(ana, ask);
  await expect(vlad.getByText("ZEBRA-ONE")).toBeVisible();

  // 2. both reply in the thread of that message, each with a receipts footer saying "local"
  await openThread(ana, "ZEBRA-ONE");
  const thread = details(ana);
  await expect(thread.getByText("Ops", { exact: true })).toBeVisible();
  await expect(thread.getByText("QA", { exact: true })).toBeVisible();
  await expect(thread.getByText(/local/)).toHaveCount(2);

  // 3. Vlad sees the same replies in the thread
  await openThread(vlad, "ZEBRA-ONE");
  await expect(details(vlad).getByText(/local/)).toHaveCount(2);

  // 4. a second ask: Ana can Stop it while it streams, Vlad has no Stop button
  await send(ana, "@Ops give me the long version ZEBRA-TWO");
  await expect(ana.getByRole("button", { name: "Stop Ops" })).toBeVisible();
  await expect(vlad.getByRole("button", { name: /^Stop/ })).toHaveCount(0);
  await ana.getByRole("button", { name: "Stop Ops" }).click();
  await expect(ana.getByRole("button", { name: "Stop Ops" })).toHaveCount(0);
  await expect(ana.getByText(/Stopped by/)).toBeVisible();
});
