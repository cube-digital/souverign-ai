// Ported from donna (MIT License, Copyright (c) 2026 Cube Digital). See THIRD_PARTY_NOTICES.md.
import { type ReactNode, useEffect, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { IconButton, Icons } from "../ds";

const MOBILE = "(max-width: 767px)";

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => window.matchMedia?.(MOBILE).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(MOBILE);
    if (!mq) return;
    const on = () => setMobile(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

const HANDLE = "w-px shrink-0 bg-border-soft transition-colors hover:bg-border-strong";

function RailBox({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <aside aria-label="Details" className="flex h-full min-h-0 flex-col bg-bg-1">
      <div className="flex h-9 shrink-0 items-center justify-end border-b border-border-soft px-2">
        <IconButton label="Close panel" onClick={onClose}>
          <Icons.X />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </aside>
  );
}

export function AppShell({
  sidebar,
  main,
  rail,
  onCloseRail,
}: {
  sidebar: ReactNode;
  main: ReactNode;
  rail: ReactNode | null;
  onCloseRail: () => void;
}) {
  const mobile = useIsMobile();
  const [drawer, setDrawer] = useState(false);
  const hasRail = rail !== null && rail !== undefined;
  const panelIds = hasRail ? ["sidebar", "main", "rail"] : ["sidebar", "main"];
  const layout = useDefaultLayout({ id: "sa-shell", panelIds, storage: localStorage });

  if (mobile) {
    return (
      <div className="relative flex h-full min-h-0 flex-col bg-bg-0">
        <div className="flex h-9 shrink-0 items-center border-b border-border-soft px-2">
          <IconButton label="Open chats" onClick={() => setDrawer(true)}>
            <Icons.Menu />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1">{main}</div>
        {drawer && (
          <div className="fixed inset-0 z-30 flex">
            <div className="h-full w-72 max-w-[85%] border-r border-border-soft bg-bg-1">
              {/* biome-ignore lint/a11y/noStaticElementInteractions: the drawer closes when a chat row is picked */}
              <div role="presentation" className="h-full" onClick={() => setDrawer(false)}>
                {sidebar}
              </div>
            </div>
            <button
              type="button"
              aria-label="Close chats"
              className="flex-1 cursor-pointer bg-black/50"
              onClick={() => setDrawer(false)}
            />
          </div>
        )}
        {hasRail && (
          <div className="fixed inset-0 z-30 bg-bg-1">
            <RailBox onClose={onCloseRail}>{rail}</RailBox>
          </div>
        )}
      </div>
    );
  }

  return (
    <Group
      id="sa-shell"
      orientation="horizontal"
      className="h-full bg-bg-0"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
    >
      <Panel id="sidebar" defaultSize={260} minSize={200} maxSize={380} className="bg-bg-1">
        {sidebar}
      </Panel>
      <Separator className={HANDLE} />
      <Panel id="main" minSize={320}>
        {main}
      </Panel>
      {hasRail && (
        <>
          <Separator className={HANDLE} />
          <Panel id="rail" defaultSize={360} minSize={280} maxSize={560}>
            <RailBox onClose={onCloseRail}>{rail}</RailBox>
          </Panel>
        </>
      )}
    </Group>
  );
}
