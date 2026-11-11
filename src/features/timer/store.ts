import { useEffect, useState } from "react";
import { createStore } from "../../lib/store";
import { playAlarm, stopAlarm } from "../../lib/sound";
import { settings } from "../../settings/store";
import { focusSoundFor, setFocusSound } from "./focusSound";

export type TimerMode = "focus" | "break";

interface TimerState {
  mode: TimerMode;
  /** Total duration in seconds. */
  duration: number;
  /** End timestamp (Date.now()) while running. */
  endsAt: number | null;
  /** Remaining seconds while paused. */
  remaining: number;
  /** Finished: stays until the user dismisses it (timer view + live activity show it). */
  finished: boolean;
  /** Last custom duration per mode (seconds), shown as its own chip. */
  custom?: Partial<Record<TimerMode, number>>;
  /** Academic Pomodoro: task linked from Google Tasks */
  linkedTask?: {
    id: string;
    projectId: string;
    title: string;
  } | null;
}

/** Limits for custom times (minutes). */
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 180;

export const presets: Record<TimerMode, number[]> = {
  focus: [15 * 60, 25 * 60, 45 * 60],
  break: [5 * 60, 10 * 60, 15 * 60],
};

const initial: TimerState = { mode: "focus", duration: 25 * 60, endsAt: null, remaining: 25 * 60, finished: false };

// Persisted: a running timer survives an app restart.
export const timer = createStore<TimerState>(initial, { persist: "timer" });

/** Is the alarm ringing right now? Not persisted, nothing rings after a restart. */
export const ringing = createStore(false);

/** Focus sound muted from the Timer tool until Crest restarts; the setting stays as it is. */
export const focusMuted = createStore(false);

export function remainingOf(s: TimerState, now = Date.now()): number {
  if (s.endsAt === null) return s.remaining;
  return Math.max(0, (s.endsAt - now) / 1000);
}

export const timerActions = {
  /** Only stop the sound; "finished" stays visible. */
  silence() {
    stopAlarm();
    window.clearTimeout(ringTimeout);
    ringing.set(false);
  },
  /** Dismiss a finished timer: after focus a short break is prepared (not started). */
  dismiss() {
    timerActions.silence();
    timer.set((s) => {
      if (!s.finished) return s;
      const mode: TimerMode = s.mode === "focus" ? "break" : "focus";
      const duration = s.custom?.[mode] ?? (mode === "break" ? presets.break[0] : presets.focus[1]);
      return { ...s, mode, duration, remaining: duration, endsAt: null, finished: false };
    });
  },
  start() {
    timerActions.silence();
    timer.set((s) => ({ ...s, endsAt: Date.now() + s.remaining * 1000, finished: false }));
  },
  pause() {
    timer.set((s) => ({ ...s, remaining: remainingOf(s), endsAt: null }));
  },
  reset() {
    timer.set((s) => ({ ...s, remaining: s.duration, endsAt: null, finished: false }));
  },
  select(mode: TimerMode, duration: number) {
    timerActions.silence();
    timer.set((s) => ({ ...s, mode, duration, remaining: duration, endsAt: null, finished: false }));
  },
  /** Sets a custom duration; values outside the presets are remembered as their own chip. */
  setMinutes(minutes: number) {
    const m = Math.round(Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, minutes)));
    timer.set((s) => {
      const duration = m * 60;
      const custom = presets[s.mode].includes(duration) ? s.custom : { ...s.custom, [s.mode]: duration };
      return { ...s, duration, remaining: duration, endsAt: null, finished: false, custom };
    });
  },
  setLinkedTask(linkedTask: { id: string; projectId: string; title: string } | null) {
    timer.set((s) => ({ ...s, linkedTask }));
  },
  completeLinkedTask() {
    const s = timer.get();
    if (s.linkedTask) {
      import("../todos/store").then(({ todoActions }) => {
        todoActions.done(s.linkedTask!.id);
      });
      timer.set((prev) => ({ ...prev, linkedTask: null }));
    }
  },
};

// Watch for the end (one place for the whole app): one timeout at `endsAt`, no
// polling while nothing runs.
/** An end older than this was missed (app closed, PC asleep): no alarm for it. */
const STALE_MS = 2 * 60_000;
let ringTimeout: number | undefined;
let endTimeout: number | undefined;
let scheduledFor: number | null = null;

function checkEnd() {
  const s = timer.get();
  if (s.endsAt !== null && remainingOf(s) <= 0) {
    timer.set((t) => ({ ...t, remaining: 0, endsAt: null, finished: true }));
    // Ended while Crest was closed or the PC slept: finished, but no alarm at the next login (as with reminders).
    if (Date.now() - s.endsAt > STALE_MS) return;
    const { sound, volume, duration: ring } = settings.get().alarm;
    playAlarm(sound, volume, ring);
    ringing.set(true);
    window.clearTimeout(ringTimeout);
    // Same length as in playAlarm ("until stopped" = at most 2 min).
    ringTimeout = window.setTimeout(() => ringing.set(false), (ring === -1 ? 120 : Math.max(3, ring)) * 1000);
  }
}

function scheduleEnd() {
  const { endsAt } = timer.get();
  if (endsAt === scheduledFor) return;
  window.clearTimeout(endTimeout);
  scheduledFor = endsAt;
  if (endsAt === null) return;
  endTimeout = window.setTimeout(() => {
    scheduledFor = null;
    checkEnd();
    // Woke too early (clock change) or capped: try again.
    scheduleEnd();
    // At most a minute at a time, so a sleep cannot delay the end by its length.
  }, Math.min(60_000, Math.max(0, endsAt - Date.now())));
}
/** The detached timer window (timer.html) shows and controls the timer, but only the notch window rings. */
export const isTimerWindow = location.pathname.endsWith("/timer.html");

if (!isTimerWindow) {
  timer.subscribe(scheduleEnd);
  scheduleEnd();
  // Dismissed or restarted from the detached window: stop the sound here too.
  timer.subscribe(() => {
    if (!timer.get().finished && ringing.get()) timerActions.silence();
  });
  // A timer still running from before Crest started stays silent until it is started again.
  const bootEndsAt = timer.get().endsAt;
  const syncFocusSound = () => {
    const { focusSound, focusVolume } = settings.get().timer;
    setFocusSound(focusSoundFor(timer.get(), focusSound, focusMuted.get(), bootEndsAt), focusVolume);
  };
  timer.subscribe(syncFocusSound);
  settings.subscribe(syncFocusSound);
  focusMuted.subscribe(syncFocusSound);
}

// Both windows share the persisted state: adopt what the other window wrote. Writing the same
// text back to localStorage fires no new event, so this does not loop.
window.addEventListener("storage", (e) => {
  if (e.key !== "notch:timer") return;
  // Read the current value: several writes can arrive as a burst of events.
  const raw = localStorage.getItem("notch:timer");
  if (!raw) return;
  try {
    timer.set(JSON.parse(raw) as TimerState);
  } catch {
    // Broken entry: keep the current state.
  }
});

/**
 * Remaining seconds while the timer runs: once per second, on the boundary where the shown
 * second changes, or every 200 ms with `fast` (looks with tenths).
 */
export function useRemaining(fast = true): number {
  const s = timer.use();
  const running = s.endsAt !== null;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running || !fast) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [running, fast]);
  const tick = useSecondTick(running && !fast, (s.endsAt ?? 0) % 1000);
  // Clamped: for one render after a start the clock may still be from before it.
  return Math.min(s.duration, remainingOf(s, fast ? now : tick));
}

/**
 * Date.now(), re-rendering once each time the second changes while `active`: one setTimeout aimed just past the next boundary, no polling.
 * `phase` (ms) moves the boundary, so a countdown to `endsAt` ticks when its own seconds change (`endsAt % 1000`).
 */
export function useSecondTick(active: boolean, phase = 0): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    let id = 0;
    const next = () => {
      const t = Date.now();
      setNow(t);
      id = window.setTimeout(next, 1000 - ((((t - phase) % 1000) + 1000) % 1000) + 5);
    };
    next();
    return () => window.clearTimeout(id);
  }, [active, phase]);
  return now;
}

export function formatClock(seconds: number): string {
  const s = Math.ceil(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
