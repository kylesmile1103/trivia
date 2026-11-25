use napi_derive::napi;
use serde::{Serialize, de::DeserializeOwned};

use crate::{Failure, engine_call, to_value};

/// Analyze a batch of blueprint expressions. Diagnostics use UTF-16 offsets.
#[napi]
pub fn analyze_expressions(request_json: String) -> String {
    expression_call(request_json, |request| Ok(trivia_expr::analyze(request)))
}

/// Emit a batch of expressions with a caller-provided map of renamed paths.
#[napi]
pub fn emit_expressions(request_json: String) -> String {
    expression_call(request_json, |request| Ok(trivia_expr::emit(request)))
}

/// Rename free `ui` references in a batch of stored blueprint expressions.
#[napi]
pub fn rename_references(request_json: String) -> String {
    expression_call(request_json, |request| {
        trivia_expr::rename_references(request).map_err(|error| invalid_request(error.to_string()))
    })
}

fn expression_call<Req: DeserializeOwned, Res: Serialize>(
    request_json: String, run: impl FnOnce(Req) -> Result<Res, Failure> + Send + 'static,
) -> String {
    engine_call(move || {
        let request = serde_json::from_str(&request_json).map_err(|error| invalid_request(error.to_string()))?;
        Ok(to_value(run(request)?)?)
    })
}

fn invalid_request(message: String) -> Failure {
    Failure { code: "invalid_op", message }
}
