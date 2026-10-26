//! Ver archivos en la pestaña App: PDF, imágenes, vídeo y audio se mandan tal cual (la vista los
//! pinta con el visor del navegador); Word, Excel y PowerPoint se pasan a HTML aquí, sin programas
//! externos (un .docx/.xlsx/.pptx es un zip de XML). Lo que no se puede ver, se abre con su programa.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

/// Tope de lo que se manda entero a la vista (un PDF o un vídeo).
const BLOB_CAP: u64 = 80 * 1024 * 1024;
/// Tope de un documento de Office y de cada parte que se descomprime.
const OFFICE_CAP: u64 = 60 * 1024 * 1024;
const PART_CAP: usize = 40 * 1024 * 1024;

/// Ruta del archivo: absoluta (elegida por ti con el diálogo) o relativa a la carpeta del proyecto.
fn resolve(project: Option<&str>, rel: &str) -> Result<PathBuf, String> {
    let raw = PathBuf::from(rel.trim());
    let file = if raw.is_absolute() {
        raw
    } else {
        let root = PathBuf::from(project.unwrap_or("").trim());
        if !root.is_dir() {
            return Err("la carpeta del proyecto no existe".into());
        }
        let mut out = root.clone();
        for comp in raw.components() {
            match comp {
                Component::Normal(c) => out.push(c),
                Component::CurDir => {}
                _ => return Err("ruta fuera del proyecto".into()),
            }
        }
        out
    };
    let meta = std::fs::metadata(&file).map_err(|_| "el archivo no existe".to_string())?;
    if !meta.is_file() {
        return Err("no es un archivo".into());
    }
    Ok(file)
}

fn ext_of(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

pub fn mime_of(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        _ => return None,
    })
}

#[derive(Serialize)]
pub struct Blob {
    mime: String,
    /// El contenido en base64.
    data: String,
    size: u64,
    mtime_ms: u64,
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Un PDF, imagen, vídeo o audio entero, para pintarlo en la vista.
#[tauri::command]
pub async fn file_blob(project: Option<String>, rel: String) -> Result<Blob, String> {
    use base64::Engine;
    let file = resolve(project.as_deref(), &rel)?;
    let mime = mime_of(&ext_of(&file)).ok_or("este tipo de archivo no tiene vista previa")?;
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    if meta.len() > BLOB_CAP {
        return Err(format!("pesa {} MB: ábrelo con su programa", meta.len() / 1_048_576));
    }
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    Ok(Blob {
        mime: mime.into(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
        size: meta.len(),
        mtime_ms: mtime_ms(&meta),
    })
}

/// Tope de un archivo de texto (código, notas, csv…).
const TEXT_CAP: usize = 2 * 1024 * 1024;

#[derive(Serialize)]
pub struct Text {
    text: String,
    truncated: bool,
    binary: bool,
    size: u64,
    mtime_ms: u64,
}

/// Un archivo de texto, del proyecto o elegido con el diálogo.
#[tauri::command]
pub async fn file_text(project: Option<String>, rel: String) -> Result<Text, String> {
    let file = resolve(project.as_deref(), &rel)?;
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    std::fs::File::open(&file)
        .and_then(|f| f.take(TEXT_CAP as u64 + 1).read_to_end(&mut raw))
        .map_err(|e| e.to_string())?;
    let truncated = raw.len() > TEXT_CAP;
    raw.truncate(TEXT_CAP);
    let binary = raw.iter().take(8192).any(|b| *b == 0);
    Ok(Text {
        text: if binary { String::new() } else { String::from_utf8_lossy(&raw).into_owned() },
        truncated,
        binary,
        size: meta.len(),
        mtime_ms: mtime_ms(&meta),
    })
}

/// Abre el archivo con el programa que tenga Windows para él (Word, Excel, el visor de PDF…).
#[tauri::command]
pub async fn file_open_external(project: Option<String>, rel: String) -> Result<(), String> {
    let file = resolve(project.as_deref(), &rel)?;
    tauri_plugin_opener::open_path(&file, None::<&str>).map_err(|e| e.to_string())
}

/// Muestra el archivo seleccionado en el Explorador.
#[tauri::command]
pub async fn file_reveal(project: Option<String>, rel: String) -> Result<(), String> {
    let file = resolve(project.as_deref(), &rel)?;
    tauri_plugin_opener::reveal_item_in_dir(&file).map_err(|e| e.to_string())
}

/// Guarda un texto exportado (un chat) donde lo elegiste en el diálogo de guardar.
#[tauri::command]
pub async fn export_save(path: String, text: String) -> Result<(), String> {
    let p = PathBuf::from(path.trim());
    if !p.is_absolute() || !matches!(ext_of(&p).as_str(), "md" | "html" | "htm" | "txt" | "json") {
        return Err("Solo se puede guardar como .md, .html, .txt o .json.".into());
    }
    std::fs::write(&p, text).map_err(|e| format!("No se pudo guardar: {e}"))
}

/// Un documento de Office (docx, xlsx, pptx) como una página HTML para leerlo.
#[tauri::command]
pub async fn file_office(project: Option<String>, rel: String) -> Result<String, String> {
    let file = resolve(project.as_deref(), &rel)?;
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    if meta.len() > OFFICE_CAP {
        return Err(format!("pesa {} MB: ábrelo con su programa", meta.len() / 1_048_576));
    }
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    office_html(&ext_of(&file), &bytes)
}

pub fn office_html(ext: &str, bytes: &[u8]) -> Result<String, String> {
    let zip = Zip::open(bytes).ok_or("el archivo está dañado o no es un documento de Office moderno")?;
    let body = match ext {
        "docx" | "docm" | "dotx" => docx(&zip)?,
        "xlsx" | "xlsm" => xlsx(&zip)?,
        "pptx" | "pptm" => pptx(&zip)?,
        _ => return Err("solo se pueden ver .docx, .xlsx y .pptx; ábrelo con su programa".into()),
    };
    Ok(format!("<!doctype html><html><head><meta charset=\"utf-8\"><style>{CSS}</style></head><body>{body}</body></html>"))
}

const CSS: &str = "\
:root{color-scheme:light}\
body{margin:0;padding:32px max(24px,calc(50% - 400px));font:15px/1.6 'Segoe UI',system-ui,sans-serif;color:#1f2328;background:#fff}\
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.4em 0 .5em;color:#111}\
h1{font-size:1.9em}h2{font-size:1.5em}h3{font-size:1.25em}\
p{margin:.45em 0}\
ul{margin:.3em 0;padding-left:1.6em}\
table{border-collapse:collapse;margin:.8em 0;font-size:13.5px}\
td,th{border:1px solid #d0d7de;padding:4px 8px;vertical-align:top;text-align:left}\
th{background:#f3f4f6;font-weight:600}\
img{max-width:100%;height:auto}\
.sheet{overflow:auto;max-width:100%}\
.sheet td.n{text-align:right;font-variant-numeric:tabular-nums}\
.sheet th.rh{color:#6b7280;font-weight:400;text-align:right}\
.slide{border:1px solid #d0d7de;border-radius:10px;padding:18px 22px;margin:0 0 18px;box-shadow:0 1px 3px rgb(0 0 0/.06)}\
.slide>small{color:#6b7280;font-size:12px}\
.note{color:#6b7280;font-size:13px}";

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '&' => o.push_str("&amp;"),
            '"' => o.push_str("&quot;"),
            c => o.push(c),
        }
    }
    o
}

// ---------------------------------------------------------------------------
// Zip mínimo: lo justo para leer un documento de Office (sin zip64 ni cifrado).
// ---------------------------------------------------------------------------

struct Zip<'a> {
    data: &'a [u8],
    /// (nombre, método, tamaño comprimido, desplazamiento de la cabecera local)
    entries: Vec<(String, u16, usize, usize)>,
}

fn u16_at(b: &[u8], i: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(i..i + 2)?.try_into().ok()?))
}
fn u32_at(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(i..i + 4)?.try_into().ok()?))
}

impl<'a> Zip<'a> {
    fn open(data: &'a [u8]) -> Option<Self> {
        // El final del directorio central está en los últimos 64 KB (más su comentario).
        let lo = data.len().saturating_sub(65_557);
        let eocd = (lo..data.len().saturating_sub(21)).rev().find(|&i| u32_at(data, i) == Some(0x0605_4b50))?;
        let count = u16_at(data, eocd + 10)? as usize;
        let mut at = u32_at(data, eocd + 16)? as usize;
        let mut entries = Vec::with_capacity(count);
        for _ in 0..count {
            if u32_at(data, at)? != 0x0201_4b50 {
                return None;
            }
            let method = u16_at(data, at + 10)?;
            let csize = u32_at(data, at + 20)? as usize;
            let nlen = u16_at(data, at + 28)? as usize;
            let elen = u16_at(data, at + 30)? as usize;
            let clen = u16_at(data, at + 32)? as usize;
            let local = u32_at(data, at + 42)? as usize;
            let name = String::from_utf8_lossy(data.get(at + 46..at + 46 + nlen)?).replace('\\', "/");
            entries.push((name, method, csize, local));
            at += 46 + nlen + elen + clen;
        }
        Some(Zip { data, entries })
    }

    fn names(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|e| e.0.as_str())
    }

    fn bytes(&self, name: &str) -> Option<Vec<u8>> {
        let (_, method, csize, local) = self.entries.iter().find(|e| e.0.eq_ignore_ascii_case(name))?;
        let d = self.data;
        if u32_at(d, *local)? != 0x0403_4b50 {
            return None;
        }
        let start = local + 30 + u16_at(d, local + 26)? as usize + u16_at(d, local + 28)? as usize;
        let raw = d.get(start..start + csize)?;
        match method {
            0 => Some(raw.to_vec()),
            8 => {
                let mut out = Vec::new();
                flate2::read::DeflateDecoder::new(raw).take(PART_CAP as u64).read_to_end(&mut out).ok()?;
                Some(out)
            }
            _ => None,
        }
    }

    fn text(&self, name: &str) -> Option<String> {
        self.bytes(name).map(|b| String::from_utf8_lossy(&b).into_owned())
    }
}

// ---------------------------------------------------------------------------
// XML mínimo: etiquetas con atributos y texto. Los XML de Office están bien formados.
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum Tok<'a> {
    /// (nombre, atributos, se cierra sola)
    Open(&'a str, Vec<(&'a str, String)>, bool),
    Close(&'a str),
    Text(String),
}

fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(end) = rest.find(';').filter(|&e| e <= 10) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let ent = &rest[1..end];
        let ch = match ent {
            "lt" => Some('<'),
            "gt" => Some('>'),
            "amp" => Some('&'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => ent
                .strip_prefix("#x")
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| ent.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn tokens(xml: &str) -> Vec<Tok<'_>> {
    let mut out = Vec::new();
    let mut rest = xml;
    while !rest.is_empty() {
        let Some(lt) = rest.find('<') else {
            out.push(Tok::Text(unescape(rest)));
            break;
        };
        if lt > 0 {
            out.push(Tok::Text(unescape(&rest[..lt])));
        }
        rest = &rest[lt..];
        if let Some(r) = rest.strip_prefix("<![CDATA[") {
            let end = r.find("]]>").unwrap_or(r.len());
            out.push(Tok::Text(r[..end].to_string()));
            rest = r.get(end + 3..).unwrap_or("");
            continue;
        }
        if rest.starts_with("<!--") {
            rest = rest.find("-->").map(|e| &rest[e + 3..]).unwrap_or("");
            continue;
        }
        let Some(gt) = rest.find('>') else { break };
        let inner = &rest[1..gt];
        rest = &rest[gt + 1..];
        if inner.starts_with('?') || inner.starts_with('!') {
            continue;
        }
        if let Some(name) = inner.strip_prefix('/') {
            out.push(Tok::Close(name.trim()));
            continue;
        }
        let selfclose = inner.ends_with('/');
        let inner = inner.trim_end_matches('/');
        let (name, mut attrs_s) = inner.split_once(char::is_whitespace).unwrap_or((inner, ""));
        let mut attrs = Vec::new();
        while let Some(eq) = attrs_s.find('=') {
            let key = attrs_s[..eq].trim();
            let after = attrs_s[eq + 1..].trim_start();
            let Some(q) = after.chars().next().filter(|c| *c == '"' || *c == '\'') else { break };
            let Some(close) = after[1..].find(q) else { break };
            attrs.push((key, unescape(&after[1..1 + close])));
            attrs_s = &after[close + 2..];
        }
        out.push(Tok::Open(name, attrs, selfclose));
    }
    out
}

fn attr<'a>(attrs: &'a [(&str, String)], key: &str) -> Option<&'a str> {
    attrs.iter().find(|(k, _)| *k == key).map(|(_, v)| v.as_str())
}

/// Las relaciones de una parte («rId3» → «media/image1.png»), relativas a su carpeta.
fn rels(zip: &Zip, path: &str) -> Vec<(String, String)> {
    let Some(xml) = zip.text(path) else { return vec![] };
    tokens(&xml)
        .into_iter()
        .filter_map(|t| match t {
            Tok::Open("Relationship", a, _) => Some((attr(&a, "Id")?.to_string(), attr(&a, "Target")?.to_string())),
            _ => None,
        })
        .collect()
}

/// «media/image1.png» junto a «word/document.xml» → «word/media/image1.png» (con «../» resueltos).
fn join_part(base_dir: &str, target: &str) -> String {
    if let Some(abs) = target.strip_prefix('/') {
        return abs.to_string();
    }
    let mut parts: Vec<&str> = base_dir.split('/').filter(|p| !p.is_empty()).collect();
    for seg in target.split('/') {
        match seg {
            ".." => {
                parts.pop();
            }
            "." | "" => {}
            s => parts.push(s),
        }
    }
    parts.join("/")
}

fn img_tag(zip: &Zip, part: &str) -> String {
    use base64::Engine;
    let ext = part.rsplit('.').next().unwrap_or("").to_lowercase();
    let (Some(mime), Some(bytes)) = (mime_of(&ext).filter(|m| m.starts_with("image/")), zip.bytes(part)) else {
        return String::new();
    };
    format!("<img src=\"data:{mime};base64,{}\" alt=\"\">", base64::engine::general_purpose::STANDARD.encode(bytes))
}

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

/// Nivel de título de un estilo («Heading2», «Ttulo2» en español, «Title»), o 0.
fn heading_level(style: &str) -> u8 {
    let s = style.to_lowercase();
    if s == "title" || s == "ttulo" || s == "titre" || s == "titel" {
        return 1;
    }
    for p in ["heading", "ttulo", "titre", "berschrift", "kop"] {
        if let Some(n) = s.strip_prefix(p)
            && let Ok(n) = n.trim().parse::<u8>() {
                return n.clamp(1, 6);
            }
    }
    0
}

fn docx(zip: &Zip) -> Result<String, String> {
    let xml = zip.text("word/document.xml").ok_or("no encuentro el texto del documento")?;
    let rel = rels(zip, "word/_rels/document.xml.rels");
    let mut out = String::new();
    let mut para = String::new();
    let (mut style, mut list) = (String::new(), false);
    let (mut bold, mut ital, mut under) = (false, false, false);
    let (mut in_rpr, mut in_t, mut in_run) = (false, false, false);
    let mut in_list_ul = false;
    let flag_on = |a: &[(&str, String)]| !matches!(attr(a, "w:val"), Some("0" | "false" | "none"));

    for t in tokens(&xml) {
        match t {
            Tok::Open("w:p", _, self_close) => {
                para.clear();
                style.clear();
                list = false;
                if self_close {
                    continue;
                }
            }
            Tok::Open("w:pStyle", a, _) => style = attr(&a, "w:val").unwrap_or("").to_string(),
            Tok::Open("w:numPr", _, _) => list = true,
            Tok::Open("w:r", _, false) => (bold, ital, under, in_run) = (false, false, false, true),
            Tok::Close("w:r") => in_run = false,
            Tok::Open("w:rPr", _, false) => in_rpr = true,
            Tok::Close("w:rPr") => in_rpr = false,
            Tok::Open("w:b", a, _) if in_rpr => bold = flag_on(&a),
            Tok::Open("w:i", a, _) if in_rpr => ital = flag_on(&a),
            Tok::Open("w:u", a, _) if in_rpr => under = flag_on(&a),
            Tok::Open("w:t", _, false) => in_t = true,
            Tok::Close("w:t") => in_t = false,
            Tok::Text(s) if in_t => {
                let mut s = esc(&s);
                if under {
                    s = format!("<u>{s}</u>");
                }
                if ital {
                    s = format!("<em>{s}</em>");
                }
                if bold {
                    s = format!("<strong>{s}</strong>");
                }
                para.push_str(&s);
            }
            Tok::Open("w:tab", _, _) if in_run && !in_rpr => para.push_str("&emsp;"),
            Tok::Open("w:br", _, _) if in_run => para.push_str("<br>"),
            Tok::Open("a:blip", a, _) => {
                if let Some(target) = attr(&a, "r:embed").and_then(|id| rel.iter().find(|(i, _)| i == id)).map(|(_, t)| t) {
                    para.push_str(&img_tag(zip, &join_part("word", target)));
                }
            }
            Tok::Open("w:tbl", _, _) => {
                if in_list_ul {
                    out.push_str("</ul>");
                    in_list_ul = false;
                }
                out.push_str("<table>");
            }
            Tok::Close("w:tbl") => out.push_str("</table>"),
            Tok::Open("w:tr", _, _) => out.push_str("<tr>"),
            Tok::Close("w:tr") => out.push_str("</tr>"),
            Tok::Open("w:tc", _, _) => out.push_str("<td>"),
            Tok::Close("w:tc") => {
                if in_list_ul {
                    out.push_str("</ul>");
                    in_list_ul = false;
                }
                out.push_str("</td>");
            }
            Tok::Close("w:p") => {
                let level = heading_level(&style);
                if list && level == 0 {
                    if !in_list_ul {
                        out.push_str("<ul>");
                        in_list_ul = true;
                    }
                    out.push_str(&format!("<li>{para}</li>"));
                    continue;
                }
                if in_list_ul {
                    out.push_str("</ul>");
                    in_list_ul = false;
                }
                if para.trim().is_empty() {
                    continue;
                }
                if level > 0 {
                    out.push_str(&format!("<h{level}>{para}</h{level}>"));
                } else {
                    out.push_str(&format!("<p>{para}</p>"));
                }
            }
            _ => {}
        }
    }
    if in_list_ul {
        out.push_str("</ul>");
    }
    if out.is_empty() {
        out.push_str("<p class=\"note\">El documento no tiene texto.</p>");
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

const MAX_ROWS: usize = 2000;
const MAX_COLS: usize = 60;

/// «BC12» → columna 54 (desde 0).
fn col_index(cell_ref: &str) -> usize {
    let mut n = 0usize;
    for c in cell_ref.chars().take_while(|c| c.is_ascii_alphabetic()) {
        n = n * 26 + (c.to_ascii_uppercase() as usize - 'A' as usize + 1);
    }
    n.saturating_sub(1)
}

fn col_name(mut i: usize) -> String {
    let mut s = Vec::new();
    loop {
        s.push((b'A' + (i % 26) as u8) as char);
        if i < 26 {
            break;
        }
        i = i / 26 - 1;
    }
    s.iter().rev().collect()
}

type SheetRow = (usize, Vec<(usize, String, bool)>);

fn xlsx(zip: &Zip) -> Result<String, String> {
    // Los textos repetidos van aparte, en sharedStrings.
    let mut shared: Vec<String> = Vec::new();
    if let Some(xml) = zip.text("xl/sharedStrings.xml") {
        let (mut cur, mut in_si, mut in_t, mut in_rph) = (String::new(), false, false, false);
        for t in tokens(&xml) {
            match t {
                Tok::Open("si", _, _) => (cur, in_si) = (String::new(), true),
                Tok::Close("si") => {
                    shared.push(std::mem::take(&mut cur));
                    in_si = false;
                }
                Tok::Open("rPh", _, false) => in_rph = true,
                Tok::Close("rPh") => in_rph = false,
                Tok::Open("t", _, false) => in_t = true,
                Tok::Close("t") => in_t = false,
                Tok::Text(s) if in_si && in_t && !in_rph => cur.push_str(&s),
                _ => {}
            }
        }
    }
    // Las hojas en el orden del libro, con su nombre.
    let wb_rels = rels(zip, "xl/_rels/workbook.xml.rels");
    let mut sheets: Vec<(String, String)> = Vec::new();
    if let Some(xml) = zip.text("xl/workbook.xml") {
        for t in tokens(&xml) {
            if let Tok::Open("sheet", a, _) = t {
                let name = attr(&a, "name").unwrap_or("Hoja").to_string();
                if let Some((_, target)) = attr(&a, "r:id").and_then(|id| wb_rels.iter().find(|(i, _)| i == id)) {
                    sheets.push((name, join_part("xl", target)));
                }
            }
        }
    }
    if sheets.is_empty() {
        let mut names: Vec<String> = zip.names().filter(|n| n.starts_with("xl/worksheets/sheet") && n.ends_with(".xml")).map(String::from).collect();
        names.sort();
        sheets = names.into_iter().enumerate().map(|(i, n)| (format!("Hoja {}", i + 1), n)).collect();
    }
    let mut out = String::new();
    for (name, part) in sheets {
        let Some(xml) = zip.text(&part) else { continue };
        let mut rows: Vec<SheetRow> = Vec::new();
        let (mut cell_t, mut cell_col, mut val, mut in_v, mut in_is_t) = (String::new(), 0usize, String::new(), false, false);
        let mut cut = false;
        for t in tokens(&xml) {
            match t {
                Tok::Open("row", a, _) => {
                    if rows.len() >= MAX_ROWS {
                        cut = true;
                        break;
                    }
                    let r = attr(&a, "r").and_then(|r| r.parse::<usize>().ok()).unwrap_or(rows.len() + 1);
                    rows.push((r, Vec::new()));
                }
                Tok::Open("c", a, self_close) => {
                    cell_t = attr(&a, "t").unwrap_or("").to_string();
                    cell_col = attr(&a, "r").map(col_index).unwrap_or(0);
                    val.clear();
                    if self_close {
                        continue;
                    }
                }
                Tok::Open("v", _, false) => in_v = true,
                Tok::Close("v") => in_v = false,
                Tok::Open("t", _, false) => in_is_t = true,
                Tok::Close("t") => in_is_t = false,
                Tok::Text(s) if in_v || in_is_t => val.push_str(&s),
                Tok::Close("c") => {
                    if cell_col >= MAX_COLS {
                        continue;
                    }
                    let (text, num) = match cell_t.as_str() {
                        "s" => (val.trim().parse::<usize>().ok().and_then(|i| shared.get(i).cloned()).unwrap_or_default(), false),
                        "b" => ((if val.trim() == "1" { "VERDADERO" } else { "FALSO" }).to_string(), false),
                        "inlineStr" | "str" | "e" => (val.clone(), false),
                        _ => (val.clone(), !val.is_empty()),
                    };
                    if let Some(row) = rows.last_mut() {
                        row.1.push((cell_col, text, num));
                    }
                }
                _ => {}
            }
        }
        rows.retain(|r| r.1.iter().any(|c| !c.1.trim().is_empty()));
        let cols = rows.iter().flat_map(|r| r.1.iter().map(|c| c.0 + 1)).max().unwrap_or(0);
        out.push_str(&format!("<h2>{}</h2>", esc(&name)));
        if rows.is_empty() {
            out.push_str("<p class=\"note\">Hoja vacía.</p>");
            continue;
        }
        out.push_str("<div class=\"sheet\"><table><tr><th></th>");
        for c in 0..cols {
            out.push_str(&format!("<th>{}</th>", col_name(c)));
        }
        out.push_str("</tr>");
        for (r, cells) in &rows {
            out.push_str(&format!("<tr><th class=\"rh\">{r}</th>"));
            let mut line = vec![(String::new(), false); cols];
            for (c, text, num) in cells {
                if let Some(slot) = line.get_mut(*c) {
                    *slot = (text.clone(), *num);
                }
            }
            for (text, num) in line {
                out.push_str(&format!("<td{}>{}</td>", if num { " class=\"n\"" } else { "" }, esc(&text)));
            }
            out.push_str("</tr>");
        }
        out.push_str("</table></div>");
        if cut {
            out.push_str(&format!("<p class=\"note\">Solo se muestran las primeras {MAX_ROWS} filas.</p>"));
        }
    }
    if out.is_empty() {
        out.push_str("<p class=\"note\">El libro no tiene hojas.</p>");
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// PowerPoint
// ---------------------------------------------------------------------------

fn pptx(zip: &Zip) -> Result<String, String> {
    // Las diapositivas en el orden de la presentación (o por su número si falta).
    let p_rels = rels(zip, "ppt/_rels/presentation.xml.rels");
    let mut slides: Vec<String> = Vec::new();
    if let Some(xml) = zip.text("ppt/presentation.xml") {
        for t in tokens(&xml) {
            if let Tok::Open("p:sldId", a, _) = t
                && let Some((_, target)) = attr(&a, "r:id").and_then(|id| p_rels.iter().find(|(i, _)| i == id)) {
                    slides.push(join_part("ppt", target));
                }
        }
    }
    if slides.is_empty() {
        let num = |n: &str| n.trim_start_matches("ppt/slides/slide").trim_end_matches(".xml").parse::<u32>().unwrap_or(0);
        let mut names: Vec<String> = zip.names().filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml")).map(String::from).collect();
        names.sort_by_key(|n| num(n));
        slides = names;
    }
    let mut out = String::new();
    for (i, part) in slides.iter().enumerate() {
        let Some(xml) = zip.text(part) else { continue };
        let dir = part.rsplit_once('/').map(|(d, _)| d).unwrap_or("ppt/slides");
        let file = part.rsplit('/').next().unwrap_or("");
        let s_rels = rels(zip, &format!("{dir}/_rels/{file}.rels"));
        let mut paras: Vec<(bool, String)> = Vec::new();
        let (mut cur, mut in_t, mut title_shape, mut in_sp) = (String::new(), false, false, false);
        let mut imgs = String::new();
        for t in tokens(&xml) {
            match t {
                Tok::Open("p:sp", _, false) => (in_sp, title_shape) = (true, false),
                Tok::Close("p:sp") => in_sp = false,
                Tok::Open("p:ph", a, _) if in_sp => {
                    title_shape = matches!(attr(&a, "type"), Some("title" | "ctrTitle"));
                }
                Tok::Open("a:p", _, false) => cur.clear(),
                Tok::Close("a:p") => {
                    if !cur.trim().is_empty() {
                        paras.push((title_shape, std::mem::take(&mut cur)));
                    }
                }
                Tok::Open("a:t", _, false) => in_t = true,
                Tok::Close("a:t") => in_t = false,
                Tok::Text(s) if in_t => cur.push_str(&esc(&s)),
                Tok::Open("a:br", _, _) => cur.push_str("<br>"),
                Tok::Open("a:blip", a, _) => {
                    if let Some(target) = attr(&a, "r:embed").and_then(|id| s_rels.iter().find(|(i, _)| i == id)).map(|(_, t)| t) {
                        imgs.push_str(&img_tag(zip, &join_part(dir, target)));
                    }
                }
                _ => {}
            }
        }
        out.push_str(&format!("<section class=\"slide\"><small>Diapositiva {}</small>", i + 1));
        for (title, text) in &paras {
            if *title {
                out.push_str(&format!("<h2>{text}</h2>"));
            } else {
                out.push_str(&format!("<p>{text}</p>"));
            }
        }
        out.push_str(&imgs);
        out.push_str("</section>");
    }
    if out.is_empty() {
        out.push_str("<p class=\"note\">La presentación no tiene diapositivas.</p>");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Un zip «a mano» con las partes dadas (deflate), como los que guarda Office.
    fn make_zip(parts: &[(&str, &str)]) -> Vec<u8> {
        let mut data = Vec::new();
        let mut central = Vec::new();
        for (name, body) in parts {
            let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
            enc.write_all(body.as_bytes()).unwrap();
            let comp = enc.finish().unwrap();
            let off = data.len() as u32;
            data.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            data.extend_from_slice(&[20, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            data.extend_from_slice(&(comp.len() as u32).to_le_bytes());
            data.extend_from_slice(&(body.len() as u32).to_le_bytes());
            data.extend_from_slice(&(name.len() as u16).to_le_bytes());
            data.extend_from_slice(&0u16.to_le_bytes());
            data.extend_from_slice(name.as_bytes());
            data.extend_from_slice(&comp);
            central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            central.extend_from_slice(&[20, 0, 20, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            central.extend_from_slice(&(comp.len() as u32).to_le_bytes());
            central.extend_from_slice(&(body.len() as u32).to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&[0; 12]);
            central.extend_from_slice(&off.to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let cd_off = data.len() as u32;
        let cd_len = central.len() as u32;
        data.extend_from_slice(&central);
        data.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        data.extend_from_slice(&[0, 0, 0, 0]);
        data.extend_from_slice(&(parts.len() as u16).to_le_bytes());
        data.extend_from_slice(&(parts.len() as u16).to_le_bytes());
        data.extend_from_slice(&cd_len.to_le_bytes());
        data.extend_from_slice(&cd_off.to_le_bytes());
        data.extend_from_slice(&0u16.to_le_bytes());
        data
    }

    #[test]
    fn word_con_titulos_negritas_listas_y_tablas() {
        let doc = r#"<?xml version="1.0"?><w:document><w:body>
<w:p><w:pPr><w:pStyle w:val="Ttulo1"/></w:pPr><w:r><w:t>Informe &amp; plan</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Hola </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>mundo</w:t></w:r><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t> fin</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>uno</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>dos</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>a1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>&lt;b1&gt;</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p/></w:body></w:document>"#;
        let z = make_zip(&[("word/document.xml", doc)]);
        let html = office_html("docx", &z).unwrap();
        assert!(html.contains("<h1>Informe &amp; plan</h1>"), "{html}");
        assert!(html.contains("<p>Hola <strong>mundo</strong> fin</p>"), "{html}");
        assert!(html.contains("<ul><li>uno</li><li>dos</li></ul>"), "{html}");
        assert!(html.contains("<table><tr><td><p>a1</p></td><td><p>&lt;b1&gt;</p></td></tr></table>"), "{html}");
    }

    #[test]
    fn excel_con_textos_compartidos_y_numeros() {
        let wb = r#"<workbook><sheets><sheet name="Ventas" sheetId="1" r:id="rId1"/></sheets></workbook>"#;
        let rels = r#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"#;
        let ss = r#"<sst><si><t>Mes</t></si><si><r><t>To</t></r><r><t>tal</t></r></si></sst>"#;
        let sh = r#"<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>enero</t></is></c><c r="C2"><v>12.5</v></c></row></sheetData></worksheet>"#;
        let z = make_zip(&[("xl/workbook.xml", wb), ("xl/_rels/workbook.xml.rels", rels), ("xl/sharedStrings.xml", ss), ("xl/worksheets/sheet1.xml", sh)]);
        let html = office_html("xlsx", &z).unwrap();
        assert!(html.contains("<h2>Ventas</h2>"));
        assert!(html.contains("<th>A</th><th>B</th><th>C</th>"), "{html}");
        assert!(html.contains("<td>Mes</td><td></td><td>Total</td>"), "{html}");
        assert!(html.contains("<td>enero</td><td></td><td class=\"n\">12.5</td>"), "{html}");
        assert_eq!(col_index("BC12"), 54);
        assert_eq!(col_name(54), "BC");
        assert_eq!(col_name(0), "A");
    }

    #[test]
    fn powerpoint_por_diapositivas() {
        let s1 = r#"<p:sld><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Portada</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>Texto</a:t></a:r></a:p></p:txBody></p:sp></p:sld>"#;
        let s2 = r#"<p:sld><p:sp><p:txBody><a:p><a:r><a:t>Segunda</a:t></a:r></a:p></p:txBody></p:sp></p:sld>"#;
        let z = make_zip(&[("ppt/slides/slide2.xml", s2), ("ppt/slides/slide1.xml", s1)]);
        let html = office_html("pptx", &z).unwrap();
        let a = html.find("Portada").unwrap();
        let b = html.find("Segunda").unwrap();
        assert!(a < b, "orden por número de diapositiva");
        assert!(html.contains("<h2>Portada</h2>"));
        assert!(html.contains("<p>Texto</p>"));
        assert!(html.contains("Diapositiva 2"));
    }

    #[test]
    fn rutas_y_archivos_raros() {
        assert_eq!(join_part("ppt/slides", "../media/image1.png"), "ppt/media/image1.png");
        assert_eq!(join_part("word", "media/a.png"), "word/media/a.png");
        assert_eq!(unescape("a &lt;b&gt; &#233; &#x41; & c"), "a <b> é A & c");
        assert!(office_html("docx", b"no es un zip").is_err());
        assert!(office_html("doc", &make_zip(&[("x", "y")])).is_err());
        assert_eq!(heading_level("Heading3"), 3);
        assert_eq!(heading_level("Normal"), 0);
        assert!(resolve(None, "../x").is_err());
    }
}

/// Prueba a mano con un documento real: `LIENZO_OFFICE_SAMPLE=<ruta> cargo test muestra -- --ignored`.
#[cfg(test)]
mod sample {
    #[test]
    #[ignore]
    fn muestra() {
        let p = std::env::var("LIENZO_OFFICE_SAMPLE").expect("ruta");
        let ext = p.rsplit('.').next().unwrap().to_lowercase();
        let html = super::office_html(&ext, &std::fs::read(&p).unwrap()).unwrap();
        let count = |t: &str| html.matches(t).count();
        println!("bytes={} h1={} h2={} h3={} p={} li={} table={} img={}", html.len(), count("<h1>"), count("<h2>"), count("<h3>"), count("<p>"), count("<li>"), count("<table>"), count("<img "));
        std::fs::write(std::env::temp_dir().join("lienzo-muestra.html"), html).unwrap();
    }
}
