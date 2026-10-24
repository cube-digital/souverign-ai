import { type Browser, expect, type Page, test } from "@playwright/test";

async function signIn(browser: Browser, name: string, pin: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/");
  await page.getByRole("button", { name }).click();
  await page.getByLabel("PIN").fill(pin);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Pick a chat or start a new one")).toBeVisible();
  return page;
}

const say = async (p: Page, text: string) => {
  const box = p.getByLabel("Message # Ops");
  await box.fill(text);
  await box.press("Enter");
};

// The echo runtime replies with the context it was given, so the reply text shows what Nora saw.
const replies = (p: Page) => p.getByText(/^echo:/);

test("an invited agent answers when addressed, sees only what followed its invite", async ({
  browser,
}) => {
  const ana = await signIn(browser, "Ana", "111111");
  const rares = await signIn(browser, "Rareș", "333333");

  // 1. Ana creates the agent Nora and the chat Ops with Rareș
  await ana.getByRole("button", { name: "+ New agent" }).click();
  await ana.getByLabel("Name").fill("Nora");
  await ana.getByRole("button", { name: "Create agent" }).click();
  await expect(ana.getByRole("region", { name: "Nora" })).toBeVisible();
  await ana.getByRole("button", { name: "New chat" }).click();
  const dialog = ana.getByRole("dialog", { name: "New chat" });
  await dialog.getByLabel("Title").fill("Ops");
  await dialog.getByLabel("Rareș").check();
  await dialog.getByRole("button", { name: "Create" }).click();
  const open = (p: Page) =>
    p.getByRole("navigation", { name: "Chats" }).getByRole("button", { name: /Ops/ }).click();
  await open(ana);
  await open(rares);

  // 2. Ana speaks, then adds Nora
  await say(ana, "BEFORE-KESTREL");
  await expect(rares.getByText("BEFORE-KESTREL")).toBeVisible();
  await ana.getByRole("button", { name: "Members" }).click();
  await ana.getByRole("button", { name: "Add agent Nora" }).click();
  await expect(ana.getByText(/Ana added Nora/)).toBeVisible();
  await ana.getByRole("button", { name: "Close" }).click();

  // 3. a message after the invite
  await say(ana, "AFTER-OSPREY");
  await expect(rares.getByText("AFTER-OSPREY")).toBeVisible();

  // 4. Rareș addresses Nora; both see an agent reply that knows only the later message
  // The echo runtime can answer faster than a poll, so record when the live bubble and the final
  // reply first show up in Rareș's DOM.
  await rares.evaluate(() => {
    const seen: { live?: number; final?: number; sent: number } = { sent: performance.now() };
    (window as unknown as { __seen: typeof seen }).__seen = seen;
    const scan = () => {
      const text = document.body.textContent ?? "";
      const activity = document.querySelector('[data-testid="agent-activity"]');
      if (seen.live === undefined && activity) seen.live = performance.now();
      if (seen.final === undefined && text.includes("echo:") && !activity)
        seen.final = performance.now();
    };
    new MutationObserver(scan).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  await say(rares, "@Nora what do you see?");
  for (const p of [ana, rares]) {
    const reply = replies(p);
    await expect(reply).toBeVisible({ timeout: 10_000 });
    await expect(p.getByText("agent · Ana's").first()).toBeVisible();
    await expect(reply).toContainText("AFTER-OSPREY");
    await expect(reply).not.toContainText("BEFORE-KESTREL");
  }

  // the live bubble showed before the final message, and none remains after it
  const seen = await rares.evaluate(
    () => (window as unknown as { __seen: { live?: number; final?: number; sent: number } }).__seen,
  );
  expect(seen.live, "live bubble appeared").toBeDefined();
  expect(seen.final, "final reply appeared").toBeDefined();
  expect(seen.live as number).toBeLessThanOrEqual(seen.final as number);
  console.log(
    `live bubble ${Math.round((seen.live as number) - seen.sent)} ms, final ${Math.round((seen.final as number) - seen.sent)} ms after send`,
  );
  for (const p of [ana, rares]) await expect(p.getByTestId("agent-activity")).toHaveCount(0);

  // 5. no mention, no reply
  await say(rares, "just talking among ourselves");
  await expect(ana.getByText("just talking among ourselves")).toBeVisible();
  await rares.waitForTimeout(5000);
  await expect(replies(rares)).toHaveCount(1);
});
