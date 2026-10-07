//! Node.js binding for the Trivia engine. Everything except `annotate` crosses the boundary
//! as JSON: `{ "ok": true, "data": … }` or `{ "ok": false, "error": { code, message } }`.

use napi_derive::napi;
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

fn envelope(result: Result<Value, EngineError>) -> String {
    match result {
        Ok(data) => json!({ "ok": true, "data": data }),
        Err(e) => json!({ "ok": false, "error": e.to_payload() }),
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

/// Node details for the inspector.
#[napi]
pub fn inspect(root: String, locator: String) -> String {
    envelope(Workspace::new(&root).and_then(|ws| ws.inspect(&locator)).and_then(to_value))
}

/// Prop schemas for every component file in `ui_dir`.
#[napi]
pub fn components(root: String, ui_dir: String, import_base: String) -> String {
    envelope(Workspace::new(&root).and_then(|ws| ws.components(&ui_dir, &import_base)).and_then(to_value))
}

/// Guarded undo/redo write: replace `file` with `content` only if it still equals `expected`.
#[napi]
pub fn restore(root: String, file: String, expected: String, content: String) -> String {
    envelope(Workspace::new(&root).and_then(|ws| ws.restore(&file, &expected, &content)).map(|()| Value::Null))
}
