//! Los chats de cada proyecto, en disco (`%APPDATA%\lienzo\chats\<carpeta>.json`). Antes vivían
//! solo en el almacenamiento del navegador interno, que se pierde al limpiar sus datos y tenía
//! tope; la interfaz lo sigue usando como copia rápida, pero lo que vale es esto.
//! El contenido es la lista tal cual la guarda la interfaz: aquí no se interpreta.

use std::path::PathBuf;

use serde_json::{json, Value};

use crate::hub::{data_dir, project_key};

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
    let body = serde_json::to_string(&json!({ "project": project, "chats": chats })).map_err(|e| e.to_string())?;
    // Escribe aparte y cambia de golpe; la versión anterior queda como .bak por si algo sale mal.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    if path.exists() {
        let _ = std::fs::rename(&path, path.with_extension("json.bak"));
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Los chats guardados de una carpeta, o null si aún no hay (la interfaz migra entonces los suyos).
#[tauri::command]
pub fn chats_read(project: String) -> Option<Value> {
    read_in(&chats_dir(), &project)
}

/// Síncrono a propósito: Tauri los ejecuta en orden, así una escritura vieja nunca pisa una nueva.
#[tauri::command]
pub fn chats_write(project: String, chats: Value) -> Result<(), String> {
    write_in(&chats_dir(), &project, &chats).map_err(|e| {
        crate::errlog::log("chats", "No se pudieron guardar los chats", &e);
        e
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
}
