import type { UserSummary } from "@sa/protocol";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  ApiFailure,
  users as fetchUsers,
  login,
  oidcExchange,
  type Session,
  setSession,
} from "../api";
import { GOOGLE_TRUST_LINE, loginErrorText, takeLoginReturn, useAuthProviders } from "../auth/oidc";
import { Avatar, Button, Input } from "../ds";

export function Login({ onSignedIn }: { onSignedIn: (s: Session) => void }) {
  const [list, setList] = useState<UserSummary[]>([]);
  const [picked, setPicked] = useState<UserSummary | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const providers = useAuthProviders();
  const started = useRef(false);

  // Runs once; no cleanup cancel, because StrictMode double-invokes effects.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const ret = takeLoginReturn();
    if (!ret) return;
    if ("error" in ret) {
      setError(loginErrorText(ret.error));
      return;
    }
    setBusy(true);
    oidcExchange(ret.code)
      .then((s) => {
        setSession(s);
        onSignedIn(s);
      })
      .catch((err) => {
        const status = err instanceof ApiFailure ? err.status : 0;
        setError(loginErrorText(status === 401 ? "expired" : "failed"));
        setBusy(false);
      });
  }, [onSignedIn]);

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
      const status = err instanceof ApiFailure ? err.status : 0;
      setError(
        status === 401
          ? "Wrong PIN"
          : status === 429
            ? "Too many wrong PINs. Wait a minute, then try again."
            : "Cannot reach the server",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-xl border border-border-soft bg-bg-1 p-6">
        <h1 className="mb-1 text-[15px] font-semibold text-text-0">Sovereign Agents</h1>
        <p className="mb-4 text-text-2">Who is signing in?</p>
        {busy && !picked && <p className="mb-4 text-text-2">Signing in…</p>}
        {providers.oidc.map((p) => (
          <a
            key={p.id}
            href={`/api/auth/oidc/${p.id}/start`}
            className="mb-2 inline-flex h-9 w-full cursor-pointer items-center justify-center rounded-md border border-text-0 bg-text-0 px-4 text-[13px] font-semibold text-bg-0 hover:opacity-90"
          >
            Sign in with {p.label}
          </a>
        ))}
        {providers.oidc.length > 0 && (
          <>
            <p className="mb-4 text-[12px] text-text-3">{GOOGLE_TRUST_LINE}</p>
            <p className="mb-3 text-center text-[12px] text-text-3">or pick a demo user</p>
          </>
        )}
        <div className="mb-4 flex flex-col gap-2">
          {list.map((u) => (
            <Button
              key={u.id}
              variant={picked?.id === u.id ? "primary" : "default"}
              size="lg"
              aria-pressed={picked?.id === u.id}
              className="justify-start text-left"
              onClick={() => {
                setPicked(u);
                setPin("");
                setError(null);
              }}
            >
              <Avatar name={u.display_name} size={20} />
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
              <p role="alert" className="text-[12.5px] text-danger">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" size="lg" disabled={busy || pin.length === 0}>
              Sign in
            </Button>
          </form>
        )}
        {!picked && error && (
          <p role="alert" className="text-[12.5px] text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
