//! Node.js binding for the Trivia engine. Everything except `annotate` crosses the boundary
//! as JSON: `{ "ok": true, "data": … }` or `{ "ok": false, "error": { code, message } }`.
//!
//! Error codes are the engine's (`EngineError::code`) plus `conflict`: a guarded write found
//! the file changed since it was read (typically an edit in the user's IDE) and wrote nothing.
//!
//! Every call is synchronous for the caller but runs on its own thread with [`ENGINE_STACK`]
//! of stack (see there), and a panic in the engine comes back as an `internal` error (thrown
//! by `annotate`) instead of aborting Node.

use std::thread;

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use trivia_oxc_engine::{self as engine, EngineError, Op, Workspace};

/// Stack for each engine call. OXC's parser and the engine's AST walks recurse once per
/// nesting level of the source, also through operator chains with no bracket at all
/// (release build, darwin-arm64: 1.3 to 2.6 KB per bracket level, 0.7 to 1.3 KB per ternary
/// or arrow, 0.5 KB per JSX element). A stack overflow cannot be caught: it kills the user's
/// dev server. The JS main thread (8 MiB, shared with V8) overflowed at about 5 000 brackets
/// or 18 000 elements, and a 64 MiB thread at 50 000 brackets or 100 000 ternaries; this
/// holds 200 000 brackets and 400 000 ternaries (`test/deep-nesting.mjs`).
///
/// It is address space, not memory: only the pages a call touches are committed, and the
/// stack is unmapped when the call's thread exits. On macOS an ordinary call's peak RSS is
/// the same as with 64 MiB. No fixed stack fits arbitrary nesting (400 000 nested brackets
/// still overflow this one), so text the HTTP API receives also needs a cap before it is
/// parsed (snippets in `ops/insert.rs`, `optionsArgs` in `ops/bind_query.rs`).
const ENGINE_STACK: usize = 512 * 1024 * 1024;

/// Run `work` on a new thread with [`ENGINE_STACK`] of stack and wait for its result. A
/// panic comes back as `Err` with its message.
fn on_engine_thread<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    let worker = thread::Builder::new()
        .name("trivia-engine".into())
        .stack_size(ENGINE_STACK)
        .spawn(work)
        .map_err(|e| format!("internal engine error: cannot start an engine thread: {e}"))?;
    worker.join().map_err(|payload| {
        let reason = payload
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "no message".into());
        format!("internal engine error: the engine panicked: {reason}")
    })
}

/// An envelope-returning call, run by [`on_engine_thread`]; a panic is an `internal` error.
fn engine_call(work: impl FnOnce() -> Result<Value, Failure> + Send + 'static) -> String {
    envelope(on_engine_thread(work).unwrap_or_else(|message| Err(Failure { code: "internal", message })))
}

/// A `data-ast-node` insertion. `offset` is in UTF-16 code units (JavaScript string index).
#[napi(object)]
pub struct Insertion {
    pub offset: u32,
    pub text: String,
}

/// Locator insertions for one file. Throws when the file does not parse, so the caller can
/// leave the file untransformed and let Vite report the syntax error itself.
#[napi]
pub fn annotate(code: String, file: String) -> napi::Result<Vec<Insertion>> {
    annotate_on_engine_thread(code, file).map_err(napi::Error::from_reason)
}

/// [`annotate`] without the `napi::Error`, which only links inside Node.
fn annotate_on_engine_thread(code: String, file: String) -> Result<Vec<Insertion>, String> {
    on_engine_thread(move || {
        engine::annotate_utf16(&code, &file)
            .map(|list| list.into_iter().map(|i| Insertion { offset: i.offset, text: i.text }).collect())
            .map_err(|e| e.to_string())
    })?
}

/// A failure at the binding boundary: an engine error, or a guarded write that lost a race.
struct Failure {
    code: &'static str,
    message: String,
}

impl From<EngineError> for Failure {
    fn from(e: EngineError) -> Self {
        Self { code: e.code(), message: e.to_string() }
    }
}

impl Failure {
    fn conflict(file: &str) -> Self {
        Self {
            code: "conflict",
            message: format!("{file} changed on disk since the designer read it; refusing to overwrite that edit"),
        }
    }
}

fn envelope(result: Result<Value, Failure>) -> String {
    match result {
        Ok(data) => json!({ "ok": true, "data": data }),
        Err(f) => json!({ "ok": false, "error": { "code": f.code, "message": f.message } }),
    }
    .to_string()
}

fn to_value<T: serde::Serialize>(v: T) -> Result<Value, EngineError> {
    serde_json::to_value(v).map_err(|e| EngineError::Internal(e.to_string()))
}

/// Apply an op (JSON, see `Op`) to the project at `root`. `data` is
/// `{ file, changed, locator, before, after }`; `before`/`after` feed the undo history.
#[napi]
pub fn apply_op(root: String, op_json: String) -> String {
    engine_call(move || {
        let op: Op = serde_json::from_str(&op_json).map_err(|e| EngineError::InvalidOp(e.to_string()))?;
        let applied = Workspace::new(&root)?.apply(&op)?;
        let mut data = to_value(&applied.outcome)?;
        data["before"] = Value::String(applied.before);
        data["after"] = Value::String(applied.outcome.code);
        Ok(data)
    })
}

/// A file's text across a transaction (`None`: the file doesn't exist).
struct Working {
    file: String,
    before: Option<String>,
    current: Option<String>,
}

/// One file's net change, for the undo history: `before: null` for a file the batch created.
#[derive(Serialize)]
struct Change {
    file: String,
    before: Option<String>,
    after: Option<String>,
}

/// Apply `ops_json` (a JSON array of `Op`) as one transaction. The ops run in order on the
/// in-memory text, each seeing the previous one's result; only then is every changed file
/// written, all-or-nothing (see `commit`). A failing op therefore leaves the disk untouched.
///
/// `data` is `{ file, changed, locator, changes: [{ file, before, after }] }`: `file` and
/// `locator` come from the last op, `changes` lists each file whose text differs from before
/// the batch, and `changed` is true when that list is non-empty.
#[napi]
pub fn apply_ops(root: String, ops_json: String) -> String {
    engine_call(move || {
        let ops: Vec<Value> = serde_json::from_str(&ops_json)
            .map_err(|e| EngineError::InvalidOp(format!("expected a JSON array of ops: {e}")))?;
        if ops.is_empty() {
            return Err(EngineError::InvalidOp("a batch needs at least one op".into()).into());
        }
        let ws = Workspace::new(&root)?;
        let total = ops.len();
        let mut files: Vec<Working> = Vec::new();
        let mut last = None;
        for (i, raw) in ops.into_iter().enumerate() {
            // Name the failing op when there is more than one.
            let step = |e: EngineError| {
                let mut f = Failure::from(e);
                if total > 1 {
                    f.message = format!("op {} of {total}: {}", i + 1, f.message);
                }
                f
            };
            let op: Op = serde_json::from_value(raw).map_err(|e| step(EngineError::InvalidOp(e.to_string())))?;
            let creates = matches!(op, Op::CreateFile { .. });
            let mut slots = Vec::new();
            for file in op.files().map_err(step)? {
                let slot = match files.iter().position(|w| w.file == file) {
                    Some(slot) => slot,
                    None => {
                        // Only a createFile may name a file that doesn't exist yet.
                        let text = if creates && !ws.exists(&file).map_err(step)? { None } else { Some(ws.read(&file).map_err(step)?) };
                        files.push(Working { file: file.clone(), before: text.clone(), current: text });
                        files.len() - 1
                    }
                };
                slots.push(slot);
            }
            let text = |slot: usize| files[slot].current.clone().ok_or_else(|| step(EngineError::Internal(format!("{} is missing", files[slot].file))));
            let outcome = match (&op, &slots[..]) {
                (Op::CreateFile { file, content, if_missing }, [slot]) => {
                    if *if_missing && let Some(existing) = &files[*slot].current {
                        engine::ops::created(file, content).map_err(step)?;
                        last = Some(engine::Outcome { file: file.clone(), changed: false, locator: None, code: existing.clone() });
                        continue;
                    }
                    if files[*slot].current.is_some() {
                        return Err(step(EngineError::Conflict(format!("{file} already exists; createFile never overwrites a file"))));
                    }
                    let mut outcome = engine::ops::created(file, content).map_err(step)?;
                    files[*slot].current = Some(std::mem::take(&mut outcome.code));
                    outcome
                }
                (_, [slot]) => {
                    let mut outcome = engine::apply_op(&text(*slot)?, &files[*slot].file, &op).map_err(step)?;
                    if outcome.changed {
                        files[*slot].current = Some(std::mem::take(&mut outcome.code));
                    }
                    outcome
                }
                // A move to another file edits both (`apply_across`).
                (_, [from, to]) => {
                    let across = engine::apply_across(&text(*from)?, &files[*from].file, &text(*to)?, &files[*to].file, &op)
                        .map_err(step)?;
                    files[*from].current = Some(across.from);
                    let mut outcome = across.to;
                    files[*to].current = Some(std::mem::take(&mut outcome.code));
                    outcome
                }
                _ => unreachable!("an op edits one or two files"),
            };
            last = Some(outcome);
        }
        let last = last.expect("ops is non-empty");
        let changes: Vec<Change> = files
            .into_iter()
            .filter(|w| w.current != w.before)
            .map(|w| Change { file: w.file, before: w.before, after: w.current })
            .collect();
        let writes: Vec<Write> = changes
            .iter()
            .map(|c| Write { file: c.file.clone(), expected: c.before.clone(), content: c.after.clone() })
            .collect();
        commit(&ws, &writes)?;
        Ok(json!({
            "file": last.file,
            "changed": !changes.is_empty(),
            "locator": last.locator,
            "changes": to_value(&changes)?,
        }))
    })
}

/// Node details for the inspector.
#[napi]
pub fn inspect(root: String, locator: String) -> String {
    engine_call(move || {
        Workspace::new(&root).and_then(|ws| ws.inspect(&locator)).and_then(to_value).map_err(Failure::from)
    })
}

/// Every JSX tree of `file` (project-relative), with locators: `OutlineNode[]`.
#[napi]
pub fn outline(root: String, file: String) -> String {
    engine_call(move || Workspace::new(&root).and_then(|ws| ws.outline(&file)).and_then(to_value).map_err(Failure::from))
}

/// The scopes of `file` (project-relative) with their top-level bindings and hook calls,
/// as value trees: `ScopeValues[]`.
#[napi]
pub fn describe_values(root: String, file: String) -> String {
    engine_call(move || Workspace::new(&root).and_then(|ws| ws.describe_values(&file)).and_then(to_value).map_err(Failure::from))
}

/// The value at a value path (`<file>#<scope>#<path>`), unwrapped to its literal.
#[napi]
pub fn describe_value(root: String, path: String) -> String {
    engine_call(move || Workspace::new(&root).and_then(|ws| ws.describe_value(&path)).and_then(to_value).map_err(Failure::from))
}

/// Prop schemas for every component file in `ui_dir`.
#[napi]
pub fn components(root: String, ui_dir: String, import_base: String) -> String {
    engine_call(move || {
        Workspace::new(&root)
            .and_then(|ws| ws.components(&ui_dir, &import_base))
            .and_then(to_value)
            .map_err(Failure::from)
    })
}

/// One guarded write: replace `file` with `content` only if it still equals `expected`.
/// `expected: null` means the file must not exist (it is created); `content: null` deletes it.
#[derive(Deserialize)]
struct Write {
    file: String,
    expected: Option<String>,
    content: Option<String>,
}

/// Write every file or none. All guards are checked before the first write; if a write still
/// fails, the files already written get their previous text back.
fn commit(ws: &Workspace, writes: &[Write]) -> Result<(), Failure> {
    for w in writes {
        let now = if ws.exists(&w.file)? { Some(ws.read(&w.file)?) } else { None };
        if now != w.expected {
            return Err(Failure::conflict(&w.file));
        }
    }
    for (i, w) in writes.iter().enumerate() {
        if let Err(e) = put(ws, &w.file, w.expected.as_deref(), w.content.as_deref()) {
            // A guard that fails only now means the file changed between the check above and
            // this write.
            let mut failure = match e {
                EngineError::Unsupported(_) | EngineError::Conflict(_) => Failure::conflict(&w.file),
                e => Failure::from(e),
            };
            for done in writes[..i].iter().rev() {
                if let Err(e) = put(ws, &done.file, done.content.as_deref(), done.expected.as_deref()) {
                    failure.message.push_str(&format!(
                        "; rolling back {} also failed ({e}), so it keeps the new content",
                        done.file
                    ));
                }
            }
            return Err(failure);
        }
    }
    Ok(())
}

/// Take `file` from `from` to `to` (`None`: absent), guarded by `from`.
fn put(ws: &Workspace, file: &str, from: Option<&str>, to: Option<&str>) -> Result<(), EngineError> {
    match (from, to) {
        (Some(from), Some(to)) => ws.restore(file, from, to),
        (None, Some(to)) => ws.create(file, to),
        (Some(from), None) => ws.remove_file(file, from),
        (None, None) => Ok(()),
    }
}

/// Guarded undo/redo write: replace `file` with `content` only if it still equals `expected`,
/// else fail with `conflict` and write nothing.
#[napi]
pub fn restore(root: String, file: String, expected: String, content: String) -> String {
    engine_call(move || {
        Workspace::new(&root)
            .map_err(Failure::from)
            .and_then(|ws| commit(&ws, &[Write { file, expected: Some(expected), content: Some(content) }]))
            .map(|()| Value::Null)
    })
}

/// All-or-nothing [`restore`] of several files (a multi-file history entry). `writes_json` is
/// `[{ file, expected, content }]`, written in that order.
#[napi]
pub fn restore_files(root: String, writes_json: String) -> String {
    engine_call(move || {
        let writes: Vec<Write> = serde_json::from_str(&writes_json)
            .map_err(|e| EngineError::InvalidOp(format!("expected [{{ file, expected, content }}]: {e}")))?;
        commit(&Workspace::new(&root)?, &writes)?;
        Ok(Value::Null)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A project root with `src/App.tsx` = `src`, removed on drop.
    struct Project(std::path::PathBuf);

    impl Project {
        fn new(name: &str, src: &str) -> Self {
            let root = std::env::temp_dir().join(format!("trivia-napi-{name}-{}", std::process::id()));
            std::fs::create_dir_all(root.join("src")).unwrap();
            std::fs::write(root.join("src/App.tsx"), src).unwrap();
            Self(root)
        }

        fn root(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }

    impl Drop for Project {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn data(json: &str) -> Value {
        let v: Value = serde_json::from_str(json).unwrap();
        assert_eq!(v["ok"], true, "{json:.300}");
        v["data"].clone()
    }

    /// The caller's stack (libtest gives each test thread 2 MiB) never holds the parser's
    /// recursion, which needs several times that for a file this deep.
    #[test]
    fn deeply_nested_files_do_not_overflow_the_callers_stack() {
        let depth = 5_000;
        let src = format!(
            "export function App() {{\n  return <div>{{{}1{}}}</div>\n}}\n",
            "(".repeat(depth),
            ")".repeat(depth)
        );
        assert_eq!(annotate_on_engine_thread(src.clone(), "src/App.tsx".into()).unwrap().len(), 1);

        let project = Project::new("deep", &src);
        let op = json!({ "op": "updateProp", "target": "src/App.tsx#App#0", "expectedName": "div", "prop": "id", "value": "x" });
        assert_eq!(data(&apply_ops(project.root(), json!([op]).to_string()))["changed"], true);
        assert_eq!(data(&inspect(project.root(), "src/App.tsx#App#0".into()))["name"], "div");
    }

    #[test]
    fn an_engine_panic_is_an_internal_error_not_an_abort() {
        let json = engine_call(|| panic!("index out of bounds in the engine"));
        let v: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["ok"], false, "{json}");
        assert_eq!(v["error"]["code"], "internal");
        let message = v["error"]["message"].as_str().unwrap();
        assert!(message.contains("panicked") && message.contains("index out of bounds in the engine"), "{message}");

        // A formatted (`String`) payload keeps its text too; `annotate` throws it.
        let err = on_engine_thread(|| -> () { panic!("bad offset {}", 7) }).unwrap_err();
        assert!(err.ends_with("panicked: bad offset 7"), "{err}");
    }

    #[test]
    fn results_and_errors_cross_the_thread_unchanged() {
        // `annotate`'s caller recognises syntax errors by this prefix.
        let err = annotate_on_engine_thread("<div".into(), "src/App.tsx".into()).err().unwrap();
        assert!(err.starts_with("cannot parse src/App.tsx: "), "{err}");
        let project = Project::new("errors", "export const App = () => <div />\n");
        let v: Value = serde_json::from_str(&inspect(project.root(), "src/App.tsx#App#9".into())).unwrap();
        assert_eq!(v["error"]["code"], "node_not_found", "{v}");
    }
}
