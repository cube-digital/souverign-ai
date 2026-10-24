import type { Agent, DirectoryEntry } from "@sa/protocol";
import { useEffect, useState } from "react";
import {
  addAgentToChat,
  addMember,
  agents as fetchAgents,
  directory as fetchDirectory,
  removeAgentFromChat,
  removeMember,
} from "../api";
import { useSession } from "../state/session";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

export function MembersPanel({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const { chats, engine, user, refreshChats } = useSession();
  const chat = chats.find((c) => c.id === chatId);
  const [people, setPeople] = useState<DirectoryEntry[]>([]);
  const [myAgents, setMyAgents] = useState<Agent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isOwner = chat?.members.some((m) => m.member_id === user.id && m.role === "owner") ?? false;

  useEffect(() => {
    if (!isOwner) return;
    fetchDirectory().then(setPeople, () => {});
    fetchAgents().then(setMyAgents, () => {});
  }, [isOwner]);

  if (!chat) return null;
  const memberIds = new Set(chat.members.map((m) => m.member_id));
  const addable = people.filter((p) => !memberIds.has(p.id));
  const addableAgents = myAgents.filter((a) => !memberIds.has(a.id));

  async function change(job: () => Promise<{ updated: typeof chat; note: string }>) {
    if (!engine) return;
    setBusy(true);
    setError(null);
    try {
      const { updated, note } = await job();
      if (!updated) return;
      await engine.createEpoch(
        updated.id,
        updated.members.flatMap((m) => m.devices),
      );
      await engine.sendSystem(updated.id, note);
      await refreshChats();
    } catch {
      setError("Couldn't update the members. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Members" onClose={onClose}>
      <ul className="mb-4 flex flex-col gap-1">
        {chat.members.map((m) => (
          <li key={m.member_id} className="flex min-h-[44px] items-center gap-3">
            <Avatar name={m.display_name} agent={m.member_type === "agent"} size={28} />
            <span className="flex-1">
              {m.display_name}
              {m.member_type === "agent" && (
                <span className="ml-2 text-xs text-muted">
                  agent · {m.owner_display_name ?? "someone"}'s
                </span>
              )}
            </span>
            {m.role === "owner" && <span className="text-xs text-muted">Owner</span>}
            {isOwner && m.member_id !== user.id && (
              <Button
                variant="ghost"
                disabled={busy}
                aria-label={`Remove ${m.display_name}`}
                onClick={() =>
                  change(async () =>
                    m.member_type === "agent"
                      ? {
                          updated: await removeAgentFromChat(chat.id, m.member_id),
                          note: `${user.display_name} removed ${m.display_name} (${m.owner_display_name ?? user.display_name}'s agent).`,
                        }
                      : {
                          updated: await removeMember(chat.id, m.member_id),
                          note: `${user.display_name} removed ${m.display_name}.`,
                        },
                  )
                }
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      {isOwner && addable.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-xs text-muted">Add to this chat</div>
          {addable.map((p) => {
            const ready = p.devices.length > 0;
            return (
              <div key={p.id} className="flex min-h-[44px] items-center gap-3">
                <span className="flex-1">{p.display_name}</span>
                {!ready && <span className="text-xs text-muted">hasn't signed in yet</span>}
                <Button
                  disabled={busy || !ready}
                  aria-label={`Add ${p.display_name}`}
                  onClick={() =>
                    change(async () => ({
                      updated: await addMember(chat.id, p.id),
                      note: `${user.display_name} added ${p.display_name}. ${p.display_name} can read messages from now on.`,
                    }))
                  }
                >
                  Add
                </Button>
              </div>
            );
          })}
        </div>
      )}
      {isOwner && addableAgents.length > 0 && (
        <div className="mt-4 flex flex-col gap-1">
          <div className="text-xs text-muted">Add one of your agents</div>
          {addableAgents.map((a) => (
            <div key={a.id} className="flex min-h-[44px] items-center gap-3">
              <Avatar name={a.name} agent size={28} />
              <span className="flex-1">{a.name}</span>
              <Button
                disabled={busy}
                aria-label={`Add agent ${a.name}`}
                onClick={() =>
                  change(async () => ({
                    updated: await addAgentToChat(chat.id, a.id),
                    note: `${user.display_name} added ${a.name} (${user.display_name}'s agent). It can read messages from now on.`,
                  }))
                }
              >
                Add
              </Button>
            </div>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}
