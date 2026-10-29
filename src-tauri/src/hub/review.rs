//! Diff de una entrega para la revisión del líder, sin depender de git: el hub guarda una
//! copia de cada archivo cuando un agente lo reserva y, al entregar, la compara con el actual.
//! Así el líder revisa con el aviso 🔎 en vez de abrir los archivos (cada lectura le cuesta
//! un turno entero de contexto).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Archivos más grandes no se copian ni se comparan.
pub const MAX_FILE_BYTES: u64 = 256 * 1024;
/// Tope de celdas de la tabla LCS; por encima probamos Myers acotado.
const MAX_CELLS: usize = 2_000_000;
/// Un reemplazo realmente grande conserva el fallback antiguo; un par de cambios
/// lejanos en miles de líneas se resuelve con D pequeño y dos hunks legibles.
const MAX_EDIT_DISTANCE: usize = 128;
/// Un archivo sin copia previa se muestra entero solo si es corto.
const MAX_LINES_WITHOUT_BASE: usize = 150;

/// Cómo estaba un archivo al reservarlo.
#[derive(Clone, Debug)]
pub enum FileBase {
    /// No existía: lo que haya ahora es nuevo.
    Missing,
    Text(String),
    /// Binario o demasiado grande: no se compara.
    Skipped,
}

/// Clave común para una ruta: relativa al proyecto, con «/» y en minúsculas.
pub fn rel_key(root: &Path, file: &str) -> String {
    let f = file.trim().replace('\\', "/");
    let r = root.to_string_lossy().replace('\\', "/");
    let r = r.trim_end_matches('/');
    let rel = if f.to_lowercase().starts_with(&format!("{}/", r.to_lowercase())) {
        f[r.len() + 1..].to_string()
    } else {
        f
    };
    rel.trim_start_matches("./").to_lowercase()
}

fn full_path(root: &Path, file: &str) -> PathBuf {
    let p = PathBuf::from(file.trim());
    if p.is_absolute() { p } else { root.join(file.trim().trim_start_matches("./")) }
}

/// Estado actual de un archivo del proyecto.
pub fn read_base(root: &Path, file: &str) -> FileBase {
    let path = full_path(root, file);
    let Ok(meta) = std::fs::metadata(&path) else { return FileBase::Missing };
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return FileBase::Skipped;
    }
    match std::fs::read(&path) {
        Ok(bytes) if !bytes.contains(&0) => match String::from_utf8(bytes) {
            Ok(text) => FileBase::Text(text.replace("\r\n", "\n")),
            Err(_) => FileBase::Skipped,
        },
        Ok(_) => FileBase::Skipped,
        Err(_) => FileBase::Missing,
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Op {
    Eq,
    Del,
    Ins,
}

/// Myers para el tramo central grande. Con D acotado, la traza de diagonales
/// ocupa O(D²) y el recorrido O((N+M)·D); no crea una tabla N×M.
fn myers_lines<'a>(a: &[&'a str], b: &[&'a str]) -> Option<Vec<(Op, &'a str)>> {
    let (n, m) = (a.len(), b.len());
    let limit = (n + m).min(MAX_EDIT_DISTANCE);
    let offset = limit + 1;
    let at = |k: isize| (offset as isize + k) as usize;
    let mut frontier = vec![0usize; 2 * limit + 3];
    let mut trace: Vec<Vec<usize>> = Vec::new();
    for d in 0..=limit {
        let mut next = frontier.clone();
        for k in (-(d as isize)..=d as isize).step_by(2) {
            let mut x = if k == -(d as isize)
                || (k != d as isize && frontier[at(k - 1)] < frontier[at(k + 1)]) {
                frontier[at(k + 1)]
            } else {
                frontier[at(k - 1)] + 1
            };
            let mut y = (x as isize - k) as usize;
            while x < n && y < m && a[x] == b[y] {
                x += 1;
                y += 1;
            }
            next[at(k)] = x;
            if x == n && y == m {
                trace.push(next);
                let mut reversed = Vec::with_capacity(n + m);
                let (mut x, mut y) = (n, m);
                for depth in (1..trace.len()).rev() {
                    let k = x as isize - y as isize;
                    let previous = &trace[depth - 1];
                    let prev_k = if k == -(depth as isize)
                        || (k != depth as isize && previous[at(k - 1)] < previous[at(k + 1)]) {
                        k + 1
                    } else {
                        k - 1
                    };
                    let prev_x = previous[at(prev_k)];
                    let prev_y = (prev_x as isize - prev_k) as usize;
                    while x > prev_x && y > prev_y {
                        x -= 1;
                        y -= 1;
                        reversed.push((Op::Eq, a[x]));
                    }
                    if x == prev_x {
                        y -= 1;
                        reversed.push((Op::Ins, b[y]));
                    } else {
                        x -= 1;
                        reversed.push((Op::Del, a[x]));
                    }
                }
                while x > 0 && y > 0 {
                    x -= 1;
                    y -= 1;
                    reversed.push((Op::Eq, a[x]));
                }
                while x > 0 { x -= 1; reversed.push((Op::Del, a[x])); }
                while y > 0 { y -= 1; reversed.push((Op::Ins, b[y])); }
                reversed.reverse();
                return Some(reversed);
            }
        }
        trace.push(next.clone());
        frontier = next;
    }
    None
}

/// Operaciones línea a línea: prefijo y sufijo comunes fuera, y LCS en el tramo central.
fn diff_lines<'a>(a: &[&'a str], b: &[&'a str]) -> Vec<(Op, &'a str)> {
    let mut pre = 0;
    while pre < a.len() && pre < b.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < a.len() - pre && suf < b.len() - pre && a[a.len() - 1 - suf] == b[b.len() - 1 - suf] {
        suf += 1;
    }
    let am = &a[pre..a.len() - suf];
    let bm = &b[pre..b.len() - suf];
    let mut out: Vec<(Op, &str)> = a[..pre].iter().map(|l| (Op::Eq, *l)).collect();
    let (n, m) = (am.len(), bm.len());
    if n.saturating_mul(m) <= MAX_CELLS {
        let w = m + 1;
        let mut t = vec![0u32; (n + 1) * w];
        for i in (0..n).rev() {
            for j in (0..m).rev() {
                t[i * w + j] = if am[i] == bm[j] {
                    t[(i + 1) * w + j + 1] + 1
                } else {
                    t[(i + 1) * w + j].max(t[i * w + j + 1])
                };
            }
        }
        let (mut i, mut j) = (0, 0);
        while i < n && j < m {
            if am[i] == bm[j] {
                out.push((Op::Eq, am[i]));
                i += 1;
                j += 1;
            } else if t[(i + 1) * w + j] >= t[i * w + j + 1] {
                out.push((Op::Del, am[i]));
                i += 1;
            } else {
                out.push((Op::Ins, bm[j]));
                j += 1;
            }
        }
        out.extend(am[i..].iter().map(|l| (Op::Del, *l)));
        out.extend(bm[j..].iter().map(|l| (Op::Ins, *l)));
    } else if let Some(ops) = myers_lines(am, bm) {
        out.extend(ops);
    } else {
        out.extend(am.iter().map(|l| (Op::Del, *l)));
        out.extend(bm.iter().map(|l| (Op::Ins, *l)));
    }
    out.extend(a[a.len() - suf..].iter().map(|l| (Op::Eq, *l)));
    out
}

/// Diff unificado con `ctx` líneas de contexto; vacío si no hay cambios.
pub fn unified(old: &str, new: &str, ctx: usize) -> String {
    let a: Vec<&str> = old.lines().collect();
    let b: Vec<&str> = new.lines().collect();
    let ops = diff_lines(&a, &b);
    let mut hunks: Vec<(usize, usize)> = vec![];
    for (i, (op, _)) in ops.iter().enumerate() {
        if *op == Op::Eq {
            continue;
        }
        let (s, e) = (i.saturating_sub(ctx), (i + ctx + 1).min(ops.len()));
        match hunks.last_mut() {
            Some(h) if s <= h.1 => h.1 = h.1.max(e),
            _ => hunks.push((s, e)),
        }
    }
    // Número de línea (vieja y nueva) antes de cada operación.
    let mut ln_a = vec![0usize; ops.len() + 1];
    let mut ln_b = vec![0usize; ops.len() + 1];
    for (k, (op, _)) in ops.iter().enumerate() {
        ln_a[k + 1] = ln_a[k] + usize::from(*op != Op::Ins);
        ln_b[k + 1] = ln_b[k] + usize::from(*op != Op::Del);
    }
    let mut out = String::new();
    for (s, e) in hunks {
        out.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            ln_a[s] + 1,
            ln_a[e] - ln_a[s],
            ln_b[s] + 1,
            ln_b[e] - ln_b[s]
        ));
        for (op, line) in &ops[s..e] {
            out.push(match op {
                Op::Eq => ' ',
                Op::Del => '-',
                Op::Ins => '+',
            });
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// Cambios de los archivos de una entrega frente a su copia al reservarlos, recortados a
/// `max_chars`. Sin copia previa, un archivo corto se muestra entero (marcado como tal).
pub fn delivery_diff(root: &Path, files: &[String], bases: &HashMap<String, FileBase>, max_chars: usize) -> String {
    let mut out = String::new();
    for file in files {
        let now = read_base(root, file);
        let section = match (bases.get(&rel_key(root, file)), &now) {
            (Some(FileBase::Text(old)), FileBase::Text(new)) => {
                let d = unified(old, new, 3);
                if d.is_empty() { "(sin cambios)\n".to_string() } else { d }
            }
            (Some(FileBase::Missing), FileBase::Text(new)) => format!("(archivo nuevo)\n{}", unified("", new, 0)),
            (Some(FileBase::Text(_)), FileBase::Missing) => "(borrado)\n".to_string(),
            (_, FileBase::Skipped) | (Some(FileBase::Skipped), _) => "(binario o grande: no se compara)\n".to_string(),
            (None, FileBase::Text(new)) if new.lines().count() <= MAX_LINES_WITHOUT_BASE => {
                format!("(sin copia previa: contenido actual)\n{}", unified("", new, 0))
            }
            (None, FileBase::Text(new)) => {
                format!("(sin copia previa; {} líneas: léelo si hace falta)\n", new.lines().count())
            }
            (_, FileBase::Missing) => "(no existe)\n".to_string(),
        };
        out.push_str(&format!("--- {}\n{section}", file.trim()));
    }
    if out.chars().count() > max_chars {
        let cut: String = out.chars().take(max_chars).collect();
        let cut = cut.rfind('\n').map(|i| &cut[..i]).unwrap_or(&cut).to_string();
        out = format!("{cut}\n… (recortado: lee el resto de los archivos si lo necesitas)\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unified_shows_only_changed_hunk_with_context() {
        let old = (1..=20).map(|i| format!("l{i}")).collect::<Vec<_>>().join("\n");
        let new = old.replace("l10", "diez");
        let d = unified(&old, &new, 2);
        assert_eq!(d, "@@ -8,5 +8,5 @@\n l8\n l9\n-l10\n+diez\n l11\n l12\n");
    }

    #[test]
    fn unified_handles_inserts_and_empty_old() {
        assert_eq!(unified("", "a\nb", 0), "@@ -1,0 +1,2 @@\n+a\n+b\n");
        assert_eq!(unified("a\nc", "a\nb\nc", 1), "@@ -1,2 +1,3 @@\n a\n+b\n c\n");
        assert_eq!(unified("igual", "igual", 3), "");
    }

    #[test]
    fn large_file_with_distant_edits_has_two_small_hunks() {
        let old = (1..=4000).map(|i| format!("línea única {i}")).collect::<Vec<_>>().join("\n");
        let new = old.replace("línea única 590", "línea editada 590")
            .replace("línea única 3500", "línea editada 3500");
        let diff = unified(&old, &new, 3);
        assert_eq!(diff.lines().filter(|l| l.starts_with("@@")).count(), 2, "{diff}");
        assert!(diff.contains("-línea única 590\n+línea editada 590"));
        assert!(diff.contains("-línea única 3500\n+línea editada 3500"));
        assert!(diff.lines().count() < 30, "diff demasiado grande");
    }

    #[test]
    fn myers_large_middle_reconstructs_insertions_and_deletions() {
        let a = (0..3500).map(|i| format!("item {i}")).collect::<Vec<_>>();
        let mut b = a.clone();
        b.insert(500, "insertado".into());
        b.remove(3000);
        let old = a.join("\n");
        let new = b.join("\n");
        let aa: Vec<&str> = old.lines().collect();
        let bb: Vec<&str> = new.lines().collect();
        let ops = diff_lines(&aa, &bb);
        assert_eq!(ops.iter().filter(|(op, _)| *op != Op::Ins).map(|(_, line)| *line).collect::<Vec<_>>(), aa);
        assert_eq!(ops.iter().filter(|(op, _)| *op != Op::Del).map(|(_, line)| *line).collect::<Vec<_>>(), bb);
        assert_eq!(unified(&old, &new, 3).lines().filter(|l| l.starts_with("@@")).count(), 2);
    }

    #[test]
    fn rel_key_normalizes_paths() {
        let root = Path::new(r"C:\Proj\App");
        assert_eq!(rel_key(root, r"C:\proj\app\src\A.ts"), "src/a.ts");
        assert_eq!(rel_key(root, "./src/a.ts"), "src/a.ts");
    }

    #[test]
    fn delivery_diff_uses_bases_and_caps_size() {
        let dir = std::env::temp_dir().join(format!("lienzo-review-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "uno\ndos\ntres\n").unwrap();
        std::fs::write(dir.join("b.txt"), "nuevo\n").unwrap();
        let mut bases = HashMap::new();
        bases.insert("a.txt".to_string(), FileBase::Text("uno\n2\ntres\n".into()));
        bases.insert("b.txt".to_string(), FileBase::Missing);
        let d = delivery_diff(&dir, &["a.txt".into(), "b.txt".into()], &bases, 10_000);
        assert!(d.contains("-2\n+dos"), "{d}");
        assert!(d.contains("--- b.txt\n(archivo nuevo)\n@@ -1,0 +1,1 @@\n+nuevo"), "{d}");
        let short = delivery_diff(&dir, &["a.txt".into(), "b.txt".into()], &bases, 30);
        assert!(short.contains("recortado") && short.chars().count() < 120);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
