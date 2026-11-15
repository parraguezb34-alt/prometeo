//! Renombrar la carpeta de un proyecto de verdad, en el disco, sin perder nada: lo del equipo
//! (chats, tareas, memoria, historial) y las conversaciones de Claude Code pasan al nombre nuevo.
//! La interfaz cierra antes las terminales (Windows no deja renombrar una carpeta en uso) y
//! después vuelve a conectar y abrir a los agentes.

use std::path::{Path, PathBuf};

use crate::hub::{self, Hub};

/// Nombres que Windows no deja usar para una carpeta.
const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1",
    "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// El nombre nuevo, limpio, o por qué no vale.
pub fn valid_name(name: &str) -> Result<String, String> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let name = name.trim_end_matches(['.', ' ']).to_string();
    if name.is_empty() {
        return Err("Escribe un nombre para la carpeta.".into());
    }
    if name.chars().count() > 120 {
        return Err("El nombre es demasiado largo (máximo 120 caracteres).".into());
    }
    if let Some(c) = name.chars().find(|c| r#"<>:"/\|?*"#.contains(*c) || c.is_control()) {
        return Err(format!("El nombre no puede llevar «{c}»."));
    }
    let stem = name.split('.').next().unwrap_or("").to_lowercase();
    if RESERVED.contains(&stem.as_str()) || name == "." || name == ".." {
        return Err(format!("Windows no deja llamar «{name}» a una carpeta."));
    }
    Ok(name)
}

/// Carpeta de Claude Code para un proyecto: todo lo que no es alfanumérico pasa a «-».
pub fn claude_slug(dir: &str) -> String {
    dir.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

/// Mueve las conversaciones de Claude Code de la carpeta vieja a la nueva (para `--resume`).
fn move_claude_sessions(home: &Path, old: &str, new: &str) -> Result<(), String> {
    let base = home.join(".claude").join("projects");
    let from = base.join(claude_slug(old));
    let to = base.join(claude_slug(new));
    if from == to || !from.is_dir() {
        return Ok(());
    }
    if !to.exists() {
        return std::fs::rename(&from, &to).map_err(|e| e.to_string());
    }
    // Ya había algo con el nombre nuevo: se pasan los archivos que falten.
    for entry in std::fs::read_dir(&from).map_err(|e| e.to_string())?.flatten() {
        let dest = to.join(entry.file_name());
        if !dest.exists() {
            std::fs::rename(entry.path(), dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Renombra con unos reintentos: OneDrive o el antivirus suelen soltar la carpeta en un momento.
fn rename_with_retries(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut last = None;
    for _ in 0..10 {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(400));
            }
        }
    }
    Err(last.unwrap())
}

fn rename_target(old: &Path, name: &str) -> Result<PathBuf, String> {
    if !old.is_dir() {
        return Err(format!("No encuentro la carpeta {}", old.display()));
    }
    let parent = old.parent().ok_or("No se puede renombrar la raíz de un disco.")?;
    let new = parent.join(name);
    let same_ignoring_case = new.to_string_lossy().to_lowercase() == old.to_string_lossy().to_lowercase();
    if new.exists() && !same_ignoring_case {
        return Err(format!("Ya hay una carpeta llamada «{name}» junto a esta."));
    }
    Ok(new)
}

/// Hace el cambio en el disco y en Prometeo. Devuelve la ruta nueva.
pub fn rename(hub: &Hub, path: &str, name: &str) -> Result<String, String> {
    let name = valid_name(name)?;
    let old = PathBuf::from(path.trim().trim_end_matches(['\\', '/']));
    let new = rename_target(&old, &name)?;
    if new == old {
        return Ok(old.display().to_string());
    }
    // La app en vivo corre dentro de la carpeta.
    crate::devapp::stop();
    rename_with_retries(&old, &new).map_err(|e| {
        let busy = matches!(e.raw_os_error(), Some(5) | Some(32)) || e.kind() == std::io::ErrorKind::PermissionDenied;
        if busy {
            "La carpeta está en uso y Windows no deja renombrarla. Cierra lo que la tenga abierta (el Explorador, \
             un editor, una terminal fuera de Prometeo) y vuelve a intentarlo."
                .to_string()
        } else {
            format!("No se pudo renombrar la carpeta: {e}")
        }
    })?;
    let old_s = old.display().to_string();
    let new_s = new.display().to_string();
    {
        let mut inner = hub.0.lock().map_err(|e| e.to_string())?;
        hub::rename_project(&mut inner, &old_s, &new_s);
        hub::persist(&inner);
    }
    hub::notify_ui();
    if let Some(home) = home()
        && let Err(e) = move_claude_sessions(&home, &old_s, &new_s) {
            crate::errlog::log("proyecto", "No se pudieron mover las conversaciones de Claude Code", &e);
        }
    Ok(new_s)
}

#[tauri::command]
pub async fn project_rename(hub: tauri::State<'_, Hub>, path: String, name: String) -> Result<String, String> {
    rename(&hub, &path, &name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nombres_validos_y_no() {
        assert_eq!(valid_name("  Tienda   web  ").unwrap(), "Tienda web");
        assert_eq!(valid_name("Proyecto.").unwrap(), "Proyecto");
        assert!(valid_name("").is_err());
        assert!(valid_name("a/b").is_err());
        assert!(valid_name("¿qué?").is_err());
        assert!(valid_name("CON").is_err());
        assert!(valid_name("nul.txt").is_err());
        assert_eq!(valid_name("Diseño 2").unwrap(), "Diseño 2");
    }

    #[test]
    fn carpeta_de_claude() {
        assert_eq!(
            claude_slug(r"C:\Users\parra\OneDrive\Escritorio\Nueva carpeta"),
            "C--Users-parra-OneDrive-Escritorio-Nueva-carpeta"
        );
    }

    #[test]
    fn mueve_las_conversaciones_de_claude() {
        let home = std::env::temp_dir().join(format!("lienzo-rn-{}", std::process::id()));
        let base = home.join(".claude").join("projects");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(base.join(claude_slug(r"C:\x\Viejo"))).unwrap();
        std::fs::write(base.join(claude_slug(r"C:\x\Viejo")).join("abc.jsonl"), "{}").unwrap();
        move_claude_sessions(&home, r"C:\x\Viejo", r"C:\x\Nuevo nombre").unwrap();
        assert!(base.join("C--x-Nuevo-nombre").join("abc.jsonl").is_file());
        assert!(!base.join("C--x-Viejo").exists());
        // Sin conversaciones no pasa nada.
        move_claude_sessions(&home, r"C:\x\Otro", r"C:\x\Mas").unwrap();
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn renombra_la_carpeta_con_lo_de_dentro() {
        let root = std::env::temp_dir().join(format!("lienzo-rn2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Viejo").join(".lienzo")).unwrap();
        std::fs::write(root.join("Viejo").join("a.txt"), "hola").unwrap();
        rename_with_retries(&root.join("Viejo"), &root.join("Nuevo")).unwrap();
        assert_eq!(std::fs::read_to_string(root.join("Nuevo").join("a.txt")).unwrap(), "hola");
        assert!(root.join("Nuevo").join(".lienzo").is_dir());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rechaza_destino_ocupado_sin_tocar_ninguna_carpeta() {
        let root = std::env::temp_dir().join(format!("lienzo-rn-ocupado-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Origen")).unwrap();
        std::fs::create_dir_all(root.join("Destino")).unwrap();
        std::fs::write(root.join("Origen").join("origen.txt"), "origen").unwrap();
        std::fs::write(root.join("Destino").join("destino.txt"), "destino").unwrap();
        assert!(rename_target(&root.join("Origen"), "Destino").is_err());
        assert_eq!(std::fs::read_to_string(root.join("Origen").join("origen.txt")).unwrap(), "origen");
        assert_eq!(std::fs::read_to_string(root.join("Destino").join("destino.txt")).unwrap(), "destino");
        let _ = std::fs::remove_dir_all(&root);
    }
}
