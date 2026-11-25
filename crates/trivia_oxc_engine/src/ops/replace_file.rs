use oxc_allocator::Allocator;
use sha2::{Digest, Sha256};

use super::Outcome;
use crate::error::{EngineError, Result};
use crate::parse;

/// Compare the exact UTF-8 bytes on disk before considering the replacement.
pub(super) fn replace_file(source: &str, file: &str, expected_hash: &str, content: &str) -> Result<Outcome> {
    let actual = format!("sha256:{:x}", Sha256::digest(source.as_bytes()));
    if actual != expected_hash {
        return Err(EngineError::Conflict(format!("{file} has hash {actual}, expected {expected_hash}")));
    }

    // A history entry (and a failed batch's rollback) must be able to restore the old code.
    parse(&Allocator::default(), source, file)?;
    if source != content {
        parse(&Allocator::default(), content, file)?;
    }
    Ok(Outcome { file: file.to_string(), changed: source != content, locator: None, code: content.to_string() })
}
