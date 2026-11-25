//! The filesystem layer: nothing outside the project root is ever read or written, writes
//! are atomic (temp file + rename) and keep permissions, failures leave no temp files, and
//! guarded writes refuse to overwrite a file that changed.

#![cfg(unix)]

use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use trivia_oxc_engine::{EngineError, Op, Placement, Workspace};

const APP: &str = "export function App() {\n  return (\n    <main>\n      <h1>Hi</h1>\n    </main>\n  )\n}\n";

/// A unique directory under the system temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("trivia-test-{tag}-{}-{nanos}-{n}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn write(&self, rel: &str, content: &str) -> PathBuf {
        let path = self.0.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        path
    }

    fn mkdir(&self, rel: &str) -> PathBuf {
        let path = self.0.join(rel);
        fs::create_dir_all(&path).unwrap();
        path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A project with `src/App.tsx`.
fn project() -> (TempDir, Workspace) {
    let dir = TempDir::new("ws");
    dir.write("src/App.tsx", APP);
    let ws = Workspace::new(dir.path()).unwrap();
    (dir, ws)
}

fn code(result: Result<impl std::fmt::Debug, EngineError>) -> &'static str {
    result.expect_err("should fail").code()
}

/// File names in `dir` (sorted), so a stray temp file shows up.
fn listing(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    names.sort();
    names
}

fn insert_heading(file: &str) -> Op {
    Op::Insert {
        target: format!("{file}#App#0"),
        expected_name: None,
        placement: Placement::LastChild,
        snippet: "<h2>Added</h2>".into(),
        imports: vec![],
    }
}

#[test]
fn paths_outside_the_root_and_non_tsx_files_are_refused() {
    let (dir, ws) = project();
    let inside = dir.path().canonicalize().unwrap().join("src/App.tsx");
    for rel in [
        "../App.tsx",
        "src/../../App.tsx",
        "src/../src/App.tsx",
        "./src/App.tsx",
        "/etc/hosts.tsx",
        inside.to_str().unwrap(),
        "",
        "src/App.ts",
        "src/App.css",
        "src/App",
        // Inside the root, but not the canonical spelling that locators use.
        "src/App.tsx/",
        "src//App.tsx",
        "src\\App.tsx",
    ] {
        assert_eq!(code(ws.read(rel)), "path_outside_root", "read {rel:?}");
        assert_eq!(code(ws.write_atomic(rel, APP)), "path_outside_root", "write {rel:?}");
        assert_eq!(code(ws.restore(rel, APP, APP)), "path_outside_root", "restore {rel:?}");
    }
    assert_eq!(ws.read("src/App.tsx").unwrap(), APP);
    dir.write("src/Legacy.jsx", APP);
    assert_eq!(ws.read("src/Legacy.jsx").unwrap(), APP);
    // An op's file comes from its locator, so a hostile locator is refused the same way.
    assert_eq!(code(ws.apply(&insert_heading("../App.tsx"))), "path_outside_root");
    assert_eq!(code(ws.inspect("../App.tsx#App#0")), "path_outside_root");
}

#[test]
fn symlinks_must_resolve_inside_the_root() {
    let (dir, ws) = project();
    let outside = TempDir::new("outside");
    let secret = outside.write("secret.tsx", APP);
    symlink(&secret, dir.path().join("src/link.tsx")).unwrap();
    symlink(outside.path(), dir.path().join("src/ext")).unwrap();
    for rel in ["src/link.tsx", "src/ext/secret.tsx"] {
        assert_eq!(code(ws.read(rel)), "path_outside_root", "{rel}");
        assert_eq!(code(ws.write_atomic(rel, "export const X = 1\n")), "path_outside_root", "{rel}");
        assert_eq!(code(ws.apply(&insert_heading(rel))), "path_outside_root", "{rel}");
    }
    assert_eq!(fs::read_to_string(&secret).unwrap(), APP, "the outside file is untouched");

    // A symlink to a file inside the root works, writes go to its target, and it stays a link.
    symlink(dir.path().join("src/App.tsx"), dir.path().join("src/Alias.tsx")).unwrap();
    let applied = ws.apply(&insert_heading("src/Alias.tsx")).unwrap();
    assert!(applied.outcome.changed);
    assert!(fs::read_to_string(dir.path().join("src/App.tsx")).unwrap().contains("<h2>Added</h2>"));
    assert!(fs::symlink_metadata(dir.path().join("src/Alias.tsx")).unwrap().file_type().is_symlink());
}

#[test]
fn missing_and_non_utf8_files_are_io_errors() {
    let (dir, ws) = project();
    assert_eq!(code(ws.read("src/Missing.tsx")), "io_error");
    assert_eq!(code(ws.apply(&insert_heading("src/Missing.tsx"))), "io_error");
    fs::write(dir.path().join("src/Bin.tsx"), [0xff, 0xfe, 0x00]).unwrap();
    assert_eq!(code(ws.read("src/Bin.tsx")), "io_error");
    assert_eq!(code(Workspace::new(dir.path().join("nope"))), "io_error");
}

#[test]
fn apply_writes_atomically_and_keeps_permissions() {
    for mode in [0o640, 0o755, 0o600] {
        let (dir, ws) = project();
        let path = dir.path().join("src/App.tsx");
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
        let inode = fs::metadata(&path).unwrap().ino();

        let applied = ws.apply(&insert_heading("src/App.tsx")).unwrap();
        assert!(applied.outcome.changed);
        assert_eq!(applied.before, APP);
        let now = fs::read_to_string(&path).unwrap();
        assert_eq!(now, applied.outcome.code);
        assert_eq!(now, APP.replace("<h1>Hi</h1>\n", "<h1>Hi</h1>\n      <h2>Added</h2>\n"));
        let meta = fs::metadata(&path).unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, mode, "permissions kept");
        assert_ne!(meta.ino(), inode, "replaced by rename, not rewritten in place");
        assert_eq!(listing(&dir.path().join("src")), ["App.tsx"], "no temp file left");
    }

    // An op that changes nothing does not touch the file.
    let (dir, ws) = project();
    let path = dir.path().join("src/App.tsx");
    let inode = fs::metadata(&path).unwrap().ino();
    let noop = Op::UpdateProp { target: "src/App.tsx#App#0".into(), expected_name: None, prop: "x".into(), value: serde_json::Value::Null };
    assert!(!ws.apply(&noop).unwrap().outcome.changed);
    assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
}

#[test]
fn failed_writes_leave_the_file_and_no_temp_files() {
    let (dir, ws) = project();
    let src = dir.path().join("src");

    // Read-only files are refused, not silently replaced.
    let path = src.join("App.tsx");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
    assert_eq!(code(ws.apply(&insert_heading("src/App.tsx"))), "io_error");
    assert_eq!(fs::read_to_string(&path).unwrap(), APP);
    assert_eq!(listing(&src), ["App.tsx"]);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

    // The rename itself fails (the target is a directory): the temp file is cleaned up.
    dir.mkdir("src/Dir.tsx/inner");
    assert_eq!(code(ws.write_atomic("src/Dir.tsx", APP)), "io_error");
    assert_eq!(listing(&src), ["App.tsx", "Dir.tsx"]);

    // The temp file cannot even be created (read-only directory).
    let locked = dir.mkdir("locked");
    let file = dir.write("locked/Page.tsx", APP);
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
    let result = ws.write_atomic("locked/Page.tsx", "export const X = 1\n");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(code(result), "io_error");
    assert_eq!(fs::read_to_string(&file).unwrap(), APP);
    assert_eq!(listing(&locked), ["Page.tsx"]);
}

#[test]
fn restore_is_guarded_and_never_writes_unparsable_code() {
    let (dir, ws) = project();
    let path = dir.path().join("src/App.tsx");
    let applied = ws.apply(&insert_heading("src/App.tsx")).unwrap();
    let after = applied.outcome.code.clone();

    // Undo: the file still holds what the edit wrote.
    ws.restore("src/App.tsx", &after, APP).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), APP);

    // Redo after someone edited the file: refused, file untouched.
    fs::write(&path, "export const Edited = () => <p />\n").unwrap();
    assert_eq!(code(ws.restore("src/App.tsx", APP, &after)), "conflict");
    assert_eq!(fs::read_to_string(&path).unwrap(), "export const Edited = () => <p />\n");

    // Unparsable content: refused, file untouched.
    let current = fs::read_to_string(&path).unwrap();
    assert_eq!(code(ws.restore("src/App.tsx", &current, "export const = <")), "invalid_result");
    assert_eq!(fs::read_to_string(&path).unwrap(), current);
    assert_eq!(listing(&dir.path().join("src")), ["App.tsx"]);
}

#[test]
fn components_reads_only_a_ui_dir_inside_the_root() {
    let (dir, ws) = project();
    dir.write("src/components/ui/button.tsx", "export function Button() { return <button /> }\n");
    assert!(ws.components("src/components/ui", "@/components/ui").is_ok());
    assert!(ws.components("./src/components/ui/", "@/components/ui").is_ok());
    let outside = TempDir::new("ui-outside");
    outside.write("evil.tsx", APP);
    symlink(outside.path(), dir.path().join("src/linked-ui")).unwrap();
    for ui in ["../ui", "/tmp", "src/../../ui", "", "src/linked-ui"] {
        assert_eq!(code(ws.components(ui, "@/ui")), "path_outside_root", "{ui:?}");
    }
    assert_eq!(code(ws.components("src/missing", "@/ui")), "io_error");
}

#[test]
fn inspect_reads_through_the_workspace() {
    let (_dir, ws) = project();
    let details = ws.inspect("src/App.tsx#App#0.0").unwrap();
    assert_eq!(details.name, "h1");
    assert_eq!(details.text.as_deref(), Some("Hi"));
    assert_eq!(code(ws.inspect("src/App.tsx#App#9")), "node_not_found");
    assert_eq!(code(ws.inspect("garbage")), "invalid_locator");
}

const FORM: &str = "export function CustomerForm() {\n  return <form />\n}\n";

#[test]
fn create_makes_a_new_file_and_its_directories_inside_the_root() {
    let (dir, ws) = project();
    assert!(!ws.exists("src/components/forms/customer-form.tsx").unwrap());
    ws.create("src/components/forms/customer-form.tsx", FORM).unwrap();
    assert_eq!(fs::read_to_string(dir.path().join("src/components/forms/customer-form.tsx")).unwrap(), FORM);
    assert!(ws.exists("src/components/forms/customer-form.tsx").unwrap());
    assert_eq!(listing(&dir.path().join("src/components/forms")), ["customer-form.tsx"], "no temp files left");
}

#[test]
fn create_never_overwrites_and_refuses_what_apply_would() {
    let (dir, ws) = project();
    assert_eq!(code(ws.create("src/App.tsx", FORM)), "conflict");
    assert_eq!(fs::read_to_string(dir.path().join("src/App.tsx")).unwrap(), APP);
    assert_eq!(code(ws.create("../outside.tsx", FORM)), "path_outside_root");
    assert_eq!(code(ws.create("/tmp/abs.tsx", FORM)), "path_outside_root");
    assert_eq!(code(ws.create("src/./x.tsx", FORM)), "path_outside_root");
    assert_eq!(code(ws.create("src/notes.md", "# hi")), "path_outside_root");
    assert_eq!(code(ws.create("src/broken.tsx", "export const A = () => <div>")), "invalid_result");
    assert!(!dir.path().join("src/broken.tsx").exists());
}

#[test]
fn create_refuses_a_directory_symlinked_outside_the_root() {
    let (dir, ws) = project();
    let outside = TempDir::new("outside");
    symlink(outside.path(), dir.path().join("src/escape")).unwrap();
    assert_eq!(code(ws.create("src/escape/x.tsx", FORM)), "path_outside_root");
    assert!(listing(outside.path()).is_empty());
}

#[test]
fn remove_file_is_guarded_by_its_content() {
    let (dir, ws) = project();
    ws.create("src/Form.tsx", FORM).unwrap();
    assert_eq!(code(ws.remove_file("src/Form.tsx", "something else")), "conflict");
    assert!(dir.path().join("src/Form.tsx").exists());
    ws.remove_file("src/Form.tsx", FORM).unwrap();
    assert!(!dir.path().join("src/Form.tsx").exists());
    assert_eq!(code(ws.remove_file("src/Form.tsx", FORM)), "io_error");
}

#[test]
fn create_file_is_an_op_that_apply_runs() {
    let (dir, ws) = project();
    let op: Op = serde_json::from_str(r#"{ "op": "createFile", "file": "src/Form.tsx", "content": "export const F = () => <form />\n" }"#).unwrap();
    assert_eq!(op.files().unwrap(), ["src/Form.tsx"]);
    let applied = ws.apply(&op).unwrap();
    assert!(applied.outcome.changed);
    assert_eq!(applied.outcome.locator, None);
    assert_eq!(fs::read_to_string(dir.path().join("src/Form.tsx")).unwrap(), "export const F = () => <form />\n");
    assert_eq!(code(ws.apply(&op)), "conflict", "a second create finds the file");
}

#[test]
fn create_file_if_missing_keeps_an_existing_file() {
    let (dir, ws) = project();
    let op: Op = serde_json::from_str(r#"{ "op": "createFile", "file": "src/App.tsx", "content": "export const X = () => <i />\n", "ifMissing": true }"#).unwrap();
    let applied = ws.apply(&op).unwrap();
    assert!(!applied.outcome.changed);
    assert_eq!(fs::read_to_string(dir.path().join("src/App.tsx")).unwrap(), APP);
    let fresh: Op = serde_json::from_str(r#"{ "op": "createFile", "file": "src/New.tsx", "content": "export const X = () => <i />\n", "ifMissing": true }"#).unwrap();
    assert!(ws.apply(&fresh).unwrap().outcome.changed);
    assert!(dir.path().join("src/New.tsx").exists());
}


#[test]
fn fr_rc_09_replace_file_checks_the_original_bytes_and_parses_the_replacement() {
    let (dir, ws) = project();
    let file = "src/App.tsx";
    let before = "export const Old = () => <div>café</div>\r\n";
    let after = "export const New = () => <div>new</div>\r\n";
    let old_hash = "sha256:8ee4edc1ba342472bcd80bb951ce4df7ff1124d8c79a36086ba55fa1af1da1cf";
    let new_hash = "sha256:3c002b0267c22e07a13e7d7e69a4f4f265469f897ec5c7bfcd8068cf8ce10a15";
    let op = |file: &str, hash: &str, content: &str| {
        serde_json::from_value::<Op>(serde_json::json!({
            "op": "replaceFile", "file": file, "expectedHash": hash, "content": content,
        })).unwrap()
    };

    dir.write(file, before);
    assert_eq!(code(ws.apply(&op("src/Missing.tsx", old_hash, after))), "file_not_found");
    assert_eq!(code(ws.apply(&op(file, old_hash, "export const = <"))), "parse_error");
    assert_eq!(ws.read(file).unwrap(), before);
    let result = ws.apply(&op(file, old_hash, after)).unwrap();
    assert!(result.outcome.changed);
    assert_eq!(result.outcome.locator, None);
    assert_eq!(result.before, before);
    assert_eq!(result.outcome.code, after);
    assert_eq!(fs::read(dir.path().join(file)).unwrap(), after.as_bytes());

    assert_eq!(code(ws.apply(&op(file, old_hash, before))), "conflict");
    assert_eq!(ws.read(file).unwrap(), after);
    assert!(!ws.apply(&op(file, new_hash, after)).unwrap().outcome.changed);
    assert!(ws.apply(&op(file, new_hash, before)).unwrap().outcome.changed);
    assert_eq!(fs::read(dir.path().join(file)).unwrap(), before.as_bytes());
}
