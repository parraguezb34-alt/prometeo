//! Oculta secretos (claves de API, tokens, contraseñas, claves privadas) antes de que lleguen al
//! feed, al buzón, a las entregas o a la memoria: todo eso se guarda en disco y lo leen los demás
//! agentes. Idea del filtro `redact_sensitive_text` de Hermes Agent, sin dependencias: se buscan
//! los prefijos conocidos de cada proveedor y los pares «clave = valor» con nombre de secreto.
//!
//! Lo oculto queda como `«oculto:ghp_…»`: se ve de qué tipo era, pero no se puede usar.

/// Prefijos de tokens conocidos y cuántos caracteres de token deben seguirles como mínimo.
const PREFIXES: &[(&str, usize)] = &[
    ("sk-ant-", 20),
    ("sk-proj-", 20),
    ("sk-or-", 20),
    ("sk-", 20),
    ("github_pat_", 20),
    ("ghp_", 30),
    ("gho_", 30),
    ("ghu_", 30),
    ("ghs_", 30),
    ("ghr_", 30),
    ("glpat-", 20),
    ("xoxb-", 15),
    ("xoxp-", 15),
    ("xoxa-", 15),
    ("xoxs-", 15),
    ("hf_", 30),
    ("npm_", 30),
    ("AIza", 35),
];

/// Nombres de campo cuyo valor es un secreto («password=…», «api_key: …»).
const SECRET_KEYS: &[&str] = &[
    "password",
    "passwd",
    "pwd",
    "contraseña",
    "secret",
    "client_secret",
    "token",
    "access_token",
    "refresh_token",
    "auth_token",
    "api_key",
    "apikey",
    "api-key",
    "access_key",
    "secret_key",
    "private_key",
];

fn token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

fn hidden(kind: &str) -> String {
    format!("«oculto:{kind}…»")
}

/// Devuelve el texto con los secretos ocultos (sin copiar si no había ninguno).
pub fn redact(text: &str) -> String {
    let once = private_keys(text);
    let once = prefixed_tokens(&once);
    let once = bearer(&once);
    let once = jwts(&once);
    let once = aws_keys(&once);
    key_values(&once)
}

/// ¿Hay algo que ocultar? (para no tocar textos que no lo necesitan).
pub fn has_secret(text: &str) -> bool {
    redact(text) != text
}

/// Bloques PEM de clave privada, enteros.
fn private_keys(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("-----BEGIN ") {
        let head = &rest[start..];
        let Some(line_end) = head.find("-----\n").or_else(|| head[11..].find("-----").map(|i| i + 11)) else {
            break;
        };
        if !head[..line_end].contains("PRIVATE KEY") {
            out.push_str(&rest[..start + 11]);
            rest = &rest[start + 11..];
            continue;
        }
        out.push_str(&rest[..start]);
        match head.find("-----END ") {
            Some(end) => {
                let tail = &head[end + 9..];
                let close = tail.find("-----").map(|i| end + 9 + i + 5).unwrap_or(head.len());
                out.push_str(&hidden("clave privada"));
                rest = &head[close..];
            }
            None => {
                out.push_str(&hidden("clave privada"));
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// Tokens con prefijo de proveedor (`sk-ant-…`, `ghp_…`, `xoxb-…`…). El prefijo tiene que empezar
/// una palabra, para no cortar algo como «desk-…».
fn prefixed_tokens(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    'outer: while i < chars.len() {
        let starts_word = i == 0 || !token_char(chars[i - 1]);
        if starts_word {
            for (prefix, min) in PREFIXES {
                let p: Vec<char> = prefix.chars().collect();
                if chars[i..].starts_with(&p) {
                    let mut j = i + p.len();
                    while j < chars.len() && token_char(chars[j]) {
                        j += 1;
                    }
                    let body = &chars[i + p.len()..j];
                    // Un token de verdad mezcla letras y números; «sk-algo-largo-de-prosa» no.
                    let digits = body.iter().any(|c| c.is_ascii_digit());
                    if body.len() >= *min && digits {
                        out.push_str(&hidden(prefix));
                        i = j;
                        continue 'outer;
                    }
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// `Bearer <token>` en cabeceras copiadas.
fn bearer(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find("Bearer ") {
        out.push_str(&rest[..pos + 7]);
        let tail = &rest[pos + 7..];
        let len = tail.find(|c: char| !(token_char(c) || c == '.' || c == '~' || c == '+' || c == '/' || c == '=')).unwrap_or(tail.len());
        if len >= 16 {
            out.push_str(&hidden("token"));
        } else {
            out.push_str(&tail[..len]);
        }
        rest = &tail[len..];
    }
    out.push_str(rest);
    out
}

/// JWT: tres trozos base64url separados por puntos que empiezan por `eyJ`.
fn jwts(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find("eyJ") {
        let before_ok = rest[..pos].chars().last().map_or(true, |c| !token_char(c));
        let tail = &rest[pos..];
        let len = tail.find(|c: char| !(token_char(c) || c == '.')).unwrap_or(tail.len());
        let cand = &tail[..len];
        if before_ok && cand.matches('.').count() == 2 && cand.len() >= 40 {
            out.push_str(&rest[..pos]);
            out.push_str(&hidden("jwt"));
        } else {
            out.push_str(&rest[..pos + len.max(3)]);
        }
        rest = &tail[len.max(3)..];
    }
    out.push_str(rest);
    out
}

/// Claves de acceso de AWS: `AKIA` + 16 mayúsculas o cifras.
fn aws_keys(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i..].starts_with(&['A', 'K', 'I', 'A'])
            && (i == 0 || !token_char(chars[i - 1]))
            && chars.len() >= i + 20
            && chars[i + 4..i + 20].iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
            && chars.get(i + 20).map_or(true, |c| !token_char(*c))
        {
            out.push_str(&hidden("AKIA"));
            i += 20;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// `password=…`, `"api_key": "…"`, `TOKEN: …`: se oculta el valor si parece un secreto (8 o más
/// caracteres seguidos sin espacios). El nombre tiene que ser la palabra entera: «tokens: 1500» no.
fn key_values(text: &str) -> String {
    let lower = text.to_lowercase();
    // Las minúsculas pueden cambiar la longitud en bytes: entonces no se arriesga a cortar mal.
    if lower.len() != text.len() {
        return text.to_string();
    }
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut i = 0;
    while i < bytes.len() {
        let mut matched = None;
        for key in SECRET_KEYS {
            if lower[i..].starts_with(key) {
                let before_ok = i == 0 || !token_char(text[..i].chars().last().unwrap_or(' '));
                let after = i + key.len();
                let after_ok = text[after..].chars().next().map_or(false, |c| !token_char(c));
                if before_ok && after_ok {
                    matched = Some(after);
                    break;
                }
            }
        }
        let Some(after) = matched else {
            i += text[i..].chars().next().map_or(1, |c| c.len_utf8());
            continue;
        };
        // Comillas de cierre del nombre, espacios, «:» o «=», espacios y comillas de apertura.
        let mut j = after;
        let rest = &text[j..];
        let skip_q = rest.len() - rest.trim_start_matches(['"', '\'']).len();
        j += skip_q;
        let rest = &text[j..];
        let skip_s = rest.len() - rest.trim_start_matches([' ', '\t']).len();
        j += skip_s;
        if !matches!(text[j..].chars().next(), Some(':') | Some('=')) {
            i = after;
            continue;
        }
        j += 1;
        let rest = &text[j..];
        let skip = rest.len() - rest.trim_start_matches([' ', '\t', '"', '\'']).len();
        j += skip;
        let value_len = text[j..]
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',' || c == ';' || c == '}' || c == '&')
            .unwrap_or(text.len() - j);
        let value = &text[j..j + value_len];
        if value_len >= 8 && !value.starts_with("«oculto") && !value.starts_with('$') && !value.starts_with('<') {
            out.push_str(&text[last..j]);
            out.push_str(&hidden("valor"));
            last = j + value_len;
        }
        i = j + value_len.max(1);
    }
    out.push_str(&text[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hides_provider_tokens() {
        let t = redact("usa ghp_1234567890abcdefghijklmnopqrstuvwxyzAB y sk-ant-api03-abc123def456ghi789jkl");
        assert!(!t.contains("ghp_1234") && !t.contains("api03"), "{t}");
        assert!(t.contains("«oculto:ghp_…»") && t.contains("«oculto:sk-ant-…»"), "{t}");
        let aws = redact("clave AKIAIOSFODNN7EXAMPLE fin");
        assert_eq!(aws, "clave «oculto:AKIA…» fin");
    }

    #[test]
    fn hides_key_values_and_headers() {
        let t = redact(r#"{"api_key": "abcd1234efgh", "user": "pedro"} password=Sup3rSecreta Authorization: Bearer abcdefghijklmnop1234"#);
        assert!(!t.contains("abcd1234efgh") && !t.contains("Sup3rSecreta") && !t.contains("abcdefghijklmnop1234"), "{t}");
        assert!(t.contains("pedro"), "lo que no es secreto se queda: {t}");
        let pem = redact("-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----\nlisto");
        assert_eq!(pem, "«oculto:clave privada…»\nlisto");
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
        assert_eq!(redact(&format!("token {jwt}")), "token «oculto:jwt…»");
    }

    #[test]
    fn leaves_normal_text_alone() {
        for t in [
            "tokens: 1500 · contexto 30%",
            "La tarea #67 «Parte B» va bien; desk-top y task-12 no son secretos.",
            "sk-revisar-la-parte-de-las-skills",
            "password: <tu contraseña>",
            "token = $GITHUB_TOKEN",
            "Configura la contraseña del usuario con passwd en la terminal.",
            "Ruta C:\\Users\\parra\\OneDrive\\Escritorio\\mejora de skill\\propuestas",
        ] {
            assert_eq!(redact(t), t);
        }
    }
}
