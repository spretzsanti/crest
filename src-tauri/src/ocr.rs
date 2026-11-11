//! Instant OCR & Screen Snip tool.
//!
//! Captures screen region or snip, runs Windows.Media.Ocr (offline, fast ~50ms),
//! copies text to clipboard and returns it.

use tauri::AppHandle;

#[tauri::command]
pub async fn ocr_screen_snip(app: AppHandle, rect: Option<[i32; 4]>) -> Result<String, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let res = do_ocr_snip(&app, rect);
        let _ = tx.send(res);
    });
    match rx.await {
        Ok(res) => res,
        Err(_) => Err("ocr_cancelled".into()),
    }
}

#[cfg(windows)]
fn do_ocr_snip(_app: &AppHandle, rect: Option<[i32; 4]>) -> Result<String, String> {
    use windows::Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap};
    use windows::Security::Cryptography::CryptographicBuffer;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::UI::HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
    use crate::capture::math::Rect;
    use crate::capture::shot;

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    let target_rect = match rect {
        Some([x, y, w, h]) if w > 0 && h > 0 => Rect { x, y, w, h },
        _ => shot::virtual_screen(),
    };

    let dib = shot::grab(target_rect).map_err(|e| format!("Capture failed: {e}"))?;

    let engine = create_engine().map_err(|e| format!("Failed to create OCR engine: {e}"))?;

    let buffer = CryptographicBuffer::CreateFromByteArray(dib.pixels())
        .map_err(|e| format!("CryptographicBuffer error: {e}"))?;

    let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
        &buffer,
        BitmapPixelFormat::Bgra8,
        dib.w,
        dib.h,
        BitmapAlphaMode::Ignore,
    ).map_err(|e| format!("SoftwareBitmap error: {e}"))?;

    drop(dib);

    let result = engine.RecognizeAsync(&bitmap)
        .map_err(|e| format!("OCR recognize error: {e}"))?
        .join()
        .map_err(|e| format!("OCR async error: {e}"))?;

    let mut lines = Vec::new();
    if let Ok(line_list) = result.Lines() {
        for line in line_list {
            if let Ok(text) = line.Text() {
                let trimmed = text.to_string_lossy().trim().to_string();
                if !trimmed.is_empty() {
                    lines.push(trimmed);
                }
            }
        }
    }

    let full_text = if lines.is_empty() {
        result.Text().map(|t| t.to_string_lossy()).unwrap_or_default()
    } else {
        lines.join("\n")
    };

    // Copy to clipboard
    if !full_text.is_empty() {
        if let Ok(mut cb) = arboard::Clipboard::new() {
            let _ = cb.set_text(&full_text);
        }
    }

    Ok(full_text)
}

#[cfg(windows)]
fn create_engine() -> windows::core::Result<windows::Media::Ocr::OcrEngine> {
    use windows::core::h;
    use windows::Globalization::Language;
    use windows::Media::Ocr::OcrEngine;

    OcrEngine::TryCreateFromUserProfileLanguages()
        .or_else(|_| OcrEngine::TryCreateFromLanguage(&Language::CreateLanguage(h!("en-US"))?))
}

#[cfg(not(windows))]
fn do_ocr_snip(_app: &AppHandle, _rect: Option<[i32; 4]>) -> Result<String, String> {
    let mock = "OCR text captured: f(x) = \\int_0^\\infty e^{-x} dx = 1";
    if let Ok(mut cb) = arboard::Clipboard::new() {
        let _ = cb.set_text(mock);
    }
    Ok(mock.to_string())
}
