import type { Agent, SharePolicy } from "@sa/protocol";
import { useId, useState } from "react";
import { setSharing } from "../api";

export function SharingSetting({ agent }: { agent: Agent }) {
  const labelId = useId();
  const [value, setValue] = useState<SharePolicy>(agent.share_private_in_chats ?? "always");
  const [error, setError] = useState(false);
  const options: { id: SharePolicy; label: string; hint: string }[] = [
    {
      id: "always",
      label: "Always",
      hint: "Use what it was taught in chats it is added to. Adding it is the consent.",
    },
    {
      id: "ask",
      label: "Ask first",
      hint:
        agent.scope === "workspace"
          ? "Show the person who asked a private preview first."
          : "Ask me before an answer that uses what I taught it is posted.",
    },
    { id: "never", label: "Never", hint: "Use taught knowledge only in a DM." },
  ];

  async function choose(next: SharePolicy) {
    const prev = value;
    setValue(next);
    setError(false);
    try {
      await setSharing(agent.id, next);
    } catch {
      setValue(prev);
      setError(true);
    }
  }

  return (
    <section className="rounded-lg border border-border-soft p-3">
      <h3 id={labelId} className="mb-2 text-[13px] font-semibold text-text-0">
        Use taught knowledge in shared chats
      </h3>
      <div role="radiogroup" aria-labelledby={labelId} className="flex flex-col gap-2">
        {options.map((o) => (
          <label key={o.id} className="flex cursor-pointer items-start gap-2 text-[13px]">
            <input
              type="radio"
              name={`sharing-${agent.id}`}
              checked={value === o.id}
              onChange={() => void choose(o.id)}
              className="mt-0.5"
            />
            <span className="flex flex-col">
              <span className="text-text-0">{o.label}</span>
              <span className="text-[12px] text-text-2">{o.hint}</span>
            </span>
          </label>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-danger">
          Couldn't save the setting.
        </p>
      )}
    </section>
  );
}
