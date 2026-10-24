import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useMatch, useNavigate } from "react-router";
import { agentDm, agents as fetchAgents } from "../api";
import { Input, Kbd, Overlay, useToast } from "../ds";
import { getTheme, setTheme } from "../shell/theme";
import { useSession } from "../state/session";

type Item = { id: string; group: "Chats" | "Agents" | "Actions"; label: string; run: () => void };

/** Fired for actions the page owns (new chat dialog, relay view, proactive pause). */
export const PALETTE_ACTION_EVENT = "sa:palette-action";
export type PaletteAction = "new-chat" | "toggle-relay" | "pause-proactive";

/** Subsequence match; lower score is better, null means no match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  let at = -1;
  let score = 0;
  for (const ch of q) {
    const next = t.indexOf(ch, at + 1);
    if (next < 0) return null;
    score += at < 0 ? next : next - at - 1;
    at = next;
  }
  return score;
}

/** Opens the palette on Cmd+K or Ctrl+K. */
export function usePaletteHotkey(setOpen: (fn: (open: boolean) => boolean) => void): void {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [setOpen]);
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <Palette onClose={onClose} />;
}

function Palette({ onClose }: { onClose: () => void }) {
  const s = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const current = useMatch("/c/:chatId/*")?.params.chatId;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [agentList, setAgentList] = useState<{ id: string; name: string }[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    fetchAgents().then(
      (a) => live && setAgentList(a.map((x) => ({ id: x.id, name: x.name }))),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  const all = useMemo<Item[]>(() => {
    const act = (a: PaletteAction) => () => {
      window.dispatchEvent(new CustomEvent(PALETTE_ACTION_EVENT, { detail: a }));
    };
    return [
      ...s.chats.map((c) => ({
        id: `chat:${c.id}`,
        group: "Chats" as const,
        label: c.title,
        run: () => navigate(`/c/${encodeURIComponent(c.id)}`),
      })),
      ...agentList.flatMap((a) => [
        {
          id: `profile:${a.id}`,
          group: "Agents" as const,
          label: `Open ${a.name} profile`,
          run: () => navigate(`/agents/${encodeURIComponent(a.id)}`),
        },
        {
          id: `ask:${a.id}`,
          group: "Agents" as const,
          label: `Ask ${a.name}…`,
          run: () => {
            const general = s.chats.find((c) => c.seed_key === "general")?.id;
            const target = current ?? general;
            navigate(target ? `/c/${encodeURIComponent(target)}` : "/", {
              state: { compose: { text: `@${a.name} ` } },
            });
          },
        },
        {
          id: `dm:${a.id}`,
          group: "Agents" as const,
          label: `Message ${a.name}`,
          run: () => {
            agentDm(a.id).then(
              (dm) => navigate(`/c/${encodeURIComponent(dm.id)}`),
              () => toast.push(`Could not open a chat with ${a.name}.`, "error"),
            );
          },
        },
      ]),
      { id: "act:new", group: "Actions", label: "New chat", run: act("new-chat") },
      { id: "act:relay", group: "Actions", label: "Toggle relay view", run: act("toggle-relay") },
      {
        id: "act:theme",
        group: "Actions",
        label: "Toggle theme",
        run: () => setTheme(getTheme() === "dark" ? "light" : "dark"),
      },
      {
        id: "act:pause",
        group: "Actions",
        label: "Pause all proactive posts",
        run: act("pause-proactive"),
      },
      { id: "act:agents", group: "Actions", label: "Open agents", run: () => navigate("/agents") },
    ];
  }, [s.chats, agentList, navigate, toast, current]);
  const items = useMemo(
    () =>
      all
        .map((i) => ({ i, score: fuzzyScore(query, i.label) }))
        .filter((x): x is { i: Item; score: number } => x.score !== null)
        .sort((a, b) => a.score - b.score)
        .map((x) => x.i),
    [all, query],
  );

  const sel = Math.min(active, Math.max(0, items.length - 1));
  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView?.({ block: "nearest" });
  }, [sel]);

  function run(item: Item | undefined) {
    if (!item) return;
    onClose();
    item.run();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(items.length ? (sel + 1) % items.length : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(items.length ? (sel - 1 + items.length) % items.length : 0);
    } else if (e.key === "Enter") {
      if (e.nativeEvent.isComposing || e.keyCode === 229 || e.nativeEvent.key === "Process") return;
      e.preventDefault();
      run(items[sel]);
    }
  }

  return (
    <Overlay
      onEscape={onClose}
      className="fixed inset-0 z-40 grid place-items-start justify-center bg-black/30 pt-[15vh]"
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes the palette */}
      <div className="fixed inset-0 -z-10" onMouseDown={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-[min(560px,92vw)] overflow-hidden rounded-lg border border-border-soft bg-bg-1 shadow-lg"
      >
        <div className="border-border-soft border-b p-2">
          <Input
            data-autofocus
            label="Search chats, agents and actions"
            hideLabel
            placeholder="Search chats, agents and actions…"
            role="textbox"
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={items[sel] ? `pal-${items[sel].id}` : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            className="w-full"
          />
        </div>
        <div
          id="palette-list"
          ref={listRef}
          role="listbox"
          aria-label="Results"
          className="max-h-80 overflow-y-auto p-1"
        >
          {items.map((it, i) => (
            <div
              key={it.id}
              tabIndex={-1}
              id={`pal-${it.id}`}
              role="option"
              aria-selected={i === sel}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(it)}
              onKeyDown={() => {}}
              className={`flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 text-[13px] text-text-0 ${i === sel ? "bg-bg-2" : ""}`}
            >
              <span>{it.label}</span>
              <span className="text-[11px] text-text-3">{it.group}</span>
            </div>
          ))}
        </div>
        {items.length === 0 && <div className="px-3 py-1.5 text-text-2">No matches</div>}
        <div role="status" aria-live="polite" className="sr-only">
          {items.length === 1 ? "1 result" : `${items.length} results`}
        </div>
        <div className="flex gap-3 border-border-soft border-t px-3 py-1.5 text-[11px] text-text-3">
          <span>
            <Kbd>↑↓</Kbd> move
          </span>
          <span>
            <Kbd>Enter</Kbd> run
          </span>
          <span>
            <Kbd>Esc</Kbd> close
          </span>
        </div>
      </div>
    </Overlay>
  );
}
