//! Build script: además de generar el contexto de Tauri, aparta los binarios
//! que estén en uso para que el linker nunca falle con "Permission denied".

use std::fs;
use std::path::{Path, PathBuf};

/// Si un archivo del target (p.ej. lienzo-mcp.exe retenido por agentes vivos,
/// o WebView2Loader.dll retenido por webviews zombie) está bloqueado, Windows
/// no deja reescribirlo y el linker copia falla con "Access is denied /
/// sharing violation (os error 5/32)". Renombrar un archivo en uso SÍ está
/// permitido: lo apartamos con marca de tiempo, quien lo necesite escribe una
/// copia nueva y los procesos viejos siguen funcionando con la suya.
fn unblock_locked_bins() {
    let Some(dir) = profile_dir() else { return };
    for name in ["lienzo-mcp.exe", "lienzo.exe", "WebView2Loader.dll"] {
        let path = dir.join(name);
        if !path.is_file() {
            continue;
        }
        // Si se puede abrir para escritura, nadie lo tiene bloqueado.
        if fs::OpenOptions::new().write(true).open(&path).is_ok() {
            continue;
        }
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let old = dir.join(format!("{name}.locked-{ts}"));
        match fs::rename(&path, &old) {
            Ok(()) => println!(
                "cargo:warning={name} estaba en uso: lo aparté como {} (los procesos vivos siguen con él)",
                old.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
            ),
            Err(e) => println!("cargo:warning=no pude apartar {name}: {e}"),
        }
    }
}

/// `<target>/<perfil>` a partir de OUT_DIR (`<target>/<perfil>/build/<pkg>/out`).
fn profile_dir() -> Option<PathBuf> {
    let out = PathBuf::from(std::env::var_os("OUT_DIR")?);
    out.ancestors().nth(3).map(Path::to_path_buf)
}

fn main() {
    // Cargo cachea los build scripts: estas líneas fuerzan a re-ejecutarlo en
    // cada build relevante, para que el desbloqueo de binarios se aplique
    // siempre antes de que el linker necesite los .exe del target.
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");
    unblock_locked_bins();
    tauri_build::build()
}
