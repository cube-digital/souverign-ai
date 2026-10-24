import { type Browser, expect, type Page, test } from "@playwright/test";

async function signIn(browser: Browser, name: string, pin: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  await page.getByRole("button", { name }).click();
  await page.getByLabel("PIN").fill(pin);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Meet your team")).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByLabel("Message # general")).toBeVisible();
  return page;
}

const say = async (p: Page, text: string) => {
  const box = p.getByLabel("Message # Ops room");
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

// The echo runtime replies with the context it was given, so the reply text shows what Nora saw.
const replies = (p: Page) => details(p).getByText(/^echo:/);

test("an invited agent answers when addressed, sees only what followed its invite", async ({
  browser,
}) => {
  const ana = await signIn(browser, "Ana", "111111");
  const rares = await signIn(browser, "Rareș", "333333");

  // 1. Ana creates the agent Nora and the chat Ops with Rareș
  await ana.getByRole("button", { name: "All agents" }).click();
  await ana.getByRole("button", { name: "+ New agent" }).click();
  await ana.getByLabel("Name").fill("Nora");
  await ana.getByRole("button", { name: "Create agent" }).click();
  await expect(ana.getByRole("region", { name: "Nora" })).toBeVisible();
  await ana.getByRole("button", { name: "New chat" }).click();
  const dialog = ana.getByRole("dialog", { name: "New chat" });
  await dialog.getByLabel("Title").fill("Ops room");
  await dialog.getByLabel("Rareș").check();
  await dialog.getByRole("button", { name: "Create" }).click();
  const open = (p: Page) =>
    p
      .getByRole("navigation", { name: "Chats" })
      .getByRole("button", { name: /Ops room/ })
      .click();
  await open(rares);
  await expect(ana.getByLabel("Message # Ops room")).toBeVisible();
  await open(ana);

  // 2. Ana speaks, then adds Nora
  await say(ana, "BEFORE-KESTREL");
  await expect(rares.getByText("BEFORE-KESTREL")).toBeVisible();
  await ana.getByRole("button", { name: "Members" }).click();
  await ana.getByRole("button", { name: "Add agent Nora" }).click();
  await expect(ana.getByText(/Nora joined/).first()).toBeVisible();
  await ana.getByRole("button", { name: "Close panel" }).click();

  // 3. a message after the invite
  await say(ana, "AFTER-OSPREY");
  await expect(rares.getByText("AFTER-OSPREY")).toBeVisible();

  // 4. Rareș addresses Nora; both see an agent reply in the thread that knows only the later message
  // The echo runtime can answer faster than a poll, so record when the live status and the final
  // reply first show up in Rareș's DOM.
  // (browser code as a string: the e2e tsconfig has no DOM lib)
  await rares.evaluate(`(() => {
    const seen = { sent: performance.now() };
    window.__seen = seen;
    const scan = () => {
      const text = document.body.textContent ?? "";
      const activity = document.querySelector('[data-testid="agent-activity"]');
      const live = activity || text.includes("working…");
      if (seen.live === undefined && live) seen.live = performance.now();
      if (seen.final === undefined && text.includes("echo:") && !live)
        seen.final = performance.now();
    };
    new MutationObserver(scan).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  })()`);
  await say(rares, "@Nora what do you see?");
  for (const p of [ana, rares]) {
    await openThread(p, "what do you see?");
    const reply = replies(p);
    await expect(reply).toBeVisible({ timeout: 10_000 });
    await expect(details(p).getByText("Ana's agent").first()).toBeVisible();
    await expect(reply).toContainText("AFTER-OSPREY");
    await expect(reply).not.toContainText("BEFORE-KESTREL");
  }

  // the live status showed before the final message, and none remains after it
  const seen = (await rares.evaluate("window.__seen")) as {
    live?: number;
    final?: number;
    sent: number;
  };
  expect(seen.live, "live status appeared").toBeDefined();
  expect(seen.final, "final reply appeared").toBeDefined();
  expect(seen.live as number).toBeLessThanOrEqual(seen.final as number);
  console.log(
    `live status ${Math.round((seen.live as number) - seen.sent)} ms, final ${Math.round((seen.final as number) - seen.sent)} ms after send`,
  );
  for (const p of [ana, rares]) await expect(p.getByTestId("agent-activity")).toHaveCount(0);

  // 5. no mention, no reply
  await say(rares, "just talking among ourselves");
  await expect(ana.getByText("just talking among ourselves")).toBeVisible();
  await rares.waitForTimeout(5000);
  await expect(replies(rares)).toHaveCount(1);
});
