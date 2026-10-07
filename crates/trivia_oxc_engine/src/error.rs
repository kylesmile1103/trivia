use serde::Serialize;

/// Every engine failure is loud and specific; nothing is papered over with a guess.
#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("invalid locator `{0}` (expected `<file>#<component>#<i.j.k>`)")]
    InvalidLocator(String),
    #[error("no JSX node at `{0}`")]
    NodeNotFound(String),
    #[error("stale locator `{locator}`: expected <{expected}> but found <{found}>; re-select and retry")]
    StaleLocator { locator: String, expected: String, found: String },
    #[error("cannot parse {file}: {message}")]
    Parse { file: String, message: String },
    #[error("{0}")]
    Unsupported(String),
    #[error("invalid snippet: {0}")]
    InvalidSnippet(String),
    #[error("component <{0}> is not imported in this file; pass an import for it")]
    UnresolvedComponent(String),
    #[error("refusing to write: the edit would produce invalid code ({0})")]
    InvalidResult(String),
    #[error("invalid op: {0}")]
    InvalidOp(String),
    #[error("path `{0}` must be a .tsx/.jsx file inside the project root")]
    PathOutsideRoot(String),
    /// The file on disk is not the text the caller based its write on (edited elsewhere).
    #[error("{0}")]
    Conflict(String),
    #[error("{path}: {source}")]
    Io { path: String, source: std::io::Error },
    #[error("internal engine error: {0}")]
    Internal(String),
}

impl EngineError {
    /// Stable machine-readable code for the HTTP/napi boundary.
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidLocator(_) => "invalid_locator",
            Self::NodeNotFound(_) => "node_not_found",
            Self::StaleLocator { .. } => "stale_locator",
            Self::Parse { .. } => "parse_error",
            Self::Unsupported(_) => "unsupported",
            Self::InvalidSnippet(_) => "invalid_snippet",
            Self::UnresolvedComponent(_) => "unresolved_component",
            Self::InvalidResult(_) => "invalid_result",
            Self::InvalidOp(_) => "invalid_op",
            Self::PathOutsideRoot(_) => "path_outside_root",
            Self::Conflict(_) => "conflict",
            Self::Io { .. } => "io_error",
            Self::Internal(_) => "internal",
        }
    }

    pub fn to_payload(&self) -> ErrorPayload {
        ErrorPayload { code: self.code(), message: self.to_string() }
    }
}

#[derive(Debug, Serialize)]
pub struct ErrorPayload {
    pub code: &'static str,
    pub message: String,
}

pub type Result<T, E = EngineError> = std::result::Result<T, E>;
