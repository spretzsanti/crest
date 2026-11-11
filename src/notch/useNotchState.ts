import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createStore } from "../lib/store";
import { isNative, setPinned } from "../platform/native";
import { hoverDelayMs, settings } from "../settings/store";
import { closeDelayMs } from "../features/window/model";

export type NotchStatus = "closed" | "peek" | "open";

/** Grace period on leave, so slipping off briefly doesn't close it (the close delay in the settings). */
const closeDelay = () => closeDelayMs[settings.get().behavior.closeDelay];

/*
 * "Hold": while dragging (seeking, drag and drop) the notch stays open and
 * clickable even if the cursor leaves briefly. A counter, so several places
 * can hold at once.
 */
const holds = createStore(0);

export function holdOpen(on: boolean) {
  holds.set((n) => Math.max(0, n + (on ? 1 : -1)));
  setPinned(holds.get() > 0);
}

/*
 * After work done away from the notch (a colour picked elsewhere on the screen) the result should stay in view, and
 * switching to a narrower or shorter tool (the dock, the wheel, a link in a tool) can leave the pointer outside the new
 * panel: the notch does not close on its own until the pointer has been over it again. A click elsewhere still closes
 * it. Moves while the panel is still resizing do not count, as the old, bigger panel is under the pointer then (#29).
 */
let awaitVisit = false;
let awaitFrom = 0;
/** springs.morph (0.36 s) and the tail of its bounce. */
const SETTLE_MS = 500;
export function stayUntilVisit() {
  awaitVisit = true;
  awaitFrom = performance.now();
}
/** The pointer moved over the notch. */
export function visited() {
  if (performance.now() - awaitFrom >= SETTLE_MS) awaitVisit = false;
}

/*
 * Pin (top right): the notch stays open even when the cursor leaves or another
 * app takes focus, e.g. to drag files from Explorer or copy a key from the
 * browser. Unlike `holdOpen`, the window stays click-through outside the notch.
 * Esc / the shortcut close and unpin it.
 */
export const pinned = createStore(false);

export function togglePin() {
  pinned.set((p) => !p);
}

/*
 * The pointer is on a button of a closed-notch notice (snooze, done, dismiss), or has just used one. Hovering
 * must not open the notch then, or the button would vanish before the click. Cleared when the pointer leaves.
 */
export const noticeHover = createStore(false);

/** The notch is open: the closed row and its notices (a break, say) are not on screen. */
export const notchOpen = createStore(false);

/**
 * Notch state machine:
 *
 *   closed ──hover──▶ peek ──hover held / click──▶ open
 *     ▲                 │                               │
 *     └────leave────┘◀──leave (grace) / Esc / click outside
 *
 *   Shortcut: closed ⇄ open directly, no peek and no delay.
 *   While typing, holding or pinned, leaving doesn't close.
 *
 *   close()   close on purpose (Esc, shortcut), also unpins.
 *   dismiss() close casually (click outside, focus loss), not when pinned.
 */
export function useNotchState() {
  const [status, setStatusState] = useState<NotchStatus>("closed");
  const statusRef = useRef<NotchStatus>("closed");
  const hovering = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  const setStatus = useCallback((s: NotchStatus) => {
    statusRef.current = s;
    setStatusState(s);
    if (notchOpen.get() !== (s === "open")) notchOpen.set(s === "open");
    if (isNative) void invoke("notch_set_expanded", { expanded: s === "open" }).catch(() => {});
  }, []);

  const later = useCallback(
    (ms: number, s: NotchStatus) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        if (s === "open" && statusRef.current === "peek" && noticeHover.get()) return;
        setStatus(s);
      }, ms);
    },
    [setStatus],
  );

  const open = useCallback(() => {
    window.clearTimeout(timer.current);
    setStatus("open");
  }, [setStatus]);

  const close = useCallback(() => {
    window.clearTimeout(timer.current);
    awaitVisit = false;
    pinned.set(false);
    setStatus("closed");
  }, [setStatus]);

  const dismiss = useCallback(() => {
    // Held (dragging, Windows Hello dialog in front) counts like pinned.
    if (pinned.get() || holds.get() > 0) return;
    window.clearTimeout(timer.current);
    awaitVisit = false;
    setStatus("closed");
  }, [setStatus]);

  /** For the shortcut: open/close directly without peek. Returns the new state. */
  const toggle = useCallback((): NotchStatus => {
    if (statusRef.current === "open") {
      close();
      return "closed";
    }
    open();
    return "open";
  }, [open, close]);

  const onPointerEnter = useCallback(() => {
    hovering.current = true;
    visited();
    window.clearTimeout(timer.current);
    if (statusRef.current === "closed") {
      setStatus("peek");
      // "Click" mode: only nudge, open on click.
      const s = settings.get();
      if (s.openMode === "hover") later(hoverDelayMs[s.hoverDelay], "open");
    }
  }, [setStatus, later]);

  const onPointerLeave = useCallback(() => {
    hovering.current = false;
    noticeHover.set(false);
    window.clearTimeout(timer.current);
    if (statusRef.current === "peek") setStatus("closed");
    else if (statusRef.current === "open" && mayAutoClose()) later(closeDelay(), "closed");
  }, [setStatus, later]);

  // Hold ended and the cursor is outside → handle the missed leave now.
  useEffect(
    () =>
      holds.subscribe(() => {
        if (!hovering.current && statusRef.current === "open" && mayAutoClose()) {
          later(closeDelay(), "closed");
        }
      }),
    [later],
  );

  // Off a notice button but still on the notch (peeking) → the hover delay starts again.
  useEffect(
    () =>
      noticeHover.subscribe(() => {
        const s = settings.get();
        if (!noticeHover.get() && hovering.current && statusRef.current === "peek" && s.openMode === "hover") later(hoverDelayMs[s.hoverDelay], "open");
      }),
    [later],
  );

  // Unpinned and the cursor is outside → close now.
  useEffect(
    () =>
      pinned.subscribe(() => {
        if (!pinned.get() && !hovering.current && statusRef.current === "open" && mayAutoClose()) later(closeDelay(), "closed");
      }),
    [later],
  );

  // Esc closes directly.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(timer.current);
    };
  }, [close]);

  return { status, open, close, dismiss, toggle, onPointerEnter, onPointerLeave };
}

function mayAutoClose(): boolean {
  return !pinned.get() && holds.get() === 0 && !awaitVisit && !isEditing();
}

function isEditing(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}
