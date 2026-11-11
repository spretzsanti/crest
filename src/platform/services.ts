import { invoke } from "@tauri-apps/api/core";
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isMac, isNative } from "./native";
import type { BluetoothEvent, LevelEvent, LockEvent, MicEvent, PowerState } from "../notch/row/status";
import type { LaunchPlan, ShellInfo } from "../features/terminal/shell";
import type { TokenReport } from "../features/usage/tokens";
import type { BatteryRaw } from "../features/system/battery";
import type { DrivesRaw } from "../features/system/storage";
import type { RulesPayload } from "../features/window/model";
import type { PartMessage } from "../features/notices/scriptParts";
import type { Ask } from "../features/notices/asks";
import type { PluginManifest } from "../features/plugins/model";
import bundledChangelog from "../changelog.json";
import { demo, photo, sample, sampleAvatar, screenshot, showcaseCall, showcaseFileSizes } from "../dev/showcase-data";
import { demoFiles, demoPaste } from "./drop";

/*
 * Bridges to the Rust services (src-tauri/src/*.rs). In the browser they return
 * sample data so every tool can be designed without the app.
 */

// ---------- Secrets (Credential Manager) ----------

export type SecretName = "t212.key" | "t212.secret" | "ai.anthropic" | "ai.openai" | "ai.openrouter" | "ai.custom" | "discord.secret" | "usage.deepseek" | "usage.zai" | "usage.claude-web" | "github.token" | PortfolioSecret | CalendarSecret;

/** A calendar source's ICS link or CalDAV app password (src-tauri/src/calendar.rs). */
export type CalendarSecret = `calendar.${string}`;

/** Read-only keys of the portfolio providers (src-tauri/src/trading/). */
export type PortfolioSecret = "kraken.key" | "kraken.secret" | "coinbase.key" | "coinbase.secret" | "binance.key" | "binance.secret" | "bitpanda.key" | "etoro.key" | "etoro.user" | "ibkr.token" | "ibkr.query";

const mockSecrets = new Map<SecretName, string>();

export const secrets = {
  has: (name: SecretName): Promise<boolean> =>
    isNative ? invoke<boolean>("secret_has", { name }) : Promise.resolve(mockSecrets.has(name)),
  set: (name: SecretName, value: string): Promise<void> => {
    if (isNative) return invoke("secret_set", { name, value });
    if (value.trim()) mockSecrets.set(name, value.trim());
    else mockSecrets.delete(name);
    return Promise.resolve();
  },
};

// Kept here for code that imports it from services (the portfolio bridge owns it).
import { localDate } from "./portfolio";
export { localDate };

// ---------- AI usage ----------

export type UsageId = "claude" | "codex" | "gemini" | "cursor" | "openrouter" | "deepseek" | "zai";

/** Money on an API-key account: kind is account | key | budget | granted | today | month. */
export interface UsageBalance {
  kind: string;
  amount: number;
  /** The cap the amount belongs to (a key limit). */
  total: number | null;
  currency: string;
}

export interface UsageWindow {
  /** session | weekly | weekly-opus | weekly-sonnet | daily | monthly | model:<Name> */
  kind: string;
  usedPercent: number;
  resetsAt: number | null;
  /** Window length in seconds (for the "on track" marker). */
  windowSecs: number | null;
}

export interface UsageProvider {
  id: UsageId;
  plan: string | null;
  windows: UsageWindow[];
  /** Missing in answers saved by older versions. */
  balances?: UsageBalance[];
  /** not-found | not-signed-in | expired | claude-expired | no-key | bad-key | rate-limited | offline | failed (with data: stale). */
  error: string | null;
  updatedAt: number;
  /** While a 429 pause runs: when the next request goes out. */
  retryAt?: number | null;
}

export function fetchUsage(providers: string[]): Promise<UsageProvider[]> {
  if (isNative) return invoke<UsageProvider[]>("usage_fetch", { providers });
  const now = Date.now();
  const h = 3600_000;
  const d = 86_400_000;
  const all: UsageProvider[] = [
    {
      id: "claude",
      plan: "Max",
      windows: [
        { kind: "session", usedPercent: 44, resetsAt: now + 2.4 * h, windowSecs: 5 * 3600 },
        { kind: "weekly", usedPercent: 61, resetsAt: now + 3.1 * d, windowSecs: 7 * 86_400 },
        { kind: "weekly-opus", usedPercent: 18, resetsAt: now + 3.1 * d, windowSecs: 7 * 86_400 },
      ],
      error: null,
      updatedAt: now,
    },
    {
      id: "codex",
      plan: "Plus",
      windows: [
        { kind: "session", usedPercent: 71, resetsAt: now + 0.8 * h, windowSecs: 5 * 3600 },
        { kind: "weekly", usedPercent: 23, resetsAt: now + 5.2 * d, windowSecs: 7 * 86_400 },
      ],
      error: null,
      updatedAt: now - 4 * 60_000,
    },
    { id: "gemini", plan: null, windows: [{ kind: "session", usedPercent: 12, resetsAt: now + 3.6 * h, windowSecs: 5 * 3600 }], error: null, updatedAt: now },
    { id: "cursor", plan: "Pro", windows: [{ kind: "monthly", usedPercent: 93, resetsAt: now + 11 * d, windowSecs: 30 * 86_400 }], error: null, updatedAt: now },
    {
      id: "openrouter",
      plan: null,
      windows: [{ kind: "key-limit", usedPercent: 62, resetsAt: now + 9 * d, windowSecs: 30 * 86_400 }],
      balances: [
        { kind: "account", amount: 18.4, total: null, currency: "USD" },
        { kind: "today", amount: 0.82, total: null, currency: "USD" },
        { kind: "month", amount: 12.4, total: null, currency: "USD" },
      ],
      error: null,
      updatedAt: now,
    },
    { id: "deepseek", plan: null, windows: [], balances: [{ kind: "account", amount: 42.15, total: null, currency: "CNY" }], error: null, updatedAt: now },
    { id: "zai", plan: "Pro", windows: [], error: "rate-limited", updatedAt: now, retryAt: now + 4 * 60_000 },
  ];
  return new Promise((r) => setTimeout(() => r(all.filter((p) => providers.includes(p.id))), 350));
}

/** Tokens per model from the local Claude Code and Codex logs (src-tauri/src/usage_logs.rs). */
export function fetchUsageTokens(): Promise<TokenReport> {
  if (isNative) return invoke<TokenReport>("usage_tokens");
  // Sample: a steady week of Claude Code and a little Codex, one quarter hour every two hours.
  const now = Date.now(), q = 15 * 60_000;
  const buckets = (models: [string, number][]) =>
    Array.from({ length: 31 * 12 }, (_, i) => now - i * 2 * 3600_000).flatMap((at, i) =>
      models.map(([model, scale]) => ({ at: at - (at % q), model, band: 0, input: 900 * scale, output: 2400 * scale, cacheRead: 40_000 * scale * (1 + (i % 3)), cacheWrite: 3000 * scale, cacheWrite1h: 0 })),
    );
  const report: TokenReport = {
    since: now - 31 * 86_400_000,
    tools: [
      { id: "claude", found: true, files: 214, unreadable: 0, buckets: buckets([["claude-opus-5-5", 3], ["claude-sonnet-5-5", 1], ["claude-haiku-5-5", 0.2]]) },
      { id: "codex", found: true, files: 12, unreadable: 0, buckets: buckets([["gpt-5-codex", 0.5], ["gpt-6-preview", 0.1]]) },
    ],
  };
  return new Promise((r) => setTimeout(() => r(report), 400));
}

// ---------- System ----------

export interface SystemStats {
  cpu: number;
  cpuName: string;
  memUsed: number;
  memTotal: number;
  /** null = no GPU counters. */
  gpu: number | null;
  gpuName: string | null;
  gpuMemUsed: number;
  gpuMemTotal: number;
  /** ms; null = no reply. */
  ping: number | null;
  /** ms since the probe started (monotonic), for rates. */
  at: number;
  /** Per logical processor while the tool is shown; `kind` 0 = the fastest kind of core. */
  cores: { usage: number; kind: number }[];
  cpuMhz: number | null;
  physicalCores: number | null;
  /** Bytes; 0 while the tool is not shown. */
  memCached: number;
  memCommit: number;
  memCommitLimit: number;
  /** Every real adapter; `usage` null while its counters were not read. */
  gpus: GpuReading[];
  /** Cumulative bytes [received, sent]. */
  net: [number, number] | null;
  /** ACPI thermal zones: [zone, kelvin]. */
  zones: [string, number][];
  /** Energy Meter / Power Meter channels: [instance, milliwatts]. */
  energy: [string, number][];
  meter: [string, number][];
  nvml: { name: string; watts: number | null; temp: number | null }[];
  /** From HWiNFO or LibreHardwareMonitor while one of them runs; `source` is the program's name. */
  external: { source: string; cpuTemp: number | null; cpuWatts: number | null; gpus: { name: string; temp: number | null; watts: number | null }[] } | null;
  battery: BatteryRaw | null;
  drives: DrivesRaw | null;
  processes: ProcReading[] | null;
}

export interface GpuReading { key: string; name: string; memTotal: number; usage: number | null; engine: string | null; memUsed: number; temp: number | null }
/** One app: its processes folded by executable name. `cpu` is percent of one core. */
export interface ProcReading { id: string; name: string; path: string | null; count: number; cpu: number; mem: number }
/** Extras the closed row asks for outside the tool. */
export interface SystemWant { net: boolean; temps: boolean; power: boolean; battery: boolean }

/** A program's icon as a PNG data URL. */
export const systemIcon = (path: string): Promise<string | null> => (isNative ? invoke<string | null>("system_icon", { path }) : Promise.resolve(null));

let mock = { cpu: 18, gpu: 32, ping: 14, rx: 0, tx: 0, at: 0 };
/** `full = false`: CPU and RAM only (GPU and ping come back as null / 0) plus what `want` asks; `withGpu` adds the GPU without the ping. */
export function fetchSystem(full: boolean, withGpu = false, want?: SystemWant): Promise<SystemStats> {
  if (isNative) return invoke<SystemStats>("system_stats", { full, withGpu, want });
  const walk = (v: number, step: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v + (Math.random() - 0.5) * step));
  mock = { cpu: walk(mock.cpu, 14, 3, 96), gpu: walk(mock.gpu, 18, 0, 99), ping: walk(mock.ping, 6, 8, 60), rx: mock.rx + Math.random() * 4e6, tx: mock.tx + Math.random() * 3e5, at: performance.now() };
  const gb = 1024 ** 3;
  const all = { net: true, temps: true, power: true, battery: true, ...want, ...(full ? { net: true, temps: true, power: true, battery: true } : {}) };
  const gpus: GpuReading[] = [
    { key: "luid_a", name: "GeForce RTX 4070 Ti", memTotal: 12 * gb, usage: full || withGpu ? mock.gpu : null, engine: "3D", memUsed: 2.9 * gb, temp: all.temps ? 54 + mock.gpu / 5 : null },
    { key: "luid_b", name: "Radeon Graphics", memTotal: 0.5 * gb, usage: full || withGpu ? 2 : null, engine: "VideoDecode", memUsed: 0.2 * gb, temp: null },
  ];
  return Promise.resolve({
    at: mock.at,
    cores: full ? Array.from({ length: 16 }, (_, i) => ({ usage: walk(mock.cpu, 40, 0, 100), kind: i < 8 ? 0 : 1 })) : [],
    cpuMhz: full ? 4200 + Math.random() * 600 : null,
    physicalCores: full ? 12 : null,
    memCached: full ? 6.2 * gb : 0,
    memCommit: full ? 21 * gb : 0,
    memCommitLimit: full ? 37 * gb : 0,
    gpus,
    net: all.net ? [mock.rx, mock.tx] : null,
    zones: all.temps ? [["\\_TZ.CPUZ", 320 + mock.cpu / 4]] : [],
    energy: all.power ? [["RAPL_Package0_PKG", 20000 + mock.cpu * 600]] : [],
    meter: [],
    nvml: all.power ? [{ name: "NVIDIA GeForce RTX 4070 Ti", watts: 40 + mock.gpu * 2, temp: 55 }] : [],
    external: null,
    battery: all.battery ? { status: 1, rateMw: -14000, remainingMwh: 41000, fullMwh: 62000, designMwh: 70000, ac: false, percent: 66, lifeSecs: null, saver: false } : null,
    drives: full
      ? {
          volumes: [{ letter: "C:", total: 931 * gb, free: 402 * gb, disk: 0 }, { letter: "D:", total: 1863 * gb, free: 911 * gb, disk: 1 }],
          disks: [{ number: 0, model: "Samsung SSD 990 PRO 1TB", bus: 17, removable: false, ssd: true, temp: [41, 82, 85] }, { number: 1, model: "WD Blue SN580 2TB", bus: 17, removable: false, ssd: true, temp: [38, 0, 0] }],
        }
      : null,
    processes: full
      ? [
          { id: "chrome.exe", name: "Google Chrome", path: null, count: 24, cpu: mock.cpu * 2, mem: 3.1 * gb },
          { id: "code.exe", name: "Visual Studio Code", path: null, count: 11, cpu: 22, mem: 1.4 * gb },
          { id: "discord.exe", name: "Discord", path: null, count: 6, cpu: 4, mem: 0.7 * gb },
          { id: "spotify.exe", name: "Spotify", path: null, count: 5, cpu: 3, mem: 0.4 * gb },
          { id: "explorer.exe", name: "Windows Explorer", path: null, count: 1, cpu: 1.2, mem: 0.2 * gb },
          { id: "msedgewebview2.exe", name: "Microsoft Edge WebView2", path: null, count: 8, cpu: 5, mem: 0.6 * gb },
        ]
      : null,
    cpu: mock.cpu,
    cpuName: "Ryzen 7 7800X3D 8-Core",
    memUsed: 13.4 * gb + Math.random() * 0.3 * gb,
    memTotal: 32 * gb,
    gpu: full || withGpu ? mock.gpu : null,
    gpuName: "GeForce RTX 4070 Ti",
    gpuMemUsed: full || withGpu ? 2.9 * gb + (mock.gpu / 100) * 3 * gb : 0,
    gpuMemTotal: 12 * gb,
    ping: full ? Math.round(mock.ping) : null,
  });
}

// ---------- Dropped files ----------

export type FileKind = "image" | "audio" | "video" | "document" | "table" | "other";

export interface DroppedFile {
  path: string;
  name: string;
  kind: FileKind;
  ext: string;
  size: number;
}

export function probeFiles(paths: string[]): Promise<{ files: DroppedFile[] }> {
  if (isNative) return invoke("convert_probe", { paths });
  // Browser: paths are made-up names from the drop event.
  const files = paths.map((p) => {
    const name = p.split(/[\\/]/).pop() ?? p;
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    const kind: FileKind = /^(png|jpe?g|webp|bmp|gif|ico|tiff?|dds|tga)$/.test(ext)
      ? "image"
      : /^(mp3|wav|flac|m4a|aac|ogg|opus)$/.test(ext)
        ? "audio"
        : /^(mp4|mov|mkv|avi|webm)$/.test(ext)
          ? "video"
          : /^(txt|md|markdown|html?|pdf|docx)$/.test(ext)
            ? "document"
            : /^(xlsx|xlsm|xls|ods|csv|tsv)$/.test(ext)
              ? "table"
              : "other";
    return { path: p, name, kind, ext, size: demoFiles.get(p)?.size ?? (sample ? showcaseFileSizes[name] : undefined) ?? 1_400_000 + name.length * 91_000 };
  });
  return Promise.resolve({ files });
}

export function revealFile(path: string): Promise<void> {
  return isNative ? invoke("reveal_file", { path }) : Promise.resolve();
}

export function openFile(path: string): Promise<void> {
  if (isNative) return invoke("open_path", { path });
  // Demo: a file the visitor dropped opens from their own browser memory; the sample files have nothing to open.
  const file = demoFiles.get(path);
  if (file && /^(image|text|application\/pdf)/.test(file.type)) window.open(URL.createObjectURL(file), "_blank", "noopener");
  return Promise.resolve();
}

/** GitHub Sponsors in the default browser. */
export function openSponsors() {
  if (isNative) void invoke("open_sponsors");
  else window.open("https://github.com/sponsors/andrealo20", "_blank", "noopener");
}

/** GitHub's bug report form, with Crest's version filled in (src-tauri lib.rs). */
/** Overview's search line: the results in the default browser (lib.rs `web_search`, which builds the address). Not in the browser demo. */
export function webSearch(engine: string, query: string): Promise<void> {
  return isNative ? invoke("web_search", { engine, query }) : Promise.resolve();
}

export function openBugReport() {
  if (isNative) void invoke("open_bug_report");
  else window.open("https://github.com/andrealo20/crest/issues/new?template=bug_report.yml", "_blank", "noopener");
}

/** Crest's rating page in the Microsoft Store app (Store build only). */
export function openStoreReview() {
  if (isNative) void invoke("open_store_review");
}

/** Puts files on the clipboard (Ctrl+V in Explorer pastes them). */
export function copyFiles(paths: string[]): Promise<void> {
  return isNative ? invoke("copy_files", { paths }) : Promise.resolve();
}

export function filePreview(path: string): Promise<string | null> {
  if (isNative) return invoke<string | null>("file_preview", { path });
  const file = demoFiles.get(path);
  if (demo) return Promise.resolve(file?.type.startsWith("image/") ? URL.createObjectURL(file) : /\.png$/i.test(path) ? samplePicture(path) : null);
  return Promise.resolve(null);
}

/** Demo: a picture for the sample images on the Shelf, drawn here so nothing is fetched. */
function samplePicture(path: string): string {
  return /banner|dusk/i.test(path) ? photo(640, 360) : screenshot(640, 360);
}

// ---------- Updates ----------

let buildInfo: Promise<{ store: boolean }> | undefined;

/** Which build runs, asked once: the Microsoft Store build (Cargo feature `store`) is updated by the Store only. */
export const build = {
  info: (): Promise<{ store: boolean }> => (buildInfo ??= isNative ? invoke<{ store: boolean }>("build_info") : Promise.resolve({ store: false })),
};

export interface SystemDiagnostics {
  os: string | null;
  build: string | null;
  arch: string;
  machine: string | null;
  scales: number[];
}

/** Windows, architecture and monitor scales for Copy diagnostics (lib.rs diagnostics_info). */
export const systemDiagnostics = (): Promise<SystemDiagnostics> =>
  isNative
    ? invoke<SystemDiagnostics>("diagnostics_info")
    : Promise.resolve({ os: "Windows 11 Pro", build: "26100", arch: "x86_64", machine: "x86_64", scales: [1.5, 1] });

/** A found update: version + install (downloads, installs, restarts). */
export interface UpdateHandle {
  version: string;
  /** Resolves "page" when it only opened the download page (a read-only portable copy) and the app keeps running. */
  install: (onProgress: (fraction: number) => void) => Promise<"page" | void>;
}

/** What changed in a version (`src/changelog.json`, newest first). */
export interface ChangelogEntry {
  version: string;
  date: string;
  /** `highlight`: shown in bold and bright (e.g. an announcement). Older versions ignore it. */
  items: { en: string; highlight?: boolean }[];
}

/** In the browser, `?update` in the URL fakes an update for testing. */
const mockUpdate: UpdateHandle = {
  version: demo ? "1.0.0" : "1.3.0",
  install: async (onProgress) => {
    for (let i = 1; i <= 20; i++) {
      await new Promise((r) => setTimeout(r, 120));
      onProgress(i / 20);
    }
    // The app restarts after an update; the demo starts over the same way.
    if (demo) location.reload();
  },
};

/** Demo: the "what's new" notice offers an update (src/dev/demo.ts). */
export const demoOffer = { on: false };

export const updater = {
  current: async (): Promise<string> => {
    // Browser: newest bundled version; `?version=1.1.0` fakes an older one (changelog test).
    if (!isNative) return new URLSearchParams(location.search).get("version") ?? bundledChangelog[0].version;
    const { getVersion } = await import("@tauri-apps/api/app");
    return getVersion();
  },
  /** Fetches the signed latest.json from the newest GitHub release. null = up to date. */
  check: async (): Promise<UpdateHandle | null> => {
    if (!isNative) return demoOffer.on || new URLSearchParams(location.search).has("update") ? mockUpdate : null;
    if ((await portable.info()).portable) return portableUpdate();
    const { check } = await import("@tauri-apps/plugin-updater");
    const found = await check();
    if (!found) return null;
    return {
      version: found.version,
      install: async (onProgress) => {
        let total = 0;
        let done = 0;
        // The installer ends the process without Tauri's exit event, so a running recording is finished first.
        // A failed or hung stop never blocks the install: the fragmented MP4 plays as far as it got.
        await Promise.race([invoke("capture_stop").catch(() => {}), new Promise((done) => setTimeout(done, 6000))]);
        await found.downloadAndInstall((e) => {
          if (e.event === "Started") total = e.data.contentLength ?? 0;
          else if (e.event === "Progress" && total) onProgress(Math.min(1, (done += e.data.chunkLength) / total));
        });
        // Windows quits the app itself while installing; otherwise restart here.
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      },
    };
  },
};

/**
 * Changelog of a newer version, before installing it: the same `src/changelog.json`
 * from that release's tag (anonymous, like the update check). null = not reachable.
 */
export async function fetchChangelog(version: string): Promise<ChangelogEntry[] | null> {
  if (!isNative) {
    const items = demo
      ? [{ en: "Quick controls in Overview and a fuller weather tab with the 7 days." }, { en: "Eight cartoon pets that live in a nest beside the notch." }]
      : Array(2).fill({ en: "Example: something new in the upcoming version" });
    return [{ version, date: new Date().toISOString().slice(0, 10), items }, ...bundledChangelog];
  }
  try {
    const r = await fetch(`https://raw.githubusercontent.com/andrealo20/crest/v${version}/src/changelog.json`, {
      signal: AbortSignal.timeout(8000),
    });
    return r.ok ? ((await r.json()) as ChangelogEntry[]) : null;
  } catch {
    return null;
  }
}

// ---------- Autostart ----------

export const autostart = {
  get: (): Promise<boolean> => (isNative ? invoke<boolean>("autostart_get") : Promise.resolve(true)),
  set: (enabled: boolean): Promise<void> => (isNative ? invoke("autostart_set", { enabled }) : Promise.resolve()),
};

// ---------- Display ----------

/** The closed notch as markup (mirror.rs Picture): the page's theme variables, and the `data:` images by index (null = unchanged). */
export interface MirrorPicture { html: string; root: string; theme: string; lang: string; dir: string; images: string[] | null }

export interface MonitorInfo {
  name: string;
  primary: boolean;
  width: number;
  height: number;
  /** Work area (without taskbar): top below the monitor's top edge, and height, in CSS px. */
  workTop: number;
  workHeight: number;
  /** The work area's left edge from the monitor's left, and its width (a taskbar on the left or right), in CSS px. */
  workLeft: number;
  workWidth: number;
}

export const display = {
  monitors: (): Promise<MonitorInfo[]> =>
    isNative
      ? invoke<MonitorInfo[]>("display_monitors")
      : Promise.resolve([
          { name: "\\\\.\\DISPLAY1", primary: true, width: 2560, height: 1440, workTop: 0, workHeight: 1440 - 48, workLeft: 0, workWidth: 2560 },
          { name: "\\\\.\\DISPLAY2", primary: false, width: 1920, height: 1080, workTop: 0, workHeight: 1080 - 48, workLeft: 0, workWidth: 1920 },
        ]),
  /**
   * `y`: window top in CSS px below the monitor's top edge (default 0); `rules`: screen_policy.rs Rules; `zoom`: panel scale (0.8 to 2, panelSize.ts PANEL_SCALES).
   * `edge` and `line`: the screen edge the window hangs from and where (CSS px from the monitor's top or left); `y` is used on top.
   * `along`: the window's length along that edge in CSS px, at least 760 (src/notch/collapsed.ts windowAlong).
   * `mode`: the Monitor setting's "follow" or "all"; with "all", `spots` holds `line` and `y` for every monitor, where mirror.rs puts a copy.
   */
  apply: (config: {
    monitor: string | null;
    mode?: string;
    spots?: { monitor: string; line: number; y: number }[];
    offset: number;
    y?: number;
    gaming: boolean;
    rules: RulesPayload;
    zoom: number;
    edge?: string;
    line?: number;
    along?: number;
  }) => {
    if (isNative) void invoke("display_apply", { config });
  },
  /** With "follow" or "all", the monitor Rust last reported for the pointer (mirror.rs): where it stayed, or whose copy it is over. */
  cursorMonitor: (): Promise<string | null> => (isNative ? invoke<string | null>("display_cursor_monitor") : Promise.resolve(null)),
  onCursorMonitor: (handler: (name: string | null) => void): (() => void) => {
    if (!isNative) return () => {};
    const off = listen<string | null>("notch://cursor-monitor", (e) => handler(e.payload));
    return () => void off.then((f) => f());
  },
  /** A monitor was added, removed, rescaled or got another taskbar. */
  onMonitors: (handler: () => void): (() => void) => {
    if (!isNative) return () => {};
    const off = listen("notch://monitors", () => handler());
    return () => void off.then((f) => f());
  },
  /** The closed notch for the copies on the other monitors (src/notch/mirror.ts); `rect` is its hit zone in the window, CSS px. */
  mirror: (picture: MirrorPicture, rect: { x: number; y: number; w: number; h: number }) => {
    if (isNative) void invoke("mirror_picture_set", { picture, rect });
  },
  fullscreen: (): Promise<boolean> => (isNative ? invoke<boolean>("display_fullscreen") : Promise.resolve(false)),
  /** true while an app covers the notch's monitor in fullscreen. */
  onFullscreen: (handler: (on: boolean) => void): (() => void) => {
    if (!isNative) return () => {};
    const off = listen<boolean>("notch://fullscreen", (e) => handler(e.payload));
    return () => void off.then((f) => f());
  },
};

// ---------- Status alerts (sysevents.rs) ----------

/** State at start, so what is already true (charger in, headphones on) does not alert. */
export interface StatusSeed { power: PowerState | null; online: boolean | null; devices: string[] }
export interface StatusHandlers { seed(s: StatusSeed): void; power(s: PowerState): void; net(online: boolean): void; bt(e: BluetoothEvent): void; level(e: LevelEvent): void; lock(e: LockEvent): void; mic(e: MicEvent): void }

export const status = {
  seed: (): Promise<StatusSeed> => (isNative ? invoke<StatusSeed>("status_seed") : Promise.resolve(mockStatus.seed())),
  on: (h: StatusHandlers): (() => void) => {
    if (!isNative) return mockStatus.subscribe(h);
    const offs = [
      listen<StatusSeed>("status://seed", (e) => h.seed(e.payload)),
      listen<PowerState>("status://power", (e) => h.power(e.payload)),
      listen<{ online: boolean }>("status://net", (e) => h.net(e.payload.online)),
      listen<BluetoothEvent>("status://bt", (e) => h.bt(e.payload)),
      listen<LevelEvent>("status://level", (e) => h.level(e.payload)),
      listen<LockEvent>("status://lock", (e) => h.lock(e.payload)),
      listen<MicEvent>("status://mic", (e) => h.mic(e.payload)),
    ];
    return () => offs.forEach((off) => void off.then((f) => f()));
  },
  /** `ddc`: read external monitors over DDC/CI (the Brightness alert is on); `locks`: watch Caps Lock and Num Lock; `bt`, `volume`: keep the Bluetooth watcher and the volume callback;
   *  `hideOsd`: hide the Windows indicator now (status.ts osdHidden); `osdArmed`: the option is in force, also while it is not hiding. */
  configure: (c: { ddc: boolean; locks: boolean; bt: boolean; volume: boolean; hideOsd: boolean; osdArmed: boolean }) => {
    if (isNative) void invoke("status_configure", c);
  },
};

// ---------- Downloads in progress (downloads.rs) ----------

/** A partial file in the Downloads folder: `name` is "" until Chrome names it, `speed` in bytes per second. */
export interface DownloadProgress { name: string; size: number; speed: number }
export interface DownloadFinished { name: string; path: string }

export const downloadWatch = {
  /** Rust watches the Downloads folder only while `on`. */
  configure: (on: boolean) => {
    if (isNative) void invoke("downloads_configure", { on });
  },
  on: (progress: (list: DownloadProgress[]) => void, finished: (d: DownloadFinished) => void): (() => void) => {
    if (!isNative) {
      const h = { progress, finished };
      mockDownloadHandlers.add(h);
      return () => void mockDownloadHandlers.delete(h);
    }
    const offs = [listen<DownloadProgress[]>("downloads://progress", (e) => progress(e.payload)), listen<DownloadFinished>("downloads://finished", (e) => finished(e.payload))];
    return () => offs.forEach((off) => void off.then((f) => f()));
  },
};

const mockDownloadHandlers = new Set<{ progress: (list: DownloadProgress[]) => void; finished: (d: DownloadFinished) => void }>();

/** Browser: a download that runs for three seconds, then finishes (the demo's "download" notice). Returns a way to call it off. */
export function mockDownload(name = "Crest-report.pdf") {
  const each = (f: (h: { progress: (list: DownloadProgress[]) => void; finished: (d: DownloadFinished) => void }) => void) => mockDownloadHandlers.forEach(f);
  let size = 0;
  const id = window.setInterval(() => {
    size += 9_000_000 + Math.random() * 3_000_000;
    each((h) => h.progress([{ name: `${name}.crdownload`, size, speed: 9_500_000 + Math.random() * 1_500_000 }]));
  }, 500);
  const end = window.setTimeout(() => {
    window.clearInterval(id);
    each((h) => h.progress([]));
    each((h) => h.finished({ name, path: `C:/Users/demo/Downloads/${name}` }));
  }, 3200);
  return () => {
    window.clearInterval(id);
    window.clearTimeout(end);
    each((h) => h.progress([]));
  };
}

const MOCK_BT = ["Audio.Headphone", "Input.Mouse", "Input.Keyboard", "Input.Gaming.Gamepad", "Audio.Speaker", "Communication.Phone", "Wearable.Watch", "Other"];

/** Browser: each dev button toggles one source. Unplugging drops the mock percent by 9, so the low tones show too. */
export const mockStatus = (() => {
  let power: PowerState = { ac: true, percent: 64, battery: true, charging: true }, online = true, buds = false, volume = 40, bright = 70, kind = 0, caps = false;
  const listeners = new Set<StatusHandlers>();
  return {
    seed: (): StatusSeed => ({ power, online, devices: buds ? ["Buds"] : [] }),
    subscribe(h: StatusHandlers) {
      listeners.add(h);
      return () => void listeners.delete(h);
    },
    unplug() {
      const percent = power.ac ? (power.percent! > 10 ? power.percent! - 9 : 64) : power.percent;
      power = { ac: !power.ac, percent, battery: true, charging: !power.ac };
      listeners.forEach((h) => h.power(power));
    },
    offline() {
      online = !online;
      listeners.forEach((h) => h.net(online));
    },
    /** Each connect is the next kind of device, so every icon shows. */
    bluetooth() {
      buds = !buds;
      const categories = [MOCK_BT[kind % MOCK_BT.length]];
      if (!buds) kind++;
      listeners.forEach((h) => h.bt({ name: "Buds", connected: buds, battery: buds ? 80 : null, categories }));
    },
    /** Steps up by 12 and wraps; past the top it shows muted once. */
    volume() {
      volume = volume >= 100 ? 0 : Math.min(100, volume + 12);
      listeners.forEach((h) => h.level({ kind: "volume", level: volume, muted: volume === 0 }));
    },
    brightness() {
      bright = bright >= 100 ? 10 : Math.min(100, bright + 15);
      listeners.forEach((h) => h.level({ kind: "brightness", level: bright, muted: false }));
    },
    /** Caps Lock flips on and off with each call. */
    capsLock() {
      caps = !caps;
      listeners.forEach((h) => h.lock({ key: "caps", on: caps }));
    },
    /** The microphone shortcut: flips the mute (Overview's switch follows) and says it. */
    mic() {
      mockQuick.micMuted = !mockQuick.micMuted;
      listeners.forEach((h) => h.mic({ muted: mockQuick.micMuted === true }));
    },
  };
})();

// ---------- Gaming mode ----------

/** FPS of the foreground process (ETW). error: no-admin | failed. */
/** One-time unlock so FPS work without running as admin (one UAC prompt). */
export function unlockFps(): Promise<"ok" | "relogin" | "cancelled" | "failed"> {
  if (isNative) return invoke("fps_unlock");
  return new Promise((r) => setTimeout(() => r("relogin"), 600));
}

export function fetchFps(): Promise<{ fps: number | null; error: string | null }> {
  if (isNative) return invoke("gaming_fps");
  return Promise.resolve({ fps: 138 + Math.round((Math.random() - 0.5) * 14), error: null });
}

// ---------- Privacy dots ----------

export interface PrivacyState {
  mic: boolean;
  camera: boolean;
  screen: boolean;
}

/** Toggled from the dev panel in the browser. */
export const mockPrivacy: PrivacyState = { mic: false, camera: false, screen: false };

export function fetchPrivacy(): Promise<PrivacyState> {
  return isNative ? invoke<PrivacyState>("privacy_state") : Promise.resolve({ ...mockPrivacy });
}

// ---------- Discord ----------

export interface DiscordMember {
  id: string;
  name: string;
  avatar: string;
  speaking: boolean;
  muted: boolean;
}

export interface DiscordCall {
  channelId: string;
  channelName: string;
  guildName: string | null;
  guildIcon: string | null;
  mute: boolean;
  deaf: boolean;
  /** You are speaking right now. */
  speaking: boolean;
  members: DiscordMember[];
}

export interface DiscordSnapshot {
  /** off | no-config | no-client | connecting | authorizing | ready | error */
  status: string;
  error: string | null;
  call: DiscordCall | null;
}

export type DiscordAction = "mute" | "deafen" | "leave";

export const discord = {
  configure: (enabled: boolean, clientId: string) => {
    if (isNative) void invoke("discord_configure", { enabled, clientId });
  },
  state: (): Promise<DiscordSnapshot> => (isNative ? invoke<DiscordSnapshot>("discord_state") : Promise.resolve(mockDiscord.get())),
  action: (action: DiscordAction) => {
    if (isNative) return void invoke("discord_action", { action });
    mockDiscord.act(action);
  },
  onState: (handler: (s: DiscordSnapshot) => void): (() => void) => {
    if (!isNative) return mockDiscord.subscribe(handler);
    const off = listen<DiscordSnapshot>("discord://state", (e) => handler(e.payload));
    return () => void off.then((f) => f());
  },
};

/** Browser: a sample call, started/ended from the dev panel. */
export const mockDiscord = (() => {
  // The demo draws its own avatars: nothing is fetched from Discord's servers.
  const avatar = (n: number, name = "") => (demo ? sampleAvatar(name, n) : `https://cdn.discordapp.com/embed/avatars/${n}.png`);
  let state: DiscordSnapshot = { status: "ready", error: null, call: null };
  const listeners = new Set<(s: DiscordSnapshot) => void>();
  const emit = () => listeners.forEach((l) => l(state));
  let talk: ReturnType<typeof setInterval> | undefined;
  const set = (call: DiscordCall | null) => {
    state = { ...state, call };
    emit();
  };
  return {
    get: () => state,
    subscribe(l: (s: DiscordSnapshot) => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    toggleCall() {
      clearInterval(talk);
      if (state.call) return set(null);
      set({
        channelId: "1",
        channelName: sample ? showcaseCall.channelName : "Zocken",
        guildName: sample ? showcaseCall.guildName : "Die Runde",
        guildIcon: null,
        mute: false,
        deaf: false,
        speaking: false,
        members: sample
          ? showcaseCall.members.map((m) => ({ id: m.id, name: m.name, avatar: avatar(m.avatar, m.name), speaking: false, muted: m.id === "3" }))
          : [
              { id: "1", name: "Du", avatar: avatar(0), speaking: false, muted: false },
              { id: "2", name: "Mara", avatar: avatar(1), speaking: false, muted: false },
              { id: "3", name: "Jonas", avatar: avatar(2), speaking: false, muted: true },
              { id: "4", name: "Lea", avatar: avatar(3), speaking: false, muted: false },
            ],
      });
      // Take turns speaking so the rings are visible.
      let i = 0;
      talk = setInterval(() => {
        if (!state.call) return;
        i++;
        const who = (sample ? ["2", "4", "2", "1"] : ["1", "2", "4", ""])[i % 4];
        set({ ...state.call, speaking: who === "1" && !state.call.mute, members: state.call.members.map((m) => ({ ...m, speaking: m.id === who && !m.muted && !(m.id === "1" && state.call!.mute) })) });
      }, 1400);
    },
    act(action: DiscordAction) {
      const c = state.call;
      if (!c) return;
      if (action === "leave") return this.toggleCall();
      if (action === "mute") set({ ...c, mute: !c.mute, members: c.members.map((m) => (m.id === "1" ? { ...m, muted: !c.mute || c.deaf } : m)) });
      if (action === "deafen") set({ ...c, deaf: !c.deaf, mute: !c.deaf ? true : c.mute });
    },
  };
})();

// ---------- Overview: volume + Windows focus ----------

export interface VolumeState {
  /** 0..1 */
  level: number;
  muted: boolean;
}

export interface FocusState {
  active: boolean;
  /** "focus" = focus session (Windows 11), "dnd" = only Do Not Disturb */
  kind: "focus" | "dnd";
}

/** One active playback device (src-tauri/src/controls.rs). */
export interface AudioOutput {
  id: string;
  name: string;
  /** The device the volume slider controls. */
  default: boolean;
}

const mockVolume: VolumeState = { level: 0.42, muted: false };
const mockBrightness = { percent: 64 };
const mockOutputs: AudioOutput[] = [
  { id: "speakers", name: "Speakers (Realtek(R) Audio)", default: true },
  { id: "headphones", name: "Headphones (WH-1000XM5)", default: false },
];
const mockFocus: FocusState = { active: false, kind: "focus" };

/** Overview's quick controls (src-tauri quick.rs, macos/quick.rs): null when the PC has no such radio. */
export interface QuickState {
  wifi: boolean | null;
  bluetooth: boolean | null;
  dark: boolean;
  /** The default microphone is muted; null when the PC has no microphone (mic.rs). */
  micMuted: boolean | null;
}
export type PowerAction = "lock" | "sleep" | "restart" | "shutdown";
const mockQuick: QuickState = { wifi: true, bluetooth: true, dark: true, micMuted: false };

/** One program in the volume mixer (all its audio sessions together). */
export interface AppVolume {
  /** Lowercase exe name, e.g. "spotify.exe". */
  id: string;
  name: string;
  /** PNG data URL of the program icon. */
  icon: string | null;
  /** 0..1 */
  level: number;
  muted: boolean;
  /** Source of what is playing right now. */
  media: boolean;
}

/** App icons for the browser mock (simple marks, only for design work and stills). */
const svgIcon = (body: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}</svg>`)}`;
const discordPath =
  "M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286ZM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189Zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z";

const mockIcons = {
  spotify: svgIcon(
    `<circle cx="16" cy="16" r="15" fill="#1ed760"/><g fill="none" stroke="#000" stroke-linecap="round"><path d="M8.5 12.2c5-1.5 10.6-1.1 15 1.2" stroke-width="2.4"/><path d="M9.4 16.6c4.2-1.2 8.8-.8 12.5 1.1" stroke-width="2"/><path d="M10.2 20.6c3.4-.9 6.9-.6 9.8.9" stroke-width="1.7"/></g>`,
  ),
  chrome: svgIcon(
    `<circle cx="16" cy="16" r="15" fill="#db4437"/><path d="M16 16 3.3 23.5A15 15 0 0 0 16 31z" fill="#0f9d58"/><path d="M16 16 16 31A15 15 0 0 0 28.7 8.5z" fill="#f4b400"/><path d="M16 16 3.3 23.5A15 15 0 0 1 3.3 8.5z" fill="#0f9d58"/><circle cx="16" cy="16" r="6.6" fill="#fff"/><circle cx="16" cy="16" r="5.2" fill="#4285f4"/>`,
  ),
  discord: svgIcon(`<rect width="32" height="32" rx="8" fill="#5865f2"/><g transform="translate(6 6) scale(.8333)"><path fill="#fff" d="${discordPath}"/></g>`),
  steam: svgIcon(
    `<circle cx="16" cy="16" r="15" fill="#1b2838"/><circle cx="20" cy="12.5" r="4.6" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="20" cy="12.5" r="2" fill="#fff"/><circle cx="11.5" cy="20.5" r="3.2" fill="#fff"/><path d="M11.5 20.5 20 12.5" stroke="#fff" stroke-width="2"/>`,
  ),
};

/** Exported for the dev panel ("Quelle wechseln"). */
export const mockApps: AppVolume[] = [
  { id: "spotify.exe", name: "Spotify", icon: mockIcons.spotify, level: 0.72, muted: false, media: true },
  { id: "chrome.exe", name: "Google Chrome", icon: mockIcons.chrome, level: 1, muted: false, media: false },
  { id: "discord.exe", name: "Discord", icon: mockIcons.discord, level: 0.45, muted: false, media: false },
  { id: "steam.exe", name: "Steam", icon: mockIcons.steam, level: 0.3, muted: true, media: false },
];

/** Volume per app, like the Windows volume mixer (src-tauri/src/mixer.rs). */
export const mixer = {
  list: (): Promise<AppVolume[]> => (isNative ? invoke<AppVolume[]>("mixer_list") : Promise.resolve(mockApps.map((a) => ({ ...a })))),
  set: (id: string, patch: { level?: number; muted?: boolean }): Promise<void> => {
    if (isNative) return invoke("mixer_set", { id, ...patch });
    const app = mockApps.find((a) => a.id === id);
    if (app) Object.assign(app, patch, patch.level !== undefined && patch.level > 0 && patch.muted === undefined ? { muted: false } : {});
    return Promise.resolve();
  },
};

export const systemControls = {
  volume: (): Promise<VolumeState> => (isNative ? invoke<VolumeState>("volume_get") : Promise.resolve({ ...mockVolume })),
  setVolume: (patch: { level?: number; muted?: boolean }): Promise<VolumeState> => {
    if (isNative) return invoke<VolumeState>("volume_set", patch);
    Object.assign(mockVolume, patch, patch.level !== undefined && patch.level > 0 && patch.muted === undefined ? { muted: false } : {});
    return Promise.resolve({ ...mockVolume });
  },
  /** The notch's monitor, 0..100; null when Crest can't set it (src-tauri brightness.rs, macos/brightness.rs). */
  brightness: (): Promise<number | null> =>
    isNative ? invoke<number | null>("brightness_get").catch(() => null) : Promise.resolve(mockBrightness.percent),
  setBrightness: (percent: number): Promise<void> => {
    if (isNative) return invoke<void>("brightness_set", { percent: Math.round(percent) });
    mockBrightness.percent = Math.round(percent);
    return Promise.resolve();
  },
  quick: (): Promise<QuickState | null> => (isNative ? invoke<QuickState>("quick_get").catch(() => null) : Promise.resolve({ ...mockQuick })),
  /** Rejects with "denied" (Windows' privacy settings), "none" (no such radio) or "settings" (the Store build opened Settings instead). */
  setRadio: (kind: "wifi" | "bluetooth", on: boolean): Promise<void> => {
    if (isNative) return invoke("quick_radio", { kind, on });
    mockQuick[kind] = on;
    return Promise.resolve();
  },
  setDark: (on: boolean): Promise<void> => {
    if (isNative) return invoke("quick_dark", { on });
    mockQuick.dark = on;
    return Promise.resolve();
  },
  /** Mutes or unmutes the default microphone; rejects with "none" without one. */
  setMicMuted: (on: boolean): Promise<void> => {
    if (isNative) return invoke("mic_mute", { on });
    mockQuick.micMuted = on;
    return Promise.resolve();
  },
  /** The microphone shortcut was pressed and flipped the mute (mic.rs). In the browser the next reading picks it up. */
  onMic: (handler: () => void): (() => void) => {
    if (!isNative) return () => {};
    const off = listen("status://mic", handler);
    return () => void off.then((f) => f());
  },
  power: (action: PowerAction): Promise<void> => (isNative ? invoke("quick_power", { action }) : Promise.resolve()),
  outputs: (): Promise<AudioOutput[]> => (isNative ? invoke<AudioOutput[]>("audio_outputs") : Promise.resolve(mockOutputs.map((o) => ({ ...o })))),
  setOutput: (id: string): Promise<void> => {
    if (isNative) return invoke("audio_set_output", { id });
    mockOutputs.forEach((o) => (o.default = o.id === id));
    return Promise.resolve();
  },
  focus: (): Promise<FocusState> => (isNative ? invoke<FocusState>("focus_get") : Promise.resolve({ ...mockFocus })),
  setFocus: (active: boolean): Promise<FocusState> => {
    if (isNative) return invoke<FocusState>("focus_set", { active });
    mockFocus.active = active;
    return Promise.resolve({ ...mockFocus });
  },
};

// ---------- Keep awake and power plans (src-tauri/src/power.rs) ----------

/** Keeps the PC and the display awake for `minutes` (null = until turned off), or lets them sleep again. */
export function keepAwake(on: boolean, minutes: number | null): Promise<void> {
  return isNative ? invoke("keep_awake_set", { on, minutes }) : Promise.resolve();
}

export interface PowerPlans {
  plans: { id: string; name: string }[];
  active: string | null;
}

const mockPlans: PowerPlans = {
  plans: [
    { id: "381b4222-f694-41f0-9685-ff5bb260df2e", name: "Balanced" },
    { id: "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c", name: "High performance" },
    { id: "a1841308-3541-4fab-bc81-f71556f20b4a", name: "Power saver" },
  ],
  active: "381b4222-f694-41f0-9685-ff5bb260df2e",
};

export const powerPlans = {
  list: (): Promise<PowerPlans> => (isNative ? invoke<PowerPlans>("power_plans") : Promise.resolve({ ...mockPlans })),
  set: (id: string): Promise<PowerPlans> => {
    if (isNative) return invoke<PowerPlans>("power_plan_set", { id });
    mockPlans.active = id;
    return Promise.resolve({ ...mockPlans });
  },
};

// ---------- Detached timer window (src-tauri/src/timer_window.rs) ----------

/** Opens the small always-on-top timer window at a saved position (physical px), if it is still on a monitor. */
export function openTimerWindow(pos: { x: number; y: number } | null): Promise<void> {
  return isNative ? invoke("timer_window_open", { x: pos?.x ?? null, y: pos?.y ?? null }) : Promise.resolve();
}

export function closeTimerWindow(): Promise<void> {
  return isNative ? invoke("timer_window_close") : Promise.resolve();
}

/** True when the window opens, false when it is gone. */
export function onTimerWindow(handler: (open: boolean) => void): () => void {
  if (!isNative) return () => {};
  const off = listen<boolean>("timer-window://open", (e) => handler(e.payload));
  return () => void off.then((f) => f());
}

// ---------- Shelf drag out and text (src-tauri/src/shelf.rs) ----------

/**
 * Native drag of files (or, with no files, text) into other apps; resolves when it is dropped
 * or cancelled. Must be called while the left button is down.
 */
export function shelfDragOut(paths: string[], text: string | null): Promise<void> {
  return isNative ? invoke("shelf_drag_out", { paths, text }) : Promise.resolve();
}

/** Files served to a phone on the same network (src-tauri/src/phone_share.rs); `qr` is an SVG path in a `size` box. */
export interface PhoneShare {
  url: string;
  qr: string;
  size: number;
  /** Seconds until it stops by itself. */
  ttl: number;
}

/** The words of the page the phone opens, in the app's language. */
export interface PhonePageText {
  lang: string;
  /** "rtl" or "ltr". */
  dir: string;
  title: string;
  count: string;
  hint: string;
  footer: string;
}

export function phoneShareStart(paths: string[], text: PhonePageText): Promise<PhoneShare> {
  if (isNative) return invoke<PhoneShare>("phone_share_start", { paths, text });
  // Demo: a stand-in code that looks like the real one but opens nothing; the app serves the files on the local network.
  return demo ? Promise.resolve({ url: "", qr: demoQr(), size: 37, ttl: 600 }) : Promise.reject(new Error("Only in the app"));
}

/** A QR-like pattern (three finder squares and fixed noise) as one SVG path in a 37 unit box: 29 modules and the 4 of quiet zone, like phone_share.rs. */
function demoQr(): string {
  const n = 29;
  const finder = (x: number, y: number) => x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let path = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const inFinder = (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
      const on = inFinder ? finder(x < 7 ? x : x - (n - 7), y < 7 ? y : y - (n - 7)) : rnd() < 0.48;
      if (on) path += `M${x + 4} ${y + 4}h1v1h-1z`;
    }
  }
  return path;
}

/** Stops the share at `url` (a newer one keeps running). */
export function phoneShareStop(url: string) {
  if (isNative) void invoke("phone_share_stop", { url });
}

/** The share at `url` ended because the computer left the network its QR code points to. */
export function onPhoneShareLost(handler: (url: string) => void): () => void {
  if (!isNative) return () => {};
  const off = listen<string>("notch://phone-share-lost", (e) => handler(e.payload));
  return () => void off.then((f) => f());
}

/** Text on the clipboard ("" if none). */
export function clipboardText(): Promise<string> {
  if (isNative) return invoke<string>("shelf_clipboard_text").catch(() => "");
  if (demo && demoPaste.text) {
    const text = demoPaste.text;
    demoPaste.text = "";
    return Promise.resolve(text);
  }
  return navigator.clipboard.readText().catch(() => "");
}
// ---------- Terminal ----------

/** Shell output as raw bytes; the last message of a session is its exit code. */
export type TerminalMessage = ArrayBuffer | { exit: number };

export const terminal = {
  info: (): Promise<ShellInfo> =>
    isNative
      ? invoke<ShellInfo>("terminal_info")
      : Promise.resolve({ pwsh: null, powershell: "powershell.exe", cmd: "cmd.exe", home: "C:\\Users\\you", buildNumber: 0 }),
  start: (plan: LaunchPlan, cols: number, rows: number, onOutput: (m: TerminalMessage) => void): Promise<void> => {
    if (demo) return import("../dev/demo-shell").then((m) => void (demoShell = m.createShell(onOutput)).start());
    if (!isNative) return Promise.resolve(mockShell.start(onOutput));
    const channel = new Channel<TerminalMessage>();
    channel.onmessage = onOutput;
    return invoke("terminal_start", { ...plan, cols, rows, onOutput: channel });
  },
  write: (data: string): Promise<void> => (isNative ? invoke<void>("terminal_write", { data }).catch(() => {}) : Promise.resolve(demoShell ? demoShell.write(data) : mockShell.write(data))),
  resize: (cols: number, rows: number) => {
    if (isNative) void invoke("terminal_resize", { cols, rows });
  },
  kill: () => (isNative ? void invoke("terminal_kill") : (demoShell?.stop(), (demoShell = null), mockShell.kill())),
  clipboardText: (): Promise<string | null> =>
    isNative ? invoke<string | null>("terminal_clipboard_text") : navigator.clipboard.readText().catch(() => null),
};

let demoShell: { write(data: string): void; stop(): void } | null = null;

/** Browser: a fake prompt that echoes what you type, so the tool can be designed without the app. */
const mockShell = (() => {
  let out: ((m: TerminalMessage) => void) | null = null;
  let line = "";
  const prompt = "\x1b[32mPS\x1b[0m C:\\Users\\you> ";
  const say = (s: string) => out?.(new TextEncoder().encode(s).buffer as ArrayBuffer);
  return {
    start(onOutput: (m: TerminalMessage) => void) {
      out = onOutput;
      line = "";
      say(`Browser preview, no real shell.\r\n\r\n${prompt}`);
    },
    write(data: string) {
      for (const ch of data) {
        if (ch === "\r") {
          if (line.trim() === "exit") return void (out?.({ exit: 0 }), (out = null));
          say(`\r\n${prompt}`);
          line = "";
        } else if (ch === "\x7f") {
          if (line) say("\b \b");
          line = line.slice(0, -1);
        } else if (ch === "\x03") {
          say(`^C\r\n${prompt}`);
          line = "";
        } else if (ch >= " ") {
          line += ch;
          say(ch);
        }
      }
    },
    kill() {
      out = null;
    },
  };
})();
// ---------- Theme files (themes.rs) ----------

export interface ThemeFileText {
  file: string;
  text: string | null;
  error: string | null;
}

/** In the browser: export downloads the file, import reads one sample theme. */
const mockThemeFiles: ThemeFileText[] = [
  {
    file: "midnight-teal.json",
    text: JSON.stringify({ format: 1, id: "midnight-teal", name: "Midnight teal", colors: { background: "#04161a", foreground: "#e6f4f1", accent: "#2dd4bf" } }),
    error: null,
  },
];

export const themeFiles = {
  folder: (): Promise<string> => (isNative ? invoke<string>("themes_folder") : Promise.resolve("")),
  read: (): Promise<ThemeFileText[]> => (isNative ? invoke<ThemeFileText[]>("themes_read") : Promise.resolve(mockThemeFiles)),
  /** Writes `<id>.json` into the themes folder and returns its path. */
  write: (id: string, text: string): Promise<string> => {
    if (isNative) return invoke<string>("themes_write", { id, text });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = `${id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    return Promise.resolve("");
  },
};
// ---------- Launcher ----------

export interface LauncherAppEntry {
  /** `shell:AppsFolder\<app id>` or an exe path; Rust only opens ids from its own list. */
  id: string;
  name: string;
  source: "start" | "apppaths";
}

const mockLauncherApps: LauncherAppEntry[] = ["Claude", "ChatGPT", "Copilot", "Cursor", "Perplexity", "Calculator", "Notepad", "Paint", "Spotify", "Terminal", "Uninstall Cursor"].map((name) => ({
  id: `shell:AppsFolder\\${name}`,
  name,
  source: "start",
}));
const mockLauncherIcon = (name: string) =>
  svgIcon(`<rect width="32" height="32" rx="8" fill="hsl(${[...name].reduce((h, c) => h + c.charCodeAt(0) * 7, 0) % 360} 55% 45%)"/><text x="16" y="21" font-size="14" font-family="sans-serif" fill="#fff" text-anchor="middle">${name[0]}</text>`);

/** Start menu apps, icons, launching and the Alt+1..6 keys (src-tauri/src/launcher.rs). */
export const launcher = {
  apps: (refresh = false): Promise<LauncherAppEntry[]> => (isNative ? invoke<LauncherAppEntry[]>("launcher_apps", { refresh }) : Promise.resolve(mockLauncherApps)),
  icons: (ids: string[]): Promise<Record<string, string | null>> =>
    isNative ? invoke("launcher_icons", { ids }) : Promise.resolve(Object.fromEntries(ids.map((id) => [id, mockLauncherIcon(id.split("\\").pop() ?? "?")]))),
  /** Errors: not-found (no longer installed), failed. */
  open: (id: string): Promise<void> => (isNative ? invoke("launcher_open", { id }) : Promise.resolve()),
  /** Registers Alt+1.. for these ids; per slot whether Windows gave the key. */
  shortcuts: (ids: string[]): Promise<boolean[]> => (isNative ? invoke<boolean[]>("launcher_shortcuts", { ids }) : Promise.resolve(ids.map((_, i) => i !== 2))),
  /** A hotkey was pressed for an app that did not start (code as in `open`). */
  onMissing: (handler: (id: string, code: string) => void): (() => void) => {
    if (!isNative) return () => {};
    const off = listen<{ id: string; code: string }>("launcher://missing", (e) => handler(e.payload.id, e.payload.code));
    return () => void off.then((f) => f());
  },
};

// ---------- GitHub ----------

export interface GithubDay {
  date: string;
  count: number;
  /** GitHub's shade, 0 to 4. */
  level: number;
}

export interface GithubContributions {
  user: string;
  /** Contributions in the last year, as GitHub states it. */
  total: number;
  days: GithubDay[];
  source: "page" | "api";
  fetchedAt: number;
}

/** The user's profile on github.com in the browser; Rust refuses anything that is not a valid login, and there is nothing to show for it. */
export function openGithubProfile(user: string) {
  if (isNative) invoke("github_open_profile", { user }).catch(() => {});
  else window.open(`https://github.com/${encodeURIComponent(user)}`, "_blank", "noopener");
}

/** Errors from Rust: no-user, not-found, rate-limited, offline, parse, failed. `force` skips the hour's cache (once a minute at most). */
export function fetchGithub(user: string, force: boolean): Promise<GithubContributions> {
  if (isNative) return invoke<GithubContributions>("github_contributions", { user, force });
  if (!user.trim()) return Promise.reject("no-user");
  const today = new Date();
  const days = Array.from({ length: 371 }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - 370 + i);
    const count = Math.max(0, Math.round(Math.sin(i * 0.7) * 4 + Math.sin(i * 0.13) * 5 + (i % 7 === 0 ? -6 : 1)));
    return { date: localDate(d), count, level: count === 0 ? 0 : Math.min(4, Math.ceil(count / 3)) };
  });
  return new Promise((r) => setTimeout(() => r({ user, total: days.reduce((s, d) => s + d.count, 0), days, source: "page", fetchedAt: Date.now() }), 300));
}
// ---------- Calendar (src-tauri/src/calendar.rs) ----------

/** A source as Rust needs it; an ICS link is not here, it is the source's secret. */
export interface CalendarSourceIn {
  id: string;
  kind: "ics" | "caldav";
  url: string;
  user: string;
  name: string;
  color: string;
}

export interface CalendarInfo {
  id: string;
  source: string;
  name: string;
  color: string;
}

export interface CalendarEvent {
  id: string;
  calendar: string;
  title: string;
  location: string;
  /** The ICS URL and DESCRIPTION (capped), where meetingLink looks for a link to join. */
  url: string;
  description: string;
  /** Epoch ms; an all-day event runs from local midnight to local midnight, end exclusive. */
  start: number;
  end: number;
  allDay: boolean;
}

export interface CalendarData {
  calendars: CalendarInfo[];
  events: CalendarEvent[];
  /** Per source: an error code (no-key, bad-url, auth, not-found, offline, too-large, parse, no-calendars, failed) and when its events were fetched. */
  sources: { id: string; error: string | null; fetchedAt: number | null }[];
  fetchedAt: number;
}

/** Events from about two months back to three ahead; `force` skips Rust's ten minutes' cache. */
export function fetchCalendar(sources: CalendarSourceIn[], force: boolean): Promise<CalendarData> {
  if (isNative) return invoke<CalendarData>("calendar_fetch", { sources, force });
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const at = (d: number, h: number, m = 0) => day.getTime() + d * 86_400_000 + (h * 60 + m) * 60_000;
  const calendars = sources.map((s) => ({ id: s.id, source: s.id, name: s.name || "Calendar", color: s.color || "#419cff" }));
  const c = (i: number) => calendars[i % Math.max(1, calendars.length)]?.id ?? "";
  // Demo: times from now on, so there is always an event coming up (the first and the fifth have a link to join).
  const soon = (min: number) => Date.now() + min * 60_000;
  const list: [number, string, string, number, number, boolean][] = demo
    ? [
        [0, "Design review", "Room 4", soon(25), soon(85), false],
        [1, "Lunch with Sam", "Café Central", at(1, 12, 30), at(1, 13, 30), false],
        // Already over, so its reminder never covers the notices the page shows.
        [0, "Standup", "", soon(-180), soon(-165), false],
        [1, "Dentist", "", at(1, 8, 15), at(1, 9), false],
        [0, "Sprint planning", "", at(1, 10), at(1, 11, 30), false],
        [1, "Mum's birthday", "", at(2, 0), at(3, 0), true],
        [0, "Release 1.0", "", at(3, 14), at(3, 15), false],
      ]
    : [
        [0, "Standup", "", at(0, 9, 30), at(0, 9, 45), false],
        [1, "Lunch with Sam", "Café Central", at(0, 12, 30), at(0, 13, 30), false],
        [0, "Design review", "Room 4", at(0, 16), at(0, 17), false],
        [1, "Dentist", "", at(1, 8, 15), at(1, 9), false],
        [0, "Sprint planning", "", at(1, 10), at(1, 11, 30), false],
        [1, "Mum's birthday", "", at(2, 0), at(3, 0), true],
        [0, "Release 0.3", "", at(3, 14), at(3, 15), false],
      ];
  const events = calendars.length
    ? list.map(([i, title, location, start, end, allDay], n) => {
        const description = n === 0 || n === 4 ? "Join with Google Meet: https://meet.google.com/abc-defg-hij" : "";
        return { id: `s${n}`, calendar: c(i), title, location, url: "", description, start, end, allDay };
      })
    : [];
  return new Promise((r) => setTimeout(() => r({ calendars, events, sources: sources.map((s) => ({ id: s.id, error: null, fetchedAt: Date.now() })), fetchedAt: Date.now() }), 300));
}

/** An event's meeting link in the default browser; Rust opens https links only. */
export async function openMeetingLink(url: string): Promise<void> {
  if (isNative) await invoke("calendar_open_link", { url });
  // Demo: the sample link goes nowhere; a notice says what the app would have done.
  else if (demo) mockNotice({ appName: "Crest demo", title: "Meeting link", body: `The app opens ${url} in your browser.` });
  else window.open(url, "_blank", "noopener");
}

// ---------- Live notices (src-tauri/src/notices.rs) ----------

/** One notice from Windows or crest-notify, before the history gives it an id. */
export type IncomingNotice = Omit<import("../features/notices/history").Notice, "id">;

export interface NoticeSourceStatus {
  access: "allowed" | "denied" | "unspecified" | "unavailable";
  mode: "off" | "event-log" | "polling" | "failed";
  pipe: boolean;
  /** The crest-notify channel could not be opened. */
  pipeFailed: boolean;
}

/** In the browser there is no source; `mockNotice` stands in (from the dev tools console). */
const mockNoticeHandlers = new Set<(n: IncomingNotice) => void>();
export function mockNotice(n: Partial<IncomingNotice>) {
  const full: IncomingNotice = { source: "cli", appId: "cli:crest-notify", appName: "crest-notify", title: "", body: "", at: Date.now(), ...n };
  mockNoticeHandlers.forEach((h) => h(full));
}

export const noticeSource = {
  configure: (windows: boolean, pipe: boolean) => {
    if (isNative) void invoke("notices_configure", { windows, pipe });
  },
  status: (): Promise<NoticeSourceStatus> =>
    isNative ? invoke<NoticeSourceStatus>("notices_status") : Promise.resolve({ access: "allowed", mode: demo ? "event-log" : "off", pipe: demo, pipeFailed: false }),
  /** The access now, or "request-failed" when Windows refused the request itself. */
  requestAccess: (): Promise<NoticeSourceStatus["access"] | "request-failed"> =>
    isNative ? invoke<NoticeSourceStatus["access"] | "request-failed">("notices_request_access") : Promise.resolve("allowed"),
  /** Removes these toasts from the Windows notification centre. */
  removeWindows: (ids: number[]) => {
    if (isNative && ids.length) void invoke("notices_remove_windows", { ids });
  },
  /**
   * Turns Windows' own banners off (or back on) for these apps; their notices still reach Crest (banners.rs).
   * Rejects with "settings" in the Store build, which opened Windows' notification settings instead.
   */
  banners: (hide: boolean, apps: string[]): Promise<void> => (isNative && !isMac ? invoke("notices_banners", { hide, apps }) : Promise.resolve()),
  /** Opens the app a Windows notice came from, on its start page. */
  openApp: (appId: string) => {
    if (isNative) void invoke("notices_open_app", { appId }).catch(() => {});
  },
  /** A notice's one-time code on the clipboard, kept out of every clipboard history and emptied after 30 s unless something else was copied (the Vault's way). The browser has only the plain clipboard. */
  copyCode: (code: string): Promise<void> => (isNative ? invoke<void>("notices_copy_code", { code }) : navigator.clipboard.writeText(code)),
  onNotice: (handler: (n: IncomingNotice) => void): (() => void) => {
    if (!isNative) {
      mockNoticeHandlers.add(handler);
      return () => void mockNoticeHandlers.delete(handler);
    }
    const off = listen<IncomingNotice>("notices://in", (e) => handler(e.payload));
    return () => void off.then((f) => f());
  },
  onStatus: (handler: (s: NoticeSourceStatus) => void): (() => void) => {
    if (!isNative) return () => {};
    const off = listen<NoticeSourceStatus>("notices://status", (e) => handler(e.payload));
    return () => void off.then((f) => f());
  },
  /** `crest-notify part`: a custom closed-row part set or cleared. In the browser `mockPart` stands in. */
  onPart: (handler: (p: PartMessage) => void): (() => void) => {
    if (!isNative) {
      mockPartHandlers.add(handler);
      return () => void mockPartHandlers.delete(handler);
    }
    const off = listen<PartMessage>("notices://part", (e) => handler(e.payload));
    return () => void off.then((f) => f());
  },
  /** `crest-notify ask`: a question waiting for a click. In the browser `mockAsk` stands in. */
  onAsk: (handler: (a: Ask) => void): (() => void) => {
    if (!isNative) {
      mockAskHandlers.add(handler);
      return () => void mockAskHandlers.delete(handler);
    }
    const off = listen<Ask>("notices://ask", (e) => handler(e.payload));
    return () => void off.then((f) => f());
  },
  /** Ids of Windows toasts that left the notification centre: their app withdrew them, or they were cleared there. */
  onToastsGone: (handler: (ids: number[]) => void): (() => void) => {
    if (!isNative) return () => {};
    const off = listen<number[]>("notices://gone", (e) => handler(e.payload));
    return () => void off.then((f) => f());
  },
  /** The asker hung up or its time ran out. */
  onAskClosed: (handler: (id: number) => void): (() => void) => {
    if (!isNative) return () => {};
    const off = listen<number>("notices://ask-closed", (e) => handler(e.payload));
    return () => void off.then((f) => f());
  },
  /** One of the question's option ids, or null for no choice. */
  answer: (id: number, choice: string | null) => {
    if (isNative) void invoke("notices_answer", { id, choice });
    else askAnswers.get(id)?.(choice), askAnswers.delete(id);
  },
};

const mockAskHandlers = new Set<(a: Ask) => void>();
let mockAskId = 0;
/** Demo: who waits for the click on a question (the terminal's `crest-notify ask`). */
export const askAnswers = new Map<number, (choice: string | null) => void>();
export function mockAsk(a: Partial<Ask> = {}): number {
  const full: Ask = { id: ++mockAskId, appId: "cli:agent", appName: "Agent", title: "Run command?", body: "cargo test", options: ["allow", "always", "deny"], at: Date.now(), ...a };
  mockAskHandlers.forEach((h) => h(full));
  return full.id;
}

const mockPartHandlers = new Set<(p: PartMessage) => void>();
export function mockPart(p: Partial<PartMessage> & { id: string }) {
  mockPartHandlers.forEach((h) => h({ source: "crest-notify", clear: false, ...p }));
}

// ---------- Plugins (src-tauri/src/plugins.rs) ----------

export interface StagedPlugin {
  token: string;
  manifest: PluginManifest;
  /** The installed version this one replaces. */
  replaces: string | null;
}

export type StorageOp = { op: "get" | "remove"; key: string } | { op: "set"; key: string; value: unknown } | { op: "keys" };
export interface PluginFetch { url: string; method?: string; headers?: Record<string, string>; body?: string }
export interface PluginResponse { status: number; contentType: string; body: string }

const notInBrowser = () => Promise.reject("not-native");

/**
 * Demo: the sample plugin (examples/plugins/hello-crest) is installed in memory. Removing it and picking a folder
 * again shows the real install screen with its permissions; the plugin's data and its one request are made up here.
 */
const demoPlugins = (() => {
  let installed = demo;
  const data = new Map<string, unknown>();
  const manifest = () => import("../../examples/plugins/hello-crest/crest-plugin.json").then((m) => m.default as PluginManifest);
  return {
    list: () => (installed ? manifest().then((m) => [m]) : Promise.resolve([])),
    pick: () => Promise.resolve("hello-crest"),
    stage: (): Promise<StagedPlugin> => manifest().then((m) => ({ token: "demo", manifest: m, replaces: null })),
    commit: () => manifest().then((m) => ((installed = true), m)),
    remove: () => ((installed = false), data.clear(), Promise.resolve()),
    storage: (op: StorageOp): Promise<unknown> => {
      if (op.op === "keys") return Promise.resolve([...data.keys()]);
      if (op.op === "get") return Promise.resolve(data.get(op.key) ?? null);
      if (op.op === "set") data.set(op.key, op.value);
      else data.delete(op.key);
      return Promise.resolve(null);
    },
    fetch: (): Promise<PluginResponse> => {
      const lines = ["Keep it logically awesome.", "Design for failure.", "Half measures are as bad as nothing at all.", "Favor focus over features."];
      return Promise.resolve({ status: 200, contentType: "text/plain", body: lines[Math.floor(Math.random() * lines.length)] });
    },
  };
})();

/** Install, list and remove plugins, and run what their pages ask for (src/features/plugins/PluginView.tsx). */
export const pluginApi = {
  list: (): Promise<PluginManifest[]> => (isMac ? Promise.resolve([]) : isNative ? invoke<PluginManifest[]>("plugins_list") : demo ? demoPlugins.list() : Promise.resolve([])),
  /** The system's folder or .zip picker; null when cancelled. */
  pick: (zip: boolean): Promise<string | null> => (isNative ? invoke<string | null>("plugins_pick", { zip }) : demo ? demoPlugins.pick() : Promise.resolve(null)),
  stage: (path: string): Promise<StagedPlugin> => (isNative ? invoke<StagedPlugin>("plugins_stage", { path }) : demo ? demoPlugins.stage() : notInBrowser()),
  commit: (token: string): Promise<PluginManifest> => (isNative ? invoke<PluginManifest>("plugins_commit", { token }) : demo ? demoPlugins.commit() : notInBrowser()),
  discard: (token: string): Promise<void> => (isNative ? invoke("plugins_discard", { token }) : Promise.resolve()),
  remove: (id: string): Promise<void> => (isNative ? invoke("plugins_remove", { id }) : demo ? demoPlugins.remove() : notInBrowser()),
  storage: (id: string, op: StorageOp): Promise<unknown> => (isNative ? invoke("plugins_storage", { id, op }) : demo ? demoPlugins.storage(op) : notInBrowser()),
  fetch: (id: string, request: PluginFetch): Promise<PluginResponse> => (isNative ? invoke<PluginResponse>("plugins_fetch", { id, request }) : demo ? demoPlugins.fetch() : notInBrowser()),
};

// ---------- Window behaviour (display.rs, shell.rs) ----------

/** What the window rules call for right now. */
export type ScreenBehavior = "normal" | "line" | "hide";
export interface RunningApp {
  name: string;
  path: string;
}
/** in-use: another program holds the combination. */
export type HotkeyState = "unset" | "active" | "in-use" | "invalid";
/** `tools`: each tool shortcut sent, by tool id (an older backend leaves it out). */
export type HotkeyStates = { open: HotkeyState; hide: HotkeyState; resize: HotkeyState; find: HotkeyState; mic: HotkeyState; tools?: Record<string, HotkeyState> };
export interface HotkeyConfig {
  open: string;
  hide: string;
  resize: string;
  find: string;
  mic: string;
  /** The tools' own shortcuts: each opens the notch on its tool (shell.rs). */
  tools: { id: string; keys: string }[];
  openLabel: string;
}

export const windowShell = {
  screen: (): Promise<ScreenBehavior> => (isNative ? invoke<ScreenBehavior>("display_screen") : Promise.resolve("normal")),
  onScreen: (handler: (b: ScreenBehavior) => void): (() => void) => {
    if (!isNative) return () => {};
    const off = listen<ScreenBehavior>("notch://screen", (e) => handler(e.payload));
    return () => void off.then((f) => f());
  },
  /** Keeps Crest's windows out of other apps' screen sharing and recordings (sharing.rs). */
  hideFromCapture: (on: boolean) => {
    if (isNative) void invoke("sharing_hide", { on }).catch(() => {});
  },
  /** The window was hidden (hide shortcut or a rule) or shown again; the notch may stay open meanwhile. */
  onHidden: (handler: (hidden: boolean) => void): (() => void) => {
    if (!isNative) return () => {};
    const off = listen<boolean>("notch://hidden", (e) => handler(e.payload));
    return () => void off.then((f) => f());
  },
  /** Shows Crest if the hide shortcut hid it and puts it above other always-on-top windows. */
  raise: () => {
    if (isNative) void invoke("display_raise");
  },
  apps: (): Promise<RunningApp[]> =>
    isNative
      ? invoke<RunningApp[]>("display_apps")
      : Promise.resolve([
          { name: "chrome", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
          { name: "vlc", path: "C:\\Program Files\\VideoLAN\\VLC\\vlc.exe" },
        ]),
  applyHotkeys: (config: HotkeyConfig): Promise<HotkeyStates> =>
    isNative
      ? invoke<HotkeyStates>("hotkeys_apply", { config })
      : Promise.resolve({
          open: config.open ? "active" : "unset",
          hide: config.hide ? "active" : "unset",
          resize: config.resize ? "active" : "unset",
          find: config.find ? "active" : "unset",
          mic: config.mic ? "active" : "unset",
          tools: Object.fromEntries(config.tools.map((x) => [x.id, "active" as const])),
        }),
  /** The Find on screen shortcut. */
  onFindKey: (handler: () => void): (() => void) => {
    if (!isNative) return () => {};
    const off = listen("notch://find", handler);
    return () => void off.then((f) => f());
  },
  /** A tool's own shortcut: the tool id it opens. */
  onToolKey: (handler: (id: string) => void): (() => void) => {
    if (!isNative) return () => {};
    const off = listen<string>("notch://tool", (e) => handler(e.payload));
    return () => void off.then((f) => f());
  },
  /** The resize shortcut: one arrow press. */
  onResizeKey: (handler: (dir: "left" | "right" | "up" | "down") => void): (() => void) => {
    if (!isNative) return () => {};
    const off = listen<"left" | "right" | "up" | "down">("notch://resize", (e) => handler(e.payload));
    return () => void off.then((f) => f());
  },
  crashLog: (text: string) => {
    if (isNative) void invoke("crash_log", { text });
  },
};
// ---------- Colour ----------

/**
 * The Colour tool's pick from the screen: Crest's own eyedropper on Windows (capture/eyedropper.rs), AppKit's colour sampler on
 * a Mac (macos/colour.rs). "#rrggbb", or null when cancelled. Not in the browser, which has its own (src/features/colour/store.ts).
 */
export const screenColour = {
  pick: (): Promise<string | null> => (isNative ? invoke<string | null>("colour_pick") : Promise.resolve(null)),
};

// ---------- Backup ----------

/** Backup files (backup.rs): errors are short codes ("too-big", "unreadable", "write", "no-folder"). Native only. */
export const backupFiles = {
  /** Writes a new file into Documents/Crest/Backups; its path. */
  save: (text: string, beforeRestore: boolean): Promise<string> =>
    isNative ? invoke<string>("backup_save", { text, beforeRestore }) : Promise.reject(new Error("unsupported")),
  /** The text of the backup file the user picks; null when cancelled. */
  open: (): Promise<string | null> => (isNative ? invoke<string | null>("backup_open") : Promise.resolve(null)),
  /** Restarts Crest, which applies a pending restore before anything reads the saved data. */
  restart: async () => {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  },
};

// ---------- Portable ----------

/** A portable copy (Crest.portable next to the exe) keeps its data beside it and updates itself in place (portable.rs). */
export const portable = {
  info: (): Promise<{ portable: boolean; writable: boolean }> =>
    isNative ? invoke<{ portable: boolean; writable: boolean }>("portable_info") : Promise.resolve({ portable: false, writable: false }),
};

/** The portable package's update: verified and swapped in by Rust, which restarts the app; a folder that can't be written opens the download page. */
async function portableUpdate(): Promise<UpdateHandle | null> {
  const version = await invoke<string | null>("portable_check");
  if (!version) return null;
  return {
    version,
    install: async (onProgress) => {
      const off = await listen<number>("portable://progress", (e) => onProgress(e.payload));
      try {
        return (await invoke<boolean>("portable_install")) ? "page" : undefined;
      } finally {
        off();
      }
    },
  };
}
// ---------- Capture (src-tauri/src/capture) ----------

export interface CaptureSource {
  /** "monitor:\\.\DISPLAY1" or "window:<handle>" */
  id: string;
  kind: "monitor" | "window";
  name: string;
  width: number;
  height: number;
  primary: boolean;
}

export interface CaptureShot {
  path: string;
  name: string;
  thumb: string | null;
  width: number;
  height: number;
}

export interface CaptureRecState {
  phase: "idle" | "recording" | "paused";
  elapsedMs: number;
  /** Set once, when a recording has ended and its file is written. */
  path: string | null;
  /** Inputs that could not be opened ("system", "mic"), or "save" when writing the file failed. */
  failed: string[];
  /** Sound only (the Recorder tool), not the screen. */
  audio: boolean;
}

export interface CaptureFile {
  path: string;
  name: string;
  kind: "shot" | "video" | "audio";
  size: number;
  modified: number;
}

export interface CaptureDetails {
  path: string;
  thumb: string | null;
  durationMs: number | null;
}

/** A line Find on screen read (capture/find.rs); `rect` in physical pixels of the virtual screen. */
export interface FoundLine {
  text: string;
  /** Index in the Capture tool's monitor order (primary first). */
  monitor: number;
  rect: { x: number; y: number; w: number; h: number };
}

const mockFound: FoundLine[] = [
  { text: "Quarterly report: revenue up 12 %", monitor: 0, rect: { x: 120, y: 200, w: 420, h: 30 } },
  { text: "Café opening hours 8:00 to 18:00", monitor: 0, rect: { x: 120, y: 260, w: 380, h: 30 } },
  { text: "Invoice number 2026-1104", monitor: 1, rect: { x: 2700, y: 140, w: 300, h: 28 } },
];

const mockSources: CaptureSource[] = [
  { id: "monitor:\\\\.\\DISPLAY1", kind: "monitor", name: "\\\\.\\DISPLAY1", width: 2560, height: 1440, primary: true },
  { id: "monitor:\\\\.\\DISPLAY2", kind: "monitor", name: "\\\\.\\DISPLAY2", width: 1920, height: 1080, primary: false },
  { id: "window:1", kind: "window", name: "Visual Studio Code", width: 1600, height: 1000, primary: false },
  // A long browser title: the source menu must keep it on one line.
  { id: "window:2", kind: "window", name: "andrealo20/crest: Crest Island (preview). A notch at the screen edge with music and synced lyrics, live notices, timers - Google Chrome", width: 1600, height: 1000, primary: false },
];

/** Showcase only: three captures for the Capture gallery, drawn as small desktops so no real screen shows. */
function showcaseCaptures(): CaptureFile[] {
  const now = Date.now();
  return [
    { path: "C:/Users/demo/Videos/Captures/Crest 1.mp4", name: "Crest 1.mp4", kind: "video", size: 48_600_000, modified: now - 3 * 60_000 },
    { path: "C:/Users/demo/Pictures/Screenshots/Crest 2.png", name: "Crest 2.png", kind: "shot", size: 1_120_000, modified: now - 40 * 60_000 },
    { path: "C:/Users/demo/Pictures/Screenshots/Crest 3.png", name: "Crest 3.png", kind: "shot", size: 2_040_000, modified: now - 26 * 3_600_000 },
    { path: "C:/Users/demo/Music/Crest/Recordings/Recording 4.m4a", name: "Recording 4.m4a", kind: "audio", size: 1_010_000, modified: now - 90 * 60_000 },
  ];
}

function showcaseThumb(path: string): string | null {
  const hue = path.endsWith("1.mp4") ? ["#3c7bff", "#0b1a4a"] : path.endsWith("2.png") ? ["#ff7ac6", "#2a0b3a"] : ["#ffd27a", "#3a1206"];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hue[0]}"/><stop offset="1" stop-color="${hue[1]}"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><rect x="40" y="30" width="240" height="120" rx="8" fill="#1e1e22" opacity="0.92"/><rect x="40" y="30" width="240" height="14" rx="4" fill="#2c2c32"/><rect x="56" y="58" width="120" height="8" rx="4" fill="#ffffff" opacity="0.5"/><rect x="56" y="74" width="180" height="6" rx="3" fill="#ffffff" opacity="0.25"/><rect x="56" y="86" width="150" height="6" rx="3" fill="#ffffff" opacity="0.25"/><rect x="0" y="168" width="320" height="12" fill="#1c1c1c" opacity="0.9"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Sample and demo: what the Capture tool lists, newest first. A screenshot or recording taken in the demo is added. */
const sampleLibrary: CaptureFile[] = sample ? showcaseCaptures() : [];
const sampleThumbs = new Map<string, string>();
const sampleLengths = new Map<string, number>();
let sampleStarted = 0;
let sampleCount = 4;

/** A demo capture appears in the list with a picture drawn here; nothing is read from the visitor's screen. */
function addSample(kind: CaptureFile["kind"], length = 0): CaptureFile {
  const n = ++sampleCount;
  const ext = kind === "shot" ? "png" : kind === "video" ? "mp4" : "m4a";
  const dir = kind === "shot" ? "Pictures/Screenshots" : kind === "video" ? "Videos/Captures" : "Music/Crest/Recordings";
  const file: CaptureFile = { path: `C:/Users/demo/${dir}/${kind === "audio" ? "Recording" : "Crest"} ${n}.${ext}`, name: `${kind === "audio" ? "Recording" : "Crest"} ${n}.${ext}`, kind, size: kind === "shot" ? 1_300_000 : Math.max(120_000, length * 16_000), modified: Date.now() };
  if (kind !== "audio") sampleThumbs.set(file.path, n % 2 ? screenshot(320, 180) : photo(320, 180));
  if (length) sampleLengths.set(file.path, length);
  sampleLibrary.unshift(file);
  return file;
}

export const capture = {
  sources: (): Promise<CaptureSource[]> => (isNative ? invoke<CaptureSource[]>("capture_sources") : Promise.resolve(mockSources)),
  /** null when the region pick was cancelled. */
  shot: (mode: "all" | "monitor" | "region", monitor: string | null): Promise<CaptureShot | null> => {
    if (isNative) return invoke<CaptureShot | null>("capture_shot", { mode, monitor });
    if (!demo) return Promise.resolve(null);
    const f = addSample("shot");
    return Promise.resolve({ path: f.path, name: f.name, thumb: sampleThumbs.get(f.path) ?? null, width: 2560, height: 1440 });
  },
  state: (): Promise<CaptureRecState> => (isNative ? invoke<CaptureRecState>("capture_state") : Promise.resolve({ phase: "idle", elapsedMs: 0, path: null, failed: [], audio: false })),
  start: (source: string, fps: number, mic: boolean, system: boolean, border: boolean): Promise<void> => {
    if (!isNative) sampleStarted = Date.now();
    return isNative ? invoke("capture_start", { source, fps, mic, system, border }) : Promise.resolve();
  },
  /** Demo: the recording that just ended joins the list; returns its path for the "saved" notice. */
  finishSample: (audio: boolean): string => addSample(audio ? "audio" : "video", Math.max(2, Math.round((Date.now() - sampleStarted) / 1000))).path,
  pause: (paused: boolean): Promise<void> => (isNative ? invoke("capture_pause", { paused }) : Promise.resolve()),
  stop: (): Promise<void> => (isNative ? invoke("capture_stop") : Promise.resolve()),
  list: (): Promise<CaptureFile[]> => (isNative ? invoke<CaptureFile[]>("capture_list") : Promise.resolve([...sampleLibrary])),
  details: (paths: string[]): Promise<CaptureDetails[]> =>
    isNative
      ? invoke<CaptureDetails[]>("capture_details", { paths })
      : Promise.resolve(paths.map((path) => ({ path, thumb: sampleThumbs.get(path) ?? showcaseThumb(path), durationMs: sampleLengths.has(path) ? sampleLengths.get(path)! * 1000 : path.endsWith(".mp4") || path.endsWith(".m4a") ? 42_000 : null }))),
  remove: (path: string): Promise<void> => {
    if (isNative) return invoke("capture_delete", { path });
    const i = sampleLibrary.findIndex((f) => f.path === path);
    if (i >= 0) sampleLibrary.splice(i, 1);
    return Promise.resolve();
  },
  /** Find on screen: every monitor read with OCR, nothing saved. Rejects with "timeout", "no-ocr" or "failed". */
  findScan: (): Promise<FoundLine[]> =>
    isNative ? invoke<FoundLine[]>("find_scan") : demo ? import("../dev/demo-data").then((m) => new Promise<FoundLine[]>((done) => setTimeout(() => done(m.FOUND_LINES), 700))) : new Promise((done) => setTimeout(() => done(mockFound), 600)),
  /** A frame around a found line on screen for two seconds. */
  findHighlight: (rect: FoundLine["rect"]) => {
    if (isNative) void invoke("find_highlight", { rect });
  },
  /** Recording state from Rust: start, pause, resume, end. */
  onState: (handler: (s: CaptureRecState) => void): (() => void) => {
    if (!isNative) return () => {};
    const off = listen<CaptureRecState>("capture://state", (e) => handler(e.payload));
    return () => void off.then((f) => f());
  },
};

// ---------- OmniSearch ----------

export interface OmniResult {
  id: string;
  title: string;
  subtitle: string;
  category: "app" | "file" | "calc" | "pdf" | "action";
  icon: string;
  target: string;
  score: number;
  action_data?: string | null;
}

export const omnisearch = {
  query: (query: string, prefix?: string | null): Promise<OmniResult[]> =>
    isNative
      ? invoke<OmniResult[]>("omnisearch_query", { query, prefix: prefix ?? null })
      : Promise.resolve(mockOmniSearch(query, prefix)),
  open: (target: string, action: string = "open"): Promise<void> =>
    isNative ? invoke("omnisearch_open", { target, action }) : Promise.resolve(),
  status: (): Promise<string> =>
    isNative ? invoke<string>("omnisearch_index_status") : Promise.resolve("Browser mock active"),
};

function mockOmniSearch(query: string, prefix?: string | null): OmniResult[] {
  const q = query.trim().toLowerCase();
  const res: OmniResult[] = [];
  if (!q) return res;

  if (q.startsWith("t ") || prefix === "t") {
    const text = q.replace(/^t\s*/, "");
    return [
      {
        id: "mock_task",
        title: `Crear Tarea: "${text}"`,
        subtitle: "Presiona Enter para crear en Google Tasks / To-Dos",
        category: "action",
        icon: "task",
        target: `action:task:${text}`,
        score: 1000,
        action_data: text,
      },
    ];
  }

  if (q.startsWith("c ") || prefix === "c") {
    const text = q.replace(/^c\s*/, "");
    return [
      {
        id: "mock_cal",
        title: `Agendar Evento: "${text}"`,
        subtitle: "Presiona Enter para agendar en Google Calendar",
        category: "action",
        icon: "calendar",
        target: `action:calendar:${text}`,
        score: 1000,
        action_data: text,
      },
    ];
  }

  if (/^[\d\s+\-*/^%().,eEkmugnp]+$/.test(q) && /[+\-*/^%]/.test(q)) {
    try {
      const sanitized = q.replace(/pi/g, "Math.PI").replace(/e/g, "Math.E");
      const val = Function(`"use strict"; return (${sanitized})`)();
      if (typeof val === "number" && !isNaN(val)) {
        res.push({
          id: "calc_mock",
          title: String(val),
          subtitle: `= ${val} (Live Calculation)`,
          category: "calc",
          icon: "calc",
          target: `calc:${val}`,
          score: 2000,
          action_data: String(val),
        });
      }
    } catch {}
  }

  if (q.includes("elctrdig") || q.includes("electr")) {
    res.push({
      id: "mock_app_1",
      title: "Electrónica Digital",
      subtitle: "Apuntes y Software de Cátedra",
      category: "app",
      icon: "app",
      target: "C:\\Facultad\\Electronica_Digital.exe",
      score: 950,
    });
  }

  return res;
}

