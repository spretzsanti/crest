import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Is the frontend running in the Tauri app (rather than a regular browser)? */
export const isNative = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** The app on a Mac, where the tools built on Windows APIs are hidden (src/notch/tabs.ts). */
export const isMac = isNative && typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/** Reports the hit zone in CSS px relative to the window to Rust (click-through). */
export function setHitRect(rect: { x: number; y: number; w: number; h: number }) {
  if (isNative) void invoke("set_hit_rect", { rect });
}

/** The pet's nest as a second zone that takes the pointer (null: no nest), in the same px as setHitRect. */
export function setPetRect(rect: { x: number; y: number; w: number; h: number } | null) {
  if (isNative) void invoke("set_pet_rect", { rect });
}

/** The pointer came onto the nest or left it; from the Rust poll, since the page sees no pointerleave once the window lets it through. */
export function onPetHover(handler: (inside: boolean) => void): () => void {
  if (!isNative) return () => {};
  const off = listen<boolean>("notch://pet-hover", (e) => handler(e.payload));
  return () => void off.then((f) => f());
}

/** Keeps the window clickable even when the cursor is outside (e.g. while typing). */
export function setPinned(pinned: boolean) {
  if (isNative) void invoke("set_pinned", { pinned });
}

/** Cursor over the hit zone; comes from the Rust poll instead of DOM events. */
export function onNativeHover(handler: (inside: boolean) => void): () => void {
  if (!isNative) return () => {};
  const off = listen<boolean>("notch://hover", (e) => handler(e.payload));
  return () => void off.then((f) => f());
}

/** Where the pointer entered the hit zone, in the page's px; sent just before the hover. */
export function onNativeHoverAt(handler: (x: number, y: number) => void): () => void {
  if (!isNative) return () => {};
  const off = listen<[number, number]>("notch://hover-at", (e) => handler(e.payload[0], e.payload[1]));
  return () => void off.then((f) => f());
}

/** Window lost focus (click into another app). */
export function onNativeBlur(handler: () => void): () => void {
  if (!isNative) return () => {};
  const off = getCurrentWindow().onFocusChanged(({ payload: focused }) => !focused && handler());
  return () => void off.then((f) => f());
}

/** Global shortcut (Ctrl+Alt+Space) was pressed. */
export function onShortcut(handler: () => void): () => void {
  if (!isNative) return () => {};
  const off = listen("notch://shortcut", handler);
  return () => void off.then((f) => f());
}

/** Global shortcut (Alt+Space) for OmniSearch was pressed. */
export function onOmniShortcut(handler: () => void): () => void {
  if (!isNative) return () => {};
  const off = listen("notch://omnisearch", handler);
  return () => void off.then((f) => f());
}

/** OmniSearch sent a file to the Shelf. */
export function onOmniShelf(handler: (path: string) => void): () => void {
  if (!isNative) return () => {};
  const off = listen<string>("notch://omni-shelf", (e) => handler(e.payload));
  return () => void off.then((f) => f());
}

/** OmniSearch created a task. */
export function onOmniTask(handler: (text: string) => void): () => void {
  if (!isNative) return () => {};
  const off = listen<string>("notch://omni-task", (e) => handler(e.payload));
  return () => void off.then((f) => f());
}

const trayHandlers = new Set<(tab: string | null) => void>();

/** Browser demo: the host page opens the notch the way the tray does (src/dev/demo.ts). */
export const demoOpen = (tab: string | null) => (trayHandlers.size ? trayHandlers.forEach((h) => h(tab)) : (waiting = { tab }));
let waiting: { tab: string | null } | null = null;

/** Tray: left click / "Open" (tab = null) or "Settings" (tab = "settings"). */
export function onTrayOpen(handler: (tab: string | null) => void): () => void {
  if (!isNative) {
    trayHandlers.add(handler);
    // An open asked for before the notch was there (the demo's first message) happens now.
    if (waiting) {
      const tab = waiting.tab;
      waiting = null;
      queueMicrotask(() => handler(tab));
    }
    return () => void trayHandlers.delete(handler);
  }
  const off = listen<string | null>("notch://open", (e) => handler(e.payload));
  return () => void off.then((f) => f());
}

/**
 * true: the window takes keyboard focus (after opening via shortcut).
 * false: focus goes back to the previous app if we still have it.
 */
export function keyboardFocus(focus: boolean) {
  if (isNative) void invoke("keyboard_focus", { focus });
}

/** WebView2 memory target: low while the notch sits closed, normal otherwise. */
export function setMemoryLow(low: boolean) {
  if (isNative) void invoke("memory_low", { low });
}

/** The tray menu's texts in the interface language (Rust starts in English). */
export function setTrayTexts(texts: { open: string; settings: string; autostart: string; quit: string }) {
  if (isNative) void invoke("tray_texts", { texts });
}
