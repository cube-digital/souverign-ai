// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { Chat, DirectoryEntry } from "@sa/protocol";
import { type FormEvent, useEffect, useState } from "react";
import { createChat, directory as fetchDirectory } from "../api";
import { Button, Input, Modal } from "../ds";
import { useSession } from "../state/session";

export function NewChatDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (chat: Chat) => void;
}) {
  const { engine, user, refreshChats } = useSession();
  const [people, setPeople] = useState<DirectoryEntry[]>([]);
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchDirectory()
      .then((d) => setPeople(d.filter((p) => p.id !== user.id)))
      .catch(() => setError("Cannot reach the server"));
  }, [user.id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!engine || !title.trim() || picked.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const chat = await createChat(title.trim(), [...picked]);
      await engine.createEpoch(
        chat.id,
        chat.members.flatMap((m) => m.devices),
      );
      await engine.sendSystem(chat.id, `${user.display_name} created this chat`);
      await refreshChats();
      onCreated(chat);
    } catch {
      setError("Couldn't create the chat. Try again.");
      setBusy(false);
    }
  }

  return (
    <Modal title="New chat" onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Input
          label="Title"
          value={title}
          maxLength={80}
          onChange={(e) => setTitle(e.target.value)}
        />
        <fieldset className="flex flex-col gap-0.5">
          <legend className="mb-1 text-[12px] text-text-2">Members</legend>
          {people.map((p) => {
            const ready = p.devices.length > 0;
            return (
              <label
                key={p.id}
                className={`flex h-7 items-center gap-2.5 rounded-md px-2 ${ready ? "cursor-pointer hover:bg-bg-2" : "opacity-60"}`}
              >
                <input
                  type="checkbox"
                  disabled={!ready}
                  checked={picked.has(p.id)}
                  onChange={(e) =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(p.id);
                      else next.delete(p.id);
                      return next;
                    })
                  }
                />
                <span>{p.display_name}</span>
                {!ready && <span className="text-[12px] text-text-3">hasn't signed in yet</span>}
              </label>
            );
          })}
        </fieldset>
        {error && (
          <p role="alert" className="text-[12.5px] text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !engine || !title.trim() || picked.size === 0}
          >
            {engine ? "Create" : "Connecting…"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
