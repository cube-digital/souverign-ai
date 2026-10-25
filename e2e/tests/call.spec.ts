import { type Browser, expect, type Page, test } from "@playwright/test";

// Needs the fake notetaker (SA_NOTETAKER=fake), MEETING_TOKEN=e2e-meeting, LIVEKIT_URL down and
// SA_CALL_GRACE_MS=2000, all exported by e2e/start-bridge.sh. Texts are unique per run.

const BRIDGE = "http://127.0.0.1:8657";
const RUN = Date.now().toString(36);

type Who = { name: string; id: string; pin: string };
const ANA: Who = { name: "Ana", id: "ana", pin: "111111" };
const VLAD: Who = { name: "Vlad", id: "vlad", pin: "222222" };
const RARES: Who = { name: "Rareș", id: "rares", pin: "333333" };

type Person = Who & { page: Page; token: () => string };

async function signIn(browser: Browser, w: Who): Promise<Person> {
  const page = await (await browser.newContext()).newPage();
  let bearer = "";
  page.on("request", (r) => {
    const h = r.headers().authorization;
    if (h?.startsWith("Bearer ")) bearer = h;
  });
  await page.goto("/");
  await page.getByRole("button", { name: w.name }).click();
  await page.getByLabel("PIN").fill(w.pin);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Meet your team")).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByLabel("Message # general")).toBeVisible();
  return { ...w, page, token: () => bearer };
}

const sidebar = (p: Page) => p.getByRole("navigation", { name: "Chats" });
const details = (p: Page) => p.getByRole("complementary", { name: "Details" });
const people = (p: Page) => p.getByRole("list", { name: "People in the call" });
const person = (p: Page, name: string) => people(p).getByRole("listitem").filter({ hasText: name });

async function createGroup(host: Person, title: string, others: Person[]) {
  await host.page.getByRole("button", { name: "New chat" }).click();
  const dialog = host.page.getByRole("dialog", { name: "New chat" });
  await dialog.getByLabel("Title").fill(title);
  for (const o of others) await dialog.getByLabel(o.name).check();
  await dialog.getByRole("button", { name: "Create" }).click();
  await openChat(host, title);
}

async function startCall(ana: Person) {
  await ana.page.getByRole("button", { name: "Start call" }).click();
  await expect(ana.page).toHaveURL(/\/c\/[^/]+\/call\/[^/]+$/);
  return ana.page.url().split("/call/")[1] as string;
}

async function joinCall(p: Person, title: string) {
  await openChat(p, title);
  await p.page.getByRole("button", { name: "Join" }).last().click();
  await expect(p.page).toHaveURL(/\/call\//);
}

async function openChat(p: Person, title: string) {
  await sidebar(p.page)
    .getByRole("button", { name: new RegExp(`^${title}\\b`) })
    .first()
    .click();
  await expect(p.page.getByLabel(`Message # ${title}`)).toBeVisible();
}

async function callInfo(p: Person, callId: string) {
  const res = await p.page.request.get(`/api/calls/${callId}`, {
    headers: { Authorization: p.token() },
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as { ended_at: number | null; notetaker: { id: string } | null };
}

async function postSegment(notetakerId: string, speaker: string, text: string) {
  const now = Date.now();
  const res = await fetch(`${BRIDGE}/internal/calls/notetakers/${notetakerId}/segments`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": "e2e-meeting" },
    body: JSON.stringify({ speaker, t0_ms: now, t1_ms: now + 2000, text }),
  });
  return res.status;
}

async function invite(ana: Person) {
  await ana.page.getByRole("button", { name: "Add notetaker" }).click();
  await expect(ana.page.getByLabel("Notetaker", { exact: true })).toBeVisible({ timeout: 30_000 });
}

/** Ana's DM with Scribe, opened in-app. */
async function openScribeDm(p: Person) {
  await sidebar(p.page)
    .getByRole("button", { name: /^Scribe\b/ })
    .click();
}

test("decliner is never captured, notes stay with the inviter until she approves, then everyone gets them in the call thread", async ({
  browser,
}) => {
  const ana = await signIn(browser, ANA);
  const vlad = await signIn(browser, VLAD);
  const rares = await signIn(browser, RARES);
  const title = `Sync ${RUN}`;
  const said = `We move delivery to the 20th of March. ${RUN}`;
  const hidden = `Rares private remark ${RUN}`;

  // 1. Ana starts a call; the card reaches the others, who join; the media-off banner shows
  await createGroup(ana, title, [vlad, rares]);
  const callId = await startCall(ana);
  await joinCall(vlad, title);
  await joinCall(rares, title);
  for (const p of [ana, vlad, rares]) {
    await expect(p.page.getByText(/Call audio is off/)).toBeVisible();
    await expect(people(p.page).getByRole("listitem")).toHaveCount(3);
  }

  // 2. Ana adds the notetaker; the banner names her; Vlad accepts, Rareș declines
  await invite(ana);
  for (const p of [vlad, rares]) {
    const banner = p.page.getByRole("region", { name: "Notetaker consent" });
    await expect(banner).toContainText("Ana invited Scribe to take notes");
  }
  await vlad.page
    .getByRole("region", { name: "Notetaker consent" })
    .getByRole("button", { name: "Accept" })
    .click();
  await rares.page
    .getByRole("region", { name: "Notetaker consent" })
    .getByRole("button", { name: "Decline" })
    .click();
  for (const p of [ana, vlad, rares]) {
    await expect(person(p.page, "Ana").getByText("captured", { exact: true })).toBeVisible();
    await expect(person(p.page, "Vlad").getByText("captured", { exact: true })).toBeVisible();
    await expect(person(p.page, "Rareș").getByText("not captured", { exact: true })).toBeVisible();
    await expect(person(p.page, "Rareș").getByText("captured", { exact: true })).toHaveCount(0);
  }

  // 3. the fake worker posts: the accepted speaker is stored, the decliner is refused
  const ntId = (await callInfo(ana, callId)).notetaker?.id as string;
  expect(await postSegment(ntId, "user:vlad", said)).toBe(201);
  expect(await postSegment(ntId, "user:rares", hidden)).toBe(403);
  await expect(ana.page.getByText(said)).toBeVisible();
  await expect(vlad.page.getByText(said)).toBeVisible();
  await expect(
    rares.page.getByText("You declined, so the lines are not shown to you."),
  ).toBeVisible();
  for (const p of [ana, vlad, rares]) await expect(p.page.getByText(hidden)).toHaveCount(0);

  // 4. a participant who is not the inviter cannot read the notes
  const res = await vlad.page.request.get(`/api/calls/${callId}/notes`, {
    headers: { Authorization: vlad.token() },
  });
  expect(res.status()).toBe(403);

  // 5. Rareș stops the notes; everyone sees it
  await rares.page.getByRole("button", { name: "Stop notes" }).click();
  for (const p of [ana, vlad, rares])
    await expect(p.page.getByText("Rareș stopped the notes.")).toBeVisible();

  // 6. only Ana gets the approval card, in her DM with Scribe
  await ana.page.getByRole("button", { name: "Leave" }).click();
  await openScribeDm(ana);
  const card = ana.page.getByRole("region", { name: "Approval" });
  await expect(card).toContainText(`Post call notes in #${title}`, { timeout: 60_000 });
  // Vlad and Rareș leave to another chat, so the group can show a mention
  for (const p of [vlad, rares]) {
    await p.page.getByRole("button", { name: "Leave" }).click();
    await openChat(p, "general");
  }
  await openScribeDm(vlad);
  await expect(vlad.page.getByRole("region", { name: "Approval" })).toHaveCount(0);
  await openChat(vlad, "general");
  await card.getByRole("button", { name: /^Approve/ }).click();

  // 7. Vlad and Rareș get the toast and a mention; the notes are in the call thread for all three
  for (const p of [vlad, rares]) {
    await expect(p.page.getByText(/^Notes from .* are ready$/)).toBeVisible({ timeout: 60_000 });
    await expect(
      sidebar(p.page).getByRole("button", { name: new RegExp(`^${title}`) }),
    ).toContainText("@ 1");
  }
  await vlad.page.getByRole("button", { name: "Open" }).click();
  const threadPath = new URL(vlad.page.url()).pathname;
  await rares.page.getByRole("button", { name: "Open" }).click();
  await ana.page.evaluate(
    `window.history.pushState(null, "", ${JSON.stringify(threadPath)}); window.dispatchEvent(new PopStateEvent("popstate"))`,
  );
  for (const p of [ana, vlad, rares]) {
    await expect(details(p.page)).toContainText("Call notes", { timeout: 30_000 });
    await expect(details(p.page)).toContainText("Not captured: 1 person who did not consent");
    await expect(details(p.page).getByText(hidden)).toHaveCount(0);
  }
});

test("everyone accepts and shows captured; after all leave the call ends once the grace period passes", async ({
  browser,
}) => {
  const ana = await signIn(browser, ANA);
  const vlad = await signIn(browser, VLAD);
  const rares = await signIn(browser, RARES);
  const title = `Standup ${RUN}`;

  await createGroup(ana, title, [vlad, rares]);
  const callId = await startCall(ana);
  await joinCall(vlad, title);
  await joinCall(rares, title);
  await invite(ana);
  for (const p of [vlad, rares])
    await p.page
      .getByRole("region", { name: "Notetaker consent" })
      .getByRole("button", { name: "Accept" })
      .click();
  for (const p of [ana, vlad, rares]) {
    await expect(people(p.page).getByText("captured", { exact: true })).toHaveCount(3);
    await expect(people(p.page).getByText("not captured", { exact: true })).toHaveCount(0);
  }

  // all three leave, nobody presses End call
  for (const p of [ana, vlad, rares]) await p.page.getByRole("button", { name: "Leave" }).click();
  await expect
    .poll(async () => (await callInfo(ana, callId)).ended_at, { timeout: 30_000 })
    .not.toBeNull();
  await expect(ana.page.getByText(/Call ended · \d+ min/).first()).toBeVisible({ timeout: 30_000 });
});

test("a denied draft can be published again by the inviter, which brings a new approval card", async ({
  browser,
}) => {
  const ana = await signIn(browser, ANA);
  const vlad = await signIn(browser, VLAD);
  const title = `Review ${RUN}`;

  await createGroup(ana, title, [vlad]);
  const callId = await startCall(ana);
  await joinCall(vlad, title);
  await invite(ana);
  await vlad.page
    .getByRole("region", { name: "Notetaker consent" })
    .getByRole("button", { name: "Accept" })
    .click();
  const ntId = (await callInfo(ana, callId)).notetaker?.id as string;
  expect(await postSegment(ntId, "user:vlad", `Ship the beta on Friday ${RUN}`)).toBe(201);
  await ana.page.getByRole("button", { name: "Stop notes" }).click();
  await ana.page.getByRole("button", { name: "Leave" }).click();

  // Ana denies the first card
  await openScribeDm(ana);
  const cards = ana.page.getByRole("region", { name: "Approval" });
  await expect(cards).toHaveCount(1, { timeout: 60_000 });
  await cards.getByRole("button", { name: "Deny" }).click();

  // the DM now offers to publish again; clicking it brings back a live approval
  const again = ana.page.getByRole("button", { name: "Publish notes again" });
  await expect(again).toBeVisible({ timeout: 30_000 });
  await again.click();
  await expect(ana.page.getByText("Sent for your approval again.")).toBeVisible();
  await expect(cards).toHaveCount(2, { timeout: 30_000 });
  await expect(cards.getByRole("button", { name: /^Approve/ })).toHaveCount(1);
  await expect(cards.last()).toContainText(`Post call notes in #${title}`);
});
