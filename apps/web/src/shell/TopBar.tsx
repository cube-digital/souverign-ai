// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import { useState } from "react";
import { PendingPill } from "../approvals/PendingPill";
import { GOOGLE_TRUST_LINE, useAuthProviders } from "../auth/oidc";
import { Avatar, Button, Icons, Kbd, Menu } from "../ds";
import { useSession } from "../state/session";
import { getTheme, setTheme } from "./theme";

export function TopBar({
  onToggleRelay,
  onOpenPalette,
  onSwitchUser,
}: {
  onToggleRelay: () => void;
  onOpenPalette: () => void;
  onSwitchUser: () => void;
}) {
  const { user } = useSession();
  const google = useAuthProviders().oidc.length > 0;
  const [theme, setThemeState] = useState(getTheme);
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  };
  return (
    <header className="flex h-9 shrink-0 items-center gap-3 border-b border-border-soft bg-bg-1 px-3">
      <p className="flex min-w-0 items-center gap-1.5 truncate text-[12px] text-text-2">
        <Icons.Lock className="shrink-0" />
        <span className="truncate">
          {google
            ? GOOGLE_TRUST_LINE
            : "Every model runs on this Mac · the relay sees ciphertext only"}
        </span>
      </p>
      <div className="ml-auto flex items-center gap-1.5">
        <PendingPill />
        <Button size="sm" variant="ghost" onClick={onToggleRelay}>
          Relay view
        </Button>
        <Button size="sm" onClick={onOpenPalette}>
          <Icons.Search />
          <span className="sr-only">Command palette</span>
          <Kbd>⌘K</Kbd>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={flip}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {theme === "dark" ? <Icons.Sun /> : <Icons.Moon />}
        </Button>
        <Menu
          label="User menu"
          trigger={
            <>
              <Avatar name={user.display_name} size={18} />
              <span className="text-[13px]">{user.display_name}</span>
            </>
          }
          items={[{ label: "Switch user", onSelect: onSwitchUser }]}
        />
      </div>
    </header>
  );
}
