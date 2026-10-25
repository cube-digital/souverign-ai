import { expect, type Page, test } from "@playwright/test";

// Needs the audio stub on 127.0.0.1:8665 (speech-to-text answers "What is on the agenda today?")
// and Chromium's fake microphone, both set up by the e2e config and start-bridge.sh.

async function signInAna(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Ana" }).click();
  await page.getByLabel("PIN").fill("111111");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Meet your team")).toBeVisible();
  await page.getByRole("button", { name: "Get started" }).click();
}

test("a held voice message gets a transcript and a spoken agent reply with a latency pill", async ({
  browser,
}) => {
  const context = await browser.newContext({ permissions: ["microphone"] });
  const ana = await context.newPage();
  await signInAna(ana);

  // 1. Ana opens her DM with Scribe (in-app: a full page load would drop the session)
  await ana
    .getByRole("navigation", { name: "Chats" })
    .getByRole("button", { name: /^Scribe\b/ })
    .click();

  // 2. she holds the mic button for 1.5 s
  const mic = ana.getByRole("button", { name: "Hold to talk" });
  await expect(mic).toBeEnabled();
  const box = await mic.boundingBox();
  if (!box) throw new Error("mic button has no box");
  await ana.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await ana.mouse.down();
  await ana.waitForTimeout(1500);
  await ana.mouse.up();

  // 3. her voice bubble shows with a duration, then the transcript
  const bubble = ana.getByRole("listitem").filter({ has: ana.getByLabel("voice message") });
  await expect(bubble).toHaveCount(1, { timeout: 30_000 });
  await expect(bubble.getByText(/^\d+:\d{2}$/)).toBeVisible();
  await expect(bubble.getByText("Transcript · on this Mac")).toBeVisible({ timeout: 30_000 });
  await expect(bubble.getByText("What is on the agenda today?")).toBeVisible();

  // 4. Scribe answers in the thread with a playable voice message and the latency pill
  await bubble.getByRole("button", { name: /\d+ repl/i }).click();
  const thread = ana.getByRole("complementary", { name: "Details" });
  const reply = thread.getByLabel("voice message");
  await expect(reply).toBeVisible({ timeout: 60_000 });
  await expect(thread.getByRole("button", { name: /voice to voice \d/ })).toBeVisible();
  await reply.getByRole("button", { name: "Play" }).click();
  await expect(reply.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(thread.getByText("Could not play this message.")).toHaveCount(0);
});
