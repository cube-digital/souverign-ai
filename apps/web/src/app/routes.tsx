import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useMatch, useNavigate } from "react-router";
import { AgentProfilePage } from "../agents/AgentProfilePage";
import { AgentsDirectoryPage } from "../agents/AgentsDirectoryPage";
import { getPrefs, setPrefs } from "../api";
import { useToast } from "../ds";
import { needsWelcome } from "../onboarding/firstRun";
import { WelcomePage } from "../onboarding/WelcomePage";
import {
  CommandPalette,
  PALETTE_ACTION_EVENT,
  type PaletteAction,
  usePaletteHotkey,
} from "../palette/CommandPalette";
import { AppShell } from "../shell/AppShell";
import { NewChatDialog } from "../shell/NewChatDialog";
import { useRail } from "../shell/rail";
import { Sidebar } from "../shell/Sidebar";
import { TopBar } from "../shell/TopBar";
import { useSession } from "../state/session";
import { ChannelPage } from "./ChannelPage";
import { useRightRail } from "./RightRail";

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-[13px] text-text-2">
      {children}
    </div>
  );
}

/** `/`: the welcome page for a first visit, else the first channel (#general first). */
function Home() {
  const { user, chats } = useSession();
  if (needsWelcome(user.id)) return <Navigate to="/welcome" replace />;
  const first =
    chats.find((c) => c.seed_key === "general") ??
    chats.find((c) => c.kind === "room" || c.kind === "group") ??
    chats[0];
  if (first) return <Navigate to={`/c/${encodeURIComponent(first.id)}`} replace />;
  return <Centered>Pick a chat or start a new one</Centered>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/welcome" element={<WelcomePage />} />
      <Route path="/c/:chatId" element={<ChannelPage />}>
        <Route path="t/:rootId" element={null} />
      </Route>
      <Route path="/agents" element={<AgentsDirectoryPage />} />
      <Route path="/agents/:agentId" element={<AgentProfilePage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** The signed-in app: sidebar, top bar, the routed page, the right rail and the palette. */
export function AppFrame({ onSwitchUser }: { onSwitchUser: () => void }) {
  const s = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const rail = useRail();
  const right = useRightRail();
  const [palette, setPalette] = useState(false);
  const [newChat, setNewChat] = useState(false);
  const chatId = useMatch("/c/:chatId/*")?.params.chatId;
  usePaletteHotkey(setPalette);

  const toggleRelay = useCallback(() => {
    if (!chatId) return;
    if (rail.panel?.kind === "relay" && rail.panel.chatId === chatId) rail.close();
    else rail.open({ kind: "relay", chatId });
  }, [chatId, rail]);
  // the palette event listener must always see the latest handler
  const toggleRef = useRef(toggleRelay);
  useEffect(() => {
    toggleRef.current = toggleRelay;
  }, [toggleRelay]);

  useEffect(() => {
    const on = (e: Event) => {
      const action = (e as CustomEvent<PaletteAction>).detail;
      if (action === "new-chat") setNewChat(true);
      else if (action === "toggle-relay") toggleRef.current();
      else if (action === "pause-proactive") {
        getPrefs()
          .then((p) => setPrefs({ ...p, pause_all: true }))
          .then(
            () => toast.push("Proactive posts paused."),
            () => toast.push("Could not pause proactive posts.", "error"),
          );
      }
    };
    window.addEventListener(PALETTE_ACTION_EVENT, on);
    return () => window.removeEventListener(PALETTE_ACTION_EVENT, on);
  }, [toast]);

  return (
    <>
      <AppShell
        sidebar={
          <Sidebar
            activeChatId={chatId ?? null}
            onOpenChat={(id) => navigate(`/c/${encodeURIComponent(id)}`)}
            onOpenAgent={(a) => navigate(`/agents/${encodeURIComponent(a.id)}`)}
            onOpenAgents={() => navigate("/agents")}
            onNewChat={() => setNewChat(true)}
          />
        }
        main={
          <div className="flex h-full min-h-0 flex-col">
            <TopBar
              onToggleRelay={toggleRelay}
              onOpenPalette={() => setPalette(true)}
              onSwitchUser={onSwitchUser}
            />
            {s.phase === "error" && (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-3 border-b border-warn bg-bg-1 px-4 py-2 text-[13px] text-warn-ink"
              >
                <span>Not connected: {s.error ?? "unknown error"}</span>
                <button type="button" onClick={s.retry} className="cursor-pointer underline">
                  Retry
                </button>
              </div>
            )}
            <main className="min-h-0 flex-1 overflow-auto">
              {s.phase === "starting" ? (
                <Centered>Setting up your secure session…</Centered>
              ) : (
                <AppRoutes />
              )}
            </main>
          </div>
        }
        rail={right.node}
        onCloseRail={right.close}
      />
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      {newChat && (
        <NewChatDialog
          onClose={() => setNewChat(false)}
          onCreated={(c) => {
            setNewChat(false);
            navigate(`/c/${encodeURIComponent(c.id)}`);
          }}
        />
      )}
    </>
  );
}
