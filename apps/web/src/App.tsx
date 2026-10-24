import { useState } from "react";
import { getSession, type Session, setSession } from "./api";
import { ChatsPage } from "./pages/ChatsPage";
import { Login } from "./pages/Login";
import { SessionProvider } from "./state/session";

export function App() {
  const [session, setSessionState] = useState<Session | null>(getSession);

  if (!session) return <Login onSignedIn={setSessionState} />;
  return (
    <SessionProvider session={session}>
      <ChatsPage
        onSwitchUser={() => {
          setSession(null);
          setSessionState(null);
        }}
      />
    </SessionProvider>
  );
}
