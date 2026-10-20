//! Límites de uso que no da el propio CLI. OpenCode Go no tiene forma de consultarlos, así que
//! se estiman con el coste que OpenCode guarda de cada mensaje en su base local
//! (`~/.local/share/opencode/opencode.db`), contra los topes del plan.

use serde::Serialize;
use std::path::PathBuf;

/// Topes de OpenCode Go (en dólares de uso): cada 5 h, por semana y por mes.
const CAPS: [(&str, &str, u64, f64); 3] = [
    ("session", "Sesión (5 h)", 5 * 3600, 12.0),
    ("week", "Semana", 7 * 24 * 3600, 30.0),
    ("month", "Mes", 30 * 24 * 3600, 60.0),
];

#[derive(Serialize)]
pub struct GoWindow {
    key: String,
    label: String,
    used_usd: f64,
    cap_usd: f64,
    used_pct: f64,
    /// Cuándo se libera el gasto más viejo de la ventana (aprox.: cuando caduca ese mensaje).
    resets_at: Option<u64>,
}

#[derive(Serialize)]
pub struct GoUsage {
    /// Hay mensajes de OpenCode Go en el último mes (si no, no hace falta enseñar nada).
    active: bool,
    windows: Vec<GoWindow>,
}

fn db_path() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    let p = PathBuf::from(home).join(".local/share/opencode/opencode.db");
    p.is_file().then_some(p)
}

/// Mensajes de OpenCode Go del último mes: (hora en ms, coste en dólares).
fn go_costs(now_ms: u64) -> Vec<(u64, f64)> {
    let Some(db) = db_path() else { return vec![] };
    let Ok(con) = rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return vec![];
    };
    let since = now_ms.saturating_sub(30 * 24 * 3600 * 1000) as i64;
    let sql = "select cast(json_extract(data, '$.time.created') as integer), \
                      coalesce(json_extract(data, '$.cost'), 0) \
               from session_message \
               where type = 'assistant' \
                 and lower(coalesce(json_extract(data, '$.model.providerID'), '')) in ('opencode-go', 'go') \
                 and cast(json_extract(data, '$.time.created') as integer) > ?1";
    let Ok(mut stmt) = con.prepare(sql) else { return vec![] };
    let Ok(rows) = stmt.query_map([since], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?))) else {
        return vec![];
    };
    rows.flatten().map(|(t, c)| (t.max(0) as u64, c)).collect()
}

pub fn summarize(costs: &[(u64, f64)], now_ms: u64) -> GoUsage {
    let windows = CAPS
        .iter()
        .map(|(key, label, secs, cap)| {
            let from = now_ms.saturating_sub(secs * 1000);
            let inside: Vec<&(u64, f64)> = costs.iter().filter(|(t, _)| *t > from).collect();
            let used: f64 = inside.iter().map(|(_, c)| c).sum();
            let oldest = inside.iter().map(|(t, _)| *t).min();
            GoWindow {
                key: key.to_string(),
                label: label.to_string(),
                used_usd: (used * 100.0).round() / 100.0,
                cap_usd: *cap,
                used_pct: ((used / cap) * 1000.0).round() / 10.0,
                resets_at: oldest.map(|t| t + secs * 1000),
            }
        })
        .collect();
    GoUsage { active: !costs.is_empty(), windows }
}

/// Uso estimado de OpenCode Go en sus tres ventanas.
#[tauri::command]
pub async fn opencode_go_usage() -> Result<GoUsage, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let now = crate::hub::now_ms();
        summarize(&go_costs(now), now)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ventanas_de_opencode_go() {
        let now = 100 * 24 * 3600 * 1000;
        let h = 3600 * 1000;
        let costs = vec![(now - h, 3.0), (now - 6 * h, 6.0), (now - 3 * 24 * h, 9.0), (now - 20 * 24 * h, 12.0)];
        let u = summarize(&costs, now);
        assert!(u.active);
        let w = |k: &str| u.windows.iter().find(|w| w.key == k).unwrap();
        assert_eq!(w("session").used_usd, 3.0);
        assert_eq!(w("session").used_pct, 25.0);
        assert_eq!(w("session").resets_at, Some(now - h + 5 * h));
        assert_eq!(w("week").used_usd, 18.0);
        assert_eq!(w("week").used_pct, 60.0);
        assert_eq!(w("month").used_usd, 30.0);
        assert_eq!(w("month").used_pct, 50.0);
        assert!(!summarize(&[], now).active);
    }
}
