import type { ReactNode } from "react";
import { Avatar } from "./Avatar";
import { TrustStrip } from "./TrustStrip";

export function Shell({
  userName,
  onSwitchUser,
  nav,
  children,
  aside,
}: {
  userName: string;
  onSwitchUser: () => void;
  nav?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-panel px-4 py-2">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="inline-block h-6 w-6 rounded-[7px] bg-teal" />
          <span className="font-semibold">Sovereign Agents</span>
        </div>
        <TrustStrip />
        <div className="flex items-center gap-2 text-sm">
          <Avatar name={userName} size={28} />
          <span>{userName}</span>
          <span className="text-muted">·</span>
          <button
            type="button"
            onClick={onSwitchUser}
            className="cursor-pointer text-muted underline-offset-2 hover:text-text hover:underline"
          >
            switch user
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-wrap">
        <nav
          aria-label="Chats"
          className="min-w-[260px] max-w-full flex-1 basis-[280px] border-r border-line bg-panel md:max-w-[300px] md:flex-none"
        >
          {nav}
        </nav>
        <main className="min-w-0 flex-[3_1_360px]">{children}</main>
        <aside
          aria-label="What the relay sees"
          className="min-w-[320px] max-w-full flex-1 basis-[350px] border-l border-line bg-panel md:max-w-[380px] md:flex-none"
        >
          {aside}
        </aside>
      </div>
    </div>
  );
}
