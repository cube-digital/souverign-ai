import type { UserSummary } from "@sa/protocol";
import { type FormEvent, useEffect, useState } from "react";
import { ApiFailure, users as fetchUsers, login, type Session, setSession } from "../api";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";

export function Login({ onSignedIn }: { onSignedIn: (s: Session) => void }) {
  const [list, setList] = useState<UserSummary[]>([]);
  const [picked, setPicked] = useState<UserSummary | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchUsers()
      .then(setList)
      .catch(() => setError("Cannot reach the server"));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const session = await login(picked.id, pin);
      setSession(session);
      onSignedIn(session);
    } catch (err) {
      setError(
        err instanceof ApiFailure && err.status === 401 ? "Wrong PIN" : "Cannot reach the server",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="w-full max-w-[420px] rounded-[14px] border border-line bg-panel p-6">
        <h1 className="mb-1 text-lg font-semibold">Sovereign Agents</h1>
        <p className="mb-4 text-muted">Who is signing in?</p>
        <div className="mb-4 flex flex-col gap-2">
          {list.map((u) => (
            <Button
              key={u.id}
              variant={picked?.id === u.id ? "primary" : "secondary"}
              aria-pressed={picked?.id === u.id}
              className="flex items-center gap-3 text-left"
              onClick={() => {
                setPicked(u);
                setPin("");
                setError(null);
              }}
            >
              <Avatar name={u.display_name} size={28} />
              <span>{u.display_name}</span>
            </Button>
          ))}
        </div>
        {picked && (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Input
              label="PIN"
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]*"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            />
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" disabled={busy || pin.length === 0}>
              Sign in
            </Button>
          </form>
        )}
        {!picked && error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
