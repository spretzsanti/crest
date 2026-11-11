//! Shell: the global shortcuts (Crest's own, the tools' own and the launcher's Alt+N, all in one registry), a
//! second launch, and the crash log.
//!
//! Shortcuts arrive from the settings as "Ctrl+Alt+Shift+Win+<KeyboardEvent.code>"; the resize
//! shortcut as "<modifiers>+Arrows", registered as four shortcuts. The frontend checks the
//! combinations and duplicates (src/features/window/hotkeys.ts); here a failed registration
//! means another program holds the combination. The microphone mute (mic.rs) is one more of them, unset until the user records it.
//! A tool's own shortcut opens the notch on that tool (`notch://tool`); the page closes it when that tool already shows.
//!
//! Crash log: panics and uncaught frontend errors are appended to crash.log in the app's log folder
//! (%LOCALAPPDATA%\io.github.andrealo20.crest\logs, or data\logs in a portable copy), rolled to crash.old.log past 512 KB.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::menu::MenuItem;
use tauri::{App, AppHandle, Emitter, Manager, State, Wry};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};
#[cfg(windows)]
use windows::Win32::System::SystemInformation::GetLocalTime;

use crate::display;

/// Until the frontend sends the saved shortcuts.
const DEFAULT_OPEN: &str = "Ctrl+Alt+Space";
const ARROWS: [(&str, &str); 4] = [("ArrowLeft", "left"), ("ArrowRight", "right"), ("ArrowUp", "up"), ("ArrowDown", "down")];

#[derive(Default)]
pub struct Hotkeys(Mutex<Bound>);

#[derive(Default)]
struct Bound {
    open: Option<Shortcut>,
    hide: Option<Shortcut>,
    resize: Vec<(Shortcut, &'static str)>,
    find: Option<Shortcut>,
    /// The microphone mute (mic.rs).
    mic: Option<Shortcut>,
    /// OmniSearch Alt+Space shortcut.
    omnisearch: Option<Shortcut>,
    /// The tools' own shortcuts and the tool id each opens.
    tools: Vec<(Shortcut, String)>,
    /// The launcher's Alt+N keys and the app id each opens.
    launch: Vec<(Shortcut, String)>,
    /// The tray's "Open Crest" item, which shows the open shortcut.
    tray_open: Option<MenuItem<Wry>>,
    /// Its text in the interface language ("" = English) and the shortcut shown after it.
    open_text: String,
    open_label: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyConfig {
    open: String,
    hide: String,
    resize: String,
    find: String,
    /// Optional; older saved settings and frontends do not send it.
    #[serde(default)]
    mic: String,
    /// Optional like `mic`: the tools whose shortcut the frontend found free, in dock order.
    #[serde(default)]
    tools: Vec<ToolKey>,
    /// The open shortcut as the tray shows it ("Ctrl+Alt+Space").
    open_label: String,
}

#[derive(Deserialize)]
pub struct ToolKey {
    id: String,
    keys: String,
}

#[derive(Serialize)]
pub struct HotkeyStatus {
    open: &'static str,
    hide: &'static str,
    resize: &'static str,
    find: &'static str,
    mic: &'static str,
    /// By tool id, for the tools sent.
    tools: HashMap<String, &'static str>,
}

/// The saved text in the plugin's spelling ("Win" is "Super" there); None for an unknown key.
fn parse(text: &str) -> Option<Shortcut> {
    let spelled: Vec<&str> = text.split('+').map(|p| if p.eq_ignore_ascii_case("win") { "Super" } else { p }).collect();
    Shortcut::from_str(&spelled.join("+")).ok()
}

fn label_text(text: &str, label: &str) -> String {
    let text = if text.is_empty() { "Open Crest" } else { text };
    if label.is_empty() { text.into() } else { format!("{text}\t{label}") }
}

/// Registers one shortcut: "unset", "active", "in-use" (another program holds it) or "invalid".
fn bind(app: &AppHandle, text: &str, slot: &mut Option<Shortcut>) -> &'static str {
    if text.is_empty() {
        return "unset";
    }
    let Some(shortcut) = parse(text) else { return "invalid" };
    if app.global_shortcut().register(shortcut).is_err() {
        return "in-use";
    }
    *slot = Some(shortcut);
    "active"
}

/// All four arrows or none: a resize shortcut with a missing direction would be confusing.
fn bind_arrows(app: &AppHandle, text: &str, slots: &mut Vec<(Shortcut, &'static str)>) -> &'static str {
    let Some(mods) = text.strip_suffix("+Arrows") else { return if text.is_empty() { "unset" } else { "invalid" } };
    for (code, dir) in ARROWS {
        let Some(shortcut) = parse(&format!("{mods}+{code}")) else { return "invalid" };
        if app.global_shortcut().register(shortcut).is_err() {
            for (s, _) in slots.drain(..) {
                let _ = app.global_shortcut().unregister(s);
            }
            return "in-use";
        }
        slots.push((shortcut, dir));
    }
    "active"
}

/// Replaces Crest's shortcuts with the saved ones. Async: registration waits for the main thread.
#[tauri::command]
pub async fn hotkeys_apply(config: HotkeyConfig, app: AppHandle, state: State<'_, Hotkeys>) -> Result<HotkeyStatus, String> {
    // Not locked while registering: that waits for the main thread, where the shortcut handler locks too.
    // Only Crest's own keys are taken out; the launcher's stay as they are (`bind_launch`).
    let (open, hide, resize, find, mic, tools) = {
        let mut b = state.0.lock().unwrap();
        (b.open.take(), b.hide.take(), std::mem::take(&mut b.resize), b.find.take(), b.mic.take(), std::mem::take(&mut b.tools))
    };
    let old = open.into_iter().chain(hide).chain(find).chain(mic).chain(resize.into_iter().map(|(s, _)| s)).chain(tools.into_iter().map(|(s, _)| s));
    for s in old {
        let _ = app.global_shortcut().unregister(s);
    }
    let (mut open, mut hide, mut resize, mut find, mut mic) = (None, None, Vec::new(), None, None);
    let mut status = HotkeyStatus {
        open: bind(&app, &config.open, &mut open),
        hide: bind(&app, &config.hide, &mut hide),
        resize: bind_arrows(&app, &config.resize, &mut resize),
        find: bind(&app, &config.find, &mut find),
        mic: bind(&app, &config.mic, &mut mic),
        tools: HashMap::new(),
    };
    // After Crest's own, which the frontend never lets a tool take.
    let mut tools = Vec::new();
    for tool in config.tools {
        let mut slot = None;
        status.tools.insert(tool.id.clone(), bind(&app, &tool.keys, &mut slot));
        if let Some(shortcut) = slot {
            tools.push((shortcut, tool.id));
        }
    }
    let mut b = state.0.lock().unwrap();
    b.open_label = if open.is_some() { config.open_label } else { String::new() };
    if let Some(item) = &b.tray_open {
        let _ = item.set_text(label_text(&b.open_text, &b.open_label));
    }
    (b.open, b.hide, b.resize, b.find, b.mic, b.tools) = (open, hide, resize, find, mic, tools);
    if b.omnisearch.is_none() {
        let _ = bind(&app, "Alt+Space", &mut b.omnisearch);
    }
    Ok(status)
}

/// The launcher's Alt+N keys (launcher.rs): frees the ones held before and registers these, each
/// opening its app id. Per key whether Windows gave it (false = another program, or a Crest shortcut, holds it).
pub fn bind_launch(app: &AppHandle, keys: Vec<(Shortcut, String)>) -> Vec<bool> {
    let state = app.state::<Hotkeys>();
    // A Crest shortcut on a launch key yields to it (hotkeys.ts does the same), even before `hotkeys_apply` runs.
    // The resize arrows can never be an Alt+digit key.
    let old: Vec<Shortcut> = {
        let mut b = state.0.lock().unwrap();
        let taken = |s: &mut Shortcut| keys.iter().any(|(k, _)| k.id() == s.id());
        let mut old: Vec<Shortcut> = std::mem::take(&mut b.launch).into_iter().map(|(s, _)| s).collect();
        old.extend(b.open.take_if(taken));
        old.extend(b.hide.take_if(taken));
        old.extend(b.find.take_if(taken));
        old.extend(b.mic.take_if(taken));
        let (lost, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut b.tools).into_iter().partition(|(s, _)| keys.iter().any(|(k, _)| k.id() == s.id()));
        b.tools = kept;
        old.extend(lost.into_iter().map(|(s, _)| s));
        old
    };
    for s in old {
        let _ = app.global_shortcut().unregister(s);
    }
    let mut held = Vec::new();
    let ok = keys
        .into_iter()
        .map(|(shortcut, id)| {
            let ok = app.global_shortcut().register(shortcut).is_ok();
            if ok {
                held.push((shortcut, id));
            }
            ok
        })
        .collect();
    state.0.lock().unwrap().launch = held;
    ok
}

/// For the global-shortcut plugin's handler.
pub fn on_shortcut(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state() != ShortcutState::Pressed {
        return;
    }
    let id = shortcut.id();
    let (open, hide, resize, find, mic, omnisearch, tool, launch) = {
        let b = app.state::<Hotkeys>();
        let b = b.0.lock().unwrap();
        (
            b.open.is_some_and(|s| s.id() == id),
            b.hide.is_some_and(|s| s.id() == id),
            b.resize.iter().find(|(s, _)| s.id() == id).map(|(_, d)| *d),
            b.find.is_some_and(|s| s.id() == id),
            b.mic.is_some_and(|s| s.id() == id),
            b.omnisearch.is_some_and(|s| s.id() == id),
            b.tools.iter().find(|(s, _)| s.id() == id).map(|(_, tool)| tool.clone()),
            b.launch.iter().find(|(s, _)| s.id() == id).map(|(_, app_id)| app_id.clone()),
        )
    };
    if let Some(app_id) = launch {
        // Only the launcher binds these, and it is Windows-only.
        #[cfg(windows)]
        crate::launcher::launch_from_key(app, app_id);
        #[cfg(not(windows))]
        let _ = app_id;
    } else if omnisearch {
        display::unhide(app);
        let _ = app.emit("notch://omnisearch", ());
    } else if open {
        display::unhide(app);
        let _ = app.emit("notch://shortcut", ());
    } else if hide {
        display::toggle_user_hidden(app);
    } else if let Some(dir) = resize {
        display::unhide(app);
        let _ = app.emit("notch://resize", dir);
    } else if find {
        // The page reads the screens (capture/find.rs) once it is open.
        display::unhide(app);
        let _ = app.emit("notch://find", ());
    } else if mic {
        // COM or a child process: not on the thread that handles the key.
        let app = app.clone();
        std::thread::spawn(move || crate::mic::toggle(&app));
    } else if let Some(tool) = tool {
        display::unhide(app);
        let _ = app.emit("notch://tool", tool);
    }
}

/// Tray "Open"/"Settings" and a second launch: bring Crest back if hidden, then open (on `tab`).
pub fn open(app: &AppHandle, tab: Option<&str>) {
    display::unhide(app);
    let _ = app.emit("notch://open", tab);
}

/// A second launch of Crest opens the settings of the running one.
pub fn second_launch(app: &AppHandle) {
    open(app, Some("settings"));
}

/// Remembers the tray item that shows the open shortcut.
pub fn set_tray_open(app: &App, item: MenuItem<Wry>) {
    app.state::<Hotkeys>().0.lock().unwrap().tray_open = Some(item);
}

/// The "Open Crest" item in the interface language (lib.rs `tray_texts`).
pub fn set_open_text(app: &AppHandle, text: String) {
    let state = app.state::<Hotkeys>();
    let mut b = state.0.lock().unwrap();
    b.open_text = text;
    if let Some(item) = &b.tray_open {
        let _ = item.set_text(label_text(&b.open_text, &b.open_label));
    }
}

/// At start: credentials copied from the old prefix, crash log, the default open shortcut.
pub fn init(app: &App) {
    if let Ok(dir) = crate::portable::app_data_dir(app.handle()) {
        crate::secrets::migrate_legacy(&dir);
    }
    // A portable copy keeps its log in its own folder.
    if let Some(dir) = crate::portable::data_dir().map(|d| d.join("logs")).or_else(|| app.path().app_log_dir().ok()) {
        install_crash_log(dir);
    }
    // If another app owns the shortcut, Crest still runs, just without it.
    let mut open = None;
    let _ = bind(app.handle(), DEFAULT_OPEN, &mut open);
    let mut omnisearch = None;
    let _ = bind(app.handle(), "Alt+Space", &mut omnisearch);
    let state = app.state::<Hotkeys>();
    let mut b = state.0.lock().unwrap();
    b.open = open;
    b.omnisearch = omnisearch;
    b.open_label = DEFAULT_OPEN.into();
}

/// The tray's "Open Crest" text before the frontend has sent the saved shortcut.
pub fn default_open_label() -> String {
    label_text("", DEFAULT_OPEN)
}

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
const LOG_MAX: u64 = 512 * 1024;

fn install_crash_log(dir: PathBuf) {
    let _ = LOG_DIR.set(dir);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
        append(&format!("panic in thread '{thread}': {info}\n{}", std::backtrace::Backtrace::force_capture()));
        previous(info);
    }));
}

/// Uncaught frontend errors (the page can't write files itself). Capped so a runaway message can't fill the disk.
#[tauri::command]
pub fn crash_log(text: String) {
    let text: String = text.chars().take(4000).collect();
    append(&format!("frontend: {text}"));
}

fn append(text: &str) {
    let Some(dir) = LOG_DIR.get() else { return };
    let _ = write_entry(dir, text);
}

fn write_entry(dir: &Path, text: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("crash.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > LOG_MAX) {
        std::fs::rename(&path, dir.join("crash.old.log"))?;
    }
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    #[cfg(windows)]
    let t = unsafe { GetLocalTime() };
    #[cfg(windows)]
    let stamp = format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond);
    #[cfg(not(windows))]
    let stamp = jiff::Zoned::now().strftime("%Y-%m-%d %H:%M:%S").to_string();
    writeln!(file, "[{stamp}] Crest {} {}", env!("CARGO_PKG_VERSION"), text.trim_end())
}
