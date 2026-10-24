import type { Agent, MessageBody } from "@sa/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { agents as fetchAgents } from "../api";
import { ChatList } from "../chat/ChatList";
import { Composer } from "../chat/Composer";
import { Conversation } from "../chat/Conversation";
import { MembersPanel } from "../chat/MembersPanel";
import { NewChatDialog } from "../chat/NewChatDialog";
import { RelayPanel } from "../chat/RelayPanel";
import { useSession } from "../state/session";
import { Shell } from "../ui/Shell";
import { AgentsPage } from "./AgentsPage";

type FileBody = Extract<MessageBody, { type: "file" }>;

export function ChatsPage({ onSwitchUser }: { onSwitchUser: () => void }) {
  const s = useSession();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newChat, setNewChat] = useState(false);
  const [members, setMembers] = useState(false);
  const [view, setView] = useState<"chats" | "agents">("chats");
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [myAgents, setMyAgents] = useState<Agent[]>([]);
  const loadAgents = useCallback(() => {
    fetchAgents().then(setMyAgents, () => {});
  }, []);
  useEffect(loadAgents, [loadAgents]);
  const active = s.chats.find((c) => c.id === activeId) ?? null;

  useEffect(() => s.openChat(active?.id ?? null), [active?.id, s.openChat]);

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of s.chats)
      for (const m of c.members) for (const d of m.devices) map.set(d.device_id, m.display_name);
    return map;
  }, [s.chats]);

  async function download(body: FileBody) {
    if (!s.engine) return;
    const bytes = await s.engine.downloadFile(body);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: body.mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = body.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  let main: React.ReactNode;
  if (s.phase === "starting") {
    main = <Centered>Setting up your secure session…</Centered>;
  } else if (view === "agents") {
    main = (
      <AgentsPage
        agents={myAgents}
        creating={creatingAgent}
        onCreatingChange={setCreatingAgent}
        onChanged={loadAgents}
      />
    );
  } else if (!active || !s.engine) {
    main = <Centered>Pick a chat or start a new one</Centered>;
  } else {
    const engine = s.engine;
    main = (
      <>
        <Conversation
          chat={active}
          messages={s.messages[active.id] ?? []}
          nameOf={(d) => names.get(d) ?? "Someone"}
          onDownload={download}
          onOpenMembers={() => setMembers(true)}
        />
        <Composer
          title={active.title}
          agentNames={active.members
            .filter((m) => m.member_type === "agent")
            .map((m) => m.display_name)}
          onSendText={(t) => engine.sendText(active.id, t)}
          onSendFile={async (f) =>
            engine.sendFile(active.id, {
              name: f.name,
              mime: f.type || "application/octet-stream",
              bytes: new Uint8Array(await f.arrayBuffer()),
            })
          }
        />
      </>
    );
  }

  return (
    <>
      <Shell
        userName={s.user.display_name}
        onSwitchUser={onSwitchUser}
        nav={
          <ChatList
            chats={s.chats}
            unread={s.unread}
            activeId={active?.id ?? null}
            publicKey={s.publicKey}
            onSelect={(id) => {
              setActiveId(id);
              setView("chats");
            }}
            onNew={() => setNewChat(true)}
            agents={myAgents}
            agentsActive={view === "agents"}
            onOpenAgents={() => setView("agents")}
            onNewAgent={() => {
              setView("agents");
              setCreatingAgent(true);
            }}
          />
        }
        banner={
          s.phase === "error" && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 border-b border-amber-line bg-amber-soft px-4 py-2 text-sm text-amber-text"
            >
              <span>Not connected: {s.error ?? "unknown error"}</span>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={s.retry}
                className="cursor-pointer font-semibold underline"
              >
                Retry
              </button>
            </div>
          )
        }
        aside={<RelayPanel />}
      >
        {main}
      </Shell>
      {newChat && (
        <NewChatDialog
          onClose={() => setNewChat(false)}
          onCreated={(c) => {
            setNewChat(false);
            setActiveId(c.id);
            setView("chats");
          }}
        />
      )}
      {members && active && (
        <MembersPanel
          chatId={active.id}
          onClose={() => {
            setMembers(false);
            loadAgents();
          }}
        />
      )}
    </>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-muted">{children}</div>;
}
