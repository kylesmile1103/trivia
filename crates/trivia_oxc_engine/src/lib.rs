//! Trivia's mutation engine: deterministic JSX locators and byte-preserving edits on
//! React/TSX source, built on OXC.
//!
//! The AST is used only to *find* things. Every mutation is a set of byte-range edits on the
//! original text, so whitespace and comments outside the edit are untouched (see `CLAUDE.md`,
//! rule 1). Every result is re-parsed before it may be written.

pub mod data_binder;
pub mod error;
pub mod import_manager;
pub mod inspect;
pub mod locator;
pub mod mutator;
pub mod prop_analyzer;
pub mod text;
pub mod workspace;

use oxc_allocator::Allocator;
use oxc_ast::ast::Program;
use oxc_parser::Parser;
use oxc_span::SourceType;

pub use data_binder::{QueryBinding, bind_query};
pub use error::{EngineError, ErrorPayload, Result};
pub use import_manager::ImportSpec;
pub use inspect::{AttrDetails, AttrKind, NodeDetails};
pub use locator::{Insertion, JsxTable, Locator};
pub use mutator::{Op, Outcome, Placement, apply_op};
pub use prop_analyzer::{ComponentSchema, PropKind, PropSchema, PropSource};
pub use workspace::{Applied, Workspace};

/// Parse `source` as the file at `file` (extension picks TS/JSX). Any syntax error fails.
pub fn parse<'a>(alloc: &'a Allocator, source: &'a str, file: &str) -> Result<Program<'a>> {
    let source_type = SourceType::from_path(file).unwrap_or_else(|_| SourceType::tsx());
    let ret = Parser::new(alloc, source, source_type).parse();
    if ret.fatal_error || ret.diagnostics.has_errors() {
        let message = ret.diagnostics.errors().map(ToString::to_string).collect::<Vec<_>>().join("; ");
        return Err(EngineError::Parse {
            file: file.to_string(),
            message: if message.is_empty() { "fatal parse error".into() } else { message },
        });
    }
    Ok(ret.program)
}

/// `data-ast-node` insertions for a file, with offsets in UTF-8 bytes.
pub fn annotate(source: &str, file: &str) -> Result<Vec<Insertion>> {
    let alloc = Allocator::default();
    let program = parse(&alloc, source, file)?;
    Ok(locator::annotate(&program, file))
}

/// Same as [`annotate`] but with offsets in UTF-16 code units, for JavaScript callers.
pub fn annotate_utf16(source: &str, file: &str) -> Result<Vec<Insertion>> {
    let mut insertions = annotate(source, file)?;
    insertions.sort_by_key(|i| i.offset);
    let offsets: Vec<u32> = insertions.iter().map(|i| i.offset).collect();
    for (ins, off) in insertions.iter_mut().zip(text::utf16_offsets(source, &offsets)) {
        ins.offset = off;
    }
    Ok(insertions)
}
