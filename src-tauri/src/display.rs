//! Display: which monitor the notch sits on, its scale, and what it does while other windows fill that monitor.
//!
//! A thread reads the foreground window every 400 ms and classifies it (maximized, borderless or
//! exclusive full screen, see screen_policy.rs). With "also check windows behind" a maximized or
//! borderless window behind it counts too. The rules answer keep, line or hide: Rust hides the
//! window itself and emits `notch://screen` so the frontend can draw the line. `notch://fullscreen`
//! still reports a full-screen foreground for gaming mode. On every new foreground window "always
//! on top" is reapplied in case another app put itself above.
//!
//! The hide hotkey (shell.rs) hides Crest on top of that until it is pressed again, the notch is
//! opened from the tray, or "raise now" runs. Opening on purpose also shows Crest over a "hide" rule
//! until the notch closes; the floating timer hides and shows with the notch.
//!
//! `offset` moves the notch along its edge (dragging), clamped to the monitor. `zoom` is the panel scale:
//! the page is zoomed and the window grown by it, so CSS px times DPI times zoom are device pixels.
//! `edge` and `line` put the window on another screen edge (bottom, left, right).
//!
//! `mode` "follow" or "all" (mirror.rs): the frontend picks `monitor` from where the pointer is, and with "all" sends a `spot`
//! (line and window top) for every monitor, where mirror.rs places a closed-only copy of the notch.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;
#[cfg(windows)]
use std::thread;
#[cfg(windows)]
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, State, WebviewWindow};
#[cfg(windows)]
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
#[cfg(windows)]
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST};
#[cfg(windows)]
use windows::Win32::System::Threading::GetCurrentProcessId;
#[cfg(windows)]
use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_RUNNING_D3D_FULL_SCREEN};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetDesktopWindow, GetForegroundWindow, GetShellWindow, GetWindow, GetWindowLongPtrW, GetWindowRect,
    GetWindowTextLengthW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, IsZoomed, SetWindowPos, GWL_EXSTYLE, GWL_STYLE, GW_OWNER,
    HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WS_CAPTION, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::FindWindowExW;
#[cfg(windows)]
use windows::core::{w, PCWSTR};

use crate::hit_test::HitState;
#[cfg(windows)]
use crate::screen_policy::Context;
use crate::screen_policy::{self, Behavior, Rules};

#[cfg(windows)]
const POLL: Duration = Duration::from_millis(400);

#[derive(Default)]
pub struct DisplayState {
    config: Mutex<Config>,
    /// Hidden with the hide hotkey.
    user_hidden: AtomicBool,
    /// The rules call for hiding right now.
    rule_hide: AtomicBool,
    /// Opened on purpose (shortcut, tray, second launch, launcher): shown over `rule_hide` until the notch closes.
    opened: AtomicBool,
    /// The window is hidden right now.
    hidden: AtomicBool,
    /// Last behaviour the rules called for (Behavior as u8), for `display_screen`.
    behavior: AtomicU8,
    /// An app covers the notch's monitor in fullscreen right now, for `display_fullscreen`.
    fullscreen: AtomicBool,
    /// Whether the notch is currently expanded (open, peek, or omni) or closed/line.
    pub(crate) expanded: AtomicBool,
    /// The monitors (HMONITOR) of other screens where a window calls for hiding or the line, so their mirrors hide.
    pub(crate) mirror_block: Mutex<Vec<isize>>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// Monitor name ("\\.\DISPLAY2"); None = primary monitor.
    pub(crate) monitor: Option<String>,
    /// "follow" (the notch goes where the pointer is) or "all" (a mirror on every other monitor); empty = the chosen monitor.
    #[serde(default)]
    pub(crate) mode: String,
    /// With "all": where the window goes on each monitor, worked out by the frontend from that monitor's size and taskbar.
    #[serde(default)]
    pub(crate) spots: Vec<Spot>,
    /// Horizontal offset from the center in CSS px.
    #[serde(default)]
    offset: f64,
    /// Window top below the monitor's top edge in CSS px (the frontend computes it).
    #[serde(default)]
    y: f64,
    /// Gaming mode: full screen keeps the style so FPS show.
    #[serde(default)]
    gaming: bool,
    /// A malformed rule is skipped instead of failing the whole call.
    #[serde(default, deserialize_with = "screen_policy::lenient_rules")]
    rules: Rules,
    /// Panel scale, 0.8 to 2.0 (fit_zoom).
    #[serde(default = "one")]
    pub(crate) zoom: f64,
    /// Screen edge the window hangs from: "top" (default), "bottom", "left" or "right" (src/notch/edge.ts).
    #[serde(default)]
    edge: String,
    /// Where that edge's frame starts, CSS px from the monitor's top (bottom) or left (left, right). On top `y` is used.
    #[serde(default)]
    line: f64,
    /// The window's length along that edge in CSS px, longer than `ALONG` for a wide closed notch (src/notch/collapsed.ts windowAlong); see `fit_along`.
    #[serde(default)]
    along: f64,
}

/// `line` and `y` of Config for one monitor.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Spot {
    pub monitor: String,
    pub line: f64,
    pub y: f64,
}

fn one() -> f64 {
    1.0
}

impl Default for Config {
    fn default() -> Self {
        Config {
            monitor: None,
            mode: String::new(),
            spots: Vec::new(),
            offset: 0.0,
            y: 0.0,
            gaming: false,
            rules: Rules::default(),
            zoom: 1.0,
            edge: String::new(),
            line: 0.0,
            along: 0.0,
        }
    }
}

/// Only the scales the settings offer (src/features/window/panelSize.ts PANEL_SCALES); anything else is 100 %.
fn fit_zoom(z: f64) -> f64 {
    [0.8, 0.9, 1.1, 1.25, 1.5, 1.75, 2.0].into_iter().find(|s| (z - s).abs() < 0.01).unwrap_or(1.0)
}

/// The window's logical size at 100 %: as on top (tauri.conf.json), and on a side edge as deep as long so the widest panel fits across.
const ALONG: f64 = 760.0;
const DEPTH: f64 = 560.0;
const SIDE_DEPTH: f64 = 760.0;
/// Dynamic viewport: closed capsule bounds (~300x44 px) to shrink HWND DirectComposition framebuffer when not expanded.
const CLOSED_ALONG: f64 = 300.0;
const CLOSED_DEPTH: f64 = 44.0;
/// The longest window along the edge: the widest closed notch the settings allow (8000) and the room around it.
const MAX_ALONG: f64 = 8060.0;

/// The window's length along its edge at 100 %: `ALONG`, or what a wider closed notch asks for, up to `MAX_ALONG`.
fn fit_along(along: f64) -> f64 {
    if along.is_finite() {
        along.clamp(ALONG, MAX_ALONG)
    } else {
        ALONG
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    name: String,
    primary: bool,
    width: u32,
    height: u32,
    /// Work area (without taskbar) in CSS px: top below the monitor's top edge, and height.
    work_top: f64,
    work_height: f64,
    /// The work area's left edge from the monitor's left, and its width (a taskbar on the left or right), in CSS px.
    work_left: f64,
    work_width: f64,
}

/// The name each monitor goes by, in the order given. A Mac names a display by its model, so two of one model share a name:
/// the later one (by position, left to right) gets a number, and the first keeps the plain name it was saved under.
/// `monitors`: name, x and y of each.
fn unique_names(monitors: &[(String, i32, i32)]) -> Vec<String> {
    let mut order: Vec<usize> = (0..monitors.len()).collect();
    order.sort_by_key(|&i| (monitors[i].1, monitors[i].2));
    let mut names = vec![String::new(); monitors.len()];
    for (at, &i) in order.iter().enumerate() {
        let same = order[..at].iter().filter(|&&j| monitors[j].0 == monitors[i].0).count();
        names[i] = if same == 0 { monitors[i].0.clone() } else { format!("{} ({})", monitors[i].0, same + 1) };
    }
    names
}

/// The monitors with the name `unique_names` gives each.
fn named_monitors(window: &WebviewWindow) -> Vec<(String, tauri::Monitor)> {
    let monitors = window.available_monitors().unwrap_or_default();
    let keys: Vec<_> = monitors.iter().map(|m| (m.name().cloned().unwrap_or_default(), m.position().x, m.position().y)).collect();
    unique_names(&keys).into_iter().zip(monitors).collect()
}

#[tauri::command]
pub fn display_monitors(window: WebviewWindow, state: State<'_, DisplayState>) -> Vec<MonitorInfo> {
    let zoom = state.config.lock().unwrap().zoom;
    let primary = window.primary_monitor().ok().flatten().map(|m| *m.position());
    named_monitors(&window)
        .into_iter()
        .map(|(name, m)| {
            let scale = m.scale_factor() * zoom;
            let wa = m.work_area();
            MonitorInfo {
                primary: primary == Some(*m.position()),
                width: (m.size().width as f64 / scale) as u32,
                height: (m.size().height as f64 / scale) as u32,
                work_top: (wa.position.y - m.position().y) as f64 / scale,
                work_height: wa.size.height as f64 / scale,
                work_left: (wa.position.x - m.position().x) as f64 / scale,
                work_width: wa.size.width as f64 / scale,
                name,
            }
        })
        .collect()
}

#[tauri::command]
pub fn display_apply(mut config: Config, window: WebviewWindow, state: State<'_, DisplayState>, hit: State<'_, HitState>) {
    config.zoom = fit_zoom(config.zoom);
    let (moved, zoomed, mirrored) = {
        let cur = state.config.lock().unwrap();
        (
            cur.monitor != config.monitor || cur.offset != config.offset || cur.y != config.y || cur.edge != config.edge || cur.line != config.line || cur.along != config.along,
            cur.zoom != config.zoom,
            cur.mode != config.mode || cur.spots != config.spots,
        )
    };
    let zoom = config.zoom;
    hit.set_edge(&config.edge);
    *state.config.lock().unwrap() = config;
    // The window's size follows the edge and the zoom in `place`.
    if zoomed {
        let _ = window.set_zoom(zoom);
        hit.set_zoom(zoom);
    }
    if moved || zoomed {
        let _ = place(&window, &state);
    }
    if moved || zoomed || mirrored {
        crate::mirror::wake(window.app_handle());
    }
}

/// What the rules call for right now ("normal" | "line" | "hide"), for the frontend's start.
#[tauri::command]
pub fn display_screen(state: State<'_, DisplayState>) -> &'static str {
    behavior_from(state.behavior.load(Ordering::Relaxed)).as_str()
}

/// Whether an app covers the notch's monitor in fullscreen right now, for the frontend's start (the event may have come before it listened).
#[tauri::command]
pub fn display_fullscreen(state: State<'_, DisplayState>) -> bool {
    state.fullscreen.load(Ordering::Relaxed)
}

/// "Raise now": shows Crest if the hide hotkey hid it and puts it on top of the topmost windows.
#[tauri::command]
pub fn display_raise(app: AppHandle) {
    // Not `unhide`: nothing opens here, so a "hide" rule keeps its say.
    if app.state::<DisplayState>().user_hidden.swap(false, Ordering::Relaxed) {
        sync(&app);
    }
    let Some(window) = app.get_webview_window("notch") else { return };
    #[cfg(windows)]
    {
        raise_topmost(&window);
        crate::mirror::raise(&app);
    }
    #[cfg(target_os = "macos")]
    crate::macos::raise(&window);
}

/// Puts the window on top of the other topmost windows. `set_always_on_top(true)` does nothing on a window that is already topmost.
#[cfg(windows)]
pub(crate) fn raise_topmost(window: &WebviewWindow) {
    if let Ok(hwnd) = window.hwnd() {
        let _ = unsafe { SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE) };
    }
}

#[derive(Serialize)]
pub struct RunningApp {
    name: String,
    path: String,
}

/// Apps with a visible window, for adding an app rule. Each executable once.
#[cfg(windows)]
#[tauri::command]
pub async fn display_apps() -> Vec<RunningApp> {
    let own = unsafe { GetCurrentProcessId() };
    let mut seen = std::collections::HashSet::new();
    let mut apps = Vec::new();
    for hwnd in top_windows() {
        let titled = unsafe { GetWindowTextLengthW(hwnd) } > 0;
        let owned = unsafe { GetWindow(hwnd, GW_OWNER) }.is_ok_and(|o| !o.is_invalid());
        if !titled || owned || !candidate(hwnd) || has_ex_style(hwnd, WS_EX_TOOLWINDOW.0) {
            continue;
        }
        let pid = app_pid(hwnd);
        if pid == own {
            continue;
        }
        let Some(path) = crate::mixer::process_path(pid) else { continue };
        if seen.insert(path.to_lowercase()) {
            apps.push(RunningApp { name: exe_name(&path), path });
        }
    }
    apps.sort_by_key(|a| a.name.to_lowercase());
    apps
}

/// App rules need the foreground window's app, which the Mac does not read yet: nothing to pick from.
#[cfg(not(windows))]
#[tauri::command]
pub async fn display_apps() -> Vec<RunningApp> {
    Vec::new()
}

/// Hide hotkey: hides Crest, or shows it again.
pub fn toggle_user_hidden(app: &AppHandle) {
    let state = app.state::<DisplayState>();
    let now = !state.user_hidden.load(Ordering::Relaxed);
    state.user_hidden.store(now, Ordering::Relaxed);
    sync(app);
}

/// Opening from the tray, the open hotkey, a second launch or the launcher brings back a Crest hidden with
/// the hotkey, and shows it over a "hide" rule until the notch closes again.
pub fn unhide(app: &AppHandle) {
    let state = app.state::<DisplayState>();
    state.user_hidden.store(false, Ordering::Relaxed);
    state.opened.store(true, Ordering::Relaxed);
    sync(app);
}

/// The notch closed (keyboard_focus(false) in lib.rs): the rules hide it again.
pub fn closed(app: &AppHandle) {
    if app.state::<DisplayState>().opened.swap(false, Ordering::Relaxed) {
        sync(app);
    }
}

/// Hidden with the hide hotkey (the mirrors hide with it; a rule only hides the notch on its own monitor).
pub fn user_hidden(app: &AppHandle) -> bool {
    app.state::<DisplayState>().user_hidden.load(Ordering::Relaxed)
}

/// Hidden by a rule or the hotkey; the hit-test thread rests meanwhile.
pub fn is_hidden(app: &AppHandle) -> bool {
    app.state::<DisplayState>().hidden.load(Ordering::Relaxed)
}

/// Shows or hides the window (and the floating timer with it) to match the hotkey and the rules; only acts on a change.
fn sync(app: &AppHandle) {
    let state = app.state::<DisplayState>();
    let rule_hide = state.rule_hide.load(Ordering::Relaxed) && !state.opened.load(Ordering::Relaxed);
    let hide = state.user_hidden.load(Ordering::Relaxed) || rule_hide;
    if state.hidden.swap(hide, Ordering::Relaxed) == hide {
        return;
    }
    crate::mirror::wake(app);
    // Hiding the window does not hide the page, so the Camera tool learns it here.
    let _ = app.emit("notch://hidden", hide);
    // The timer window exists only while it is open (timer_window.rs destroys it on close).
    if let Some(timer) = app.get_webview_window("timer") {
        let _ = if hide { timer.hide() } else { timer.show() };
    }
    let Some(window) = app.get_webview_window("notch") else { return };
    if hide {
        let _ = window.hide();
    } else {
        let _ = window.show();
        #[cfg(windows)]
        raise_topmost(&window);
        #[cfg(target_os = "macos")]
        {
            let _ = window.set_always_on_top(true);
            crate::macos::raise(&window);
        }
        // Let the click-through state be set again after show() (the poll caches the old one).
        app.state::<HitState>().refresh();
    }
}

/// Dynamically resizes and repositions the notch window HWND based on expanded state.
#[tauri::command]
pub fn notch_set_expanded(expanded: bool, window: WebviewWindow, state: State<'_, DisplayState>) -> tauri::Result<()> {
    state.expanded.store(expanded, Ordering::Relaxed);
    place(&window, &state)?;
    Ok(())
}

/// Centered on the chosen monitor (primary otherwise), `y` CSS px below its top edge (clamped to the monitor).
/// Off the top edge the window's own edge goes on `line`, centred along that edge, and on a side edge it is as deep as long.
pub fn place(window: &WebviewWindow, state: &DisplayState) -> tauri::Result<()> {
    let c = state.config();
    put(window, c.monitor.as_deref(), &c, c.line, c.y, state.expanded.load(Ordering::Relaxed))
}

impl DisplayState {
    pub(crate) fn config(&self) -> Config {
        self.config.lock().unwrap().clone()
    }
}

/// `place` for any window: on `wanted` (the primary monitor when it is missing), with `line` and `y` for that monitor and the rest of `c`.
pub(crate) fn put(window: &WebviewWindow, wanted: Option<&str>, c: &Config, line: f64, y: f64, expanded: bool) -> tauri::Result<()> {
    let (offset, zoom, edge, along) = (c.offset, c.zoom, c.edge.as_str(), fit_along(c.along));
    let side = edge == "left" || edge == "right";
    let monitor = wanted
        .and_then(|name| named_monitors(window).into_iter().find(|(n, _)| n == name).map(|(_, m)| m))
        .or(window.primary_monitor()?);
    let Some(monitor) = monitor else { return Ok(()) };
    // Set twice: when moving to a monitor with different scaling, the window size
    // only updates after the first move.
    for _ in 0..2 {
        let mut size = window.outer_size()?;
        // Dynamic viewport: 760x560 when expanded (open/peek), 300x44 when closed/line
        let (lw, lh) = if expanded {
            (if side { SIDE_DEPTH } else { along } * zoom, if side { along } else { DEPTH } * zoom)
        } else {
            (if side { CLOSED_DEPTH } else { CLOSED_ALONG } * zoom, if side { CLOSED_ALONG } else { CLOSED_DEPTH } * zoom)
        };
        let dpi = window.scale_factor()?;
        if (size.width as f64 - lw * dpi).abs() > 2.0 || (size.height as f64 - lh * dpi).abs() > 2.0 {
            window.set_size(LogicalSize::new(lw, lh))?;
            size = window.outer_size()?;
        }
        let monitor_px = (monitor.size().width as i32, monitor.size().height as i32);
        let at = Placement { edge, offset, y, line, keep: kept_along(if expanded { along } else { CLOSED_ALONG }), scale: monitor.scale_factor() * zoom };
        let (x, top) = at.position(monitor_px, (size.width as i32, size.height as i32));
        window.set_position(PhysicalPosition::new(monitor.position().x + x, monitor.position().y + top))?;
    }
    Ok(())
}

/// The widest panel along its edge in CSS px (panelSize.ts MAX_SIZE), kept on the monitor when the notch is moved.
const PANEL_ALONG: f64 = 740.0;

/// What stays on the monitor when a window this long is moved along its edge: the widest panel, or a wider closed notch with its hover nudge,
/// which a longer window holds with the same margin as `ALONG` holds the panel.
fn kept_along(along: f64) -> f64 {
    fit_along(along) - (ALONG - PANEL_ALONG)
}

/// Where the window goes on its monitor; CSS px values, `scale` = monitor DPI x zoom.
struct Placement<'a> {
    edge: &'a str,
    offset: f64,
    y: f64,
    line: f64,
    /// The length along the edge kept on the monitor (`kept_along`).
    keep: f64,
    scale: f64,
}

impl Placement<'_> {
    /// The window's top-left in physical px from the monitor's top-left, for a `window` (w, h) on a `monitor` (w, h).
    /// The hanging edge stays on `line` (or `y` on top) and the window is centred along the edge even when it is larger
    /// than the monitor (a big scale on a small screen), so the notch never leaves its edge; the offset along the edge
    /// is clamped so the widest panel (or a wider closed notch) stays on the monitor.
    fn position(&self, (mw, mh): (i32, i32), (w, h): (i32, i32)) -> (i32, i32) {
        let line = (self.line * self.scale).round() as i32;
        let side = self.edge == "left" || self.edge == "right";
        let (m_along, w_along) = if side { (mh, h) } else { (mw, w) };
        let free = (m_along - (self.keep * self.scale).round() as i32).max(0);
        let along = (m_along - w_along) / 2 + ((self.offset * self.scale) as i32).clamp(-free / 2, free / 2);
        match self.edge {
            "bottom" => (along, line - h),
            "left" => (line, along),
            "right" => (line - w, along),
            _ => (along, ((self.y * self.scale) as i32).min(mh - h).max(0)),
        }
    }
}

#[cfg(windows)]
pub fn spawn(app: AppHandle, window: WebviewWindow) {
    thread::spawn(move || {
        let Ok(own) = window.hwnd() else { return };
        let mut last_fullscreen = false;
        let mut last_behavior: Option<Behavior> = None;
        let mut last_foreground = HWND::default();
        let (mut front, mut behind) = (Known::default(), Known::default());
        // What each other monitor's window was last known as: its frontmost window and the one behind it.
        let mut aside: std::collections::HashMap<isize, (Known, Known)> = Default::default();
        loop {
            thread::sleep(POLL);
            // Screen off or suspending (standby.rs): the windows and monitors are not read until it is back.
            if crate::standby::asleep() {
                continue;
            }
            let state = app.state::<DisplayState>();
            let (rules, gaming, mirrors) = {
                let c = state.config.lock().unwrap();
                (c.rules.clone(), c.gaming, c.mode == "all")
            };
            let foreground = unsafe { GetForegroundWindow() };
            let monitor = unsafe { MonitorFromWindow(own, MONITOR_DEFAULTTONEAREST) };
            let fg = read_foreground(foreground, own, monitor, &mut front);
            // Looked up only where it can matter: nothing in front fills the monitor.
            let bg = (rules.background_matters() && fg.context == Context::Desktop)
                .then(|| read_background(foreground, own, monitor, &mut behind))
                .flatten();

            let fullscreen = fg.context.is_fullscreen();
            if fullscreen != last_fullscreen {
                last_fullscreen = fullscreen;
                state.fullscreen.store(fullscreen, Ordering::Relaxed);
                let _ = app.emit("notch://fullscreen", fullscreen);
            }
            let behavior = screen_policy::decide(
                &rules,
                (fg.context, &fg.name, &fg.path),
                bg.as_ref().map(|b| (b.context, b.name.as_str(), b.path.as_str())),
                gaming,
            );
            if last_behavior != Some(behavior) {
                last_behavior = Some(behavior);
                state.behavior.store(behavior as u8, Ordering::Relaxed);
                state.rule_hide.store(behavior == Behavior::Hide, Ordering::Relaxed);
                let _ = app.emit("notch://screen", behavior.as_str());
                sync(&app);
            }
            // With mirrors, the windows on another monitor answer for the mirror there, read like the notch's own screen.
            let mut block = Vec::new();
            if mirrors {
                for m in crate::mirror::monitors(&app).into_iter().filter(|&m| m != monitor.0 as isize) {
                    let (near, far) = aside.entry(m).or_default();
                    let elsewhere = HMONITOR(m as *mut _);
                    let seen = read_foreground(foreground, own, elsewhere, near);
                    let back = (rules.background_matters() && seen.context == Context::Desktop).then(|| read_background(foreground, own, elsewhere, far)).flatten();
                    let rule = screen_policy::decide(&rules, (seen.context, &seen.name, &seen.path), back.as_ref().map(|b| (b.context, b.name.as_str(), b.path.as_str())), gaming);
                    if rule != Behavior::Normal {
                        block.push(m);
                    }
                }
            }
            if std::mem::replace(&mut *state.mirror_block.lock().unwrap(), block.clone()) != block {
                crate::mirror::wake(&app);
            }
            // New foreground window: reapply "on top" in case it covered us.
            if !state.hidden.load(Ordering::Relaxed) && foreground != last_foreground {
                raise_topmost(&window);
            }
            last_foreground = foreground;
        }
    });
}

fn behavior_from(v: u8) -> Behavior {
    match v {
        1 => Behavior::Line,
        2 => Behavior::Hide,
        _ => Behavior::Normal,
    }
}

#[cfg(windows)]
/// One window as the rules see it.
struct Seen {
    context: Context,
    name: String,
    path: String,
}

#[cfg(windows)]
impl Seen {
    fn desktop() -> Seen {
        Seen { context: Context::Desktop, name: String::new(), path: String::new() }
    }
}

#[cfg(windows)]
/// The last window's app, so the executable is read once per window instead of every poll.
#[derive(Default)]
struct Known {
    hwnd: isize,
    pid: u32,
    name: String,
    path: String,
}

#[cfg(windows)]
impl Known {
    fn describe(&mut self, hwnd: HWND, pid: u32) -> (String, String) {
        if self.hwnd != hwnd.0 as isize || self.pid != pid {
            let path = crate::mixer::process_path(pid).unwrap_or_default();
            *self = Known { hwnd: hwnd.0 as isize, pid, name: exe_name(&path), path };
        }
        (self.name.clone(), self.path.clone())
    }
}

#[cfg(windows)]
fn read_foreground(hwnd: HWND, own: HWND, monitor: HMONITOR, known: &mut Known) -> Seen {
    if hwnd.is_invalid() || hwnd == own || !candidate(hwnd) || unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) } != monitor {
        return Seen::desktop();
    }
    let pid = window_pid(hwnd);
    if pid == unsafe { GetCurrentProcessId() } {
        return Seen::desktop();
    }
    let Some(m) = monitor_rect(monitor) else { return Seen::desktop() };
    let (name, path) = known.describe(hwnd, app_pid(hwnd));
    // The notification state is global; with the foreground window on our monitor, it is this window.
    let exclusive = unsafe { SHQueryUserNotificationState() }.is_ok_and(|s| s == QUNS_RUNNING_D3D_FULL_SCREEN);
    let context = screen_policy::classify(exclusive, covers(frame_rect(hwnd), m), has_caption(hwnd), unsafe { IsZoomed(hwnd) }.as_bool());
    Seen { context, name, path }
}

#[cfg(windows)]
/// A maximized or frameless full-monitor window on our monitor behind the foreground one (a browser left
/// maximized behind another app, a borderless game in the background). Skips tool and cloaked windows
/// (other virtual desktops) and our own.
fn read_background(foreground: HWND, own: HWND, monitor: HMONITOR, known: &mut Known) -> Option<Seen> {
    let m = monitor_rect(monitor)?;
    let own_pid = unsafe { GetCurrentProcessId() };
    // EnumWindows runs from the top of the z-order, so the first match is the frontmost one.
    for hwnd in top_windows() {
        if hwnd == foreground || hwnd == own || !candidate(hwnd) || unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) } != monitor {
            continue;
        }
        let maximized = unsafe { IsZoomed(hwnd) }.as_bool();
        let caption = has_caption(hwnd);
        let full = covers(frame_rect(hwnd), m);
        // Tool windows, click-through and never-activated windows are overlays (dimmers, recording frames), not apps.
        if (!maximized && !(full && !caption)) || has_ex_style(hwnd, WS_EX_TOOLWINDOW.0 | WS_EX_TRANSPARENT.0 | WS_EX_NOACTIVATE.0) {
            continue;
        }
        let pid = window_pid(hwnd);
        if pid == own_pid {
            continue;
        }
        let (name, path) = known.describe(hwnd, app_pid(hwnd));
        return Some(Seen { context: screen_policy::classify(false, full, caption, maximized), name, path });
    }
    None
}

#[cfg(windows)]
/// Visible, not minimized, not cloaked, not the desktop or taskbar.
fn candidate(hwnd: HWND) -> bool {
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() || is_desktop(hwnd) {
            return false;
        }
        let mut cloaked = 0u32;
        let ok = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, 4).is_ok();
        !(ok && cloaked != 0)
    }
}

#[cfg(windows)]
fn top_windows() -> Vec<HWND> {
    unsafe extern "system" fn collect(hwnd: HWND, list: LPARAM) -> windows::core::BOOL {
        (*(list.0 as *mut Vec<HWND>)).push(hwnd);
        true.into()
    }
    let mut list: Vec<HWND> = Vec::new();
    let _ = unsafe { EnumWindows(Some(collect), LPARAM(&mut list as *mut Vec<HWND> as isize)) };
    list
}

#[cfg(windows)]
fn window_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

#[cfg(windows)]
/// The app behind a window: a UWP app's frame belongs to ApplicationFrameHost, its CoreWindow child to the app.
fn app_pid(hwnd: HWND) -> u32 {
    if class_name(hwnd) == "ApplicationFrameWindow" {
        if let Ok(core) = unsafe { FindWindowExW(Some(hwnd), None, w!("Windows.UI.Core.CoreWindow"), PCWSTR::null()) } {
            if !core.is_invalid() {
                return window_pid(core);
            }
        }
    }
    window_pid(hwnd)
}

#[cfg(windows)]
fn has_ex_style(hwnd: HWND, bits: u32) -> bool {
    unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & bits != 0 }
}

#[cfg(windows)]
fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 64];
    let len = unsafe { GetClassNameW(hwnd, &mut buf) }.max(0) as usize;
    String::from_utf16_lossy(&buf[..len])
}

#[cfg(windows)]
/// "C:\…\Game.exe" → "Game".
fn exe_name(path: &str) -> String {
    let file = path.rsplit(['\\', '/']).next().unwrap_or(path);
    file.strip_suffix(".exe").or_else(|| file.strip_suffix(".EXE")).unwrap_or(file).to_string()
}

#[cfg(windows)]
fn has_caption(hwnd: HWND) -> bool {
    unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) as u32 & WS_CAPTION.0 != 0 }
}

#[cfg(windows)]
/// The visible frame (without the invisible resize borders), else the window rect.
fn frame_rect(hwnd: HWND) -> RECT {
    let mut rect = RECT::default();
    unsafe {
        if DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut rect as *mut RECT as *mut _, std::mem::size_of::<RECT>() as u32).is_err() {
            let _ = GetWindowRect(hwnd, &mut rect);
        }
    }
    rect
}

#[cfg(windows)]
fn monitor_rect(monitor: HMONITOR) -> Option<RECT> {
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool().then_some(info.rcMonitor)
}

#[cfg(windows)]
/// Covers the whole monitor, give or take 2 px.
fn covers(r: RECT, m: RECT) -> bool {
    r.left <= m.left + 2 && r.top <= m.top + 2 && r.right >= m.right - 2 && r.bottom >= m.bottom - 2
}

#[cfg(windows)]
/// Desktop and taskbar never count as fullscreen.
fn is_desktop(hwnd: HWND) -> bool {
    if unsafe { hwnd == GetDesktopWindow() || hwnd == GetShellWindow() } {
        return true;
    }
    matches!(class_name(hwnd).as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd")
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monitors_of_one_model_get_distinct_names_and_the_first_keeps_its_own() {
        let named = |list: &[(&str, i32, i32)]| unique_names(&list.iter().map(|(n, x, y)| (n.to_string(), *x, *y)).collect::<Vec<_>>());
        assert_eq!(named(&[("Monitor #1", 0, 0), ("Monitor #2", 1920, 0)]), ["Monitor #1", "Monitor #2"]);
        // The order given is kept; the numbering follows the position, left to right.
        assert_eq!(named(&[("Monitor #7", 2560, 0), ("Monitor #7", 0, 0), ("Monitor #7", -2560, 0)]), ["Monitor #7 (3)", "Monitor #7 (2)", "Monitor #7"]);
        assert!(named(&[]).is_empty());
    }

    /// 1920 x 1080 at 100, 125 and 150 % Windows scaling, panel scale from 0.8 to 2, on every edge, hanging from the screen edge,
    /// with the usual window and one lengthened for a wide closed notch.
    #[test]
    fn only_the_offered_panel_scales_are_kept() {
        assert_eq!(fit_zoom(1.25), 1.25);
        assert_eq!(fit_zoom(0.8), 0.8);
        assert_eq!(fit_zoom(2.0), 2.0);
        assert_eq!(fit_zoom(1.3), 1.0);
        assert_eq!(fit_zoom(f64::NAN), 1.0);
        assert_eq!(fit_zoom(5.0), 1.0);
    }

    #[test]
    fn the_notch_stays_on_its_edge_and_centred_even_when_the_window_is_larger_than_the_monitor() {
        let (mw, mh) = (1920, 1080);
        for wanted in [0.0, 1400.0] {
            let length = fit_along(wanted);
            for dpi in [1.0, 1.25, 1.5] {
                for zoom in [0.8, 1.0, 1.25, 1.5, 2.0] {
                    let scale = dpi * zoom;
                    for edge in ["top", "bottom", "left", "right"] {
                        let side = edge == "left" || edge == "right";
                        let w = ((if side { SIDE_DEPTH } else { length }) * zoom * dpi).round() as i32;
                        let h = ((if side { length } else { DEPTH }) * zoom * dpi).round() as i32;
                        let line = match edge {
                            "bottom" => mh as f64 / scale,
                            "right" => mw as f64 / scale,
                            _ => 0.0,
                        };
                        let at = |offset: f64| Placement { edge, offset, y: 0.0, line, keep: kept_along(wanted), scale }.position((mw, mh), (w, h));
                        let case = format!("{edge} at {dpi} x {zoom}, {length} long");
                        let (x, top) = at(0.0);
                        match edge {
                            "top" => assert_eq!(top, 0, "{case}"),
                            "bottom" => assert!((top + h - mh).abs() <= 1, "{case}: bottom edge at {}", top + h),
                            "left" => assert_eq!(x, 0, "{case}"),
                            _ => assert!((x + w - mw).abs() <= 1, "{case}: right edge at {}", x + w),
                        }
                        let (along, m_along, w_along) = if side { (top, mh, h) } else { (x, mw, w) };
                        assert_eq!(along, (m_along - w_along) / 2, "{case}: centred");
                        // Pushed far either way, the widest panel or closed notch (centred in the window) stays on the monitor when it fits at all.
                        let panel = kept_along(wanted) * scale;
                        for push in [-10_000.0, 10_000.0] {
                            let (x, top) = at(push);
                            let centre = (if side { top + h / 2 } else { x + w / 2 }) as f64;
                            if panel <= m_along as f64 {
                                assert!(centre - panel / 2.0 >= -1.0 && centre + panel / 2.0 <= m_along as f64 + 1.0, "{case}: pushed {push}");
                            } else {
                                assert_eq!(if side { top } else { x }, (m_along - w_along) / 2, "{case}: no room, stays centred");
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn the_window_is_as_long_as_before_unless_a_wide_closed_notch_needs_more() {
        assert_eq!(fit_along(0.0), ALONG);
        assert_eq!(kept_along(0.0), PANEL_ALONG);
        assert_eq!(fit_along(f64::NAN), ALONG);
        assert_eq!(fit_along(1400.0), 1400.0);
        assert_eq!(kept_along(1400.0), 1380.0);
        assert_eq!(fit_along(1e9), MAX_ALONG);
    }

    #[test]
    fn the_capsule_top_stays_on_the_monitor() {
        let at = |y: f64| Placement { edge: "top", offset: 0.0, y, line: 0.0, keep: PANEL_ALONG, scale: 1.0 }.position((1920, 1080), (760, 560));
        assert_eq!(at(100.0).1, 100);
        assert_eq!(at(5000.0).1, 520);
        assert_eq!(at(-50.0).1, 0);
    }
}
