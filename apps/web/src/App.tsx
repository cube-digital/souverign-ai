import { useState } from "react";
import { BrowserRouter } from "react-router";
import { getSession, type Session, setSession } from "./api";
import { AppFrame } from "./app/routes";
import { ApprovalsProvider } from "./approvals/store";
import { ToastProvider } from "./ds";
import { Login } from "./pages/Login";
import { RailProvider } from "./shell/rail";
import { resetAgents } from "./state/agents";
import { SessionProvider } from "./state/session";

export function App() {
  const [session, setSessionState] = useState<Session | null>(getSession);

  if (!session) return <Login onSignedIn={setSessionState} />;
  return (
    <ToastProvider>
      <SessionProvider session={session}>
        <BrowserRouter>
          <RailProvider>
            <ApprovalsProvider>
              <AppFrame
                onSwitchUser={() => {
                  setSession(null);
                  resetAgents();
                  setSessionState(null);
                }}
              />
            </ApprovalsProvider>
          </RailProvider>
        </BrowserRouter>
      </SessionProvider>
    </ToastProvider>
  );
}
