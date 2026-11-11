//! OmniSearch: fast app, file, calculator, and PDF search.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant};

use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OmniResult {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub category: String, // "app" | "file" | "calc" | "pdf" | "action"
    pub icon: String,
    pub target: String,
    pub score: u32,
    pub action_data: Option<String>,
}

#[derive(Clone, Debug)]
pub struct IndexedApp {
    pub id: String,
    pub name: String,
    pub path: String,
    pub icon: String,
}

#[derive(Clone, Debug)]
pub struct IndexedFile {
    pub name: String,
    pub path: String,
    pub is_pdf: bool,
    pub is_dir: bool,
    pub category: &'static str,
}

pub struct SearchIndex {
    pub apps: Vec<IndexedApp>,
    pub files: Vec<IndexedFile>,
    pub last_scanned: Instant,
}

impl Default for SearchIndex {
    fn default() -> Self {
        Self {
            apps: Vec::new(),
            files: Vec::new(),
            last_scanned: Instant::now() - Duration::from_secs(3600),
        }
    }
}

static SEARCH_INDEX: OnceLock<Arc<RwLock<SearchIndex>>> = OnceLock::new();

fn get_index() -> &'static Arc<RwLock<SearchIndex>> {
    SEARCH_INDEX.get_or_init(|| {
        let index = Arc::new(RwLock::new(SearchIndex::default()));
        let index_clone = Arc::clone(&index);
        std::thread::spawn(move || {
            reindex_all(&index_clone);
        });
        index
    })
}

// ==========================================
// 1. Live Math & Engineering Calculator
// ==========================================

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Number(f64),
    Hex(u64),
    Bin(u64),
    Ident(String),
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Caret,
    LParen,
    RParen,
    Comma,
    Arrow,
}

fn tokenize_math(input: &str) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = input.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }

        // Arrow `->`
        if c == '-' && i + 1 < len && chars[i + 1] == '>' {
            tokens.push(Token::Arrow);
            i += 2;
            continue;
        }

        // Operators & delimiters
        match c {
            '+' => {
                tokens.push(Token::Plus);
                i += 1;
                continue;
            }
            '-' => {
                tokens.push(Token::Minus);
                i += 1;
                continue;
            }
            '*' => {
                tokens.push(Token::Star);
                i += 1;
                continue;
            }
            '/' => {
                tokens.push(Token::Slash);
                i += 1;
                continue;
            }
            '%' => {
                tokens.push(Token::Percent);
                i += 1;
                continue;
            }
            '^' => {
                tokens.push(Token::Caret);
                i += 1;
                continue;
            }
            '(' => {
                tokens.push(Token::LParen);
                i += 1;
                continue;
            }
            ')' => {
                tokens.push(Token::RParen);
                i += 1;
                continue;
            }
            ',' => {
                tokens.push(Token::Comma);
                i += 1;
                continue;
            }
            _ => {}
        }

        // Hex number: 0x...
        if c == '0' && i + 1 < len && (chars[i + 1] == 'x' || chars[i + 1] == 'X') {
            i += 2;
            let start = i;
            while i < len && chars[i].is_ascii_hexdigit() {
                i += 1;
            }
            if start == i {
                return Err("Invalid hex literal".into());
            }
            let hex_str: String = chars[start..i].iter().collect();
            let val = u64::from_str_radix(&hex_str, 16).map_err(|e| e.to_string())?;
            tokens.push(Token::Hex(val));
            continue;
        }

        // Binary number: 0b...
        if c == '0' && i + 1 < len && (chars[i + 1] == 'b' || chars[i + 1] == 'B') {
            i += 2;
            let start = i;
            while i < len && (chars[i] == '0' || chars[i] == '1') {
                i += 1;
            }
            if start == i {
                return Err("Invalid bin literal".into());
            }
            let bin_str: String = chars[start..i].iter().collect();
            let val = u64::from_str_radix(&bin_str, 2).map_err(|e| e.to_string())?;
            tokens.push(Token::Bin(val));
            continue;
        }

        // Decimal numbers with optional scientific notation and engineering suffixes (k, M, G, m, u, n, p)
        if c.is_ascii_digit() || (c == '.' && i + 1 < len && chars[i + 1].is_ascii_digit()) {
            let start = i;
            let mut has_dot = false;
            let mut has_exp = false;

            while i < len {
                let ch = chars[i];
                if ch.is_ascii_digit() {
                    i += 1;
                } else if ch == '.' && !has_dot && !has_exp {
                    has_dot = true;
                    i += 1;
                } else if (ch == 'e' || ch == 'E') && !has_exp {
                    has_exp = true;
                    i += 1;
                    if i < len && (chars[i] == '+' || chars[i] == '-') {
                        i += 1;
                    }
                } else {
                    break;
                }
            }

            let num_str: String = chars[start..i].iter().collect();
            let mut val: f64 = num_str.parse().map_err(|_| "Failed to parse number")?;

            // Check if there is an engineering unit suffix attached right after the number:
            // k, M, G, T, m, u, µ, n, p
            if i < len {
                let ch = chars[i];
                let mul = match ch {
                    'k' | 'K' => Some(1e3),
                    'M' => Some(1e6),
                    'G' => Some(1e9),
                    'T' => Some(1e12),
                    'm' => Some(1e-3),
                    'u' | 'µ' => Some(1e-6),
                    'n' => Some(1e-9),
                    'p' => Some(1e-12),
                    _ => None,
                };
                if let Some(m) = mul {
                    // Make sure it's not followed by another letter (like 'pi' or function name)
                    let next_is_letter = if i + 1 < len { chars[i + 1].is_alphabetic() } else { false };
                    if !next_is_letter {
                        val *= m;
                        i += 1;
                    }
                }
            }

            tokens.push(Token::Number(val));
            continue;
        }

        // Identifiers: functions, constants, conversions (bin, hex, dec)
        if c.is_alphabetic() || c == '_' {
            let start = i;
            while i < len && (chars[i].is_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            match word.as_str() {
                "to" | "as" => tokens.push(Token::Arrow),
                _ => tokens.push(Token::Ident(word)),
            }
            continue;
        }

        return Err(format!("Unexpected character: {}", c));
    }

    Ok(tokens)
}

struct Parser<'a> {
    tokens: &'a [Token],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(tokens: &'a [Token]) -> Self {
        Self { tokens, pos: 0 }
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn advance(&mut self) -> Option<&Token> {
        let tok = self.tokens.get(self.pos);
        if tok.is_some() {
            self.pos += 1;
        }
        tok
    }

    fn parse_expression(&mut self) -> Result<f64, String> {
        self.parse_add_sub()
    }

    fn parse_add_sub(&mut self) -> Result<f64, String> {
        let mut left = self.parse_mul_div()?;
        while let Some(tok) = self.peek() {
            match tok {
                Token::Plus => {
                    self.advance();
                    let right = self.parse_mul_div()?;
                    left += right;
                }
                Token::Minus => {
                    self.advance();
                    let right = self.parse_mul_div()?;
                    left -= right;
                }
                _ => break,
            }
        }
        Ok(left)
    }

    fn parse_mul_div(&mut self) -> Result<f64, String> {
        let mut left = self.parse_power()?;
        while let Some(tok) = self.peek() {
            match tok {
                Token::Star => {
                    self.advance();
                    let right = self.parse_power()?;
                    left *= right;
                }
                Token::Slash => {
                    self.advance();
                    let right = self.parse_power()?;
                    if right == 0.0 {
                        return Err("Division by zero".into());
                    }
                    left /= right;
                }
                Token::Percent => {
                    self.advance();
                    let right = self.parse_power()?;
                    if right == 0.0 {
                        return Err("Modulo by zero".into());
                    }
                    left %= right;
                }
                _ => break,
            }
        }
        Ok(left)
    }

    fn parse_power(&mut self) -> Result<f64, String> {
        let left = self.parse_unary()?;
        if let Some(Token::Caret) = self.peek() {
            self.advance();
            let right = self.parse_power()?; // right-associative
            return Ok(left.powf(right));
        }
        Ok(left)
    }

    fn parse_unary(&mut self) -> Result<f64, String> {
        match self.peek() {
            Some(Token::Plus) => {
                self.advance();
                self.parse_unary()
            }
            Some(Token::Minus) => {
                self.advance();
                let val = self.parse_unary()?;
                Ok(-val)
            }
            _ => self.parse_primary(),
        }
    }

    fn parse_primary(&mut self) -> Result<f64, String> {
        match self.peek() {
            Some(Token::Number(n)) => {
                let v = *n;
                self.advance();
                Ok(v)
            }
            Some(Token::Hex(h)) => {
                let v = *h as f64;
                self.advance();
                Ok(v)
            }
            Some(Token::Bin(b)) => {
                let v = *b as f64;
                self.advance();
                Ok(v)
            }
            Some(Token::Ident(name)) => {
                let name = name.clone();
                self.advance();
                // Check if followed by `(` (function call)
                if let Some(Token::LParen) = self.peek() {
                    self.advance();
                    let mut args = Vec::new();
                    if let Some(Token::RParen) = self.peek() {
                        self.advance();
                    } else {
                        loop {
                            let arg = self.parse_expression()?;
                            args.push(arg);
                            if let Some(Token::Comma) = self.peek() {
                                self.advance();
                            } else if let Some(Token::RParen) = self.peek() {
                                self.advance();
                                break;
                            } else {
                                return Err("Expected ')' or ',' in function call".into());
                            }
                        }
                    }

                    match name.to_lowercase().as_str() {
                        "log10" | "log" => {
                            if args.len() != 1 {
                                return Err("log10 expects 1 argument".into());
                            }
                            Ok(args[0].log10())
                        }
                        "ln" => {
                            if args.len() != 1 {
                                return Err("ln expects 1 argument".into());
                            }
                            Ok(args[0].ln())
                        }
                        "sqrt" => {
                            if args.len() != 1 {
                                return Err("sqrt expects 1 argument".into());
                            }
                            Ok(args[0].sqrt())
                        }
                        "sin" => {
                            if args.len() != 1 {
                                return Err("sin expects 1 argument".into());
                            }
                            Ok(args[0].sin())
                        }
                        "cos" => {
                            if args.len() != 1 {
                                return Err("cos expects 1 argument".into());
                            }
                            Ok(args[0].cos())
                        }
                        "tan" => {
                            if args.len() != 1 {
                                return Err("tan expects 1 argument".into());
                            }
                            Ok(args[0].tan())
                        }
                        "asin" => {
                            if args.len() != 1 {
                                return Err("asin expects 1 argument".into());
                            }
                            Ok(args[0].asin())
                        }
                        "acos" => {
                            if args.len() != 1 {
                                return Err("acos expects 1 argument".into());
                            }
                            Ok(args[0].acos())
                        }
                        "atan" => {
                            if args.len() != 1 {
                                return Err("atan expects 1 argument".into());
                            }
                            Ok(args[0].atan())
                        }
                        "abs" => {
                            if args.len() != 1 {
                                return Err("abs expects 1 argument".into());
                            }
                            Ok(args[0].abs())
                        }
                        "ceil" => {
                            if args.len() != 1 {
                                return Err("ceil expects 1 argument".into());
                            }
                            Ok(args[0].ceil())
                        }
                        "floor" => {
                            if args.len() != 1 {
                                return Err("floor expects 1 argument".into());
                            }
                            Ok(args[0].floor())
                        }
                        "round" => {
                            if args.len() != 1 {
                                return Err("round expects 1 argument".into());
                            }
                            Ok(args[0].round())
                        }
                        "fc" => {
                            // Cut-off frequency fc = 1 / (2 * pi * R * C)
                            if args.len() != 2 {
                                return Err("fc expects (R, C) arguments".into());
                            }
                            let (r, c) = (args[0], args[1]);
                            Ok(1.0 / (2.0 * std::f64::consts::PI * r * c))
                        }
                        "vdiv" => {
                            // Voltage divider: Vout = Vin * R2 / (R1 + R2)
                            if args.len() != 3 {
                                return Err("vdiv expects (Vin, R1, R2) arguments".into());
                            }
                            let (vin, r1, r2) = (args[0], args[1], args[2]);
                            Ok(vin * r2 / (r1 + r2))
                        }
                        _ => Err(format!("Unknown function: {}", name)),
                    }
                } else {
                    // Constants
                    match name.to_lowercase().as_str() {
                        "pi" => Ok(std::f64::consts::PI),
                        "e" => Ok(std::f64::consts::E),
                        _ => Err(format!("Unknown identifier: {}", name)),
                    }
                }
            }
            Some(Token::LParen) => {
                self.advance();
                let val = self.parse_expression()?;
                if let Some(Token::RParen) = self.peek() {
                    self.advance();
                    Ok(val)
                } else {
                    Err("Expected ')'".into())
                }
            }
            _ => Err("Unexpected token".into()),
        }
    }
}

pub struct LiveMathResult {
    pub display: String,
    pub subtitle: String,
    pub raw_val: String,
}

pub fn try_evaluate_math(input: &str) -> Option<LiveMathResult> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Check for conversions: e.g. `0xFF -> bin`, `100 -> hex`, `0b1010 -> hex`
    let tokens = tokenize_math(trimmed).ok()?;
    if tokens.is_empty() {
        return None;
    }

    // Check if there's an arrow conversion: <expr> -> <target_base>
    let arrow_pos = tokens.iter().position(|t| *t == Token::Arrow);
    if let Some(idx) = arrow_pos {
        let left_tokens = &tokens[..idx];
        let right_tokens = &tokens[idx + 1..];
        if left_tokens.is_empty() || right_tokens.is_empty() {
            return None;
        }

        let mut parser = Parser::new(left_tokens);
        let val = parser.parse_expression().ok()?;
        let int_val = val as i64;

        if let Token::Ident(target_base) = &right_tokens[0] {
            let base_low = target_base.to_lowercase();
            match base_low.as_str() {
                "bin" | "binary" => {
                    let formatted = format!("0b{:b}", int_val);
                    return Some(LiveMathResult {
                        display: format!("{} ({})", formatted, int_val),
                        subtitle: format!("Converted to Binary | Dec: {}, Hex: 0x{:X}", int_val, int_val),
                        raw_val: formatted,
                    });
                }
                "hex" | "hexadecimal" => {
                    let formatted = format!("0x{:X}", int_val);
                    return Some(LiveMathResult {
                        display: format!("{} ({})", formatted, int_val),
                        subtitle: format!("Converted to Hexadecimal | Dec: {}, Bin: 0b{:b}", int_val, int_val),
                        raw_val: formatted,
                    });
                }
                "dec" | "decimal" => {
                    let formatted = format!("{}", int_val);
                    return Some(LiveMathResult {
                        display: format!("{} (0x{:X})", formatted, int_val),
                        subtitle: format!("Converted to Decimal | Hex: 0x{:X}, Bin: 0b{:b}", int_val, int_val),
                        raw_val: formatted,
                    });
                }
                "oct" | "octal" => {
                    let formatted = format!("0o{:o}", int_val);
                    return Some(LiveMathResult {
                        display: format!("{} ({})", formatted, int_val),
                        subtitle: format!("Converted to Octal | Dec: {}", int_val),
                        raw_val: formatted,
                    });
                }
                _ => {}
            }
        }
    }

    // Single hex or bin literal (e.g. `0xFF` or `0b1010`)
    if tokens.len() == 1 {
        match &tokens[0] {
            Token::Hex(h) => {
                return Some(LiveMathResult {
                    display: format!("{} (0x{:X})", h, h),
                    subtitle: format!("Hex: 0x{:X} → Dec: {}, Bin: 0b{:b}", h, h, h),
                    raw_val: h.to_string(),
                });
            }
            Token::Bin(b) => {
                return Some(LiveMathResult {
                    display: format!("{} (0b{:b})", b, b),
                    subtitle: format!("Bin: 0b{:b} → Dec: {}, Hex: 0x{:X}", b, b, b),
                    raw_val: b.to_string(),
                });
            }
            _ => {
                // If it's a single plain number without operators or letters, don't show calculator unless requested
                if !trimmed.contains(|c: char| "+-*/^%()".contains(c)) {
                    return None;
                }
            }
        }
    }

    // Must contain math operators, function calls or parens to qualify as an expression
    let has_math_symbols = trimmed.contains(|c: char| "+-*/^%()".contains(c))
        || trimmed.starts_with("fc(")
        || trimmed.starts_with("vdiv(")
        || trimmed.starts_with("log")
        || trimmed.starts_with("ln")
        || trimmed.starts_with("sqrt");

    if !has_math_symbols {
        return None;
    }

    let mut parser = Parser::new(&tokens);
    let val = parser.parse_expression().ok()?;
    if parser.pos != tokens.len() {
        return None;
    }

    // Engineering & formatting touches
    let is_fc = trimmed.contains("1 / (2 * pi")
        || trimmed.contains("1/(2*pi")
        || trimmed.starts_with("fc(");
    let is_gain = trimmed.contains("20 * log10")
        || trimmed.contains("20*log10")
        || trimmed.contains("10 * log10")
        || trimmed.contains("10*log10");

    let (display, subtitle) = if is_fc {
        let (freq_str, unit) = if val >= 1e9 {
            (format!("{:.3}", val / 1e9), "GHz")
        } else if val >= 1e6 {
            (format!("{:.3}", val / 1e6), "MHz")
        } else if val >= 1e3 {
            (format!("{:.3}", val / 1e3), "kHz")
        } else {
            (format!("{:.3}", val), "Hz")
        };
        (
            format!("{} {}", freq_str, unit),
            format!("Cutoff Frequency fc = {:.4} Hz (1/(2·π·R·C))", val),
        )
    } else if is_gain {
        (
            format!("{:.3} dB", val),
            format!("Gain = {:.4} dB", val),
        )
    } else {
        let formatted = if val.fract() == 0.0 && val.abs() < 1e15 {
            format!("{}", val as i64)
        } else {
            // Trim excess zeroes from float
            let s = format!("{:.6}", val);
            let s = s.trim_end_matches('0').trim_end_matches('.');
            s.to_string()
        };
        (formatted.clone(), format!("= {} (Live Calculation)", formatted))
    };

    Some(LiveMathResult {
        display,
        subtitle,
        raw_val: val.to_string(),
    })
}

// ==========================================
// 2. Start Menu & Directory Indexing
// ==========================================

fn reindex_all(index: &Arc<RwLock<SearchIndex>>) {
    let mut apps = Vec::new();
    let mut files = Vec::new();

    // 1) Start Menu apps
    #[cfg(windows)]
    {
        // ProgramData Start Menu
        if let Ok(program_data) = std::env::var("ProgramData") {
            let p = Path::new(&program_data).join(r"Microsoft\Windows\Start Menu\Programs");
            scan_apps_in_folder(&p, &mut apps);
        }
        // User Start Menu
        if let Ok(app_data) = std::env::var("APPDATA") {
            let p = Path::new(&app_data).join(r"Microsoft\Windows\Start Menu\Programs");
            scan_apps_in_folder(&p, &mut apps);
        }
    }

    #[cfg(not(windows))]
    {
        // Linux desktop entries fallback
        let desktop_paths = ["/usr/share/applications", "/usr/local/share/applications"];
        for dir in desktop_paths {
            let p = Path::new(dir);
            if p.exists() {
                scan_desktop_entries(p, &mut apps);
            }
        }
    }

    // 2) Priority User Directories
    let home_dir = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok();
    if let Some(home) = home_dir {
        let home_path = PathBuf::from(&home);

        // Facultad
        let facultad = home_path.join("Documents").join("Facultad");
        if facultad.exists() {
            scan_priority_dir(&facultad, "facultad", &mut files, 5);
        }

        // Vault
        let vault = home_path.join("Documents").join("Vault");
        if vault.exists() {
            scan_priority_dir(&vault, "vault", &mut files, 4);
        }

        // General Documents
        let docs = home_path.join("Documents");
        if docs.exists() {
            scan_priority_dir(&docs, "documents", &mut files, 3);
        }

        // Desktop
        let desktop = home_path.join("Desktop");
        if desktop.exists() {
            scan_priority_dir(&desktop, "desktop", &mut files, 3);
        }

        // Code repositories / Projects
        for sub in &["Projects", "source/repos", "dev", "code"] {
            let proj = home_path.join(sub);
            if proj.exists() {
                scan_priority_dir(&proj, "project", &mut files, 3);
            }
        }
    }

    if let Ok(mut lock) = index.write() {
        lock.apps = apps;
        lock.files = files;
        lock.last_scanned = Instant::now();
    }
}

#[cfg(windows)]
fn scan_apps_in_folder(dir: &Path, apps: &mut Vec<IndexedApp>) {
    if !dir.exists() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_apps_in_folder(&path, apps);
        } else if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
            let ext_low = ext.to_lowercase();
            if ext_low == "lnk" || ext_low == "url" || ext_low == "exe" {
                let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
                if !name.is_empty() && !apps.iter().any(|a| a.name.eq_ignore_ascii_case(&name)) {
                    apps.push(IndexedApp {
                        id: path.to_string_lossy().to_string(),
                        name,
                        path: path.to_string_lossy().to_string(),
                        icon: "app".to_string(),
                    });
                }
            }
        }
    }
}

#[cfg(not(windows))]
fn scan_desktop_entries(dir: &Path, apps: &mut Vec<IndexedApp>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("desktop") {
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
            if !stem.is_empty() && !apps.iter().any(|a| a.name == stem) {
                apps.push(IndexedApp {
                    id: path.to_string_lossy().to_string(),
                    name: stem,
                    path: path.to_string_lossy().to_string(),
                    icon: "app".to_string(),
                });
            }
        }
    }
}

fn scan_priority_dir(dir: &Path, category: &'static str, files: &mut Vec<IndexedFile>, max_depth: usize) {
    if max_depth == 0 || !dir.exists() {
        return;
    }

    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target" || name == ".git" {
            continue;
        }

        let is_dir = path.is_dir();
        let is_pdf = path.extension().and_then(|s| s.to_str()).map(|e| e.eq_ignore_ascii_case("pdf")).unwrap_or(false);

        if is_dir {
            files.push(IndexedFile {
                name: name.clone(),
                path: path.to_string_lossy().to_string(),
                is_pdf: false,
                is_dir: true,
                category,
            });
            scan_priority_dir(&path, category, files, max_depth - 1);
        } else {
            files.push(IndexedFile {
                name,
                path: path.to_string_lossy().to_string(),
                is_pdf,
                is_dir: false,
                category,
            });
        }
    }
}

// ==========================================
// 3. Everything IPC / CLI Integration
// ==========================================

fn query_everything_cli(query: &str) -> Vec<IndexedFile> {
    #[cfg(windows)]
    {
        // Check for es.exe in standard locations or PATH
        let es_candidates = [
            PathBuf::from("es.exe"),
            PathBuf::from(r"C:\Program Files\Everything\es.exe"),
            PathBuf::from(r"C:\Program Files (x86)\Everything\es.exe"),
        ];

        let es_path = es_candidates.into_iter().find(|p| p.exists());
        if let Some(cmd_path) = es_path {
            use std::process::Command;
            let mut cmd = Command::new(cmd_path);
            cmd.arg("-n").arg("25").arg(query);
            crate::convert::hide_console(&mut cmd);
            if let Ok(output) = cmd.output() {
                if output.status.success() {
                    let text = String::from_utf8_lossy(&output.stdout);
                    let mut list = Vec::new();
                    for line in text.lines() {
                        let line = line.trim();
                        if line.is_empty() {
                            continue;
                        }
                        let path = Path::new(line);
                        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or(line).to_string();
                        let is_pdf = path.extension().and_then(|s| s.to_str()).map(|e| e.eq_ignore_ascii_case("pdf")).unwrap_or(false);
                        list.push(IndexedFile {
                            name,
                            path: line.to_string(),
                            is_pdf,
                            is_dir: path.is_dir(),
                            category: "everything",
                        });
                    }
                    return list;
                }
            }
        }
    }
    let _ = query;
    Vec::new()
}

pub fn everything_ipc_available() -> bool {
    #[cfg(windows)]
    {
        use windows::core::w;
        use windows::Win32::UI::WindowsAndMessaging::FindWindowW;
        let hwnd = unsafe { FindWindowW(w!("EVERYTHING_IPC_WNDCLASS"), windows::core::PCWSTR::null()) };
        hwnd.is_ok() && !hwnd.unwrap().0.is_null()
    }
    #[cfg(not(windows))]
    false
}

// ==========================================
// 4. SQLite FTS5 PDF Search Integration
// ==========================================

fn query_sqlite_pdf_fts(query: &str) -> Vec<OmniResult> {
    let mut results = Vec::new();
    let home_dir = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok();
    let Some(home) = home_dir else { return results };
    let home_path = PathBuf::from(home);

    let candidates = [
        home_path.join("Documents").join("Facultad").join("pdf-index.db"),
        home_path.join("AppData").join("Roaming").join("pdf-indice-local").join("index.db"),
        home_path.join("AppData").join("Local").join("pdf-indice-local").join("index.db"),
        home_path.join("Documents").join("pdf-index.db"),
    ];

    let db_path = candidates.into_iter().find(|p| p.exists());
    let Some(db) = db_path else { return results };

    // Execute sqlite3 CLI if available
    let sql = format!(
        "SELECT path, page, content FROM pdf_fts WHERE pdf_fts MATCH '{}' LIMIT 10;",
        query.replace('\'', "''")
    );

    let mut cmd = std::process::Command::new("sqlite3");
    cmd.arg(&db).arg(&sql);
    #[cfg(windows)]
    crate::convert::hide_console(&mut cmd);

    if let Ok(output) = cmd.output() {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            for (idx, line) in text.lines().enumerate() {
                let parts: Vec<&str> = line.split('|').collect();
                if !parts.is_empty() {
                    let path = parts[0].trim();
                    let page = if parts.len() > 1 { parts[1].trim() } else { "1" };
                    let snippet = if parts.len() > 2 { parts[2].trim() } else { "" };
                    let file_name = Path::new(path).file_name().and_then(|s| s.to_str()).unwrap_or(path);

                    results.push(OmniResult {
                        id: format!("pdf_fts_{}_{}", idx, path),
                        title: format!("{} (Pág. {})", file_name, page),
                        subtitle: if snippet.is_empty() { path.to_string() } else { snippet.to_string() },
                        category: "pdf".to_string(),
                        icon: "pdf".to_string(),
                        target: path.to_string(),
                        score: 950 - (idx as u32 * 10),
                        action_data: Some(page.to_string()),
                    });
                }
            }
        }
    }

    results
}

// ==========================================
// 5. Query & Ranking Engine
// ==========================================

#[tauri::command]
pub async fn omnisearch_query(query: String, prefix: Option<String>) -> Result<Vec<OmniResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed = query.trim();
        let mut results = Vec::new();

        // Detect explicit or implicit prefix
        let (eff_prefix, search_text) = if let Some(p) = prefix {
            (p, trimmed.to_string())
        } else if trimmed.starts_with("t ") || trimmed.starts_with("t:") {
            ("t".to_string(), trimmed[2..].trim().to_string())
        } else if trimmed.starts_with("c ") || trimmed.starts_with("c:") {
            ("c".to_string(), trimmed[2..].trim().to_string())
        } else if trimmed.starts_with("p ") || trimmed.starts_with("p:") {
            ("p".to_string(), trimmed[2..].trim().to_string())
        } else {
            ("".to_string(), trimmed.to_string())
        };

        // Mode: Quick Google Tasks (`t `)
        if eff_prefix == "t" {
            let task_text = if search_text.is_empty() { "Nueva tarea en Google Tasks" } else { &search_text };
            results.push(OmniResult {
                id: "action_task".to_string(),
                title: format!("Crear Tarea: \"{}\"", task_text),
                subtitle: "Presiona Enter para crear en To-Dos / Google Tasks".to_string(),
                category: "action".to_string(),
                icon: "task".to_string(),
                target: format!("action:task:{}", task_text),
                score: 1000,
                action_data: Some(task_text.to_string()),
            });
            return Ok(results);
        }

        // Mode: Quick Google Calendar (`c `)
        if eff_prefix == "c" {
            let event_text = if search_text.is_empty() { "Nuevo evento de Calendario" } else { &search_text };
            results.push(OmniResult {
                id: "action_calendar".to_string(),
                title: format!("Agendar Evento: \"{}\"", event_text),
                subtitle: "Presiona Enter para agendar en Google Calendar".to_string(),
                category: "action".to_string(),
                icon: "calendar".to_string(),
                target: format!("action:calendar:{}", event_text),
                score: 1000,
                action_data: Some(event_text.to_string()),
            });
            return Ok(results);
        }

        // Mode: PDF search (`p `)
        if eff_prefix == "p" {
            if search_text.is_empty() {
                return Ok(results);
            }

            // 1. Check SQLite FTS5 index
            let fts_results = query_sqlite_pdf_fts(&search_text);
            if !fts_results.is_empty() {
                results.extend(fts_results);
            }

            // 2. Also fuzzy-match indexed PDF files in Facultad and Vault
            let index = get_index();
            if let Ok(lock) = index.read() {
                let mut matcher = Matcher::new(Config::DEFAULT);
                let mut p_buf = Vec::new();
                let needle = Utf32Str::new(&search_text, &mut p_buf);

                for file in lock.files.iter().filter(|f| f.is_pdf) {
                    let mut h_buf = Vec::new();
                    let haystack = Utf32Str::new(&file.name, &mut h_buf);
                    if let Some(score) = matcher.fuzzy_match(haystack, needle) {
                        results.push(OmniResult {
                            id: format!("pdf_{}", file.path),
                            title: file.name.clone(),
                            subtitle: format!("PDF en {} • {}", file.category, file.path),
                            category: "pdf".to_string(),
                            icon: "pdf".to_string(),
                            target: file.path.clone(),
                            score: score as u32 + 300,
                            action_data: None,
                        });
                    }
                }
            }

            results.sort_by(|a, b| b.score.cmp(&a.score));
            results.truncate(30);
            return Ok(results);
        }

        // Mode: Universal Search (No prefix)
        if search_text.is_empty() {
            return Ok(results);
        }

        // 1. Live Math & Engineering Evaluation
        if let Some(math) = try_evaluate_math(&search_text) {
            results.push(OmniResult {
                id: "calc_result".to_string(),
                title: math.display,
                subtitle: math.subtitle,
                category: "calc".to_string(),
                icon: "calc".to_string(),
                target: format!("calc:{}", math.raw_val),
                score: 2000, // Top priority
                action_data: Some(math.raw_val),
            });
        }

        let index = get_index();
        let lock = index.read().unwrap();
        let mut matcher = Matcher::new(Config::DEFAULT);
        let mut p_buf = Vec::new();
        let needle = Utf32Str::new(&search_text, &mut p_buf);

        // 2. Apps Matching (with nucleo-matcher fuzzy scoring)
        for app in &lock.apps {
            let mut h_buf = Vec::new();
            let haystack = Utf32Str::new(&app.name, &mut h_buf);
            if let Some(score) = matcher.fuzzy_match(haystack, needle) {
                // Apps receive a significant score bonus
                results.push(OmniResult {
                    id: format!("app_{}", app.id),
                    title: app.name.clone(),
                    subtitle: "Aplicación instalada".to_string(),
                    category: "app".to_string(),
                    icon: app.icon.clone(),
                    target: app.path.clone(),
                    score: (score as u32) + 800,
                    action_data: None,
                });
            }
        }

        // 3. Priority Files Matching
        for file in &lock.files {
            let mut h_buf = Vec::new();
            let haystack = Utf32Str::new(&file.name, &mut h_buf);
            if let Some(score) = matcher.fuzzy_match(haystack, needle) {
                let category = if file.is_pdf {
                    "pdf"
                } else {
                    "file"
                };
                let icon = if file.is_pdf {
                    "pdf"
                } else if file.is_dir {
                    "folder"
                } else {
                    "file"
                };

                // Facultad / Vault files get priority bonus
                let bonus = match file.category {
                    "facultad" => 400,
                    "vault" => 350,
                    "project" => 300,
                    _ => 150,
                };

                results.push(OmniResult {
                    id: format!("file_{}", file.path),
                    title: file.name.clone(),
                    subtitle: format!("{} • {}", file.category.to_uppercase(), file.path),
                    category: category.to_string(),
                    icon: icon.to_string(),
                    target: file.path.clone(),
                    score: (score as u32) + bonus,
                    action_data: None,
                });
            }
        }

        // 4. Everything query if results are few or Everything is available
        if results.len() < 10 {
            let everything_matches = query_everything_cli(&search_text);
            for ev in everything_matches {
                if !results.iter().any(|r| r.target.eq_ignore_ascii_case(&ev.path)) {
                    let cat = if ev.is_pdf { "pdf" } else { "file" };
                    results.push(OmniResult {
                        id: format!("ev_{}", ev.path),
                        title: ev.name,
                        subtitle: ev.path.clone(),
                        category: cat.to_string(),
                        icon: cat.to_string(),
                        target: ev.path,
                        score: 400,
                        action_data: None,
                    });
                }
            }
        }

        // Sort results by score descending
        results.sort_by(|a, b| b.score.cmp(&a.score));
        results.truncate(30);

        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn omnisearch_open(target: String, action: String, app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let action = action.as_str();

        // 1. Reveal in File Explorer
        if action == "reveal" {
            let clean_target = if target.starts_with("calc:") {
                return Err("Cannot reveal calculation".into());
            } else {
                target
            };
            return crate::convert::reveal_file(clean_target);
        }

        // 2. Add to Shelf
        if action == "shelf" {
            let _ = app.emit("notch://omni-shelf", target);
            return Ok(());
        }

        // 3. Default "open"
        if let Some(calc_val) = target.strip_prefix("calc:") {
            // Copy calculation result to clipboard
            let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            clipboard.set_text(calc_val).map_err(|e| e.to_string())?;
            return Ok(());
        }

        if target.starts_with("http://") || target.starts_with("https://") {
            return crate::open_url(&target);
        }

        if target.starts_with("action:task:") {
            let task_text = &target["action:task:".len()..];
            let _ = app.emit("notch://omni-task", task_text);
            return Ok(());
        }

        if target.starts_with("action:calendar:") {
            let event_text = &target["action:calendar:".len()..];
            let url = format!(
                "https://calendar.google.com/calendar/render?action=TEMPLATE&text={}",
                urlencoding_encode(event_text)
            );
            return crate::open_url(&url);
        }

        // Normal file / application launch
        #[cfg(windows)]
        {
            use windows::core::{HSTRING, PCWSTR};
            use windows::Win32::UI::Shell::ShellExecuteW;
            use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

            let ok = unsafe {
                ShellExecuteW(
                    None,
                    windows::core::w!("open"),
                    &HSTRING::from(&target),
                    PCWSTR::null(),
                    PCWSTR::null(),
                    SW_SHOWNORMAL,
                )
            }
            .0 as isize
                > 32;

            if ok {
                Ok(())
            } else {
                crate::open_url(&target)
            }
        }
        #[cfg(not(windows))]
        {
            crate::open_url(&target)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn omnisearch_index_status() -> String {
    let index = get_index();
    let lock = index.read().unwrap();
    let ev_status = if everything_ipc_available() { "active" } else { "standby" };
    format!(
        "Apps: {} | Files: {} (Facultad, Vault, Docs) | Everything: {}",
        lock.apps.len(),
        lock.files.len(),
        ev_status
    )
}

fn urlencoding_encode(s: &str) -> String {
    let mut encoded = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{:02X}", b));
        }
    }
    encoded
}
