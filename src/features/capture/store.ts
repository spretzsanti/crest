import { createStore } from "../../lib/store";
import { capture, type CaptureRecState } from "../../platform/services";
import { isNative } from "../../platform/native";
import { demo } from "../../dev/showcase-data";
import { settings } from "../../settings/store";
import { addToShelf } from "../shelf/store";
import type { RecClock } from "./clock";

/*
 * Capture state shared by the tool and the closed notch: the running recording (from
 * Rust's `capture://state`), the last saved file for the notice, and a counter that
 * tells the library to reload.
 */

export const recording = createStore<RecClock & { failed: string[]; audio: boolean }>({ phase: "idle", elapsedMs: 0, at: 0, failed: [], audio: false });

export interface Saved {
  kind: "shot" | "video" | "audio";
  path: string;
  thumb: string | null;
  /** The recording ended early (an error): what was saved is cut short. */
  cut?: boolean;
  /** Date.now() when saved, so a second save in a row shows again. */
  at: number;
}
/** The last saved capture, for the notice in the closed notch (SAVED.showMs). */
export const saved = createStore<Saved | null>(null);
export const libraryEpoch = createStore(0);

function apply(s: CaptureRecState) {
  recording.set({ phase: s.phase, elapsedMs: s.elapsedMs, at: Date.now(), failed: s.failed, audio: s.audio });
  if (s.phase === "idle" && s.path) {
    if (!s.failed.includes("save")) saved.set({ kind: s.audio ? "audio" : "video", path: s.path, thumb: null, cut: s.failed.some((f) => f === "video" || f === "disk" || f === "partial"), at: Date.now() });
    libraryEpoch.set((n) => n + 1);
  }
}

/** Follows recordings started or ended anywhere (a closed window ends one on its own). */
export function startCapture() {
  capture.onState(apply);
  void capture.state().then(apply);
}

export async function takeShot(mode: "all" | "monitor" | "region", monitor: string | null) {
  const shot = await capture.shot(mode, monitor);
  if (!shot) return;
  saved.set({ kind: "shot", path: shot.path, thumb: shot.thumb, at: Date.now() });
  libraryEpoch.set((n) => n + 1);
  if (settings.get().capture.shelf) addToShelf([shot.path]);
}

export async function startRecording(source: string, fps: number, mic: boolean, system: boolean, border: boolean) {
  await capture.start(source, fps, mic, system, border);
  // In the browser there is no Rust to report back.
  if (!isNative) apply({ phase: "recording", elapsedMs: 0, path: null, failed: [], audio: source === "audio" });
}

export function pauseRecording(paused: boolean) {
  void capture.pause(paused);
  if (!isNative) {
    const r = recording.get();
    apply({ phase: paused ? "paused" : "recording", elapsedMs: r.elapsedMs + (r.phase === "recording" ? Date.now() - r.at : 0), path: null, failed: [], audio: r.audio });
  }
}

export function stopRecording() {
  void capture.stop();
  // Demo: the finished recording joins the list and shows its "saved" notice.
  if (!isNative) apply({ phase: "idle", elapsedMs: 0, path: demo ? capture.finishSample(recording.get().audio) : null, failed: [], audio: recording.get().audio });
}
