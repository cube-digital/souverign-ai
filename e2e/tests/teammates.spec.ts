import { type Browser, expect, type Page, test } from "@playwright/test";

async function signIn(browser: Browser, name: string, pin: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  await page.getByRole("button", { name }).click();
  await page.getByLabel("PIN").fill(pin);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Meet your team")).toBeVisible();
  return page;
}

const details = (p: Page) => p.getByRole("complementary", { name: "Details" });

test("the first five minutes: welcome, seeded history, Try this, a threaded reply with receipts", async ({
  browser,
}) => {
  const ana = await signIn(browser, "Ana", "111111");
  await ana.getByRole("button", { name: "Get started" }).click();

  // seeded history is readable on a brand-new device
  await expect(ana.getByLabel("Message # general")).toBeVisible();
  await expect(ana.getByText(/The 7\.4 date is set/)).toBeVisible({ timeout: 30_000 });

  // Try this: 👀 shows, the reply lands in a thread with receipts, then ✅
  // (the echo runtime is quick, so record 👀 as it passes instead of polling for it)
  await ana.evaluate(`(() => {
    window.__eyes = false;
    new MutationObserver(() => {
      if ((document.body.textContent ?? "").includes("👀")) window.__eyes = true;
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  })()`);
  const prompt = "@Ops is anything about to go wrong?";
  await ana.getByRole("button", { name: prompt }).click();
  await ana
    .getByRole("listitem")
    .filter({ hasText: prompt })
    .getByRole("button", { name: /\d+ repl/i })
    .click();
  await expect(details(ana).getByText("Ops", { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(details(ana).getByText(/local/)).toBeVisible();
  expect(await ana.evaluate("window.__eyes")).toBe(true);
  await expect(ana.getByRole("button", { name: /✅/ }).first()).toBeVisible();
});

test("a member who is not the owner adds a workspace agent and everyone sees the join line", async ({
  browser,
}) => {
  const ana = await signIn(browser, "Ana", "111111");
  await ana.getByRole("button", { name: "Skip" }).click();
  const vlad = await signIn(browser, "Vlad", "222222");
  await vlad.getByRole("button", { name: "Skip" }).click();

  // Ana owns the group
  await ana.getByRole("button", { name: "New chat" }).click();
  const dialog = ana.getByRole("dialog", { name: "New chat" });
  await dialog.getByLabel("Title").fill("Launch");
  await dialog.getByLabel("Vlad").check();
  await dialog.getByRole("button", { name: "Create" }).click();
  await vlad
    .getByRole("navigation", { name: "Chats" })
    .getByRole("button", { name: /Launch/ })
    .click();

  // Vlad tags QA, which is not in the chat, and adds it from the composer prompt
  const box = vlad.getByLabel("Message # Launch");
  await box.fill("@QA is the build green?");
  await box.press("Enter");
  await vlad.getByRole("button", { name: "Add and send" }).click();
  const line = "QA joined · new chat key · sees messages from now on";
  await expect(vlad.getByText(line)).toBeVisible({ timeout: 30_000 });
  await expect(ana.getByText(line)).toBeVisible({ timeout: 30_000 });
});
