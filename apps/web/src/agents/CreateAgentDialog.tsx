import type { Agent, AgentTemplate } from "@sa/protocol";
import { type FormEvent, useState } from "react";
import { createAgent } from "../api";
import { Button, Input, Modal, Textarea } from "../ds";

/** Personal agents can only use these templates; the bridge rejects the others. */
const TEMPLATES: { id: AgentTemplate; label: string }[] = [
  { id: "general", label: "General" },
  { id: "devops", label: "DevOps" },
];

export function CreateAgentDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (a: Agent) => void;
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
    } catch {
      setError("Couldn't create the agent. Check the name and try again.");
      setBusy(false);
    }
  }

  return (
    <Modal title="New agent" onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Input
          label="Name"
          data-autofocus
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="flex flex-col gap-1">
          <label htmlFor="new-agent-template" className="text-[12px] text-text-2">
            Template
          </label>
          <select
            id="new-agent-template"
            value={template}
            onChange={(e) => setTemplate(e.target.value as AgentTemplate)}
            className="h-7 rounded-md border border-border-soft bg-bg-1 px-2 text-[13px] text-text-0"
          >
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <Textarea
          label="Personality"
          value={soul}
          maxLength={2000}
          onChange={(e) => setSoul(e.target.value)}
        />
        {error && (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            Create agent
          </Button>
        </div>
      </form>
    </Modal>
  );
}
