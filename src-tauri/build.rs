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
            Ok(()) => {
                // Se deja una copia con el nombre original: si este build no regenera el binario
                // (p. ej. un `cargo check`), los agentes siguen encontrando lienzo-mcp.exe.
                // La copia no está bloqueada, así que el linker puede reescribirla.
                let _ = fs::copy(&old, &path);
                println!(
                "cargo:warning={name} estaba en uso: lo aparté como {} (los procesos vivos siguen con él)",
                old.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
                )
            }
            Err(e) => println!("cargo:warning=no pude apartar {name}: {e}"),
        }
    }
}

/// Qué versión es esta: el commit, si había cambios sin guardar, cuándo se compiló y los últimos
/// commits (para «Novedades» al actualizar). Va en `OUT_DIR/cambios.txt`, una línea por commit:
/// `hash<US>fecha<US>asunto`.
fn embed_changes() {
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .current_dir("..")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    };
    let commit = git(&["rev-parse", "--short", "HEAD"]);
    // Los archivos de la versión (los toca scripts/version.mjs al compilar) no cuentan.
    let dirty = !git(&[
        "status", "--porcelain", "--untracked-files=no", "--", ".",
        ":!package.json", ":!src-tauri/tauri.conf.json", ":!src-tauri/Cargo.toml", ":!src-tauri/Cargo.lock",
    ])
    .is_empty();
    let log = git(&["log", "-n", "80", "--format=%h%x1f%ct%x1f%s"]);
    let built = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    println!("cargo:rustc-env=PROMETEO_COMMIT={commit}");
    println!("cargo:rustc-env=PROMETEO_DIRTY={}", if dirty { "1" } else { "" });
    println!("cargo:rustc-env=PROMETEO_BUILT_MS={built}");
    if let Some(out) = std::env::var_os("OUT_DIR") {
        let _ = fs::write(PathBuf::from(out).join("cambios.txt"), log);
    }
    // Un commit nuevo vuelve a ejecutar esto.
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs/heads");
    println!("cargo:rerun-if-changed=../.git/index");
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
    embed_changes();
    tauri_build::build();
    link_manifest_into_tests();
}

/// tauri-build solo enlaza el manifiesto de Windows (comctl32 v6) en los
/// binarios; sin él los tests mueren al arrancar con STATUS_ENTRYPOINT_NOT_FOUND.
/// Aquí solo se publica dónde está el recurso: lo enlaza `lib.rs` con `cfg(test)`.
fn link_manifest_into_tests() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let Some(out) = std::env::var_os("OUT_DIR").map(PathBuf::from) else { return };
    if out.join("libresource.a").is_file() || out.join("resource.lib").is_file() {
        println!("cargo:rustc-link-search=native={}", out.display());
    }
}
