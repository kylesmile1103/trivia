//! The pure Rust compiler for blueprint expressions.

#[doc(hidden)]
pub mod parse;

#[doc(hidden)]
mod utf16;
mod subset;
mod allow;
mod scope;
mod deps;
mod graph;

use std::{collections::BTreeMap, sync::Arc};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct Scope {
    pub roots: BTreeMap<String, Root>,
    pub locals: Locals,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Root {
    pub tier: RootTier,
    pub members: Option<Members>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Members {
    Names(Vec<String>),
    Shaped(BTreeMap<String, Option<Members>>),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Locals {
    Names(Vec<String>),
    Tiered(BTreeMap<String, Tier>),
}

impl Default for Locals {
    fn default() -> Self { Self::Names(Vec::new()) }
}

impl Locals {
    pub fn tier(&self, name: &str) -> Option<Tier> {
        match self {
            Self::Names(names) => names.iter().any(|local| local == name).then_some(Tier::Client),
            Self::Tiered(tiers) => tiers.get(name).copied(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    #[default]
    Static,
    Server,
    Client,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RootTier {
    Static,
    Server,
    Client,
    Query,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ExpressionInput {
    pub id: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defines: Option<String>,
    #[serde(default)]
    pub locals: Locals,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AnalyzeRequest {
    #[serde(default)]
    pub scope: Scope,
    pub expressions: Vec<ExpressionInput>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    Utf16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Diagnostic {
    pub code: &'static str,
    pub severity: Severity,
    pub start: usize,
    pub end: usize,
    #[serde(serialize_with = "serialize_message")]
    pub message: Arc<str>,
}

fn serialize_message<S: serde::Serializer>(message: &Arc<str>, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(message)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Analysis {
    pub id: String,
    pub ok: bool,
    pub deps: Vec<String>,
    pub tier: Tier,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct AnalyzeResponse {
    pub unit: Unit,
    pub results: Vec<Analysis>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmitRequest {
    pub expressions: Vec<ExpressionInput>,
    #[serde(default)]
    pub rename: BTreeMap<String, String>,
    #[serde(default)]
    pub arrow_body: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RenameRequest {
    pub expressions: Vec<ExpressionInput>,
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct EmitResult {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct EmitResponse {
    pub unit: Unit,
    pub results: Vec<EmitResult>,
}

const MAX_EXPRESSIONS: usize = 10_000;

impl Diagnostic {
    fn at(source: &str, code: &'static str, severity: Severity, span: oxc_span::Span, message: impl Into<Arc<str>>) -> Self {
        let (start, end) = utf16::to_utf16(source, span);
        Self { code, severity, start, end, message: message.into() }
    }

    fn from_parse(source: &str, error: parse::ParseError) -> Self {
        Self::at(source, error.code, Severity::Error, error.span, error.message)
    }

    fn batch_limit() -> Self {
        Self {
            code: "expr_too_large", severity: Severity::Error, start: 0, end: 0,
            message: "Batch exceeds 10 000 expressions".into(),
        }
    }
}

pub fn analyze(request: AnalyzeRequest) -> AnalyzeResponse {
    let mut results: Vec<_> = request.expressions.iter().enumerate().map(|(index, input)| {
        let source = &input.source;
        let (diagnostics, reads) = if index >= MAX_EXPRESSIONS {
            (vec![Diagnostic::batch_limit()], deps::Reads::default())
        } else {
            parse::parse(source, |expression| subset::check(source, expression, scope::ScopeCheck {
                scope: &request.scope, locals: &input.locals,
            }))
                .unwrap_or_else(|error| (vec![Diagnostic::from_parse(source, error)], deps::Reads::default()))
        };
        let ok = diagnostics.iter().all(|diagnostic| diagnostic.severity != Severity::Error);
        Analysis { id: input.id.clone(), ok, deps: reads.deps, tier: reads.tier, diagnostics }
    }).collect();
    deps::propagate_query_tiers(&request, &mut results);
    graph::report_cycles(&request, &mut results);
    AnalyzeResponse { unit: Unit::Utf16, results }
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    use serde_json::{from_str, json, to_value};

    #[test]
    fn fr_ex_08_page_scope_and_expression_wire_format() {
        let request: AnalyzeRequest = from_str(r#"{
            "scope": {
                "roots": {
                    "params": {"tier":"server", "members":["id"]},
                    "search": {"tier":"server", "members":null},
                    "data": {"tier":"query", "members":["customers"]},
                    "ui": {"tier":"client", "members":{"search":["value"]}}
                },
                "locals":["row"]
            },
            "expressions":[{"id":"/a","source":"data.customers","defines":"data.orders","locals":{"item":"server"}}]
        }"#).unwrap();
        assert_eq!(request.scope.roots["data"].tier, RootTier::Query);
        assert_eq!(request.scope.roots["search"].members, None);
        assert_eq!(request.scope.roots["ui"].members, Some(Members::Shaped(BTreeMap::from([
            ("search".into(), Some(Members::Names(vec!["value".into()]))),
        ]))));
        assert_eq!(request.scope.locals.tier("row"), Some(Tier::Client));
        assert_eq!(request.expressions[0].locals.tier("item"), Some(Tier::Server));
        assert_eq!(request.expressions[0].defines.as_deref(), Some("data.orders"));
    }

    #[test]
    fn fr_ex_08_response_labels_diagnostic_units() {
        let response = AnalyzeResponse {
            unit: Unit::Utf16,
            results: vec![Analysis {
                id: "/a".into(), ok: false, deps: vec![], tier: Tier::Static,
                diagnostics: vec![Diagnostic {
                    code: "expr_unknown_root", severity: Severity::Error,
                    start: 1, end: 5, message: "Unknown root".into(),
                }],
            }],
        };
        assert_eq!(to_value(response).unwrap(), json!({
            "unit": "utf16",
            "results": [{"id":"/a", "ok":false, "deps":[], "tier":"static", "diagnostics":[{
                "code":"expr_unknown_root", "severity":"error", "start":1, "end":5, "message":"Unknown root"
            }]}]
        }));
        let emitted = EmitResult { id: "/a".into(), ts: Some("42".into()), diagnostics: vec![] };
        assert_eq!(to_value(emitted).unwrap(), json!({"id":"/a", "ts":"42"}));
    }
}
