//! Google Sync Backend: OAuth2, DPAPI encryption, Tasks & Calendar sync.
//!
//! Stores OAuth tokens encrypted via Windows DPAPI into `%APPDATA%\io.github.andrealo20.crest\google_tokens.dat`.
//! Caches Google Tasks (`gtasks-cache.json`) and Google Calendar (`gcal-cache.json`) offline-first.

use std::path::PathBuf;
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const TOKENS_FILE: &str = "google_tokens.dat";
const GTASKS_CACHE_FILE: &str = "gtasks-cache.json";
const GCAL_CACHE_FILE: &str = "gcal-cache.json";

// Default desktop OAuth client credentials (fallback if user hasn't provided custom ones)
const DEFAULT_CLIENT_ID: &str = "982347102938-crestsync.apps.googleusercontent.com";
const DEFAULT_CLIENT_SECRET: &str = "GOCSPX-crestsync_mock_secret";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleTokens {
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expiry_timestamp: Option<i64>,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleAuthStatus {
    pub connected: bool,
    pub email: Option<String>,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GTaskList {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub updated: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GTaskItem {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub updated: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    pub status: String, // "needsAction" | "completed"
    #[serde(default)]
    pub due: Option<String>,
    #[serde(default)]
    pub completed: Option<String>,
    #[serde(default)]
    pub list_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GCalendarMeta {
    pub id: String,
    pub summary: String,
    #[serde(default)]
    pub primary: Option<bool>,
    #[serde(rename = "backgroundColor", default)]
    pub background_color: Option<String>,
    #[serde(rename = "foregroundColor", default)]
    pub foreground_color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GCalendarEventTime {
    #[serde(rename = "dateTime", default)]
    pub date_time: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GCalendarEvent {
    pub id: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub start: Option<GCalendarEventTime>,
    #[serde(default)]
    pub end: Option<GCalendarEventTime>,
    #[serde(rename = "hangoutLink", default)]
    pub hangout_link: Option<String>,
    #[serde(rename = "htmlLink", default)]
    pub html_link: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(rename = "calendarId", default)]
    pub calendar_id: Option<String>,
    #[serde(rename = "colorId", default)]
    pub color_id: Option<String>,
}

// Offline Caches
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GTasksCache {
    pub lists: Vec<GTaskList>,
    pub tasks_by_list: std::collections::HashMap<String, Vec<GTaskItem>>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GCalCache {
    pub calendars: Vec<GCalendarMeta>,
    pub events: Vec<GCalendarEvent>,
    pub updated_at: i64,
}

fn now_sec() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn tokens_path(app: &AppHandle) -> Result<PathBuf, String> {
    crate::portable::app_data_dir(app)
        .map(|d| d.join(TOKENS_FILE))
        .map_err(|e| e.to_string())
}

fn gtasks_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    crate::portable::app_data_dir(app)
        .map(|d| d.join(GTASKS_CACHE_FILE))
        .map_err(|e| e.to_string())
}

fn gcal_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    crate::portable::app_data_dir(app)
        .map(|d| d.join(GCAL_CACHE_FILE))
        .map_err(|e| e.to_string())
}

// ----------------- DPAPI Cryptography -----------------

#[cfg(windows)]
extern "system" {
    fn LocalFree(hmem: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
}

#[cfg(windows)]
fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    use windows::core::PCWSTR;

    let mut in_blob = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(&mut in_blob, PCWSTR::null(), None, None, None, 0, &mut out_blob)
            .map_err(|e| format!("DPAPI protect failed: {e}"))?;
        let slice = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize);
        let result = slice.to_vec();
        LocalFree(out_blob.pbData as _);
        Ok(result)
    }
}

#[cfg(windows)]
fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    let mut in_blob = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&mut in_blob, None, None, None, None, 0, &mut out_blob)
            .map_err(|e| format!("DPAPI unprotect failed: {e}"))?;
        let slice = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize);
        let result = slice.to_vec();
        LocalFree(out_blob.pbData as _);
        Ok(result)
    }
}

#[cfg(not(windows))]
fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, String> {
    // Non-Windows fallback (xor obfuscated)
    Ok(data.iter().map(|b| b ^ 0x5A).collect())
}

#[cfg(not(windows))]
fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(data.iter().map(|b| b ^ 0x5A).collect())
}

// ----------------- Token persistence -----------------

pub fn load_tokens(app: &AppHandle) -> Result<GoogleTokens, String> {
    let path = tokens_path(app)?;
    if !path.exists() {
        return Err("not_found".into());
    }
    let encrypted = std::fs::read(&path).map_err(|e| e.to_string())?;
    let decrypted = dpapi_unprotect(&encrypted)?;
    let tokens: GoogleTokens = serde_json::from_slice(&decrypted).map_err(|e| e.to_string())?;
    Ok(tokens)
}

pub fn save_tokens(app: &AppHandle, tokens: &GoogleTokens) -> Result<(), String> {
    let path = tokens_path(app)?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::to_vec(tokens).map_err(|e| e.to_string())?;
    let encrypted = dpapi_protect(&json)?;
    crate::write_atomic(&path, &encrypted).map_err(|e| e.to_string())
}

pub fn clear_tokens(app: &AppHandle) -> Result<(), String> {
    let path = tokens_path(app)?;
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    // Also clear caches
    let _ = gtasks_cache_path(app).map(|p| { if p.exists() { let _ = std::fs::remove_file(p); } });
    let _ = gcal_cache_path(app).map(|p| { if p.exists() { let _ = std::fs::remove_file(p); } });
    Ok(())
}

// ----------------- Token Refreshing -----------------

pub async fn get_valid_token(app: &AppHandle) -> Result<String, String> {
    let mut tokens = load_tokens(app)?;
    let now = now_sec();

    // Check if token expires within 60s
    let is_expired = match tokens.expiry_timestamp {
        Some(exp) => exp <= now + 60,
        None => false,
    };

    if !is_expired {
        return Ok(tokens.access_token.clone());
    }

    let refresh_token = match &tokens.refresh_token {
        Some(rt) if !rt.is_empty() => rt.clone(),
        _ => return Ok(tokens.access_token.clone()), // No refresh token, fallback to existing
    };

    // Refresh token via Google OAuth endpoint
    let client_id = tokens.client_id.clone().unwrap_or_else(|| DEFAULT_CLIENT_ID.into());
    let client_secret = tokens.client_secret.clone().unwrap_or_else(|| DEFAULT_CLIENT_SECRET.into());

    let body = format!(
        "client_id={}&client_secret={}&refresh_token={}&grant_type=refresh_token",
        urlencoding::encode(&client_id),
        urlencoding::encode(&client_secret),
        urlencoding::encode(&refresh_token)
    );

    let client = reqwest::Client::new();
    let res = client
        .post("https://oauth2.googleapis.com/token")
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await;

    match res {
        Ok(resp) if resp.status().is_success() => {
            #[derive(Deserialize)]
            struct RefreshResponse {
                access_token: String,
                expires_in: Option<i64>,
            }
            if let Ok(data) = resp.json::<RefreshResponse>().await {
                tokens.access_token = data.access_token.clone();
                tokens.expiry_timestamp = Some(now + data.expires_in.unwrap_or(3600));
                let _ = save_tokens(app, &tokens);
                Ok(data.access_token)
            } else {
                Ok(tokens.access_token)
            }
        }
        _ => Ok(tokens.access_token),
    }
}

// ----------------- Cache helpers -----------------

pub fn load_tasks_cache(app: &AppHandle) -> GTasksCache {
    gtasks_cache_path(app)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<GTasksCache>(&b).ok())
        .unwrap_or_default()
}

pub fn save_tasks_cache(app: &AppHandle, cache: &GTasksCache) {
    if let Ok(p) = gtasks_cache_path(app) {
        if let Ok(b) = serde_json::to_vec_pretty(cache) {
            let _ = crate::write_atomic(&p, &b);
        }
    }
}

pub fn load_cal_cache(app: &AppHandle) -> GCalCache {
    gcal_cache_path(app)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<GCalCache>(&b).ok())
        .unwrap_or_default()
}

pub fn save_cal_cache(app: &AppHandle, cache: &GCalCache) {
    if let Ok(p) = gcal_cache_path(app) {
        if let Ok(b) = serde_json::to_vec_pretty(cache) {
            let _ = crate::write_atomic(&p, &b);
        }
    }
}

// =========================================================================
// Commands
// =========================================================================

#[tauri::command]
pub fn google_auth_status(app: AppHandle) -> GoogleAuthStatus {
    match load_tokens(&app) {
        Ok(t) => GoogleAuthStatus {
            connected: !t.access_token.is_empty(),
            email: t.email,
            expires_at: t.expiry_timestamp,
        },
        Err(_) => GoogleAuthStatus {
            connected: false,
            email: None,
            expires_at: None,
        },
    }
}

#[tauri::command]
pub fn google_auth_start(app: AppHandle) -> Result<String, String> {
    let tokens = load_tokens(&app).ok();
    let client_id = tokens
        .and_then(|t| t.client_id)
        .unwrap_or_else(|| DEFAULT_CLIENT_ID.into());

    let redirect_uri = "http://127.0.0.1:45678";
    let scopes = "https://www.googleapis.com/auth/tasks%20https://www.googleapis.com/auth/calendar%20https://www.googleapis.com/auth/userinfo.email";
    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent",
        client_id, redirect_uri, scopes
    );
    let _ = crate::open_url(&auth_url);
    Ok(auth_url)
}

#[tauri::command]
pub async fn google_auth_save_tokens(
    app: AppHandle,
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    client_id: Option<String>,
    client_secret: Option<String>,
) -> Result<(), String> {
    let now = now_sec();
    let expiry_timestamp = expires_in.map(|sec| now + sec);

    // Try fetching user email with the new access_token
    let client = reqwest::Client::new();
    let email = if let Ok(resp) = client
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(&access_token)
        .send()
        .await
    {
        #[derive(Deserialize)]
        struct UserInfo {
            email: Option<String>,
        }
        resp.json::<UserInfo>().await.ok().and_then(|u| u.email)
    } else {
        None
    };

    let tokens = GoogleTokens {
        client_id,
        client_secret,
        access_token,
        refresh_token,
        expiry_timestamp,
        email,
    };

    save_tokens(&app, &tokens)
}

#[tauri::command]
pub fn google_auth_disconnect(app: AppHandle) -> Result<(), String> {
    clear_tokens(&app)
}

// ----------------- Google Tasks Commands -----------------

#[tauri::command]
pub async fn gtasks_list_lists(app: AppHandle) -> Result<Vec<GTaskList>, String> {
    let cache = load_tasks_cache(&app);
    let token = match get_valid_token(&app).await {
        Ok(t) => t,
        Err(_) => {
            // Return cached lists if offline / not logged in
            if !cache.lists.is_empty() {
                return Ok(cache.lists);
            }
            return Err("not_authenticated".into());
        }
    };

    let client = reqwest::Client::new();
    let res = client
        .get("https://tasks.googleapis.com/tasks/v1/users/@me/lists")
        .bearer_auth(&token)
        .send()
        .await;

    match res {
        Ok(resp) if resp.status().is_success() => {
            #[derive(Deserialize)]
            struct ListsResponse {
                items: Option<Vec<GTaskList>>,
            }
            if let Ok(data) = resp.json::<ListsResponse>().await {
                let lists = data.items.unwrap_or_default();
                let mut new_cache = cache;
                new_cache.lists = lists.clone();
                new_cache.updated_at = now_sec();
                save_tasks_cache(&app, &new_cache);
                Ok(lists)
            } else {
                Ok(cache.lists)
            }
        }
        _ => {
            if !cache.lists.is_empty() {
                Ok(cache.lists)
            } else {
                Err("failed_to_fetch_tasks_lists".into())
            }
        }
    }
}

#[tauri::command]
pub async fn gtasks_list_tasks(app: AppHandle, list_id: String) -> Result<Vec<GTaskItem>, String> {
    let cache = load_tasks_cache(&app);
    let token = match get_valid_token(&app).await {
        Ok(t) => t,
        Err(_) => {
            if let Some(tasks) = cache.tasks_by_list.get(&list_id) {
                return Ok(tasks.clone());
            }
            return Err("not_authenticated".into());
        }
    };

    let client = reqwest::Client::new();
    let url = format!(
        "https://tasks.googleapis.com/tasks/v1/lists/{}/tasks?showCompleted=true&showHidden=true&maxResults=100",
        list_id
    );
    let res = client.get(&url).bearer_auth(&token).send().await;

    match res {
        Ok(resp) if resp.status().is_success() => {
            #[derive(Deserialize)]
            struct TasksResponse {
                items: Option<Vec<GTaskItem>>,
            }
            if let Ok(data) = resp.json::<TasksResponse>().await {
                let mut tasks = data.items.unwrap_or_default();
                for t in &mut tasks {
                    t.list_id = Some(list_id.clone());
                }
                let mut new_cache = cache;
                new_cache.tasks_by_list.insert(list_id, tasks.clone());
                new_cache.updated_at = now_sec();
                save_tasks_cache(&app, &new_cache);
                Ok(tasks)
            } else {
                Ok(cache.tasks_by_list.get(&list_id).cloned().unwrap_or_default())
            }
        }
        _ => Ok(cache.tasks_by_list.get(&list_id).cloned().unwrap_or_default()),
    }
}

#[tauri::command]
pub async fn gtasks_create_task(
    app: AppHandle,
    list_id: String,
    title: String,
    notes: Option<String>,
    due: Option<String>,
) -> Result<GTaskItem, String> {
    let token = get_valid_token(&app).await?;
    let client = reqwest::Client::new();
    let url = format!("https://tasks.googleapis.com/tasks/v1/lists/{}/tasks", list_id);

    #[derive(Serialize)]
    struct NewTaskBody {
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        notes: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        due: Option<String>,
    }

    let body = NewTaskBody {
        title: title.clone(),
        notes: notes.clone(),
        due: due.clone(),
    };

    let res = client
        .post(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Task creation failed with status: {}", res.status()));
    }

    let mut item = res.json::<GTaskItem>().await.map_err(|e| e.to_string())?;
    item.list_id = Some(list_id.clone());

    // Update cache
    let mut cache = load_tasks_cache(&app);
    let list_tasks = cache.tasks_by_list.entry(list_id).or_default();
    list_tasks.insert(0, item.clone());
    save_tasks_cache(&app, &cache);

    Ok(item)
}

#[tauri::command]
pub async fn gtasks_patch_task(
    app: AppHandle,
    list_id: String,
    task_id: String,
    status: String,
    title: Option<String>,
    notes: Option<String>,
    due: Option<String>,
) -> Result<GTaskItem, String> {
    let token = get_valid_token(&app).await?;
    let client = reqwest::Client::new();
    let url = format!(
        "https://tasks.googleapis.com/tasks/v1/lists/{}/tasks/{}",
        list_id, task_id
    );

    #[derive(Serialize)]
    struct PatchTaskBody {
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        notes: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        due: Option<String>,
    }

    let body = PatchTaskBody {
        status: status.clone(),
        title,
        notes,
        due,
    };

    let res = client
        .patch(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Task patch failed with status: {}", res.status()));
    }

    let mut item = res.json::<GTaskItem>().await.map_err(|e| e.to_string())?;
    item.list_id = Some(list_id.clone());

    // Update cache
    let mut cache = load_tasks_cache(&app);
    if let Some(list_tasks) = cache.tasks_by_list.get_mut(&list_id) {
        if let Some(existing) = list_tasks.iter_mut().find(|t| t.id == task_id) {
            *existing = item.clone();
        }
    }
    save_tasks_cache(&app, &cache);

    Ok(item)
}

#[tauri::command]
pub async fn gtasks_delete_task(
    app: AppHandle,
    list_id: String,
    task_id: String,
) -> Result<(), String> {
    let token = get_valid_token(&app).await?;
    let client = reqwest::Client::new();
    let url = format!(
        "https://tasks.googleapis.com/tasks/v1/lists/{}/tasks/{}",
        list_id, task_id
    );

    let res = client
        .delete(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() && res.status() != reqwest::StatusCode::NOT_FOUND {
        return Err(format!("Task delete failed with status: {}", res.status()));
    }

    // Update cache
    let mut cache = load_tasks_cache(&app);
    if let Some(list_tasks) = cache.tasks_by_list.get_mut(&list_id) {
        list_tasks.retain(|t| t.id != task_id);
    }
    save_tasks_cache(&app, &cache);

    Ok(())
}

// ----------------- Google Calendar Commands -----------------

#[tauri::command]
pub async fn gcal_list_calendars(app: AppHandle) -> Result<Vec<GCalendarMeta>, String> {
    let cache = load_cal_cache(&app);
    let token = match get_valid_token(&app).await {
        Ok(t) => t,
        Err(_) => {
            if !cache.calendars.is_empty() {
                return Ok(cache.calendars);
            }
            return Err("not_authenticated".into());
        }
    };

    let client = reqwest::Client::new();
    let res = client
        .get("https://www.googleapis.com/calendar/v3/users/me/calendarList")
        .bearer_auth(&token)
        .send()
        .await;

    match res {
        Ok(resp) if resp.status().is_success() => {
            #[derive(Deserialize)]
            struct CalendarListResp {
                items: Option<Vec<GCalendarMeta>>,
            }
            if let Ok(data) = resp.json::<CalendarListResp>().await {
                let calendars = data.items.unwrap_or_default();
                let mut new_cache = cache;
                new_cache.calendars = calendars.clone();
                new_cache.updated_at = now_sec();
                save_cal_cache(&app, &new_cache);
                Ok(calendars)
            } else {
                Ok(cache.calendars)
            }
        }
        _ => {
            if !cache.calendars.is_empty() {
                Ok(cache.calendars)
            } else {
                Err("failed_to_fetch_calendars".into())
            }
        }
    }
}

#[tauri::command]
pub async fn gcal_list_events(
    app: AppHandle,
    calendar_id: Option<String>,
    time_min: Option<String>,
    time_max: Option<String>,
) -> Result<Vec<GCalendarEvent>, String> {
    let cache = load_cal_cache(&app);
    let cal_id = calendar_id.unwrap_or_else(|| "primary".into());
    let token = match get_valid_token(&app).await {
        Ok(t) => t,
        Err(_) => {
            if !cache.events.is_empty() {
                return Ok(cache.events);
            }
            return Err("not_authenticated".into());
        }
    };

    let mut query_params = vec![
        "singleEvents=true".to_string(),
        "orderBy=startTime".to_string(),
        "maxResults=100".to_string(),
    ];

    if let Some(tm) = time_min {
        query_params.push(format!("timeMin={}", urlencoding::encode(&tm)));
    } else {
        // Default from 7 days ago
        let seven_days_ago = now_sec() - 7 * 86400;
        let ts = jiff::Timestamp::from_second(seven_days_ago)
            .map(|t| t.to_string())
            .unwrap_or_default();
        if !ts.is_empty() {
            query_params.push(format!("timeMin={}", urlencoding::encode(&ts)));
        }
    }

    if let Some(tm) = time_max {
        query_params.push(format!("timeMax={}", urlencoding::encode(&tm)));
    }

    let client = reqwest::Client::new();
    let url = format!(
        "https://www.googleapis.com/calendar/v3/calendars/{}/events?{}",
        urlencoding::encode(&cal_id),
        query_params.join("&")
    );

    let res = client
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await;

    match res {
        Ok(resp) if resp.status().is_success() => {
            #[derive(Deserialize)]
            struct EventsResp {
                items: Option<Vec<GCalendarEvent>>,
            }
            if let Ok(data) = resp.json::<EventsResp>().await {
                let mut events = data.items.unwrap_or_default();
                for ev in &mut events {
                    ev.calendar_id = Some(cal_id.clone());
                }
                let mut new_cache = cache;
                new_cache.events = events.clone();
                new_cache.updated_at = now_sec();
                save_cal_cache(&app, &new_cache);
                Ok(events)
            } else {
                Ok(cache.events)
            }
        }
        _ => Ok(cache.events),
    }
}

#[tauri::command]
pub async fn gcal_create_event(
    app: AppHandle,
    calendar_id: Option<String>,
    summary: String,
    start: String,
    end: String,
    description: Option<String>,
    location: Option<String>,
) -> Result<GCalendarEvent, String> {
    let token = get_valid_token(&app).await?;
    let cal_id = calendar_id.unwrap_or_else(|| "primary".into());
    let client = reqwest::Client::new();
    let url = format!(
        "https://www.googleapis.com/calendar/v3/calendars/{}/events",
        urlencoding::encode(&cal_id)
    );

    #[derive(Serialize)]
    struct EventTimeBody {
        #[serde(rename = "dateTime")]
        date_time: String,
    }

    #[derive(Serialize)]
    struct CreateEventBody {
        summary: String,
        start: EventTimeBody,
        end: EventTimeBody,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        location: Option<String>,
    }

    let body = CreateEventBody {
        summary,
        start: EventTimeBody { date_time: start },
        end: EventTimeBody { date_time: end },
        description,
        location,
    };

    let res = client
        .post(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Calendar event creation failed: {}", res.status()));
    }

    let mut item = res.json::<GCalendarEvent>().await.map_err(|e| e.to_string())?;
    item.calendar_id = Some(cal_id);

    // Update cache
    let mut cache = load_cal_cache(&app);
    cache.events.insert(0, item.clone());
    save_cal_cache(&app, &cache);

    Ok(item)
}

#[tauri::command]
pub async fn gcal_next_event(app: AppHandle) -> Result<Option<GCalendarEvent>, String> {
    let now = now_sec();
    let ts_now = jiff::Timestamp::from_second(now)
        .map(|t| t.to_string())
        .unwrap_or_default();

    // Query events from now on
    let events = gcal_list_events(app, None, Some(ts_now), None).await?;
    let next = events.into_iter().find(|e| {
        if let Some(start) = &e.start {
            if let Some(dt) = &start.date_time {
                if let Ok(parsed) = jiff::Timestamp::from_str(dt) {
                    return parsed.as_second() >= now;
                }
            }
        }
        false
    });

    Ok(next)
}

// Module urlencoding minimal helper so we don't depend on an extra crate
mod urlencoding {
    pub fn encode(data: &str) -> String {
        let mut out = String::with_capacity(data.len());
        for b in data.bytes() {
            match b {
                b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    out.push(b as char);
                }
                _ => {
                    out.push_str(&format!("%{:02X}", b));
                }
            }
        }
        out
    }
}
