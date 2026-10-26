//! Los chats de cada proyecto, en disco (`%APPDATA%\lienzo\chats\<carpeta>.json`). Antes vivían
//! solo en el almacenamiento del navegador interno, que se pierde al limpiar sus datos y tenía
//! tope; la interfaz lo sigue usando como copia rápida, pero lo que vale es esto.
//! El contenido es la lista tal cual la guarda la interfaz: aquí no se interpreta.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value};

use crate::hub::{data_dir, project_key};

static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn project_lock(path: &std::path::Path) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap();
    guard
        .entry(path.to_path_buf())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn file_for(dir: &std::path::Path, project: &str) -> PathBuf {
    // FNV-1a de la clave de la carpeta: un nombre estable y corto (igual que el archivo del feed).
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in project_key(project).bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    dir.join(format!("{h:016x}.json"))
}

fn chats_dir() -> PathBuf {
    data_dir().join("chats")
}

pub fn read_in(dir: &std::path::Path, project: &str) -> Option<Value> {
    let path = file_for(dir, project);
    // Si el archivo falta o está estropeado, vale la copia anterior.
    [path.clone(), path.with_extension("json.bak")].iter().find_map(|p| {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()?;
        v.get("chats").filter(|c| c.is_array()).cloned()
    })
}

pub fn write_in(dir: &std::path::Path, project: &str, chats: &Value) -> Result<(), String> {
    if !chats.is_array() {
        return Err("lista de chats no válida".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = file_for(dir, project);
    let lock = project_lock(&path);
    let _guard = lock.lock().map_err(|e| e.to_string())?;

    let body = serde_json::to_string(&json!({ "project": project, "chats": chats })).map_err(|e| e.to_string())?;
    // Escribe con su propio temporal único para evitar colisiones entre escrituras simultáneas (BUG-8).
    let seq = TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(format!(".tmp-{}-{}", std::process::id(), seq));
    let tmp = path.with_file_name(tmp_name);

    let written = (|| -> std::io::Result<()> {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(body.as_bytes())?;
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }

    if path.exists() {
        let _ = std::fs::copy(&path, path.with_extension("json.bak"));
    }

    let mut result = std::fs::rename(&tmp, &path);
    for _ in 0..5 {
        if result.is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
        result = std::fs::rename(&tmp, &path);
    }
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

/// Los chats guardados de una carpeta, o null si aún no hay (la interfaz migra entonces los suyos).
#[tauri::command]
pub fn chats_read(project: String) -> Option<Value> {
    read_in(&chats_dir(), &project)
}

/// Síncrono a propósito: Tauri los ejecuta en orden, así una escritura vieja nunca pisa una nueva.
#[tauri::command]
pub fn chats_write(project: String, chats: Value) -> Result<(), String> {
    write_in(&chats_dir(), &project, &chats).inspect_err(|e| {
        crate::errlog::log("chats", "No se pudieron guardar los chats", e);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guarda_lee_y_recupera_la_copia() {
        let dir = std::env::temp_dir().join(format!("lienzo-chats-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(read_in(&dir, r"C:\P\uno").is_none());
        write_in(&dir, r"C:\P\uno", &json!([{ "id": "a" }])).unwrap();
        write_in(&dir, r"C:\P\uno", &json!([{ "id": "b" }, { "id": "a" }])).unwrap();
        // La misma carpeta escrita de otra forma (mayúsculas, barras) es la misma.
        assert_eq!(read_in(&dir, "c:/p/uno/").unwrap(), json!([{ "id": "b" }, { "id": "a" }]));
        assert!(read_in(&dir, r"C:\P\dos").is_none());
        assert!(write_in(&dir, r"C:\P\uno", &json!({ "no": "lista" })).is_err());
        // Si el archivo se estropea, vale la copia anterior.
        std::fs::write(file_for(&dir, r"C:\P\uno"), "{roto").unwrap();
        assert_eq!(read_in(&dir, r"C:\P\uno").unwrap(), json!([{ "id": "a" }]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dos_escrituras_concurrentes_no_corrompen_chats() {
        let dir = std::env::temp_dir().join(format!("lienzo-chats-conc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let project = r"C:\P\concurrente";

        let d1 = dir.clone();
        let t1 = std::thread::spawn(move || {
            for i in 0..10 {
                let chats = json!([{ "id": format!("t1-{i}") }]);
                write_in(&d1, project, &chats).unwrap();
            }
        });

        let d2 = dir.clone();
        let t2 = std::thread::spawn(move || {
            for i in 0..10 {
                let chats = json!([{ "id": format!("t2-{i}") }]);
                write_in(&d2, project, &chats).unwrap();
            }
        });

        t1.join().unwrap();
        t2.join().unwrap();

        let final_chats = read_in(&dir, project).expect("debe existir y ser json válido");
        assert!(final_chats.is_array());
        let arr = final_chats.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        let id = arr[0]["id"].as_str().unwrap();
        assert!(id.starts_with("t1-") || id.starts_with("t2-"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
