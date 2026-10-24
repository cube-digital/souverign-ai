import type { Agent, AgentTemplate } from "@sa/protocol";
import { type FormEvent, useState } from "react";
import { ApiFailure, createAgent, updateAgent } from "../api";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Pill } from "../ui/Pill";

const SOUL_MAX = 2000;

const TEMPLATES: { id: AgentTemplate; label: string; blurb: string; sim: boolean }[] = [
  { id: "general", label: "General", blurb: "A helpful assistant for any chat.", sim: false },
  {
    id: "devops",
    label: "DevOps",
    blurb: "Watches cluster health, alerts and metrics.",
    sim: true,
  },
  { id: "qa", label: "QA", blurb: "Tracks test runs, flaky tests and releases.", sim: true },
];

function CreateForm({
  onCreated,
  onCancel,
}: {
  onCreated: (a: Agent) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<AgentTemplate>("general");
  const [soul, setSoul] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await createAgent(name.trim(), template, soul));
    } catch (err) {
      setError(
        err instanceof ApiFailure && err.status === 409
          ? "You already have an agent with this name."
          : "Couldn't create the agent. Check the name and try again.",
      );
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      aria-label="New agent"
      className="flex flex-col gap-4 rounded-[14px] border border-line bg-panel p-5"
    >
      <h2 className="text-[15px] font-semibold">New agent</h2>
      <Input label="Name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-xs text-muted">Template</legend>
        {TEMPLATES.map((t) => (
          <label
            key={t.id}
            className={`flex cursor-pointer items-start gap-3 rounded-[10px] border px-3 py-2.5 ${template === t.id ? "border-agent-line bg-teal-soft" : "border-line bg-bg"}`}
          >
            <input
              type="radio"
              name="template"
              className="mt-1 accent-[#2fd3b5]"
              checked={template === t.id}
              onChange={() => setTemplate(t.id)}
            />
            <span>
              <span className="font-medium">{t.label}</span>
              <br />
              <span className="text-xs text-muted">{t.blurb}</span>
              {t.sim && (
                <>
                  <br />
                  <span className="text-xs text-muted">Reads the simulated test backend</span>
                </>
              )}
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-col gap-1">
        <label htmlFor="new-soul" className="text-xs text-muted">
          Personality
        </label>
        <textarea
          id="new-soul"
          rows={4}
          maxLength={SOUL_MAX}
          value={soul}
          onChange={(e) => setSoul(e.target.value)}
          className="rounded-[10px] border border-line bg-panel-2 px-3 py-2.5 text-text outline-none focus:border-teal"
        />
        <span className="text-xs text-muted">
          {soul.length} / {SOUL_MAX}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
          Create agent
        </Button>
      </div>
    </form>
  );
}

function AgentCard({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
  const [soul, setSoul] = useState(agent.soul);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const tpl = TEMPLATES.find((t) => t.id === agent.template);

  async function save() {
    setState("saving");
    try {
      await updateAgent(agent.id, soul);
      setState("saved");
      onChanged();
    } catch {
      setState("failed");
    }
  }

  return (
    <section
      aria-label={agent.name}
      className="flex flex-col gap-3 rounded-[14px] border border-line bg-panel p-5"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={agent.name} agent size={44} />
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold">{agent.name}</h2>
          <div className="text-xs text-muted">{tpl?.label ?? agent.template} template</div>
        </div>
        <Pill tone={agent.status === "running" ? "teal" : "neutral"}>{agent.status}</Pill>
      </div>
      {tpl?.sim && <p className="text-xs text-muted">Reads the simulated test backend</p>}
      <label htmlFor={`soul-${agent.id}`} className="text-xs text-muted">
        Personality
      </label>
      <textarea
        id={`soul-${agent.id}`}
        rows={3}
        maxLength={SOUL_MAX}
        value={soul}
        onChange={(e) => {
          setSoul(e.target.value);
          setState("idle");
        }}
        className="rounded-[10px] border border-line bg-panel-2 px-3 py-2.5 text-text outline-none focus:border-teal"
      />
      <div className="flex items-center justify-end gap-3">
        {state === "saved" && <span className="text-xs text-teal-text">Saved</span>}
        {state === "failed" && (
          <span role="alert" className="text-xs text-danger">
            Couldn't save
          </span>
        )}
        <span className="text-xs text-muted">
          {soul.length} / {SOUL_MAX}
        </span>
        <Button onClick={save} disabled={state === "saving" || soul === agent.soul}>
          Save personality
        </Button>
      </div>
    </section>
  );
}

export function AgentsPage({
  agents,
  creating,
  onCreatingChange,
  onChanged,
}: {
  agents: Agent[];
  creating: boolean;
  onCreatingChange: (v: boolean) => void;
  onChanged: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-7 py-5">
      <div className="flex items-center gap-3">
        <h1 className="flex-1 text-[22px] font-semibold">My agents</h1>
        {!creating && (
          <Button variant="primary" onClick={() => onCreatingChange(true)}>
            + New agent
          </Button>
        )}
      </div>
      <p className="text-sm text-muted">
        Your agents never read each other's memory. They share only through a chat they are both in.
      </p>
      {creating && (
        <CreateForm
          onCancel={() => onCreatingChange(false)}
          onCreated={() => {
            onCreatingChange(false);
            onChanged();
          }}
        />
      )}
      {agents.map((a) => (
        <AgentCard key={`${a.id}:${a.soul}`} agent={a} onChanged={onChanged} />
      ))}
      {agents.length === 0 && !creating && (
        <p className="text-muted">You have no agents yet. Create one from a template.</p>
      )}
    </div>
  );
}
