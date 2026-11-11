//! More monitors (Settings, Display, Monitor): "Follow the cursor" and "All monitors".
//!
//! There is still one notch window with the whole app. A thread here reads which monitor the pointer is on, ten times a
//! second while either mode is on, and tells the frontend (`notch://cursor-monitor`):
//! - follow: the monitor the pointer has stayed on for `DWELL`, so crossing a screen edge does not move the notch;
//! - all: the monitor whose mirror the pointer is over, None elsewhere.
//!
//! The frontend moves the notch there while it is closed and nothing holds it (src/notch/monitor.ts) by sending that
//! monitor to `display_apply`, so the placement keeps one source.
//!
//! With "all", every other monitor gets a mirror: a click-through window (`mirror-<n>`, page mirror.html) that draws a
//! copy of the closed notch. The notch window sends that copy (`mirror_picture_set`, src/notch/mirror.ts) while it is
//! closed; it is kept here for mirrors that start later and passed on as `mirror://picture`. Hovering a mirror moves the
//! notch onto it, where it opens as usual, and the mirror moves to the monitor the notch left. The mirrors hide with the
//! hide hotkey, and each one on its own where a window on its monitor calls for a hiding or line rule.
//!
//! The thread also notices monitors being added, removed, rescaled or getting another taskbar (once a second): it places
//! the notch again and emits `notch://monitors`, which makes the frontend read them again.

use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WebviewWindowBuilder};
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, MONITORINFO, MONITORINFOEXW, MONITOR_DEFAULTTONEAREST};
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetForegroundWindow};

use crate::display::{self, DisplayState, Spot};
use crate::hit_test::HitRect;

/// How long the pointer stays on another monitor before the notch follows it.
const DWELL: Duration = Duration::from_millis(350);
/// The pointer is read this often while a mode is on; otherwise only the monitors are checked, once a second.
const TICK: Duration = Duration::from_millis(100);
const IDLE: Duration = Duration::from_secs(1);
/// Template of the mirror windows in tauri.conf.json (never created itself; each mirror is `mirror-<n>`).
const TEMPLATE: &str = "mirror";

/// The closed notch as the notch window draws it: its markup, the page's theme variables and the images it shows.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Picture {
    html: String,
    root: String,
    theme: String,
    /// The page's `lang` and `dir`, which pick the CJK glyphs and the direction of what is drawn.
    lang: String,
    dir: String,
    /// The pictures' `data:` sources by index; None = as last sent.
    images: Option<Vec<String>>,
}

#[derive(Default)]
pub struct MirrorState {
    picture: Mutex<Picture>,
    /// The closed notch's hit zone in the window, CSS px: over this spot on a mirror, the notch moves there.
    rect: Mutex<HitRect>,
    /// What the frontend was last told, for its start.
    cursor: Mutex<Option<String>>,
    wake: Mutex<Option<Sender<()>>>,
}

#[tauri::command]
pub fn mirror_picture_set(picture: Picture, rect: HitRect, app: AppHandle, state: State<'_, MirrorState>) {
    *state.rect.lock().unwrap() = rect;
    {
        let mut kept = state.picture.lock().unwrap();
        let images = picture.images.clone().or_else(|| kept.images.take());
        *kept = Picture { images, ..picture.clone() };
    }
    // Only the mirror pages listen for it.
    let _ = app.emit("mirror://picture", picture);
}

/// The latest picture with its images, for a mirror page that has just loaded.
#[tauri::command]
pub fn mirror_picture(state: State<'_, MirrorState>) -> Picture {
    state.picture.lock().unwrap().clone()
}

#[tauri::command]
pub fn display_cursor_monitor(state: State<'_, MirrorState>) -> Option<String> {
    state.cursor.lock().unwrap().clone()
}

/// Something the mirrors depend on changed (display_apply, the hotkey, a rule): sync them now instead of on the next tick.
pub fn wake(app: &AppHandle) {
    if let Some(tx) = app.state::<MirrorState>().wake.lock().unwrap().as_ref() {
        let _ = tx.send(());
    }
}

/// The monitor (HMONITOR) of every mirror window, shown or not.
pub fn monitors(app: &AppHandle) -> Vec<isize> {
    let windows = app.webview_windows();
    let hwnds = windows.iter().filter(|(label, _)| label.starts_with("mirror-")).filter_map(|(_, w)| w.hwnd().ok());
    hwnds.map(|h| unsafe { MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST) }.0 as isize).collect()
}

/// "Raise now": the shown mirrors go back on top of the topmost windows too.
pub fn raise(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with("mirror-") && window.is_visible().unwrap_or(false) {
            display::raise_topmost(&window);
        }
    }
}

pub fn spawn(app: AppHandle) {
    let (tx, rx) = channel();
    *app.state::<MirrorState>().wake.lock().unwrap() = Some(tx);
    thread::spawn(move || run(app, rx));
}

/// A mirror window and what was last done to it.
struct Mirror {
    window: WebviewWindow,
    monitor: String,
    shown: bool,
    zoom: f64,
}

fn run(app: AppHandle, rx: Receiver<()>) {
    let mut mirrors: Vec<Mirror> = Vec::new();
    let mut dwell = Dwell::default();
    let mut over: Option<String> = None;
    let mut screens = String::new();
    let mut checked = Instant::now();
    let mut foreground = 0isize;
    let mut dirty = false;
    loop {
        let mode = app.state::<DisplayState>().config().mode;
        let active = mode == "follow" || mode == "all";
        match rx.recv_timeout(if active { TICK } else { IDLE }) {
            Ok(()) => dirty = true,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        while rx.try_recv().is_ok() {}
        // Screen off or suspending (standby.rs): no monitor, window or pointer reads until it is back; a change that came meanwhile waits.
        if crate::standby::asleep() {
            continue;
        }

        if checked.elapsed() >= IDLE || screens.is_empty() {
            checked = Instant::now();
            let now = signature(&app);
            if !screens.is_empty() && now != screens {
                if let Some(window) = app.get_webview_window("notch") {
                    let _ = display::place(&window, &app.state::<DisplayState>());
                }
                let _ = app.emit("notch://monitors", ());
                dirty = true;
            }
            screens = now;
        }
        // Another app came to the front: the mirrors go back on top, like the notch (display.rs).
        let front = unsafe { GetForegroundWindow() }.0 as isize;
        if front != foreground {
            foreground = front;
            for m in mirrors.iter().filter(|m| m.shown) {
                display::raise_topmost(&m.window);
            }
        }
        if std::mem::take(&mut dirty) {
            sync(&app, &mut mirrors);
        }

        let told = match mode.as_str() {
            "follow" => cursor().and_then(|(name, _)| dwell.step(Some(name), Instant::now())).map(Some),
            "all" => {
                let rect = *app.state::<MirrorState>().rect.lock().unwrap();
                let zoom = app.state::<DisplayState>().config().zoom;
                let now = cursor().and_then(|(_, at)| mirrors.iter().find(|m| m.shown && over_spot(&m.window, at, &rect, zoom)).map(|m| m.monitor.clone()));
                (now != over).then(|| {
                    over = now.clone();
                    now
                })
            }
            _ => None,
        };
        if mode != "follow" {
            dwell = Dwell::default();
        }
        if mode != "all" {
            over = None;
        }
        if let Some(name) = told {
            *app.state::<MirrorState>().cursor.lock().unwrap() = name.clone();
            let _ = app.emit("notch://cursor-monitor", name);
        }
    }
}

/// Makes the mirror windows match the settings: one on every monitor but the notch's, placed, scaled and shown or hidden.
fn sync(app: &AppHandle, mirrors: &mut Vec<Mirror>) {
    let display = app.state::<DisplayState>();
    let config = display.config();
    let available = app.available_monitors().unwrap_or_default();
    let present: Vec<String> = available.iter().filter_map(|m| m.name().cloned()).collect();
    let primary = app.primary_monitor().ok().flatten().and_then(|m| m.name().cloned());
    let spots: Vec<Spot> = if config.mode == "all" { mirrored(&config.spots, config.monitor.as_deref(), primary.as_deref(), &present) } else { Vec::new() };
    while mirrors.len() > spots.len() {
        if let Some(m) = mirrors.pop() {
            let _ = m.window.destroy();
        }
    }
    let hidden = display::user_hidden(app);
    let blocked = display.mirror_block.lock().unwrap().clone();
    for (i, spot) in spots.iter().enumerate() {
        if i == mirrors.len() {
            match create(app, &format!("{TEMPLATE}-{i}")) {
                Ok(window) => mirrors.push(Mirror { window, monitor: String::new(), shown: false, zoom: 1.0 }),
                Err(e) => {
                    eprintln!("mirror window: {e}");
                    return;
                }
            }
        }
        let m = &mut mirrors[i];
        if m.zoom != config.zoom {
            let _ = m.window.set_zoom(config.zoom);
            m.zoom = config.zoom;
        }
        m.monitor = spot.monitor.clone();
        let _ = display::put(&m.window, Some(&spot.monitor), &config, spot.line, spot.y, false);
        let on = m.window.hwnd().map(|h| unsafe { MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST) }.0 as isize).unwrap_or(0);
        let show = !hidden && !blocked.contains(&on);
        if show != m.shown {
            m.shown = show;
            if show {
                let _ = m.window.show();
                display::raise_topmost(&m.window);
                // Only after show(): it fails on a window that was never shown. Clicks always go through; hover is read here.
                let _ = m.window.set_ignore_cursor_events(true);
            } else {
                let _ = m.window.hide();
            }
        }
    }
}

fn create(app: &AppHandle, label: &str) -> tauri::Result<WebviewWindow> {
    let mut config = app.config().app.windows.iter().find(|w| w.label == TEMPLATE).cloned().ok_or(tauri::Error::WindowNotFound)?;
    config.label = label.to_string();
    // The same WebView2 folder and arguments as the notch, so the mirror joins its browser process (portable.rs).
    let mut builder = WebviewWindowBuilder::from_config(app, &config)?.on_navigation(crate::own_page);
    if let Some(dir) = crate::portable::data_dir() {
        builder = builder.data_directory(dir);
    }
    let window = builder.build()?;
    crate::capture::exclude_if_capturing(app);
    Ok(window)
}

/// The monitors that get a mirror, in order: every present one with a spot, except the notch's (`placed`, else the primary).
fn mirrored(spots: &[Spot], placed: Option<&str>, primary: Option<&str>, present: &[String]) -> Vec<Spot> {
    let placed = placed.filter(|p| present.iter().any(|n| n == p)).or(primary);
    spots.iter().filter(|s| Some(s.monitor.as_str()) != placed && present.contains(&s.monitor)).cloned().collect()
}

/// Is the pointer (physical px) over the closed notch's hit zone on this mirror?
fn over_spot(window: &WebviewWindow, at: (i32, i32), rect: &HitRect, zoom: f64) -> bool {
    let (Ok(origin), Ok(scale)) = (window.outer_position(), window.scale_factor()) else { return false };
    in_rect(at, (origin.x, origin.y), scale * zoom, rect)
}

fn in_rect((x, y): (i32, i32), (ox, oy): (i32, i32), scale: f64, rect: &HitRect) -> bool {
    rect.contains((x - ox) as f64 / scale, (y - oy) as f64 / scale)
}

/// The monitor under the pointer ("\\.\DISPLAY2", as Tauri names it) and the pointer in physical px.
fn cursor() -> Option<(String, (i32, i32))> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p) }.ok()?;
    let monitor = unsafe { MonitorFromPoint(p, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFOEXW { monitorInfo: MONITORINFO { cbSize: std::mem::size_of::<MONITORINFOEXW>() as u32, ..Default::default() }, ..Default::default() };
    if !unsafe { GetMonitorInfoW(monitor, &mut info.monitorInfo) }.as_bool() {
        return None;
    }
    let len = info.szDevice.iter().position(|&c| c == 0).unwrap_or(info.szDevice.len());
    Some((String::from_utf16_lossy(&info.szDevice[..len]), (p.x, p.y)))
}

/// What a change of monitors shows in: names, places, sizes, scales and work areas.
fn signature(app: &AppHandle) -> String {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let (p, s, w) = (m.position(), m.size(), m.work_area());
            format!("{:?}@{},{} {}x{} {} {},{} {}x{}", m.name(), p.x, p.y, s.width, s.height, m.scale_factor(), w.position.x, w.position.y, w.size.width, w.size.height)
        })
        .collect::<Vec<_>>()
        .join("|")
}

/// The monitor the pointer has stayed on for `DWELL`, told once each time it changes.
#[derive(Default)]
struct Dwell {
    seen: Option<String>,
    since: Option<Instant>,
    told: Option<String>,
}

impl Dwell {
    fn step(&mut self, seen: Option<String>, now: Instant) -> Option<String> {
        if seen != self.seen || self.since.is_none() {
            self.seen = seen;
            self.since = Some(now);
        }
        let stayed = self.since.is_some_and(|t| now.duration_since(t) >= DWELL);
        if stayed && self.seen.is_some() && self.seen != self.told {
            self.told = self.seen.clone();
            return self.told.clone();
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spot(name: &str) -> Spot {
        Spot { monitor: name.into(), line: 0.0, y: 0.0 }
    }

    #[test]
    fn the_notch_follows_only_once_the_pointer_has_stayed() {
        let t0 = Instant::now();
        let at = |ms: u64| t0 + Duration::from_millis(ms);
        let mut d = Dwell::default();
        assert_eq!(d.step(Some("A".into()), at(0)), None);
        assert_eq!(d.step(Some("A".into()), at(350)), Some("A".into()));
        // Told once.
        assert_eq!(d.step(Some("A".into()), at(500)), None);
        // Crossing B on the way back to A moves nothing.
        assert_eq!(d.step(Some("B".into()), at(600)), None);
        assert_eq!(d.step(Some("B".into()), at(900)), None);
        assert_eq!(d.step(Some("A".into()), at(1000)), None);
        assert_eq!(d.step(Some("A".into()), at(1400)), None);
        // Staying on B does.
        assert_eq!(d.step(Some("B".into()), at(1500)), None);
        assert_eq!(d.step(Some("B".into()), at(1849)), None);
        assert_eq!(d.step(Some("B".into()), at(1850)), Some("B".into()));
        // No monitor read: nothing to tell.
        assert_eq!(d.step(None, at(3000)), None);
        assert_eq!(d.step(None, at(4000)), None);
    }

    #[test]
    fn every_present_monitor_but_the_notchs_gets_a_mirror() {
        let spots = [spot("A"), spot("B"), spot("C")];
        let present: Vec<String> = ["A", "B", "C"].map(String::from).to_vec();
        let names = |v: Vec<Spot>| v.into_iter().map(|s| s.monitor).collect::<Vec<_>>();
        assert_eq!(names(mirrored(&spots, Some("B"), Some("A"), &present)), ["A", "C"]);
        // None = the primary.
        assert_eq!(names(mirrored(&spots, None, Some("A"), &present)), ["B", "C"]);
        // C unplugged: no mirror there; the notch's monitor unplugged: the notch is on the primary, which gets none.
        let two: Vec<String> = ["A", "B"].map(String::from).to_vec();
        assert_eq!(names(mirrored(&spots, Some("C"), Some("A"), &two)), ["B"]);
        // A new monitor without a spot yet waits for the frontend's.
        assert_eq!(names(mirrored(&spots[..1], Some("B"), Some("A"), &present)), ["A"]);
        assert!(mirrored(&[], Some("B"), Some("A"), &present).is_empty());
    }

    #[test]
    fn the_hit_zone_scales_with_each_mirrors_monitor() {
        let rect: HitRect = serde_json::from_str(r#"{"x":300,"y":0,"w":160,"h":40}"#).unwrap();
        // A mirror at (1920, 0) on a 150 % monitor at panel scale 1: CSS (300..460, 0..40) is physical 2370..2610, 0..60.
        assert!(in_rect((2400, 30), (1920, 0), 1.5, &rect));
        assert!(!in_rect((2400, 70), (1920, 0), 1.5, &rect));
        assert!(!in_rect((2300, 30), (1920, 0), 1.5, &rect));
        // A monitor left of the primary has negative coordinates.
        assert!(in_rect((-2560 + 450, 10), (-2560, 0), 1.0, &rect));
    }
}
