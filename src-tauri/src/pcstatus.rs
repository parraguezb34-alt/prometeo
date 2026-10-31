//! Estado del PC para el iPad (RPC `pc_status`, solo lectura): memoria, disco del proyecto,
//! corriente/batería, tiempo encendido, IP de Tailscale y versión. Sin dependencias: en Windows
//! se leen directamente de kernel32; en otros sistemas los campos quedan en `None`.
use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Default, Debug, PartialEq)]
pub struct PcStatus {
    pub version: String,
    pub ram_total_mb: Option<u64>,
    pub ram_free_mb: Option<u64>,
    pub disk_free_mb: Option<u64>,
    pub disk_total_mb: Option<u64>,
    /// `Some(true)` = enchufado; `None` = desconocido.
    pub on_ac: Option<bool>,
    /// 0–100; `None` = sin batería o desconocido.
    pub battery_pct: Option<u8>,
    pub uptime_s: Option<u64>,
    pub tailscale: Option<String>,
    pub project: Option<String>,
    /// Avisos para mostrar en el iPad (RAM < 10 %, disco < 2 GB, sin corriente).
    pub warnings: Vec<String>,
}

const MB: u64 = 1024 * 1024;

pub fn warnings(s: &PcStatus) -> Vec<String> {
    let mut w = Vec::new();
    if let (Some(total), Some(free)) = (s.ram_total_mb, s.ram_free_mb)
        && total > 0
        && free * 100 < total * 10
    {
        w.push(format!("Queda poca memoria en el PC ({free} MB libres de {total} MB)."));
    }
    if let Some(free) = s.disk_free_mb
        && free < 2048
    {
        w.push(format!("Queda poco disco en el proyecto ({free} MB libres)."));
    }
    if s.on_ac == Some(false) {
        let pct = s.battery_pct.map(|p| format!(" ({p} %)")).unwrap_or_default();
        w.push(format!("El PC no está enchufado: va con batería{pct}."));
    }
    w
}

pub fn collect(project: Option<&str>, tailscale: Option<String>) -> PcStatus {
    let mut s = PcStatus {
        version: env!("CARGO_PKG_VERSION").to_string(),
        tailscale,
        project: project.map(str::to_owned),
        ..Default::default()
    };
    platform::fill(&mut s, project.map(Path::new));
    s.warnings = warnings(&s);
    s
}

#[cfg(windows)]
mod platform {
    use super::{MB, PcStatus};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    #[repr(C)]
    struct MemoryStatusEx {
        length: u32,
        memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }

    #[repr(C)]
    struct SystemPowerStatus {
        ac_line_status: u8,
        battery_flag: u8,
        battery_life_percent: u8,
        system_status_flag: u8,
        battery_life_time: u32,
        battery_full_life_time: u32,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalMemoryStatusEx(buf: *mut MemoryStatusEx) -> i32;
        fn GetDiskFreeSpaceExW(dir: *const u16, free_caller: *mut u64, total: *mut u64, free_total: *mut u64) -> i32;
        fn GetSystemPowerStatus(buf: *mut SystemPowerStatus) -> i32;
        fn GetTickCount64() -> u64;
    }

    pub fn fill(s: &mut PcStatus, project: Option<&Path>) {
        // SAFETY: estructuras con el diseño de la API de Windows, inicializadas a cero y con su
        // tamaño en `length`; los punteros apuntan a variables locales vivas durante la llamada.
        unsafe {
            let mut mem: MemoryStatusEx = std::mem::zeroed();
            mem.length = std::mem::size_of::<MemoryStatusEx>() as u32;
            if GlobalMemoryStatusEx(&mut mem) != 0 {
                s.ram_total_mb = Some(mem.total_phys / MB);
                s.ram_free_mb = Some(mem.avail_phys / MB);
            }
            let mut pw: SystemPowerStatus = std::mem::zeroed();
            if GetSystemPowerStatus(&mut pw) != 0 {
                s.on_ac = match pw.ac_line_status {
                    0 => Some(false),
                    1 => Some(true),
                    _ => None,
                };
                // 128 = sin batería; 255 = desconocido.
                if pw.battery_flag & 128 == 0 && pw.battery_life_percent <= 100 {
                    s.battery_pct = Some(pw.battery_life_percent);
                }
            }
            s.uptime_s = Some(GetTickCount64() / 1000);
            if let Some(dir) = project {
                let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
                let (mut free, mut total, mut free_all) = (0u64, 0u64, 0u64);
                if GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, &mut total, &mut free_all) != 0 {
                    s.disk_free_mb = Some(free / MB);
                    s.disk_total_mb = Some(total / MB);
                }
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::PcStatus;
    use std::path::Path;
    pub fn fill(_s: &mut PcStatus, _project: Option<&Path>) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warns_on_low_ram_low_disk_and_battery() {
        let ok = PcStatus {
            ram_total_mb: Some(16000),
            ram_free_mb: Some(4000),
            disk_free_mb: Some(50_000),
            on_ac: Some(true),
            ..Default::default()
        };
        assert!(warnings(&ok).is_empty());
        let bad = PcStatus {
            ram_total_mb: Some(16000),
            ram_free_mb: Some(1500),
            disk_free_mb: Some(1000),
            on_ac: Some(false),
            battery_pct: Some(40),
            ..Default::default()
        };
        let w = warnings(&bad);
        assert_eq!(w.len(), 3, "{w:?}");
        assert!(w[2].contains("40 %"));
        // Desconocido no avisa.
        assert!(warnings(&PcStatus::default()).is_empty());
    }

    #[test]
    fn collect_reads_this_machine() {
        let dir = std::env::temp_dir();
        let s = collect(dir.to_str(), None);
        assert_eq!(s.version, env!("CARGO_PKG_VERSION"));
        if cfg!(windows) {
            assert!(s.ram_total_mb.unwrap_or(0) > 0);
            assert!(s.disk_total_mb.unwrap_or(0) > 0);
            assert!(s.uptime_s.is_some());
        }
    }
}
