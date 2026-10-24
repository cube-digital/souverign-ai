import { useState } from "react";
import { getSession, type Session, setSession } from "./api";
import { Login } from "./pages/Login";
import { Shell } from "./ui/Shell";

export function App() {
  const [session, setSessionState] = useState<Session | null>(getSession);

  if (!session) return <Login onSignedIn={setSessionState} />;
  return (
    <Shell
      userName={session.user.display_name}
      onSwitchUser={() => {
        setSession(null);
        setSessionState(null);
      }}
    >
      <div className="flex h-full items-center justify-center text-muted">
        Your chats appear here
      </div>
    </Shell>
  );
}
