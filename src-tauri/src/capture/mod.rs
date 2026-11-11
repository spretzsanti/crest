//! Capture: screenshots, screen recordings and audio-only recordings (the Recorder tool).
//!
//! Screenshots land in Windows' Screenshots folder as PNG and on the clipboard;
//! recordings in Videos\Crest\Recordings as MP4, audio-only ones in Music\Crest\Recordings as M4A.
//! While a screenshot or screen recording is taken, Crest's own window is excluded from capture
//! (WDA_EXCLUDEFROMCAPTURE), and only then, unless "Hide Crest from screen sharing" is on (sharing.rs): then it stays out.
//! Recording state goes to the frontend as `capture://state`. Find on screen (find.rs)
//! reads the screens with OCR from in-memory copies.

mod audio;
pub(crate) mod eyedropper;
pub(crate) mod find;
pub(crate) mod math;
mod record;
pub(crate) mod shot;
mod voice;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use windows::core::{Interface, BOOL, HSTRING, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, PROPERTYKEY, RECT, SIZE};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::Media::MediaFoundation::{MFCreateSourceReaderFromURL, MFShutdown, MFStartup, MFSTARTUP_FULL, MF_VERSION};
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED, COINIT_MULTITHREADED};
use windows::Win32::System::LibraryLoader::{LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::SystemInformation::GetLocalTime;
use windows::Win32::UI::HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::Shell::*;
use windows::Win32::UI::WindowsAndMessaging::*;

use math::{file_name, Rect, Stamp};

#[derive(Default)]
pub struct CaptureState {
    rec: Mutex<Option<Recording>>,
    /// A recording is being set up (one to three seconds); the slot is filled only after,
    /// so pause, state and screenshots never wait on the setup.
    starting: AtomicBool,
    /// A recording is being finished (audio flushed, file written).
    stopping: AtomicBool,
    /// A screen recording keeps Crest's windows out of capture, from its setup to its end.
    screen: AtomicBool,
    /// Screenshots and Find reads under way, each keeping Crest's windows out of capture.
    holds: AtomicUsize,
}

impl CaptureState {
    /// Also while one is finishing: its slot is empty by then, and a new start would race its last `idle` and its exclusion.
    fn busy(&self) -> bool {
        self.starting.load(Ordering::SeqCst) || self.stopping.load(Ordering::SeqCst) || self.rec.lock().unwrap().is_some()
    }

    /// Crest's windows are already out of capture: a screenshot need not take them out and put them back.
    fn excluded(&self) -> bool {
        self.screen.load(Ordering::SeqCst)
    }
}

/// Keeps Crest's windows out of capture while a screenshot or a Find read grabs the screens.
/// The last one to drop puts them back, unless a recording still needs them out.
struct Hold<'a>(&'a AppHandle);

impl<'a> Hold<'a> {
    fn new(app: &'a AppHandle) -> Self {
        let state = app.state::<CaptureState>();
        state.holds.fetch_add(1, Ordering::SeqCst);
        if !state.excluded() {
            exclude(app, true);
            // Let the compositor drop the windows from the next frame.
            std::thread::sleep(std::time::Duration::from_millis(60));
        }
        Hold(app)
    }
}

impl Drop for Hold<'_> {
    fn drop(&mut self) {
        let state = self.0.state::<CaptureState>();
        if state.holds.fetch_sub(1, Ordering::SeqCst) == 1 && !state.excluded() {
            exclude(self.0, false);
        }
    }
}

enum Media {
    Screen(record::Recorder),
    Voice(Arc<voice::Shared>),
}

struct Recording {
    media: Media,
    audio: Option<audio::AudioCapture>,
    path: PathBuf,
}

impl Recording {
    fn clock(&self) -> &Mutex<math::Clock> {
        match &self.media {
            Media::Screen(r) => &r.shared.clock,
            Media::Voice(v) => &v.clock,
        }
    }

    fn resume(&self, now: i64) {
        match &self.media {
            Media::Screen(r) => r.shared.resume(now),
            Media::Voice(v) => v.clock.lock().unwrap().resume(now),
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecState {
    /// idle | recording | paused
    phase: &'static str,
    elapsed_ms: i64,
    /// The finished file, once, when a recording ends.
    path: Option<String>,
    /// Inputs that could not be opened ("system", "mic"), why a recording stopped on its own
    /// ("video": capture or encoder failed, "disk": no space left), or that writing the file failed ("save").
    failed: Vec<&'static str>,
    /// Sound only (the Recorder tool), not the screen.
    audio: bool,
}

/// QPC now in 100 ns, the clock frames and audio packets are stamped with.
fn now() -> i64 {
    let (mut c, mut f) = (0i64, 0i64);
    unsafe {
        let _ = QueryPerformanceCounter(&mut c);
        let _ = QueryPerformanceFrequency(&mut f);
    }
    (c as i128 * 10_000_000 / f.max(1) as i128) as i64
}

fn stamp() -> Stamp {
    let t = unsafe { GetLocalTime() };
    Stamp { year: t.wYear, month: t.wMonth, day: t.wDay, hour: t.wHour, minute: t.wMinute, second: t.wSecond }
}

/// Windows' own Screenshots folder (Pictures\Screenshots, where Win+PrtScn saves), wherever it was moved to.
fn screenshots_dir() -> Option<PathBuf> {
    unsafe {
        let p = SHGetKnownFolderPath(&FOLDERID_Screenshots, KF_FLAG_CREATE, None).ok()?;
        let dir = p.to_string().ok().map(PathBuf::from);
        CoTaskMemFree(Some(p.0 as _));
        dir
    }
}

/// Where screenshots went up to 0.3.2; still listed so older ones don't vanish from Recent.
fn old_screenshots_dir(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().picture_dir().ok()?.join("Crest").join("Screenshots"))
}

fn recordings_dir(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().video_dir().ok()?.join("Crest").join("Recordings"))
}

fn audio_dir(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().audio_dir().ok()?.join("Crest").join("Recordings"))
}

/// A free file name in `dir` (created if missing).
/// Errors that reach the frontend are short codes it translates (CaptureView).
fn new_file(dir: &Path, prefix: &str, ext: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|_| "no-folder".to_string())?;
    Ok(dir.join(file_name(prefix, ext, stamp(), |n| dir.join(n).exists())))
}

/// For a Crest window opened while a recording runs or while Crest is hidden from screen sharing (the floating timer, a copy
/// on another monitor): exclude it too.
pub(crate) fn exclude_if_capturing(app: &AppHandle) {
    if app.state::<CaptureState>().excluded() || crate::sharing::hidden() {
        exclude(app, true);
    }
}

/// Every Crest window (the notch, the floating timer, ...) in or out of captures. "Out" ends at the user's choice
/// (sharing.rs): with Hide Crest from screen sharing on, putting the windows back leaves them excluded.
fn exclude(app: &AppHandle, on: bool) {
    // One pass at a time, with the flag read inside it: a pass that started earlier cannot put back an outdated flag
    // over the user's latest choice (the end of a screenshot against the Hide Crest switch).
    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let flag = affinity(on, crate::sharing::hidden());
    for w in app.webview_windows().values() {
        if let Ok(hwnd) = w.hwnd() {
            let _ = unsafe { SetWindowDisplayAffinity(hwnd, flag) };
        }
    }
}

/// Out of captures when asked to be (a screenshot, a recording) or when the user chose to hide Crest from screen sharing.
fn affinity(on: bool, hidden: bool) -> WINDOW_DISPLAY_AFFINITY {
    if on || hidden { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE }
}

/// The setting changed (sharing.rs). A recording or a screenshot of Crest's own keeps the windows out until it ends, whatever
/// the setting says; the last Hold puts the setting back when it drops.
pub(crate) fn set_hidden(app: &AppHandle, on: bool) {
    let state = app.state::<CaptureState>();
    if !state.excluded() && state.holds.load(Ordering::SeqCst) == 0 {
        exclude(app, on);
    }
}

fn own_hwnd(window: &WebviewWindow) -> isize {
    window.hwnd().map(|h| h.0 as isize).unwrap_or(0)
}

// ---------- Sources ----------

struct Monitor {
    handle: HMONITOR,
    name: String,
    rect: Rect,
    primary: bool,
}

fn monitors() -> Vec<Monitor> {
    unsafe extern "system" fn each(handle: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        let list = unsafe { &mut *(data.0 as *mut Vec<Monitor>) };
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if unsafe { GetMonitorInfoW(handle, &mut info.monitorInfo) }.as_bool() {
            let r = info.monitorInfo.rcMonitor;
            let len = info.szDevice.iter().position(|&c| c == 0).unwrap_or(info.szDevice.len());
            list.push(Monitor {
                handle,
                name: String::from_utf16_lossy(&info.szDevice[..len]),
                rect: Rect { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top },
                primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
            });
        }
        true.into()
    }
    let mut list: Vec<Monitor> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(each), LPARAM(&mut list as *mut _ as isize));
    }
    // Primary first, then left to right: the order people number their screens in.
    list.sort_by_key(|m| (!m.primary, m.rect.x, m.rect.y));
    list
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    /// "monitor:\\.\DISPLAY1" or "window:<handle>"
    id: String,
    kind: &'static str,
    name: String,
    width: i32,
    height: i32,
    primary: bool,
}

/// Visible top-level windows with a title, the way Alt+Tab lists them.
fn windows_list(own: &[isize]) -> Vec<SourceInfo> {
    unsafe extern "system" fn each(hwnd: HWND, data: LPARAM) -> BOOL {
        let list = unsafe { &mut *(data.0 as *mut Vec<(HWND, String, RECT)>) };
        unsafe {
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            let mut cloaked = 0u32;
            let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, 4);
            if !IsWindowVisible(hwnd).as_bool() || cloaked != 0 || ex & WS_EX_TOOLWINDOW.0 != 0 || GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.is_invalid()) {
                return true.into();
            }
            let mut buf = [0u16; 256];
            let len = GetWindowTextW(hwnd, &mut buf).max(0) as usize;
            let mut r = RECT::default();
            let _ = GetWindowRect(hwnd, &mut r);
            if len > 0 && r.right - r.left > 40 && r.bottom - r.top > 40 {
                list.push((hwnd, String::from_utf16_lossy(&buf[..len]), r));
            }
        }
        true.into()
    }
    let mut found: Vec<(HWND, String, RECT)> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(each), LPARAM(&mut found as *mut _ as isize));
    }
    found
        .into_iter()
        .filter(|(h, ..)| !own.contains(&(h.0 as isize)))
        .map(|(h, name, r)| SourceInfo { id: format!("window:{}", h.0 as isize), kind: "window", name, width: r.right - r.left, height: r.bottom - r.top, primary: false })
        .collect()
}

#[tauri::command]
pub async fn capture_sources(app: AppHandle) -> Vec<SourceInfo> {
    // Crest's own windows are not offered as sources.
    let own: Vec<isize> = app.webview_windows().values().filter_map(|w| w.hwnd().ok()).map(|h| h.0 as isize).collect();
    tauri::async_runtime::spawn_blocking(move || {
        unsafe {
            let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        let mut list: Vec<SourceInfo> = monitors()
            .into_iter()
            .map(|m| SourceInfo { id: format!("monitor:{}", m.name), kind: "monitor", name: m.name, width: m.rect.w, height: m.rect.h, primary: m.primary })
            .collect();
        list.extend(windows_list(&own));
        list
    })
    .await
    .unwrap_or_default()
}

// ---------- Screenshots ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    path: String,
    name: String,
    thumb: Option<String>,
    width: i32,
    height: i32,
}

/// `mode`: "all" (every screen), "monitor" (`monitor` = device name, primary if missing) or "region".
/// None when the region pick was cancelled.
#[tauri::command]
pub async fn capture_shot(mode: String, monitor: Option<String>, app: AppHandle, window: WebviewWindow) -> Result<Option<Shot>, String> {
    let own = own_hwnd(&window);
    let dir = screenshots_dir().ok_or("no-folder")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _hold = Hold::new(&app);
        take_shot(&mode, monitor.as_deref(), &dir, own)
    })
    .await
    .map_err(|_| "failed".to_string())?
}

/// `owner`: the notch window, which the region overlay stays above.
fn take_shot(mode: &str, monitor: Option<&str>, dir: &Path, owner: isize) -> Result<Option<Shot>, String> {
    unsafe {
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    let screen = shot::virtual_screen();
    let dib = shot::grab(screen).map_err(|_| "failed")?;
    let all = Rect { x: 0, y: 0, w: screen.w, h: screen.h };
    let list = monitors();
    let crop = match mode {
        "region" => match shot::pick_region(&dib, screen, &list.iter().map(|m| m.rect).collect::<Vec<_>>(), owner).map_err(|_| "failed")? {
            Some(r) => r,
            None => return Ok(None),
        },
        "monitor" => {
            let m = list.iter().find(|m| Some(m.name.as_str()) == monitor).or_else(|| list.iter().find(|m| m.primary)).ok_or("no-monitor")?;
            math::to_bitmap(m.rect, screen).ok_or("no-monitor")?
        }
        _ => all,
    };
    let rgba = dib.crop_rgba(crop);
    drop(dib);
    let path = new_file(dir, "Screenshot", "png")?;
    // Fast compression: a multi-monitor shot saves in a fraction of the time, for slightly larger files.
    let file = std::io::BufWriter::new(std::fs::File::create(&path).map_err(|_| "save-failed")?);
    let png = image::codecs::png::PngEncoder::new_with_quality(file, image::codecs::png::CompressionType::Fast, image::codecs::png::FilterType::Adaptive);
    if rgba.write_with_encoder(png).is_err() {
        let _ = std::fs::remove_file(&path);
        return Err("save-failed".into());
    }
    let _ = arboard::Clipboard::new().and_then(|mut c| {
        c.set_image(arboard::ImageData { width: rgba.width() as usize, height: rgba.height() as usize, bytes: rgba.as_raw().into() })
    });
    Ok(Some(Shot {
        name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        thumb: crate::clipboard::thumbnail(&rgba),
        width: crop.w,
        height: crop.h,
    }))
}

// ---------- Recording ----------

fn emit(app: &AppHandle, s: RecState) {
    let _ = app.emit("capture://state", s);
}

fn current(state: &CaptureState) -> RecState {
    match state.rec.lock().unwrap().as_ref() {
        None => RecState { phase: "idle", elapsed_ms: 0, path: None, failed: vec![], audio: false },
        Some(r) => {
            let clock = r.clock().lock().unwrap();
            RecState { phase: if clock.paused() { "paused" } else { "recording" }, elapsed_ms: clock.elapsed(now()) / 10_000, path: None, failed: vec![], audio: matches!(r.media, Media::Voice(_)) }
        }
    }
}

#[tauri::command]
pub fn capture_state(app: AppHandle) -> RecState {
    current(&app.state::<CaptureState>())
}

/// `source`: an id from `capture_sources`, or "audio" for sound only. `border`: keep Windows' yellow capture frame.
#[tauri::command]
pub async fn capture_start(source: String, fps: u32, mic: bool, system: bool, border: bool, app: AppHandle) -> Result<(), String> {
    let dir = if source == "audio" { audio_dir(&app) } else { recordings_dir(&app) }.ok_or("no-folder")?;
    if app.state::<CaptureState>().busy() || app.state::<CaptureState>().starting.swap(true, Ordering::SeqCst) {
        return Err("busy".into());
    }
    let task = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || begin(&task, &source, fps, mic, system, border, &dir)).await.unwrap_or(Err("failed".into()));
    app.state::<CaptureState>().starting.store(false, Ordering::SeqCst);
    result
}

fn begin(app: &AppHandle, source: &str, fps: u32, mic: bool, system: bool, border: bool, dir: &Path) -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    if source == "audio" {
        return begin_voice(app, mic, system, dir);
    }
    let target = if let Some(name) = source.strip_prefix("monitor:") {
        let list = monitors();
        let m = list.iter().find(|m| m.name == name).or_else(|| list.iter().find(|m| m.primary)).ok_or("no-monitor")?;
        record::Source::Monitor(m.handle)
    } else if let Some(h) = source.strip_prefix("window:").and_then(|h| h.parse::<isize>().ok()) {
        let hwnd = HWND(h as *mut _);
        if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
            return Err("window-closed".into());
        }
        record::Source::Window(hwnd)
    } else {
        return Err("unknown-source".into());
    };
    if !media_foundation() {
        return Err("no-media".into());
    }
    let path = new_file(dir, "Recording", "mp4")?;
    unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }.map_err(|_| "failed")?;
    app.state::<CaptureState>().screen.store(true, Ordering::SeqCst);
    exclude(app, true);
    let fps = if fps >= 60 { 60 } else { 30 };
    // Opening the audio takes about half a second; it runs while the encoder starts.
    let opening = std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        audio::open_inputs(system, mic)
    });
    let ending = app.clone();
    // The source closed or capturing failed: stop on another thread, the capture's own must return.
    let on_end: record::OnEnd = Arc::new(move |why| {
        let app = ending.clone();
        std::thread::spawn(move || finish(&app, why));
    });
    let recorder = match record::start(target, &path, fps, mic || system, border, now, on_end) {
        Ok(r) => r,
        Err(_) => {
            app.state::<CaptureState>().screen.store(false, Ordering::SeqCst);
            exclude(app, false);
            drop(opening.join());
            let _ = std::fs::remove_file(&path);
            unsafe {
                let _ = MFShutdown();
            }
            return Err("failed".into());
        }
    };
    let (inputs, failed) = opening.join().unwrap_or_default();
    let audio = recorder.has_audio.then(|| audio::start(recorder.shared.clone(), inputs, now));
    *app.state::<CaptureState>().rec.lock().unwrap() = Some(Recording { media: Media::Screen(recorder), audio, path });
    emit(app, RecState { phase: "recording", elapsed_ms: 0, path: None, failed, audio: false });
    Ok(())
}

/// Sound only, into an M4A. Crest's windows stay visible to other capture: nothing of the screen is taken.
fn begin_voice(app: &AppHandle, mic: bool, system: bool, dir: &Path) -> Result<(), String> {
    if !media_foundation() {
        return Err("no-media".into());
    }
    let (inputs, failed) = audio::open_inputs(system, mic);
    if failed.len() == usize::from(mic) + usize::from(system) {
        return Err(if mic && !system { "no-mic" } else { "no-audio" }.into());
    }
    let path = new_file(dir, "Recording", "m4a")?;
    unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }.map_err(|_| "failed")?;
    let shared = match voice::start(&path, now()) {
        Ok(s) => s,
        Err(_) => {
            let _ = std::fs::remove_file(&path);
            unsafe {
                let _ = MFShutdown();
            }
            return Err("failed".into());
        }
    };
    let audio = Some(audio::start(shared.clone(), inputs, now));
    *app.state::<CaptureState>().rec.lock().unwrap() = Some(Recording { media: Media::Voice(shared), audio, path });
    emit(app, RecState { phase: "recording", elapsed_ms: 0, path: None, failed, audio: true });
    Ok(())
}

/// Async: resuming copies the held frame on the GPU and writes it, which must not run on the main thread.
#[tauri::command]
pub async fn capture_pause(paused: bool, app: AppHandle) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<CaptureState>();
        let live = state
            .rec
            .lock()
            .unwrap()
            .as_ref()
            .map(|r| {
                if paused {
                    r.clock().lock().unwrap().pause(now());
                } else {
                    r.resume(now());
                }
            })
            .is_some();
        // An empty slot means a stop is under way: it sends the final state itself.
        if live {
            emit(&app, current(&state));
        }
    })
    .await;
}

#[tauri::command]
pub async fn capture_stop(app: AppHandle) {
    let _ = tauri::async_runtime::spawn_blocking(move || finish(&app, None)).await;
}

/// When Crest quits: finishes the recording, or waits for a start or stop already under way,
/// at most EXIT_WAIT. Giving up is safe: the fragmented MP4 plays as far as it got.
pub(crate) fn finish_on_exit(app: &AppHandle) {
    const EXIT_WAIT: std::time::Duration = std::time::Duration::from_secs(5);
    let deadline = std::time::Instant::now() + EXIT_WAIT;
    let state = app.state::<CaptureState>();
    let busy = || state.starting.load(Ordering::SeqCst) || state.stopping.load(Ordering::SeqCst);
    while state.starting.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let task = app.clone();
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        // No window calls here: the main thread is waiting below, and asking a window for its handle would block on it.
        end(&task, None, false);
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()));
    while busy() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// Ends the recording (if any), writes the file and tells the frontend. `why`: the reason
/// it ended on its own ("video"), None when asked to.
fn finish(app: &AppHandle, why: Option<&'static str>) {
    end(app, why, true);
}

/// `restore`: take Crest's windows out of capture exclusion again (skipped on exit, where the process ends anyway).
fn end(app: &AppHandle, why: Option<&'static str>, restore: bool) {
    let state = app.state::<CaptureState>();
    let r = {
        let mut slot = state.rec.lock().unwrap();
        let Some(r) = slot.take() else { return };
        // Set under the lock, so a second caller that finds the slot empty can see a stop is running.
        state.stopping.store(true, Ordering::SeqCst);
        r
    };
    let elapsed = r.clock().lock().unwrap().elapsed(now()) / 10_000;
    if let Some(a) = r.audio {
        a.stop();
    }
    let screen = matches!(r.media, Media::Screen(_));
    let finished = match r.media {
        Media::Screen(recorder) => recorder.stop().is_ok(),
        Media::Voice(v) => v.stop().is_ok(),
    };
    // Checked after `stop`, which releases the writer and with it the file.
    // Fragmented MP4 still plays when it could not be finished: kept then ("partial"), removed only when unreadable ("save").
    let playable = finished || unsafe { MFCreateSourceReaderFromURL(&HSTRING::from(r.path.as_path()), None) }.is_ok();
    unsafe {
        let _ = MFShutdown();
    }
    if !playable {
        let _ = std::fs::remove_file(&r.path);
    }
    let problem = if !playable { Some("save") } else if !finished { Some("partial") } else { None };
    let failed = why.into_iter().chain(problem).collect();
    let path = playable.then(|| r.path.to_string_lossy().into_owned());
    emit(app, RecState { phase: "idle", elapsed_ms: elapsed, path, failed, audio: !screen });
    state.stopping.store(false, Ordering::SeqCst);
    // Last, after the file work and the flag: window handles go through the main thread, which may
    // be waiting for this stop on quit (finish_on_exit).
    if screen {
        state.screen.store(false, Ordering::SeqCst);
        if restore {
            exclude(app, false);
        }
    }
}

// ---------- Library ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureFile {
    path: String,
    name: String,
    /// shot | video | audio
    kind: &'static str,
    size: u64,
    /// ms since 1970
    modified: u64,
}

#[tauri::command(async)]
pub fn capture_list(app: AppHandle) -> Vec<CaptureFile> {
    let mut out = Vec::new();
    for (dir, kind, ext) in [(screenshots_dir(), "shot", "png"), (old_screenshots_dir(&app), "shot", "png"), (recordings_dir(&app), "video", "mp4"), (audio_dir(&app), "audio", "m4a")] {
        let Some(entries) = dir.and_then(|d| std::fs::read_dir(d).ok()) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            let Ok(meta) = e.metadata() else { continue };
            if !meta.is_file() || !p.extension().is_some_and(|x| x.eq_ignore_ascii_case(ext)) {
                continue;
            }
            out.push(CaptureFile {
                name: e.file_name().to_string_lossy().into_owned(),
                path: p.to_string_lossy().into_owned(),
                kind,
                size: meta.len(),
                modified: meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64),
            });
        }
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    path: String,
    thumb: Option<String>,
    duration_ms: Option<u64>,
}

/// Media Foundation, delay-loaded (build.rs), is missing on Windows N editions without the Media Feature Pack, and a call into a
/// missing delay-loaded DLL ends the process: recording asks here first. The modules stay loaded for the delay-load to use.
fn media_foundation() -> bool {
    static FOUND: OnceLock<bool> = OnceLock::new();
    *FOUND.get_or_init(|| unsafe {
        LoadLibraryExW(windows::core::w!("mfplat.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32).is_ok()
            && LoadLibraryExW(windows::core::w!("mfreadwrite.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32).is_ok()
    })
}

/// System.Media.Duration, in 100 ns.
const PKEY_MEDIA_DURATION: PROPERTYKEY = PROPERTYKEY { fmtid: windows::core::GUID::from_u128(0x64440490_4c8b_11d1_8b70_080036b11a03), pid: 3 };

/// Explorer's thumbnail and, for videos, the duration. One STA thread for the batch, as the shell expects.
#[tauri::command]
pub async fn capture_details(paths: Vec<String>) -> Vec<Details> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
        let _ = tx.send(paths.into_iter().map(|p| details(p)).collect::<Vec<_>>());
    });
    rx.await.unwrap_or_default()
}

fn details(path: String) -> Details {
    let mut d = Details { path, thumb: None, duration_ms: None };
    unsafe {
        let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem2>(&HSTRING::from(d.path.as_str()), None) else { return d };
        d.duration_ms = item.GetUInt64(&PKEY_MEDIA_DURATION).ok().filter(|&v| v > 0).map(|v| v / 10_000);
        if let Ok(bmp) = item.cast::<IShellItemImageFactory>().and_then(|f| f.GetImage(SIZE { cx: 240, cy: 240 }, SIIGBF_BIGGERSIZEOK | SIIGBF_THUMBNAILONLY)) {
            d.thumb = bitmap_thumb(bmp);
            let _ = DeleteObject(bmp.into());
        }
    }
    d
}

/// HBITMAP from the shell as a PNG data URL.
unsafe fn bitmap_thumb(bmp: HBITMAP) -> Option<String> {
    unsafe {
        let mut info = BITMAP::default();
        if GetObjectW(bmp.into(), std::mem::size_of::<BITMAP>() as i32, Some(&mut info as *mut _ as *mut _)) == 0 {
            return None;
        }
        let (w, h) = (info.bmWidth, info.bmHeight.abs());
        let mut header = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER { biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: BI_RGB.0, ..Default::default() },
            ..Default::default()
        };
        let mut px = vec![0u8; (w * h * 4) as usize];
        let dc = GetDC(None);
        let lines = GetDIBits(dc, bmp, 0, h as u32, Some(px.as_mut_ptr() as *mut _), &mut header, DIB_RGB_COLORS);
        ReleaseDC(None, dc);
        if lines == 0 {
            return None;
        }
        // Thumbnails without an alpha channel come back with alpha 0 everywhere.
        let opaque = px.chunks_exact(4).all(|p| p[3] == 0);
        for p in px.chunks_exact_mut(4) {
            p.swap(0, 2);
            if opaque {
                p[3] = 255;
            }
        }
        crate::clipboard::thumbnail(&image::RgbaImage::from_raw(w as u32, h as u32, px)?)
    }
}

/// Moves a capture to the Recycle Bin. Only files in the capture folders. A file too big for the bin
/// asks Windows' permission to be deleted for good ("cancelled" when refused).
#[tauri::command(async)]
pub fn capture_delete(path: String, app: AppHandle) -> Result<(), String> {
    let p = Path::new(&path);
    let parent = p.parent().and_then(|d| d.canonicalize().ok());
    let inside = [screenshots_dir(), old_screenshots_dir(&app), recordings_dir(&app), audio_dir(&app)].into_iter().flatten().filter_map(|d| d.canonicalize().ok()).any(|d| Some(&d) == parent.as_ref());
    let ext_ok = p.extension().is_some_and(|x| ["png", "mp4", "m4a"].iter().any(|e| x.eq_ignore_ascii_case(e)));
    if !inside || !ext_ok || !p.is_file() {
        return Err("not-capture".into());
    }
    // Double-null-terminated list of one path.
    let from: Vec<u16> = path.encode_utf16().chain([0, 0]).collect();
    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: PCWSTR(from.as_ptr()),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_WANTNUKEWARNING | FOF_SILENT | FOF_NOERRORUI).0 as u16,
        ..Default::default()
    };
    match unsafe { SHFileOperationW(&mut op) } {
        0 if op.fAnyOperationsAborted.as_bool() => Err("cancelled".into()),
        0 => Ok(()),
        // DE_OPCANCELLED: the shell can report a refusal this way too.
        0x75 => Err("cancelled".into()),
        _ => Err("delete-failed".into()),
    }
}

#[cfg(test)]
mod affinity_tests {
    use super::*;

    #[test]
    fn a_capture_gives_the_windows_back_to_the_users_choice() {
        assert_eq!(affinity(true, false), WDA_EXCLUDEFROMCAPTURE);
        assert_eq!(affinity(false, false), WDA_NONE);
        // Hide Crest from screen sharing on: the end of a screenshot or a recording leaves the windows out.
        assert_eq!(affinity(false, true), WDA_EXCLUDEFROMCAPTURE);
        assert_eq!(affinity(true, true), WDA_EXCLUDEFROMCAPTURE);
    }
}

#[cfg(test)]
mod live {
    //! Records two seconds of the primary monitor with system audio into a temp file and reads it back.
    //! Touches real hardware, so only on request: `cargo test --lib capture::live -- --ignored`.
    use super::*;

    fn init() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            MFStartup(MF_VERSION, MFSTARTUP_FULL).unwrap();
        }
    }

    fn no_end() -> record::OnEnd {
        Arc::new(|_| {})
    }

    fn streams(path: &Path) -> usize {
        unsafe { MFCreateSourceReaderFromURL(&HSTRING::from(path), None) }.map(|r| (0..2).filter(|&i| unsafe { r.GetNativeMediaType(i, 0) }.is_ok()).count()).unwrap_or(0)
    }

    /// Crest killed mid-recording: the writer is dropped without finishing, the fragmented MP4 still plays.
    #[test]
    #[ignore]
    fn unfinished_file_still_plays() {
        init();
        let path = std::env::temp_dir().join("crest-capture-unfinished.mp4");
        let _ = std::fs::remove_file(&path);
        let m = monitors().into_iter().find(|m| m.primary).unwrap();
        let (inputs, _) = audio::open_inputs(true, false);
        let recorder = record::start(record::Source::Monitor(m.handle), &path, 30, true, true, now, no_end()).unwrap();
        let audio = audio::start(recorder.shared.clone(), inputs, now);
        std::thread::sleep(std::time::Duration::from_millis(3000));
        audio.stop();
        drop(recorder);
        assert_eq!(streams(&path), 2);
        std::fs::remove_file(&path).unwrap();
    }

    /// Two seconds of system audio into an M4A, with a half-second pause left out.
    #[test]
    #[ignore]
    fn records_a_playable_m4a() {
        init();
        let path = std::env::temp_dir().join("crest-capture-voice.m4a");
        let _ = std::fs::remove_file(&path);
        let (inputs, failed) = audio::open_inputs(true, false);
        assert!(failed.is_empty(), "{failed:?}");
        let shared = voice::start(&path, now()).unwrap();
        let audio = audio::start(shared.clone(), inputs, now);
        std::thread::sleep(std::time::Duration::from_millis(1000));
        shared.clock.lock().unwrap().pause(now());
        std::thread::sleep(std::time::Duration::from_millis(500));
        shared.clock.lock().unwrap().resume(now());
        std::thread::sleep(std::time::Duration::from_millis(1000));
        audio.stop();
        shared.stop().unwrap();
        assert_eq!(streams(&path), 1);
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
        let ms = details(path.to_string_lossy().into_owned()).duration_ms.unwrap_or(0);
        assert!((1900..=2300).contains(&ms), "{ms}");
        std::fs::remove_file(&path).unwrap();
    }

    /// A window that never changes delivers one frame: with audio running the writer must not
    /// stall, and stopping after `CREST_STILL_SECS` (default 60) must finish the file.
    #[test]
    #[ignore]
    fn still_window_does_not_stall() {
        use windows::core::w;
        init();
        let secs: u64 = std::env::var("CREST_STILL_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(60);
        let hwnd = unsafe { CreateWindowExW(WS_EX_TOOLWINDOW, w!("STATIC"), w!("Crest still test"), WS_POPUP | WS_VISIBLE, 40, 40, 320, 240, None, None, None, None) }.unwrap();
        let path = std::env::temp_dir().join("crest-capture-still.mp4");
        let _ = std::fs::remove_file(&path);
        let (inputs, _) = audio::open_inputs(true, false);
        let recorder = record::start(record::Source::Window(hwnd), &path, 30, true, true, now, no_end()).unwrap();
        let audio = audio::start(recorder.shared.clone(), inputs, now);
        let until = std::time::Instant::now() + std::time::Duration::from_secs(secs);
        let mut msg = MSG::default();
        while std::time::Instant::now() < until {
            unsafe {
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let stopping = std::time::Instant::now();
        audio.stop();
        recorder.stop().unwrap();
        let took = stopping.elapsed();
        unsafe {
            let _ = DestroyWindow(hwnd);
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
        let ms = details(path.to_string_lossy().into_owned()).duration_ms.unwrap_or(0);
        eprintln!("still {secs} s: stop took {took:?}, duration {ms} ms, streams {}", streams(&path));
        assert!(took < std::time::Duration::from_secs(5));
        assert!((secs * 1000 - 500..=secs * 1000 + 500).contains(&ms), "{ms}");
        std::fs::remove_file(&path).unwrap();
    }

    /// Opens the region overlay and drives it with posted messages: a drag, then Esc.
    #[test]
    #[ignore]
    fn region_overlay_drag_and_cancel() {
        use windows::core::w;
        use windows::Win32::Foundation::WPARAM;
        use windows::Win32::UI::Input::KeyboardAndMouse::VK_ESCAPE;
        unsafe {
            let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        let screen = shot::virtual_screen();
        let dib = shot::grab(screen).unwrap();
        let post = |msgs: Vec<(u32, usize, isize)>| {
            std::thread::spawn(move || {
                // Windows rescales posted mouse coordinates between threads of different DPI awareness.
                unsafe {
                    let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
                let hwnd = unsafe { FindWindowW(w!("CrestCaptureOverlay"), None) }.unwrap();
                for (m, wp, lp) in msgs {
                    unsafe { PostMessageW(Some(hwnd), m, WPARAM(wp), LPARAM(lp)) }.unwrap();
                    std::thread::sleep(std::time::Duration::from_millis(30));
                }
            })
        };
        let at = |x: isize, y: isize| (y << 16) | x;
        let t = post(vec![(WM_LBUTTONDOWN, 0, at(10, 20)), (WM_MOUSEMOVE, 0, at(200, 120)), (WM_LBUTTONUP, 0, at(110, 70))]);
        assert_eq!(shot::pick_region(&dib, screen, &[], 0).unwrap(), Some(Rect { x: 10, y: 20, w: 101, h: 51 }));
        t.join().unwrap();
        let t = post(vec![(WM_KEYDOWN, VK_ESCAPE.0 as usize, 0)]);
        assert_eq!(shot::pick_region(&dib, screen, &[], 0).unwrap(), None);
        t.join().unwrap();
    }

    #[test]
    #[ignore]
    fn takes_screenshots() {
        let dir = std::env::temp_dir().join("crest-capture-shots");
        let _ = std::fs::remove_dir_all(&dir);
        let all = take_shot("all", None, &dir, 0).unwrap().unwrap();
        let screen = shot::virtual_screen();
        assert_eq!((all.width, all.height), (screen.w, screen.h));
        let primary = monitors().into_iter().find(|m| m.primary).unwrap();
        let one = take_shot("monitor", Some(&primary.name), &dir, 0).unwrap().unwrap();
        assert_eq!((one.width, one.height), (primary.rect.w, primary.rect.h));
        // Two in the same second get different names.
        assert_ne!(all.path, one.path);
        assert_eq!(image::image_dimensions(&one.path).unwrap(), (one.width as u32, one.height as u32));
        assert!(one.thumb.is_some());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    #[ignore]
    fn records_a_playable_mp4() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            MFStartup(MF_VERSION, MFSTARTUP_FULL).unwrap();
        }
        let path = std::env::temp_dir().join("crest-capture-test.mp4");
        let _ = std::fs::remove_file(&path);
        let m = monitors().into_iter().find(|m| m.primary).unwrap();
        let t0 = std::time::Instant::now();
        let (inputs, failed) = audio::open_inputs(true, false);
        assert!(failed.is_empty(), "{failed:?}");
        let recorder = record::start(record::Source::Monitor(m.handle), &path, 30, true, true, now, no_end()).unwrap();
        let audio = audio::start(recorder.shared.clone(), inputs, now);
        eprintln!("started in {:?}, gpu {}", t0.elapsed(), recorder.gpu);
        std::thread::sleep(std::time::Duration::from_millis(1000));
        recorder.shared.clock.lock().unwrap().pause(now());
        std::thread::sleep(std::time::Duration::from_millis(500));
        recorder.shared.clock.lock().unwrap().resume(now());
        std::thread::sleep(std::time::Duration::from_millis(1000));
        audio.stop();
        recorder.stop().unwrap();
        let size = std::fs::metadata(&path).unwrap().len();
        unsafe {
            use windows::Win32::Media::MediaFoundation::*;
            let reader = MFCreateSourceReaderFromURL(&HSTRING::from(path.as_path()), None).unwrap();
            let kinds: Vec<_> = (0..2).filter_map(|i| reader.GetNativeMediaType(i, 0).ok()).map(|t| t.GetMajorType().unwrap()).collect();
            assert!(kinds.contains(&MFMediaType_Video) && kinds.contains(&MFMediaType_Audio), "{kinds:?}");
        }
        assert!(size > 10_000, "{size}");
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
        let d = details(path.to_string_lossy().into_owned());
        let ms = d.duration_ms.unwrap_or(0);
        eprintln!("size {size} bytes, duration {ms} ms, thumb {}", d.thumb.is_some());
        // Two seconds recorded, the half-second pause left out.
        assert!((1900..=2300).contains(&ms), "{ms}");

        // Rows top to bottom: the video's thumbnail looks like the screen, not like it upside down.
        use base64::Engine;
        let png = base64::engine::general_purpose::STANDARD.decode(d.thumb.unwrap().trim_start_matches("data:image/png;base64,")).unwrap();
        let thumb = image::load_from_memory(&png).unwrap().to_rgba8();
        let screen = shot::virtual_screen();
        let now_shot = shot::grab(screen).unwrap().crop_rgba(math::to_bitmap(m.rect, screen).unwrap());
        let small = image::imageops::resize(&now_shot, thumb.width(), thumb.height(), image::imageops::FilterType::Triangle);
        let diff = |flip: bool| -> u64 {
            let h = thumb.height();
            thumb.enumerate_pixels().map(|(x, y, p)| (0..3).map(|c| (p[c] as i64 - small.get_pixel(x, if flip { h - 1 - y } else { y })[c] as i64).unsigned_abs()).sum::<u64>()).sum()
        };
        let (upright, flipped) = (diff(false), diff(true));
        eprintln!("thumbnail difference upright {upright}, flipped {flipped}");
        assert!(upright < flipped);
        std::fs::remove_file(&path).unwrap();
    }
}
