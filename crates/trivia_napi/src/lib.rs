//! Node.js binding for the Trivia engine. Everything except `annotate` crosses the boundary
//! as JSON: `{ "ok": true, "data": … }` or `{ "ok": false, "error": { code, message } }`.
//!
//! Error codes are the engine's (`EngineError::code`) plus `conflict`: a guarded write found
//! the file changed since it was read (typically an edit in the user's IDE) and wrote nothing.

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use trivia_oxc_engine::{self as engine, EngineError, Op, Workspace};

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
    engine::annotate_utf16(&code, &file)
        .map(|list| list.into_iter().map(|i| Insertion { offset: i.offset, text: i.text }).collect())
        .map_err(|e| napi::Error::from_reason(e.to_string()))
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
    envelope((|| {
        let op: Op = serde_json::from_str(&op_json).map_err(|e| EngineError::InvalidOp(e.to_string()))?;
        let applied = Workspace::new(&root)?.apply(&op)?;
        let mut data = to_value(&applied.outcome)?;
        data["before"] = Value::String(applied.before);
        data["after"] = Value::String(applied.outcome.code);
        Ok(data)
    })())
}

/// A file's text across a transaction.
struct Working {
    file: String,
    before: String,
    current: String,
}

/// One file's net change, for the undo history.
#[derive(Serialize)]
struct Change {
    file: String,
    before: String,
    after: String,
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
    envelope((|| {
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
            let file = op.file().map_err(step)?;
            let slot = match files.iter().position(|w| w.file == file) {
                Some(slot) => slot,
                None => {
                    let text = ws.read(&file).map_err(step)?;
                    files.push(Working { file: file.clone(), before: text.clone(), current: text });
                    files.len() - 1
                }
            };
            let mut outcome = engine::apply_op(&files[slot].current, &file, &op).map_err(step)?;
            if outcome.changed {
                files[slot].current = std::mem::take(&mut outcome.code);
            }
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
    })())
}

/// Node details for the inspector.
#[napi]
pub fn inspect(root: String, locator: String) -> String {
    envelope(Workspace::new(&root).and_then(|ws| ws.inspect(&locator)).and_then(to_value).map_err(Failure::from))
}

/// Prop schemas for every component file in `ui_dir`.
#[napi]
pub fn components(root: String, ui_dir: String, import_base: String) -> String {
    envelope(
        Workspace::new(&root)
            .and_then(|ws| ws.components(&ui_dir, &import_base))
            .and_then(to_value)
            .map_err(Failure::from),
    )
}

/// One guarded write: replace `file` with `content` only if it still equals `expected`.
#[derive(Deserialize)]
struct Write {
    file: String,
    expected: String,
    content: String,
}

/// Write every file or none. All guards are checked before the first write; if a write still
/// fails, the files already written get their previous text back.
fn commit(ws: &Workspace, writes: &[Write]) -> Result<(), Failure> {
    for w in writes {
        if ws.read(&w.file)? != w.expected {
            return Err(Failure::conflict(&w.file));
        }
    }
    for (i, w) in writes.iter().enumerate() {
        if let Err(e) = ws.restore(&w.file, &w.expected, &w.content) {
            // `Workspace::restore` reports a failed guard as `Unsupported`: the file changed
            // between the check above and this write.
            let mut failure = match e {
                EngineError::Unsupported(_) => Failure::conflict(&w.file),
                e => Failure::from(e),
            };
            for done in writes[..i].iter().rev() {
                if let Err(e) = ws.restore(&done.file, &done.content, &done.expected) {
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

/// Guarded undo/redo write: replace `file` with `content` only if it still equals `expected`,
/// else fail with `conflict` and write nothing.
#[napi]
pub fn restore(root: String, file: String, expected: String, content: String) -> String {
    envelope(
        Workspace::new(&root)
            .map_err(Failure::from)
            .and_then(|ws| commit(&ws, &[Write { file, expected, content }]))
            .map(|()| Value::Null),
    )
}

/// All-or-nothing [`restore`] of several files (a multi-file history entry). `writes_json` is
/// `[{ file, expected, content }]`, written in that order.
#[napi]
pub fn restore_files(root: String, writes_json: String) -> String {
    envelope((|| {
        let writes: Vec<Write> = serde_json::from_str(&writes_json)
            .map_err(|e| EngineError::InvalidOp(format!("expected [{{ file, expected, content }}]: {e}")))?;
        commit(&Workspace::new(&root)?, &writes)?;
        Ok(Value::Null)
    })())
}
