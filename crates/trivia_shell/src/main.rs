//! Trivia's desktop shell: one native window on the designer.
//!
//! The designer is served by its own dev server (`pnpm --filter @trivia/designer dev`), which
//! proxies the user's app, so the canvas iframe is same-origin with it. A webview pointed at
//! that URL therefore works as a browser tab does, with no bridge: the page gets no Tauri API
//! (no capability grants it one). Until the designer answers, the window shows a bundled page
//! (`waiting/index.html`) that says how to start it, and moves to the designer once it's up.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use tauri::{Url, WebviewUrl, WebviewWindowBuilder};

const DEFAULT_URL: &str = "http://localhost:4400/__trivia/";
const POLL: Duration = Duration::from_millis(500);
const USAGE: &str = "usage: trivia_shell [designer-url]

Opens the Trivia designer in a native window. The URL is the first argument, else
$TRIVIA_DESIGNER_URL, else http://localhost:4400/__trivia/. Start the designer with
`pnpm --filter @trivia/designer dev` (and the user's app with the Trivia Vite plugin).";

fn main() {
    let url = match designer_url(std::env::args().skip(1), std::env::var("TRIVIA_DESIGNER_URL").ok()) {
        Ok(Some(url)) => url,
        Ok(None) => {
            println!("{USAGE}");
            return;
        }
        Err(why) => {
            eprintln!("trivia_shell: {why}\n\n{USAGE}");
            std::process::exit(2);
        }
    };
    tauri::Builder::default()
        .setup(move |app| {
            let up = answers(&url);
            let start = if up { WebviewUrl::External(url.clone()) } else { WebviewUrl::App(waiting_page(&url).into()) };
            let window = WebviewWindowBuilder::new(app, "designer", start)
                .title("Trivia")
                .inner_size(1440.0, 900.0)
                .min_inner_size(800.0, 500.0)
                .build()?;
            if !up {
                std::thread::spawn(move || {
                    while !answers(&url) {
                        std::thread::sleep(POLL);
                    }
                    if let Err(error) = window.navigate(url.clone()) {
                        eprintln!("trivia_shell: could not open {url}: {error}");
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the Trivia shell failed to start its window");
}

/// The designer's URL from the arguments or the environment, or None for `--help`.
fn designer_url(mut args: impl Iterator<Item = String>, env: Option<String>) -> Result<Option<Url>, String> {
    let given = match args.next() {
        Some(flag) if flag == "-h" || flag == "--help" => return Ok(None),
        Some(arg) => {
            if let Some(extra) = args.next() {
                return Err(format!("unexpected argument {extra:?}: pass one URL"));
            }
            arg
        }
        None => env.filter(|v| !v.is_empty()).unwrap_or_else(|| DEFAULT_URL.to_string()),
    };
    let url = Url::parse(&given).map_err(|e| format!("{given:?} is not a URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(format!("{given:?} is not an http(s) URL"));
    }
    Ok(Some(url))
}

/// The bundled waiting page, told which URL it is waiting for.
fn waiting_page(url: &Url) -> String {
    let mut page = Url::parse("http://shell/index.html").expect("a fixed URL");
    page.query_pairs_mut().append_pair("target", url.as_str());
    format!("index.html?{}", page.query().unwrap_or_default())
}

/// Whether a server at `url` answers a GET for it with a success or a redirect. Plain HTTP
/// over std, so the shell needs no HTTP client; https is taken as up once its port accepts.
fn answers(url: &Url) -> bool {
    let (Some(host), Some(port)) = (url.host_str(), url.port_or_known_default()) else { return false };
    let Some(addr) = (host, port).to_socket_addrs().ok().and_then(|mut a| a.next()) else { return false };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, POLL) else { return false };
    if url.scheme() == "https" {
        return true;
    }
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let target = match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_string(),
    };
    let request = format!("GET {target} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 12];
    stream.read_exact(&mut head).is_ok() && status_ok(&head)
}

/// `HTTP/1.x 2xx` or `3xx`.
fn status_ok(head: &[u8]) -> bool {
    head.starts_with(b"HTTP/1.") && head.len() >= 10 && matches!(head[9], b'2' | b'3')
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;

    use super::*;

    fn args(list: &[&str]) -> impl Iterator<Item = String> {
        list.iter().map(|s| s.to_string()).collect::<Vec<_>>().into_iter()
    }

    #[test]
    fn takes_the_url_from_the_argument_then_the_environment_then_the_default() {
        let env = Some("http://127.0.0.1:4500/__trivia/".to_string());
        let url = |a: &[&str], e: Option<String>| designer_url(args(a), e).unwrap().unwrap().to_string();
        assert_eq!(url(&["http://localhost:4411/__trivia/"], env.clone()), "http://localhost:4411/__trivia/");
        assert_eq!(url(&[], env), "http://127.0.0.1:4500/__trivia/");
        assert_eq!(url(&[], Some(String::new())), DEFAULT_URL);
        assert_eq!(url(&[], None), DEFAULT_URL);
        assert!(designer_url(args(&["--help"]), None).unwrap().is_none());
    }

    #[test]
    fn refuses_what_is_not_one_http_url() {
        for bad in [&["localhost:4400"][..], &["file:///etc/passwd"], &["not a url"], &["http://a/", "http://b/"]] {
            assert!(designer_url(args(bad), None).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn tells_the_waiting_page_its_target() {
        let url = Url::parse("http://localhost:4400/__trivia/?a=1&b=2").unwrap();
        assert_eq!(waiting_page(&url), "index.html?target=http%3A%2F%2Flocalhost%3A4400%2F__trivia%2F%3Fa%3D1%26b%3D2");
    }

    #[test]
    fn reads_the_status_line() {
        assert!(status_ok(b"HTTP/1.1 200 OK"));
        assert!(status_ok(b"HTTP/1.1 302 Found"));
        assert!(!status_ok(b"HTTP/1.1 404 Not Found"));
        assert!(!status_ok(b"HTTP/1.1 502 Bad Gateway"));
        assert!(!status_ok(b"SSH-2.0-Open"));
    }

    #[test]
    fn knows_whether_the_designer_answers() {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!("http://{}/__trivia/", server.local_addr().unwrap())).unwrap();
        let reply = |status: &'static str| {
            let (mut conn, _) = server.accept().unwrap();
            let mut buf = [0u8; 1024];
            let n = conn.read(&mut buf).unwrap();
            assert!(String::from_utf8_lossy(&buf[..n]).starts_with("GET /__trivia/ HTTP/1.1\r\n"));
            conn.write_all(status.as_bytes()).unwrap();
        };
        std::thread::scope(|s| {
            s.spawn(|| reply("HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n"));
            assert!(answers(&url));
        });
        std::thread::scope(|s| {
            s.spawn(|| reply("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n"));
            assert!(!answers(&url));
        });
        let closed = Url::parse(&format!("http://{}/", server.local_addr().unwrap())).unwrap();
        drop(server);
        assert!(!answers(&closed));
    }
}
