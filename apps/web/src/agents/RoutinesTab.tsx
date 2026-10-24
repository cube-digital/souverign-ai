import type { Agent, Prefs, Routine } from "@sa/protocol";
import { type FormEvent, useEffect, useState } from "react";
import {
  createRoutine,
  deleteRoutine,
  routines as fetchRoutines,
  getPrefs,
  setPrefs,
  updateRoutine,
} from "../api";
import { Button, EmptyState, Input, Textarea, Toggle } from "../ds";
import { useSession } from "../state/session";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WORKDAYS = [1, 2, 3, 4, 5];
const SELECT = "h-7 rounded-md border border-border-soft bg-bg-1 px-2 text-[13px] text-text-0";

export function RoutinesTab({ agent }: { agent: Agent }) {
  const { chats, user } = useSession();
  const [list, setList] = useState<Routine[] | null>(null);
  const [prefs, setPrefsState] = useState<Prefs>({ pause_all: false });
  const [error, setError] = useState<string | null>(null);
  const shared = chats.filter(
    (c) =>
      c.members.some((m) => m.member_type === "user" && m.member_id === user.id) &&
      c.members.some((m) => m.member_type === "agent" && m.member_id === agent.id),
  );
  const [days, setDays] = useState<number[]>(WORKDAYS);
  const [time, setTime] = useState("09:00");
  const [chatId, setChatId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setList(null);
    Promise.all([fetchRoutines(agent.id), getPrefs()])
      .then(([r, p]) => {
        if (!live) return;
        setList(r);
        setPrefsState(p);
      })
      .catch(() => live && setError("Couldn't load routines."));
    return () => {
      live = false;
    };
  }, [agent.id]);

  const zone = prefs.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const chatTitle = (id: string) => chats.find((c) => c.id === id)?.title ?? "";
  const fail = (msg: string) => () => setError(msg);

  const pause = (r: Routine) =>
    updateRoutine(r.id, !r.paused)
      .then((u) => setList((l) => (l ?? []).map((x) => (x.id === r.id ? u : x))))
      .catch(fail("Couldn't update the routine."));
  const remove = (r: Routine) =>
    deleteRoutine(r.id)
      .then(() => setList((l) => (l ?? []).filter((x) => x.id !== r.id)))
      .catch(fail("Couldn't delete the routine."));
  const pauseAll = (next: boolean) =>
    setPrefs({ ...prefs, pause_all: next })
      .then(setPrefsState)
      .catch(fail("Couldn't save the setting."));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const target = chatId || shared[0]?.id;
    if (!target || !prompt.trim() || days.length === 0 || busy) return;
    setBusy(true);
    try {
      const created = await createRoutine({
        agent_id: agent.id,
        chat_id: target,
        days: [...days].sort(),
        time,
        prompt: prompt.trim(),
      });
      setList((l) => [...(l ?? []), created]);
      setPrompt("");
    } catch {
      setError("Couldn't create the routine.");
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      )}
      <p className="text-[12px] text-text-2">{`Times are in ${zone}, this Mac's time zone`}</p>
      <div className="flex items-center gap-2 text-[13px] text-text-1">
        <Toggle
          checked={prefs.pause_all}
          onChange={(v) => void pauseAll(v)}
          label="Pause all my proactive posts"
        />
        <span aria-hidden="true">Pause all my proactive posts</span>
      </div>
      {list === null && !error && <EmptyState>Loading routines…</EmptyState>}
      {list?.length === 0 && <EmptyState>No routines yet.</EmptyState>}
      <ul className="flex flex-col gap-2">
        {(list ?? []).map((r) => (
          <li
            key={r.id}
            className="flex items-center gap-3 rounded-lg border border-border-soft p-2 text-[13px]"
          >
            <div className="min-w-0 flex-1">
              <p className="text-text-0">{r.prompt}</p>
              <p className="text-[12px] text-text-3">
                {`${r.days.map((d) => DAYS[d]).join(", ")} · ${r.time} · ${chatTitle(r.chat_id)}`}
              </p>
              {r.kind === "alert_watch" && (
                <p className="text-[12px] text-text-2">Workspace · anyone can pause</p>
              )}
            </div>
            <Toggle
              checked={r.paused}
              onChange={() => void pause(r)}
              label={`Pause routine: ${r.prompt}`}
            />
            {r.kind === "routine" && (
              <Button
                size="sm"
                variant="danger"
                aria-label={`Delete routine: ${r.prompt}`}
                onClick={() => void remove(r)}
              >
                Delete
              </Button>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={submit} aria-label="New routine" className="flex flex-col gap-3">
        <fieldset className="flex flex-wrap gap-3 text-[12px] text-text-1">
          <legend className="mb-1 text-text-2">Days</legend>
          {DAYS.map((d, i) => (
            <label key={d} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={days.includes(i)}
                onChange={(e) =>
                  setDays((cur) => (e.target.checked ? [...cur, i] : cur.filter((x) => x !== i)))
                }
              />
              {d}
            </label>
          ))}
        </fieldset>
        <Input label="Time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        <div className="flex flex-col gap-1">
          <label htmlFor="routine-chat" className="text-[12px] text-text-2">
            Chat
          </label>
          <select
            id="routine-chat"
            className={SELECT}
            value={chatId || shared[0]?.id || ""}
            onChange={(e) => setChatId(e.target.value)}
          >
            {shared.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </div>
        <Textarea
          label="Prompt"
          value={prompt}
          maxLength={500}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || shared.length === 0 || !prompt.trim() || days.length === 0}
          >
            Create routine
          </Button>
        </div>
      </form>
    </div>
  );
}
