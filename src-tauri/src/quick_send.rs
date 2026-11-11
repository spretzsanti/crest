//! Quick Send backend: Windows Quick Share, LocalSend protocol, ADB Push, and Telegram bridge.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalSendDevice {
    pub id: String,
    pub alias: String,
    pub device_model: Option<String>,
    pub device_type: String, // "mobile" | "tablet" | "desktop"
    pub ip: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdbDevice {
    pub id: String,
    pub model: String,
    pub product: Option<String>,
    pub status: String,
}

static LOCALSEND_CACHE: Mutex<Option<HashMap<String, (LocalSendDevice, Instant)>>> = Mutex::new(None);
static LISTENER_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

const MULTICAST_IP: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 167);
const LOCALSEND_PORT: u16 = 53317;

fn start_discovery_listener() {
    if LISTENER_STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        let socket = match UdpSocket::bind(("0.0.0.0", LOCALSEND_PORT)) {
            Ok(s) => s,
            Err(_) => match UdpSocket::bind("0.0.0.0:0") {
                Ok(s) => s,
                Err(_) => return,
            },
        };
        let _ = socket.join_multicast_v4(&MULTICAST_IP, &Ipv4Addr::UNSPECIFIED);
        let _ = socket.set_read_timeout(Some(Duration::from_secs(2)));
        let mut buf = [0u8; 4096];
        loop {
            if let Ok((len, src)) = socket.recv_from(&mut buf) {
                if let Ok(text) = std::str::from_utf8(&buf[..len]) {
                    if let Some(dev) = parse_localsend_packet(text, src) {
                        record_device(dev);
                    }
                }
            }
        }
    });
}

fn parse_localsend_packet(text: &str, src: SocketAddr) -> Option<LocalSendDevice> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let alias = v.get("alias").and_then(|a| a.as_str()).unwrap_or("LocalSend Device").to_string();
    let device_model = v.get("deviceModel").and_then(|m| m.as_str()).map(|s| s.to_string());
    let raw_type = v.get("deviceType").and_then(|t| t.as_str()).unwrap_or("mobile");
    let device_type = match raw_type.to_lowercase().as_str() {
        "tablet" => "tablet".to_string(),
        "desktop" | "web" => "desktop".to_string(),
        _ => "mobile".to_string(),
    };
    let port = v.get("port").and_then(|p| p.as_u64()).unwrap_or(LOCALSEND_PORT as u64) as u16;
    let fingerprint = v.get("fingerprint").and_then(|f| f.as_str()).unwrap_or("");
    let ip = src.ip().to_string();
    let id = if !fingerprint.is_empty() {
        fingerprint.to_string()
    } else {
        format!("{}:{}", ip, port)
    };
    Some(LocalSendDevice {
        id,
        alias,
        device_model,
        device_type,
        ip,
        port,
    })
}

fn record_device(dev: LocalSendDevice) {
    let mut cache = LOCALSEND_CACHE.lock().unwrap();
    let map = cache.get_or_insert_with(HashMap::new);
    map.insert(dev.id.clone(), (dev, Instant::now()));
}

fn send_multicast_announcement() {
    let Ok(socket) = UdpSocket::bind("0.0.0.0:0") else { return };
    let _ = socket.set_multicast_loop_v4(true);
    let _ = socket.set_read_timeout(Some(Duration::from_millis(200)));

    let payload = serde_json::json!({
        "alias": "Crest",
        "version": "2.0",
        "deviceModel": "PC",
        "deviceType": "desktop",
        "fingerprint": "crest-desktop-client",
        "port": LOCALSEND_PORT,
        "protocol": "https",
        "download": false,
        "announcement": true,
        "announce": true
    });
    let bytes = payload.to_string();
    let _ = socket.send_to(bytes.as_bytes(), (MULTICAST_IP, LOCALSEND_PORT));

    // Listen briefly for any immediate responses
    let mut buf = [0u8; 4096];
    let end = Instant::now() + Duration::from_millis(200);
    while Instant::now() < end {
        if let Ok((len, src)) = socket.recv_from(&mut buf) {
            if let Ok(text) = std::str::from_utf8(&buf[..len]) {
                if let Some(dev) = parse_localsend_packet(text, src) {
                    record_device(dev);
                }
            }
        }
    }
}

/// Discovers nearby LocalSend devices via UDP Multicast on 224.0.0.167:53317.
#[tauri::command]
pub async fn localsend_devices() -> Vec<LocalSendDevice> {
    start_discovery_listener();
    send_multicast_announcement();

    let mut cache = LOCALSEND_CACHE.lock().unwrap();
    let map = cache.get_or_insert_with(HashMap::new);
    let now = Instant::now();
    // Retain devices seen within the last 60 seconds
    map.retain(|_, (_, seen)| now.duration_since(*seen) < Duration::from_secs(60));
    map.values().map(|(dev, _)| dev.clone()).collect()
}

/// Sends files to a LocalSend device using the LocalSend v2 HTTP API.
#[tauri::command]
pub async fn localsend_send(device_ip: String, port: u16, paths: Vec<String>) -> Result<(), String> {
    let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).filter(|p| p.is_file()).collect();
    if files.is_empty() {
        return Err("No hay archivos válidos para enviar".into());
    }

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let mut file_dtos = serde_json::Map::new();
    let mut file_info_list = Vec::new();

    for (i, path) in files.iter().enumerate() {
        let meta = std::fs::metadata(path).map_err(|e| format!("Error al leer archivo: {e}"))?;
        let id = format!("crest-file-{}", i);
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| format!("file_{i}"));
        let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "pdf" => "application/pdf",
            "mp4" => "video/mp4",
            "zip" => "application/zip",
            _ => "application/octet-stream",
        };

        let dto = serde_json::json!({
            "id": id,
            "fileName": name,
            "size": meta.len(),
            "fileType": mime,
            "sha256": null,
            "preview": null
        });
        file_dtos.insert(id.clone(), dto);
        file_info_list.push((id, path.clone()));
    }

    let prepare_body = serde_json::json!({
        "info": {
            "alias": "Crest",
            "version": "2.0",
            "deviceModel": "PC",
            "deviceType": "desktop",
            "fingerprint": "crest-desktop-client"
        },
        "files": file_dtos
    });

    // Try HTTPS first, then fallback to HTTP
    let schemes = ["https", "http"];
    let mut session_info: Option<(String, HashMap<String, String>, &'static str)> = None;

    for scheme in schemes {
        let url = format!("{scheme}://{device_ip}:{port}/api/localsend/v2/prepare-upload");
        let res = client.post(&url)
            .json(&prepare_body)
            .send()
            .await;

        if let Ok(resp) = res {
            if resp.status().is_success() {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    let session_id = json.get("sessionId").and_then(|s| s.as_str()).unwrap_or("").to_string();
                    let mut tokens = HashMap::new();
                    if let Some(files_obj) = json.get("files").and_then(|f| f.as_object()) {
                        for (k, v) in files_obj {
                            if let Some(t) = v.as_str() {
                                tokens.insert(k.clone(), t.to_string());
                            }
                        }
                    }
                    if !session_id.is_empty() {
                        session_info = Some((session_id, tokens, scheme));
                        break;
                    }
                }
            } else if resp.status().as_u16() == 403 {
                return Err("El dispositivo receptor rechazó la transferencia".into());
            }
        }
    }

    let (session_id, tokens, scheme) = session_info.ok_or_else(|| "No se pudo establecer conexión con el dispositivo LocalSend".to_string())?;

    for (file_id, path) in file_info_list {
        let token = tokens.get(&file_id).ok_or_else(|| format!("Token de subida no otorgado para {file_id}"))?;
        let bytes = std::fs::read(&path).map_err(|e| format!("Error leyendo {}: {e}", path.display()))?;
        let upload_url = format!("{scheme}://{device_ip}:{port}/api/localsend/v2/upload?sessionId={session_id}&fileId={file_id}&token={token}");

        let resp = client.post(&upload_url)
            .header("Content-Type", "application/octet-stream")
            .body(bytes)
            .send()
            .await
            .map_err(|e| format!("Error al transferir {}: {e}", path.display()))?;

        if !resp.status().is_success() {
            return Err(format!("Fallo al enviar archivo {}: HTTP {}", path.display(), resp.status()));
        }
    }

    Ok(())
}

fn adb_command() -> std::process::Command {
    let mut cmd = std::process::Command::new("adb");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW
        cmd.creation_flags(0x08000000);
    }
    cmd
}

/// Lists connected ADB devices via `adb devices -l`.
#[tauri::command]
pub fn adb_devices() -> Vec<AdbDevice> {
    let output = match adb_command().arg("devices").arg("-l").output() {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let mut devices = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("List of devices") || trimmed.starts_with('*') {
            continue;
        }
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() < 2 {
            continue;
        }
        let id = parts[0].to_string();
        let status = parts[1].to_string();

        let mut model = id.clone();
        let mut product = None;

        for part in &parts[2..] {
            if let Some(m) = part.strip_prefix("model:") {
                model = m.replace('_', " ");
            } else if let Some(p) = part.strip_prefix("product:") {
                product = Some(p.replace('_', " "));
            }
        }

        devices.push(AdbDevice {
            id,
            model,
            product,
            status,
        });
    }

    devices
}

/// Pushes files directly to an Android device using `adb push`.
#[tauri::command]
pub fn adb_push(device_id: Option<String>, paths: Vec<String>, target_dir: Option<String>) -> Result<String, String> {
    let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).filter(|p| p.is_file()).collect();
    if files.is_empty() {
        return Err("No hay archivos válidos para enviar por ADB".into());
    }

    let target = target_dir.unwrap_or_else(|| "/sdcard/Download/".into());
    let target = if !target.ends_with('/') { format!("{target}/") } else { target };

    for path in &files {
        let mut cmd = adb_command();
        if let Some(ref id) = device_id {
            cmd.arg("-s").arg(id);
        }
        cmd.arg("push").arg(path).arg(&target);

        let output = cmd.output().map_err(|e| format!("Fallo al ejecutar ADB: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Error en ADB push: {}", stderr.trim()));
        }
    }

    Ok(format!("{} archivo(s) transferido(s) a {}", files.len(), target))
}

/// Opens Windows Quick Share / Google Quick Share or native Windows Share UI.
#[tauri::command]
pub fn quick_share_files(paths: Vec<String>) -> Result<(), String> {
    let files: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).filter(|p| p.is_file()).collect();
    if files.is_empty() {
        return Err("No hay archivos para compartir".into());
    }

    #[cfg(windows)]
    {
        // 1. Check if Google Quick Share for Windows is installed
        let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        let prog_files = std::env::var_os("ProgramFiles").map(PathBuf::from);
        let prog_files_x86 = std::env::var_os("ProgramFiles(x86)").map(PathBuf::from);

        let mut nearby_paths = Vec::new();
        if let Some(p) = local_app_data {
            nearby_paths.push(p.join("Google").join("NearbyShare").join("nearby_share.exe"));
        }
        if let Some(p) = prog_files {
            nearby_paths.push(p.join("Google").join("NearbyShare").join("nearby_share.exe"));
        }
        if let Some(p) = prog_files_x86 {
            nearby_paths.push(p.join("Google").join("NearbyShare").join("nearby_share.exe"));
        }

        for exe in nearby_paths {
            if exe.is_file() {
                let mut cmd = std::process::Command::new(exe);
                for f in &files {
                    cmd.arg(f);
                }
                if cmd.spawn().is_ok() {
                    return Ok(());
                }
            }
        }

        // 2. Fall back to Windows 11 native Share UI via context verb "share"
        use windows::core::{w, HSTRING, PCWSTR};
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        if let Some(first) = files.first() {
            let path_str = first.to_string_lossy();
            let ok = unsafe {
                ShellExecuteW(
                    None,
                    w!("share"),
                    &HSTRING::from(path_str.as_ref()),
                    PCWSTR::null(),
                    PCWSTR::null(),
                    SW_SHOWNORMAL,
                )
            }.0 as isize > 32;

            if ok {
                return Ok(());
            }
        }

        // 3. Try ms-windows-share: protocol
        if crate::open_url("ms-windows-share:").is_ok() {
            return Ok(());
        }
    }

    #[cfg(not(windows))]
    {
        if let Some(first) = files.first() {
            let _ = crate::open_url(&first.to_string_lossy());
            return Ok(());
        }
    }

    Ok(())
}

/// Generates and opens a Telegram share link for the given text or files.
#[tauri::command]
pub fn telegram_share(text: Option<String>, paths: Vec<String>) -> Result<String, String> {
    let file_names: Vec<String> = paths.into_iter()
        .map(PathBuf::from)
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect();

    let message = match (text, file_names.is_empty()) {
        (Some(t), false) => format!("{}: {}", t, file_names.join(", ")),
        (Some(t), true) => t,
        (None, false) => format!("Archivos de Crest: {}", file_names.join(", ")),
        (None, true) => return Err("No hay contenido ni archivos para compartir en Telegram".into()),
    };

    let encoded = percent_encode(&message);
    let url = format!("https://t.me/share/url?text={encoded}");
    crate::open_url(&url).map_err(|e| format!("Error al abrir Telegram: {e}"))?;

    Ok(url)
}

fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
