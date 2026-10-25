import { useEffect, useRef, useState } from "react";
import { sendCorrection } from "../api";
import { Button, Textarea, useToast } from "../ds";

/** Asks what an agent should have said and teaches it as a correction. */
export function CorrectionPrompt({
  agentId,
  agentName,
  chatId,
  messageId,
  onDone,
}: {
  agentId: string;
  agentName: string;
  chatId: string;
  messageId: string;
  onDone: () => void;
}) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector("textarea")?.focus();
  }, []);
  async function send() {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try {
      await sendCorrection(agentId, { chat_id: chatId, message_id: messageId, text: t });
      toast.push(`Thanks. ${agentName} will use this correction.`);
      onDone();
    } catch {
      toast.push("Could not send the correction.", "error");
      setBusy(false);
    }
  }
  return (
    <div ref={box} className="mt-2 flex flex-col gap-1.5">
      <Textarea
        label="Correction"
        hideLabel
        placeholder="What should it have said?"
        value={text}
        maxLength={1000}
        onChange={(e) => setText(e.target.value)}
      />
      <p className="text-[12px] text-text-2">{`${text.length} / 1000`}</p>
      <div className="flex gap-1.5">
        <Button size="sm" disabled={busy || !text.trim()} onClick={() => void send()}>
          Send correction
        </Button>
        <Button size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
