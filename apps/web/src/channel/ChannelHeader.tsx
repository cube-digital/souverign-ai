// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import type { Chat } from "@sa/protocol";
import { useState } from "react";
import { useNavigate } from "react-router";
import { callApi } from "../call/api";
import { Avatar, Button, Icons } from "../ds";
import { useRail } from "../shell/rail";
import { useSession } from "../state/session";
import { AgentStatusChip } from "./AgentMessage";

/** A fresh LiveKit media key: base64url of 32 random bytes. It only ever goes into the encrypted call message. */
function newMediaKey(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function callError(e: unknown): string {
  const status = (e as { status?: number } | null)?.status;
  if (status === 429) return "Too many calls were started. Try again in a minute.";
  if (status === 503) return "Calls are not available: the call server is not running on this Mac.";
  return "Could not start the call. Try again in a moment.";
}

/** Title, topic, members and the rail buttons of a chat. */
export function ChannelHeader({ chat }: { chat: Chat }) {
  const rail = useRail();
  const { user, engine } = useSession();
  const navigate = useNavigate();
  const [calling, setCalling] = useState(false);
  const [callNote, setCallNote] = useState<string | null>(null);
  const people = chat.members.filter((m) => m.member_type === "user");
  const agents = chat.members.filter((m) => m.member_type === "agent");
  const relayOpen = rail.panel?.kind === "relay";
  async function startCall() {
    if (!engine || calling) return;
    setCalling(true);
    setCallNote(null);
    try {
      const { call } = await callApi.start(chat.id);
      if (call.anchor_message_id === null) {
        const id = await engine.sendText(chat.id, `${user.display_name} started a call.`, {
          call: { call_id: call.id, op: "started", media_key: newMediaKey() },
        });
        await callApi.anchor(call.id, id);
      }
      navigate(`/c/${encodeURIComponent(chat.id)}/call/${encodeURIComponent(call.id)}`);
    } catch (e) {
      setCallNote(callError(e));
    } finally {
      setCalling(false);
    }
  }

  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-border-soft px-4 py-2">
      <div className="min-w-0 flex-1 basis-60">
        <h1 className="flex items-center gap-1 text-[15px] font-semibold text-text-0">
          <Icons.Hash />
          <span className="truncate">{chat.title}</span>
        </h1>
        {chat.topic && <p className="truncate text-[12px] text-text-2">{chat.topic}</p>}
      </div>
      <div className="flex items-center gap-1">
        {people.slice(0, 5).map((p) => (
          <span key={p.member_id} title={p.display_name}>
            <Avatar name={p.display_name} size={20} />
          </span>
        ))}
      </div>
      <ul className="flex flex-wrap items-center gap-2 text-[12px] text-text-1">
        {agents.map((a) => (
          <li key={a.member_id} className="inline-flex items-center gap-1">
            <AgentStatusChip status={a.status} />
            {a.display_name}
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        aria-label="Members"
        onClick={() => rail.open({ kind: "members", chatId: chat.id })}
      >
        <Icons.Users />
        <span>{people.length + agents.length}</span>
      </Button>
      <Button size="sm" onClick={() => rail.open({ kind: "activity", chatId: chat.id })}>
        <Icons.Pulse />
        Activity
      </Button>
      <Button size="sm" onClick={() => rail.open({ kind: "notes", chatId: chat.id })}>
        Notes
      </Button>
      <Button size="sm" disabled={calling} onClick={() => void startCall()}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2" />
        </svg>
        Start call
      </Button>
      {callNote && (
        <p role="alert" className="w-full text-[12px] text-danger">
          {callNote}
        </p>
      )}
      <Button
        size="sm"
        aria-pressed={relayOpen}
        onClick={() => (relayOpen ? rail.close() : rail.open({ kind: "relay", chatId: chat.id }))}
      >
        Relay
      </Button>
    </header>
  );
}
