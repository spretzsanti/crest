import { createStore } from "../../lib/store";
import { terminal as pty, type TerminalMessage } from "../../platform/services";
import { settings } from "../../settings/store";
import { t, tBackend } from "../../i18n";
import { launchPlan } from "./shell";

export type SessionState = "idle" | "starting" | "running" | "exited";
export const sessionState = createStore<SessionState>("idle");
export const terminalOutput = createStore<string>("");

let generation = 0;
let watching = false;
let pending = "";
let unsent = "";
let sending = false;
let focusHandler: (() => void) | null = null;

const decoder = new TextDecoder();

/** Basic ANSI regex to clean up terminal stream codes for lightweight display. */
function stripAnsi(text: string): string {
  return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

export function registerFocusHandler(fn: () => void) {
  focusHandler = fn;
}

export function unregisterFocusHandler() {
  focusHandler = null;
}

export function focusTerminal() {
  focusHandler?.();
}

export function clearTerminalOutput() {
  terminalOutput.set("");
}

export async function send(data: string) {
  unsent += data;
  if (sending) return;
  sending = true;
  while (unsent) {
    const chunk = unsent;
    unsent = "";
    await pty.write(chunk);
  }
  sending = false;
}

/** Starts a new shell, replacing a running one. */
export async function start() {
  const id = ++generation;
  unsent = "";
  sessionState.set("starting");
  watchTool();
  try {
    const shells = await pty.info();
    const plan = launchPlan(settings.get().terminal, shells);
    if (id !== generation) return;

    terminalOutput.set(`[${shells.pwsh ? "PowerShell 7" : shells.powershell ? "Windows PowerShell" : "CMD"}]\r\n`);
    await pty.start(plan, 80, 24, (m) => onMessage(id, m));
    if (id === generation) {
      sessionState.set("running");
      const command = pending;
      pending = "";
      if (command) void send(command);
    } else if (sessionState.get() === "idle") {
      pty.kill();
    }
  } catch (e) {
    if (id !== generation) return;
    pending = "";
    sessionState.set("exited");
    terminalOutput.set((prev) => prev + `\r\n${t("Shell konnte nicht starten: {error}", { error: tBackend(String(e)) })}\r\n`);
  }
}

function onMessage(id: number, m: TerminalMessage) {
  if (id !== generation) return;
  if (m instanceof ArrayBuffer) {
    const raw = decoder.decode(m);
    const clean = stripAnsi(raw);
    terminalOutput.set((prev) => {
      const next = prev + clean;
      // Keep scrollback to last 20,000 chars for lightweight memory usage
      return next.length > 20_000 ? next.slice(-15_000) : next;
    });
    return;
  }
  sessionState.set("exited");
  terminalOutput.set((prev) => prev + `\r\n[${t("Sitzung beendet (Code {code}). Enter startet eine neue.", { code: m.exit })}]\r\n`);
}

/** Ends the shell and clears the screen; the next open starts a fresh one. */
export function endSession() {
  if (sessionState.get() === "idle") return;
  pending = "";
  generation++;
  pty.kill();
  terminalOutput.set("");
  sessionState.set("idle");
}

/** Types `command` and Enter into the shell, starting one if none runs. The caller opens the Terminal tool to show it. */
export function runInTerminal(command: string) {
  const line = command + "\r\n";
  const state = sessionState.get();
  if (state === "running") return void send(line);
  if (!pending.includes(line)) pending += line;
  if (state !== "starting") void start();
}

/** Turning the tool off ends its shell, so nothing keeps running unseen. */
function watchTool() {
  if (watching) return;
  watching = true;
  settings.subscribe(() => {
    if (!settings.get().tools.some((x) => x.id === "terminal" && x.enabled)) endSession();
  });
}

/** Minimal container attach stub for backwards compatibility. */
export async function attachTerminal(_container: HTMLElement): Promise<() => void> {
  if (sessionState.get() === "idle") void start();
  return () => {};
}
