// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { ChatMember, DirectoryEntry } from "@sa/protocol";
import { useEffect, useRef, useState } from "react";
import { directory as fetchDirectory } from "../api";
import { agentLabel } from "../channel/shared";
import { AgentAvatar, Avatar, Button, StatusDot } from "../ds";
import { timeOf } from "../lib/format";
import { useAgents } from "../state/agents";
import { addAgentWithKey, addPersonWithKey, removeWithKey } from "../state/membership";
import { useSession } from "../state/session";

/** People and agents of a chat, with the add and remove controls the caller may use. */
export function MembersRail({ chatId }: { chatId: string }) {
  const { chats, engine, user, refreshChats } = useSession();
  const chat = chats.find((c) => c.id === chatId);
  const [people, setPeople] = useState<DirectoryEntry[]>([]);
  const roster = useAgents().agents ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [focusRow, setFocusRow] = useState<{ id: string; kind: "confirm" | "remove" } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const isOwner = chat?.members.some((m) => m.member_id === user.id && m.role === "owner") ?? false;
  const canAddPeople = isOwner || chat?.kind === "room";

  useEffect(() => {
    if (!focusRow) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-focus="${focusRow.kind}-${focusRow.id}"]`)
      ?.focus();
    setFocusRow(null);
  }, [focusRow]);

  useEffect(() => {
    if (canAddPeople) fetchDirectory().then(setPeople, () => {});
  }, [canAddPeople]);

  if (!chat || !engine) return null;
  const ids = new Set(chat.members.map((m) => m.member_id));
  const ctx = { engine, chat, refresh: refreshChats };
  const addablePeople = canAddPeople ? people.filter((p) => !ids.has(p.id)) : [];
  // workspace agents: any member (the bridge enforces the rest); personal agents: the chat owner
  const addableAgents = roster.filter(
    (a) => !ids.has(a.id) && (a.scope === "workspace" || isOwner),
  );

  async function run(job: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await job();
      // the removed row is gone: park focus on the member list
      listRef.current?.focus();
      return true;
    } catch {
      setError("Couldn't update the members. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const canRemove = (m: ChatMember) =>
    m.member_id !== user.id && (m.agent_scope === "workspace" || isOwner);

  return (
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-3">
      <ul
        ref={listRef}
        tabIndex={-1}
        aria-label="Members"
        className="flex flex-col gap-1 outline-none"
      >
        {chat.members.map((m) => {
          const isAgent = m.member_type === "agent";
          return (
            <li key={m.member_id} className="flex min-h-9 items-center gap-2">
              {isAgent ? (
                <AgentAvatar name={m.display_name} id={m.member_id} size={24} />
              ) : (
                <Avatar name={m.display_name} size={24} />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[13px] text-text-0">
                  <span className="truncate">{m.display_name}</span>
                  {isAgent && m.status && <StatusDot status={m.status} />}
                </div>
                {isAgent && <div className="text-[12px] text-text-2">{agentLabel(m)}</div>}
                {isAgent && m.joined_at !== undefined && (
                  <div className="text-[12px] text-text-3">can read from {timeOf(m.joined_at)}</div>
                )}
                {m.seed && (
                  <div className="text-[12px] text-text-2">demo colleague · hosted on this Mac</div>
                )}
                {m.role === "owner" && <div className="text-[12px] text-text-3">Owner</div>}
              </div>
              {canRemove(m) &&
                (confirming === m.member_id ? (
                  <span className="flex gap-1">
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busy}
                      data-focus={`confirm-${m.member_id}`}
                      aria-label={`Confirm remove ${m.display_name}`}
                      onClick={() => {
                        setConfirming(null);
                        void run(() =>
                          removeWithKey({
                            ...ctx,
                            actor: user.display_name,
                            target: {
                              kind: isAgent ? "agent" : "user",
                              id: m.member_id,
                              name: m.display_name,
                            },
                          }),
                        ).then((ok) => {
                          if (!ok) setFocusRow({ id: m.member_id, kind: "remove" });
                        });
                      }}
                    >
                      Remove?
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Keep ${m.display_name}`}
                      onClick={() => {
                        setConfirming(null);
                        setFocusRow({ id: m.member_id, kind: "remove" });
                      }}
                    >
                      Keep
                    </Button>
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    data-focus={`remove-${m.member_id}`}
                    aria-label={`Remove ${m.display_name}`}
                    onClick={() => {
                      setConfirming(m.member_id);
                      setFocusRow({ id: m.member_id, kind: "confirm" });
                    }}
                  >
                    Remove
                  </Button>
                ))}
            </li>
          );
        })}
      </ul>
      {addablePeople.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="text-[12px] font-normal text-text-2">Add to this chat</h3>
          {addablePeople.map((p) => (
            <div key={p.id} className="flex min-h-9 items-center gap-2 text-[13px]">
              <span className="flex-1 truncate">{p.display_name}</span>
              {p.devices.length === 0 && (
                <span className="text-[12px] text-text-3">hasn't signed in yet</span>
              )}
              <Button
                size="sm"
                disabled={busy || p.devices.length === 0}
                aria-label={`Add ${p.display_name}`}
                onClick={() => run(() => addPersonWithKey({ ...ctx, person: p }))}
              >
                Add
              </Button>
            </div>
          ))}
        </section>
      )}
      {addableAgents.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="text-[12px] font-normal text-text-2">Add an agent</h3>
          {addableAgents.map((a) => (
            <div key={a.id} className="flex min-h-9 items-center gap-2 text-[13px]">
              <AgentAvatar name={a.name} id={a.id} rosterId={a.roster_id} size={20} />
              <span className="flex-1 truncate">{a.name}</span>
              <Button
                size="sm"
                disabled={busy}
                aria-label={`Add agent ${a.name}`}
                onClick={() => run(() => addAgentWithKey({ ...ctx, agent: a }))}
              >
                Add
              </Button>
            </div>
          ))}
        </section>
      )}
      {error && (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
