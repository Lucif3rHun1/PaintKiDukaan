use base64::Engine;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Instant;
use tauri_plugin_updater::UpdaterExt;

const DEV_PASSWORD: &str = "paintkiduakan-dev";

fn sha256(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

fn fixture_path() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("tests/fixtures");
    #[cfg(target_os = "windows")]
    p.push("fixture.zip");
    #[cfg(target_os = "macos")]
    p.push("fixture.app.tar.gz");
    #[cfg(target_os = "linux")]
    p.push("fixture.AppImage.tar.gz");
    p
}

#[cfg(target_os = "windows")]
fn make_fixture(path: &Path) -> io::Result<()> {
    use zip::write::SimpleFileOptions;
    let exe = path.with_file_name("fixture.exe");
    let mut v = vec![0u8; 1024];
    v[0] = b'M';
    v[1] = b'Z';
    v[0x3c] = 0x40;
    v[0x40] = b'P';
    v[0x41] = b'E';
    fs::write(&exe, &v)?;
    let file = fs::File::create(path)?;
    let mut z = zip::ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    z.start_file("fixture.exe", opts)?;
    z.write_all(&v)?;
    z.finish()?;
    fs::remove_file(&exe)?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn make_fixture(path: &Path) -> io::Result<()> {
    let base = path.parent().unwrap();
    let app = base.join("fixture.app");
    let bin = app.join("Contents/MacOS");
    fs::create_dir_all(&bin)?;
    fs::write(bin.join("fixture"), vec![0u8; 1024])?;
    let s = Command::new("tar")
        .args(["-czf", &path.to_string_lossy(), "-C", &base.to_string_lossy(), "fixture.app"])
        .status()?;
    fs::remove_dir_all(&app)?;
    if !s.success() {
        return Err(io::Error::new(io::ErrorKind::Other, "tar failed"));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn make_fixture(path: &Path) -> io::Result<()> {
    let base = path.parent().unwrap();
    let img = base.join("fixture.AppImage");
    fs::write(&img, vec![0u8; 1024])?;
    let s = Command::new("tar")
        .args(["-czf", &path.to_string_lossy(), "-C", &base.to_string_lossy(), "fixture.AppImage"])
        .status()?;
    fs::remove_file(&img)?;
    if !s.success() {
        return Err(io::Error::new(io::ErrorKind::Other, "tar failed"));
    }
    Ok(())
}

fn sign(path: &Path, key: &Path, sig: &Path) -> io::Result<()> {
    let mut child = Command::new("minisign")
        .args(["-S", "-m", &path.to_string_lossy(), "-s", &key.to_string_lossy(), "-x", &sig.to_string_lossy()])
        .stdin(Stdio::piped())
        .spawn()?;
    child.stdin.take().unwrap().write_all(format!("{}\n", DEV_PASSWORD).as_bytes())?;
    let status = child.wait()?;
    if !status.success() {
        return Err(io::Error::new(io::ErrorKind::Other, "minisign sign failed"));
    }
    Ok(())
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let start = Instant::now();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let key_dir = root.join("tests/keypair");
    let pub_path = key_dir.join("minisign.pub");
    let sec_path = key_dir.join("minisign.key");
    if !pub_path.exists() {
        return Err("Run scripts/dev-setup-minisign.sh first".into());
    }
    let pub_content = fs::read_to_string(&pub_path)?;
    let pubkey = base64::engine::general_purpose::STANDARD.encode(pub_content.trim());
    let artifact = fixture_path();
    fs::create_dir_all(artifact.parent().unwrap())?;
    make_fixture(&artifact)?;
    let sig = artifact.with_extension("minisig");
    sign(&artifact, &sec_path, &sig)?;
    let sig_content = fs::read_to_string(&sig)?;
    let signature = base64::engine::general_purpose::STANDARD.encode(sig_content.trim());
    let expected_bytes = fs::read(&artifact)?;
    let expected_hash = sha256(&expected_bytes);
    let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(addr) => addr.port(),
        _ => return Err("expected TCP listen address".into()),
    };
    let base = format!("http://127.0.0.1:{port}");
    let manifest = serde_json::json!({
        "version": "9.9.9",
        "notes": "dev fixture",
        "url": format!("{base}/download"),
        "signature": signature,
    });
    let server = Arc::new(server);
    let s = server.clone();
    let artifact_for_thread = artifact.clone();
    std::thread::spawn(move || {
        for req in s.incoming_requests() {
            match req.url() {
                "/latest.json" => {
                    let body = serde_json::to_vec(&manifest).unwrap();
                    let len = body.len();
                    let _ = req.respond(tiny_http::Response::new(
                        tiny_http::StatusCode(200),
                        vec![],
                        std::io::Cursor::new(body),
                        Some(len),
                        None,
                    ));
                }
                "/download" => {
                    let _ = req.respond(tiny_http::Response::from_file(
                        fs::File::open(&artifact_for_thread).unwrap(),
                    ));
                }
                _ => {
                    let _ = req.respond(tiny_http::Response::new(
                        tiny_http::StatusCode(404),
                        vec![],
                        std::io::Cursor::new(vec![]),
                        Some(0),
                        None,
                    ));
                }
            }
        }
    });
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().pubkey(&pubkey).build())
        .build(tauri::generate_context!("tests/fixtures/tauri.conf.json"))?;
    let updater = app
        .updater_builder()
        .version_comparator(|_, _| true)
        .endpoints(vec![tauri::Url::parse(&format!("{base}/latest.json"))?])?
        .build()?;
    let update = updater.check().await?.ok_or("no update found")?;
    let bytes = update.download(|_, _| {}, || {}).await?;
    let actual_hash = sha256(&bytes);
    if actual_hash != expected_hash {
        return Err(format!("SHA-256 mismatch: expected {expected_hash}, got {actual_hash}").into());
    }
    println!("passes: GREEN ({}ms)", start.elapsed().as_millis());
    Ok(())
}

fn main() {
    if let Err(e) = tauri::async_runtime::block_on(run()) {
        println!("FAILS: RED ({e})");
        std::process::exit(1);
    }
}
