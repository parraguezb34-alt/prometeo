//! Captura de la pantalla principal del PC para el iPad (RPC `pc_screenshot`, solo lectura).
//! En Windows usa GDI por FFI (BitBlt/StretchBlt + GetDIBits), reduce a ≤1600 px de ancho y la
//! codifica en PNG. Para no cargar el PC, como mucho una captura nueva cada 2 s: dentro de ese
//! plazo se devuelve la anterior.
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const MAX_WIDTH: u32 = 1600;
const MIN_GAP: Duration = Duration::from_secs(2);

#[derive(Serialize, Clone, Debug)]
pub struct PcShot {
    /// `data:image/png;base64,…`
    pub data_url: String,
    pub width: u32,
    pub height: u32,
    /// Milisegundos desde 1970 (hora del PC) en que se tomó.
    pub taken_at: u64,
}

static LAST: Mutex<Option<(Instant, PcShot)>> = Mutex::new(None);

/// Mensaje cuando la captura sale negra o falla: lo normal es la pantalla bloqueada.
pub const LOCKED_MSG: &str = "No se puede ver la pantalla: el PC está bloqueado, con la sesión cerrada o con la pantalla apagada. Los agentes siguen trabajando igual.";

pub fn capture() -> Result<PcShot, String> {
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, shot)) = last.as_ref()
        && at.elapsed() < MIN_GAP
    {
        return Ok(shot.clone());
    }
    let (w, h, rgb) = platform::grab(MAX_WIDTH)?;
    if rgb.iter().all(|&b| b == 0) {
        return Err(LOCKED_MSG.into());
    }
    let png = encode_png(w, h, &rgb)?;
    use base64::Engine as _;
    let shot = PcShot {
        data_url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png)
        ),
        width: w,
        height: h,
        taken_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    };
    *last = Some((Instant::now(), shot.clone()));
    Ok(shot)
}

/// Tamaño de destino conservando la proporción, con el ancho limitado a `max_w`.
pub fn fit(w: u32, h: u32, max_w: u32) -> (u32, u32) {
    if w <= max_w || w == 0 {
        return (w, h);
    }
    let nh = ((h as u64 * max_w as u64 + w as u64 / 2) / w as u64).max(1) as u32;
    (max_w, nh)
}

fn encode_png(w: u32, h: u32, rgb: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(rgb.len() / 4);
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut wr = enc.write_header().map_err(|e| e.to_string())?;
        wr.write_image_data(rgb).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;

    type Hdc = *mut c_void;
    type Hbitmap = *mut c_void;

    #[repr(C)]
    struct BitmapInfoHeader {
        size: u32,
        width: i32,
        height: i32,
        planes: u16,
        bit_count: u16,
        compression: u32,
        size_image: u32,
        x_ppm: i32,
        y_ppm: i32,
        clr_used: u32,
        clr_important: u32,
    }

    #[repr(C)]
    struct BitmapInfo {
        header: BitmapInfoHeader,
        colors: [u32; 1],
    }

    const SM_CXSCREEN: i32 = 0;
    const SM_CYSCREEN: i32 = 1;
    const SRCCOPY: u32 = 0x00CC_0020;
    const CAPTUREBLT: u32 = 0x4000_0000;
    const HALFTONE: i32 = 4;
    const DIB_RGB_COLORS: u32 = 0;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetDC(hwnd: *mut c_void) -> Hdc;
        fn ReleaseDC(hwnd: *mut c_void, hdc: Hdc) -> i32;
        fn GetSystemMetrics(index: i32) -> i32;
    }

    #[link(name = "gdi32")]
    unsafe extern "system" {
        fn CreateCompatibleDC(hdc: Hdc) -> Hdc;
        fn CreateCompatibleBitmap(hdc: Hdc, w: i32, h: i32) -> Hbitmap;
        fn SelectObject(hdc: Hdc, obj: *mut c_void) -> *mut c_void;
        fn DeleteObject(obj: *mut c_void) -> i32;
        fn DeleteDC(hdc: Hdc) -> i32;
        fn SetStretchBltMode(hdc: Hdc, mode: i32) -> i32;
        fn SetBrushOrgEx(hdc: Hdc, x: i32, y: i32, old: *mut c_void) -> i32;
        fn StretchBlt(
            dst: Hdc, dx: i32, dy: i32, dw: i32, dh: i32,
            src: Hdc, sx: i32, sy: i32, sw: i32, sh: i32, rop: u32,
        ) -> i32;
        fn GetDIBits(hdc: Hdc, bmp: Hbitmap, start: u32, lines: u32, bits: *mut c_void, info: *mut BitmapInfo, usage: u32) -> i32;
    }

    /// Devuelve (ancho, alto, píxeles RGB de arriba abajo).
    pub fn grab(max_w: u32) -> Result<(u32, u32, Vec<u8>), String> {
        // SAFETY: llamadas GDI estándar; cada objeto creado se libera antes de salir y los
        // búferes tienen el tamaño exacto que pide GetDIBits (32 bits por píxel).
        unsafe {
            let sw = GetSystemMetrics(SM_CXSCREEN);
            let sh = GetSystemMetrics(SM_CYSCREEN);
            if sw <= 0 || sh <= 0 {
                return Err(super::LOCKED_MSG.into());
            }
            let (w, h) = super::fit(sw as u32, sh as u32, max_w);
            let screen = GetDC(std::ptr::null_mut());
            if screen.is_null() {
                return Err(super::LOCKED_MSG.into());
            }
            let mem = CreateCompatibleDC(screen);
            let bmp = CreateCompatibleBitmap(screen, w as i32, h as i32);
            let mut result = Err(super::LOCKED_MSG.to_string());
            if !mem.is_null() && !bmp.is_null() {
                let old = SelectObject(mem, bmp);
                SetStretchBltMode(mem, HALFTONE);
                SetBrushOrgEx(mem, 0, 0, std::ptr::null_mut());
                let ok = StretchBlt(mem, 0, 0, w as i32, h as i32, screen, 0, 0, sw, sh, SRCCOPY | CAPTUREBLT);
                SelectObject(mem, old);
                if ok != 0 {
                    let mut info: BitmapInfo = std::mem::zeroed();
                    info.header.size = std::mem::size_of::<BitmapInfoHeader>() as u32;
                    info.header.width = w as i32;
                    info.header.height = -(h as i32); // de arriba abajo
                    info.header.planes = 1;
                    info.header.bit_count = 32;
                    let mut bgra = vec![0u8; (w * h * 4) as usize];
                    let lines = GetDIBits(mem, bmp, 0, h, bgra.as_mut_ptr().cast(), &mut info, DIB_RGB_COLORS);
                    if lines == h as i32 {
                        let mut rgb = Vec::with_capacity((w * h * 3) as usize);
                        for px in bgra.chunks_exact(4) {
                            rgb.extend_from_slice(&[px[2], px[1], px[0]]);
                        }
                        result = Ok((w, h, rgb));
                    }
                }
            }
            if !bmp.is_null() {
                DeleteObject(bmp);
            }
            if !mem.is_null() {
                DeleteDC(mem);
            }
            ReleaseDC(std::ptr::null_mut(), screen);
            result
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn grab(_max_w: u32) -> Result<(u32, u32, Vec<u8>), String> {
        Err("Ver la pantalla solo funciona con el PC en Windows.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_keeps_ratio_and_limits_width() {
        assert_eq!(fit(1280, 720, 1600), (1280, 720));
        assert_eq!(fit(3840, 2160, 1600), (1600, 900));
        assert_eq!(fit(2560, 1440, 1600), (1600, 900));
        assert_eq!(fit(0, 0, 1600), (0, 0));
    }

    /// Captura real (necesita escritorio): `cargo test --lib pcshot -- --ignored`.
    /// Con PCSHOT_OUT=<ruta.png> guarda la imagen para mirarla.
    #[test]
    #[ignore]
    fn real_capture() {
        let shot = capture().expect("captura");
        assert!(shot.width > 0 && shot.width <= MAX_WIDTH && shot.height > 0);
        if let Ok(path) = std::env::var("PCSHOT_OUT") {
            use base64::Engine as _;
            let b64 = shot.data_url.split_once(',').unwrap().1;
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
    }

    #[test]
    fn png_roundtrip_header() {
        let png = encode_png(2, 1, &[255, 0, 0, 0, 255, 0]).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    }
}
