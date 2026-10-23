//! Limpieza al arrancar, antes de que exista el visor web: lo que su perfil (WebView2) guardó y ya
//! no hace falta. Desde la 1.0.107 la caché tiene tope de 20 MB y no se descargan componentes de
//! Edge, pero lo que había antes se quedaba en disco (unos 200 MB): Chromium no recorta una caché
//! en la que ya no escribe.

use std::path::{Path, PathBuf};

/// Por encima de esto la caché HTTP es de antes del tope (20 MB): se borra entera y se rehace.
const CACHE_MAX: u64 = 25 * 1024 * 1024;

/// Componentes de Edge que una app local no usa (y que ya no se actualizan).
const UNUSED: [&str; 3] = ["WidevineCdm", "Subresource Filter", "component_crx_cache"];

fn dir_size(dir: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    rd.flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(_) => e.metadata().map(|m| m.len()).unwrap_or(0),
            Err(_) => 0,
        })
        .sum()
}

/// Limpia el perfil del visor en `profile` (la carpeta `EBWebView`). Devuelve los bytes liberados.
/// Lo que no se pueda borrar (en uso por otra ventana de Prometeo) se deja: es solo caché.
pub fn clean_profile(profile: &Path) -> u64 {
    let mut freed = 0;
    let cache = profile.join("Default").join("Cache");
    let size = dir_size(&cache);
    if size > CACHE_MAX && std::fs::remove_dir_all(&cache).is_ok() {
        freed += size;
    }
    for name in UNUSED {
        let dir = profile.join(name);
        let size = dir_size(&dir);
        if size > 0 && std::fs::remove_dir_all(&dir).is_ok() {
            freed += size;
        }
    }
    freed
}

/// El perfil del visor de esta app: `%LOCALAPPDATA%\<identificador>\EBWebView`.
fn profile_dir() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    Some(PathBuf::from(local).join("dev.lienzo.app").join("EBWebView"))
}

/// Se llama al arrancar, antes de crear las ventanas.
pub fn at_startup() {
    let Some(profile) = profile_dir() else { return };
    let freed = clean_profile(&profile);
    if freed > 0 {
        // Solo por consola: no es un error (en Errores encendería el aviso de Ajustes).
        eprintln!("[limpieza] caché vieja del visor borrada: {} MB", freed / 1_048_576);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn borra_la_cache_grande_y_los_componentes_y_deja_lo_demas() {
        let p = std::env::temp_dir().join(format!("lienzo-limpieza-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        let cache = p.join("Default").join("Cache").join("Cache_Data");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("big"), vec![0u8; (CACHE_MAX + 1) as usize]).unwrap();
        std::fs::create_dir_all(p.join("WidevineCdm").join("4.1")).unwrap();
        std::fs::write(p.join("WidevineCdm").join("4.1").join("x.dll"), b"drm").unwrap();
        std::fs::create_dir_all(p.join("Default").join("Code Cache")).unwrap();
        std::fs::write(p.join("Default").join("Code Cache").join("js"), b"keep").unwrap();
        std::fs::write(p.join("Default").join("Preferences"), b"{}").unwrap();

        let freed = clean_profile(&p);
        assert!(freed > CACHE_MAX);
        assert!(!p.join("Default").join("Cache").exists());
        assert!(!p.join("WidevineCdm").exists());
        assert!(p.join("Default").join("Code Cache").join("js").exists(), "la caché de código se queda");
        assert!(p.join("Default").join("Preferences").exists(), "los ajustes del perfil se quedan");

        // Una caché pequeña (ya con tope) no se toca; y una segunda vez no hay nada que hacer.
        std::fs::create_dir_all(p.join("Default").join("Cache")).unwrap();
        std::fs::write(p.join("Default").join("Cache").join("small"), b"x").unwrap();
        assert_eq!(clean_profile(&p), 0);
        assert!(p.join("Default").join("Cache").join("small").exists());
        let _ = std::fs::remove_dir_all(&p);
    }
}
