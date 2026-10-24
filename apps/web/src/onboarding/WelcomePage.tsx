import { ROSTER } from "@sa/protocol/roster";
import { useState } from "react";
import { useNavigate } from "react-router";
import { AgentAvatar, Button, Card, useToast } from "../ds";
import { useSession } from "../state/session";
import { markWelcomed } from "./firstRun";
import { ensureScribeDm } from "./scribeDm";

const COUNT_WORD: Record<number, string> = { 4: "Four", 5: "Five", 6: "Six", 7: "Seven" };

export function WelcomePage() {
  const s = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    let list = s.chats;
    try {
      await ensureScribeDm(s.engine, async () => {
        list = await s.refreshChats();
      });
    } catch {
      toast.push("Could not open your Scribe chat. You can start it later from Agents.", "error");
    }
    markWelcomed(s.user.id);
    const general = list.find((c) => c.seed_key === "general");
    navigate(general ? `/c/${encodeURIComponent(general.id)}` : "/");
  }

  function skip() {
    markWelcomed(s.user.id);
    navigate("/");
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6 text-[13px] text-text-0">
      <header className="flex flex-col gap-1">
        <h1 className="text-[18px] font-semibold">Meet your team</h1>
        <p className="text-text-2">
          {COUNT_WORD[ROSTER.length] ?? ROSTER.length} agent teammates live in your chats. Tag one
          in any message to ask for help.
        </p>
      </header>
      <ul className="grid list-none grid-cols-1 gap-3 p-0 md:grid-cols-2">
        {ROSTER.map((r) => (
          <li key={r.id}>
            <Card ai className="flex h-full flex-col gap-2">
              <div className="flex items-center gap-2">
                <AgentAvatar name={r.name} rosterId={r.id} size={28} />
                <h2 className="font-semibold">{r.name}</h2>
              </div>
              <p>{r.role}</p>
              <p className="text-text-2">Can see: {r.sees}</p>
              <ul className="m-0 flex list-none flex-col gap-1 p-0 text-text-1">
                {r.examples.map((e) => (
                  <li key={e} className="rounded-md border border-border-soft px-2 py-1">
                    {e}
                  </li>
                ))}
              </ul>
            </Card>
          </li>
        ))}
      </ul>
      <p className="text-text-2">Every model runs on this Mac · the relay sees ciphertext only</p>
      <div className="flex gap-2">
        <Button variant="primary" size="lg" aria-busy={busy} onClick={busy ? undefined : start}>
          Get started
        </Button>
        <Button variant="ghost" size="lg" aria-busy={busy} onClick={busy ? undefined : skip}>
          Skip
        </Button>
      </div>
    </div>
  );
}
