import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Open overlays, topmost last; only the topmost reacts to Escape and Tab.
const stack: object[] = [];

/**
 * A layer above the page: rendered in a portal, the rest of the page is inert while it is open,
 * focus moves in, is trapped, and returns to the opener on close. Escape calls `onEscape`
 * unless `busy`.
 */
export function Overlay({
  children,
  onEscape,
  busy = false,
  className,
}: {
  children: ReactNode;
  onEscape: () => void;
  busy?: boolean;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef({ onEscape, busy });
  latest.current = { onEscape, busy };

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const token = {};
    stack.push(token);
    const opener = document.activeElement as HTMLElement | null;
    const inerted: HTMLElement[] = [];
    for (const el of document.body.children) {
      if (el instanceof HTMLElement && !el.contains(node) && !el.inert) {
        el.inert = true;
        inerted.push(el);
      }
    }
    (
      node.querySelector<HTMLElement>("[data-autofocus]") ??
      node.querySelector<HTMLElement>(FOCUSABLE) ??
      node
    ).focus();
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== token) return;
      if (e.key === "Escape") {
        if (!latest.current.busy) latest.current.onEscape();
        return;
      }
      if (e.key !== "Tab") return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        return;
      }
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      stack.splice(stack.indexOf(token), 1);
      for (const el of inerted) el.inert = false;
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return createPortal(
    <div ref={box} tabIndex={-1} className={className}>
      {children}
    </div>,
    document.body,
  );
}
