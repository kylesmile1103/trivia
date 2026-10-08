//! Atomic JSX mutations, each computed as byte-range [`Edit`]s against the original source.
//!
//! Nothing here re-prints the AST: OXC only tells us where things are. New text is limited
//! to the inserted fragment (indented to match its surroundings) and the touched import.
//!
//! Layout rules, chosen so that every edit has an exact inverse (insert → remove, move → move
//! back, set → set back all restore the original bytes; see `tests/roundtrip.rs`):
//! * A node inserted next to a node that sits on its own line gets its own line. Next to
//!   inline content it is inserted inline, with no added whitespace.
//! * Into an element with no content: on its own line when the element already spans two
//!   lines (or the new text is multi-line), else inline (`<div></div>` → `<div><X /></div>`).
//! * Into a self-closing element: `<X a />` becomes `<X a>` + the child on its own line +
//!   `</X>`. This is the one edit whose inverse (removing the child) leaves the expanded
//!   `<X a>` / `</X>` pair rather than `<X a />`.
//! * Moved text keeps its bytes; only its line indentation changes, and never inside
//!   multi-line string or template literals.
//!
//! One module per op, on the shared machinery here (resolving locators, anchoring an
//! insertion, re-parsing and locating the result):
//! * `insert`: `insert` and `insertChild`, with the checks on the snippet;
//! * `update_prop`: `updateProp`;
//! * `set_text`: `setText`;
//! * `remove`: `remove`;
//! * `move_node`: `move` and `moveNode`, with the check that moved code keeps its bindings;
//! * `move_across`: `move` and `moveNode` between two files (`apply_across`);
//! * `bind_query`: `bindQuery`, which parses on its own (it edits a function body too).
//!
//! A new op is a new module here plus its `Op` variant.

use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast::ast::{Program, StringLiteral, TemplateLiteral};
use oxc_ast_visit::{Visit, walk};
use oxc_semantic::{AstNode, AstNodes, SemanticBuilder};
use oxc_span::Span;
use oxc_syntax::symbol::SymbolFlags;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{EngineError, Result};
use crate::import_manager::ImportSpec;
use crate::locator::{JsxNode, JsxTable, Locator, NodeKind};
use crate::parse;
use crate::text::{self, Edit};

pub mod bind_query;
mod insert;
mod move_across;
mod move_node;
mod remove;
mod set_text;
mod update_prop;

pub use insert::{MAX_SNIPPET_BYTES, MAX_SNIPPET_DEPTH, MAX_SNIPPET_TAGS_AND_BRACKETS};
pub use move_across::{AcrossOutcome, apply_across};

/// Where to put a node relative to a target node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Placement {
    Before,
    After,
    FirstChild,
    LastChild,
}

impl Placement {
    fn is_sibling(self) -> bool {
        matches!(self, Placement::Before | Placement::After)
    }
}

/// A serializable edit. This is the single action vocabulary shared by the designer, the
/// HTTP/napi boundary and (later) agents: every change to user code goes through it.
///
/// Every locator an op names can carry the tag name the caller saw there (`expectedName`,
/// `expectedTargetName`, `expectedParentName`): when the locator now resolves to another
/// tag (a hand edit shifted it), the op fails with `stale_locator` instead of editing the
/// wrong node (CLAUDE.md rule 4). Unknown fields are rejected, so a misspelled guard is an
/// error rather than silently no guard.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum Op {
    /// Insert `snippet` (one JSX element) relative to `target`.
    Insert {
        target: String,
        /// Stale-locator guard: the tag name the caller saw at `target`.
        #[serde(default)]
        expected_name: Option<String>,
        placement: Placement,
        snippet: String,
        #[serde(default)]
        imports: Vec<ImportSpec>,
    },
    /// Insert `snippet` before the parent's `index`-th child (`index == len` appends).
    InsertChild {
        parent: String,
        /// Stale-locator guard: the tag name the caller saw at `parent`.
        #[serde(default)]
        expected_name: Option<String>,
        index: usize,
        snippet: String,
        #[serde(default)]
        imports: Vec<ImportSpec>,
    },
    /// Set (`value` = string/bool/number/array/object) or remove (`value` = null) a prop.
    UpdateProp {
        target: String,
        #[serde(default)]
        expected_name: Option<String>,
        prop: String,
        value: Value,
    },
    /// Replace the plain-text content of `target` (`<Button>Save</Button>`), keeping the line
    /// breaks and indentation around it (see `set_text`).
    SetText {
        target: String,
        #[serde(default)]
        expected_name: Option<String>,
        text: String,
    },
    /// Remove a node; imports whose last reference it was are dropped.
    Remove {
        target: String,
        #[serde(default)]
        expected_name: Option<String>,
    },
    /// Move `source` relative to `target` (same file). Refused when the moved code uses a
    /// binding that is not the same one at the destination (see `Doc::check_scope`).
    Move {
        source: String,
        /// Stale-locator guard: the tag name the caller saw at `source`.
        #[serde(default)]
        expected_name: Option<String>,
        target: String,
        /// Stale-locator guard: the tag name the caller saw at `target`.
        #[serde(default)]
        expected_target_name: Option<String>,
        placement: Placement,
    },
    /// Move `source` before the parent's `index`-th child, counted before the move.
    MoveNode {
        source: String,
        /// Stale-locator guard: the tag name the caller saw at `source`.
        #[serde(default)]
        expected_name: Option<String>,
        parent: String,
        /// Stale-locator guard: the tag name the caller saw at `parent`.
        #[serde(default)]
        expected_parent_name: Option<String>,
        index: usize,
    },
    /// Bind an element to a TanStack Query: inject `useQuery` into its component and set its
    /// data/loading props (see `bind_query`).
    BindQuery(bind_query::QueryBinding),
    /// Write a new `.tsx`/`.jsx` file (e.g. a generated form component). Refused when the file
    /// exists or `content` does not parse; undoing it deletes the file.
    CreateFile { file: String, content: String },
}

impl Op {
    /// The file this op edits.
    pub fn file(&self) -> Result<String> {
        if let Op::CreateFile { file, .. } = self {
            return Ok(file.clone());
        }
        let primary = match self {
            Op::Insert { target, .. }
            | Op::UpdateProp { target, .. }
            | Op::SetText { target, .. }
            | Op::Remove { target, .. } => target,
            Op::InsertChild { parent, .. } => parent,
            Op::Move { source, .. } | Op::MoveNode { source, .. } => source,
            Op::BindQuery(binding) => &binding.target,
            Op::CreateFile { .. } => unreachable!("returned above"),
        };
        Ok(Locator::parse(primary)?.file)
    }

    /// Every file this op edits: its own, and for a move whose destination is elsewhere, that
    /// file too (`apply_across`).
    pub fn files(&self) -> Result<Vec<String>> {
        let first = self.file()?;
        let destination = match self {
            Op::Move { target, .. } => Some(Locator::parse(target)?.file),
            Op::MoveNode { parent, .. } => Some(Locator::parse(parent)?.file),
            _ => None,
        };
        Ok(match destination {
            Some(other) if other != first => vec![first, other],
            _ => vec![first],
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub file: String,
    pub changed: bool,
    /// Locator of the inserted, moved or updated node after the edit (`None` after removal).
    pub locator: Option<String>,
    /// The full new source.
    #[serde(skip)]
    pub code: String,
}

/// Apply `op` to `source` (the content of `file`). Pure: no I/O.
pub fn apply_op(source: &str, file: &str, op: &Op) -> Result<Outcome> {
    let alloc = Allocator::default();
    let program = parse(&alloc, source, file)?;
    let table = JsxTable::build(&program, file)?;
    let doc = Doc { src: source, file, program: &program, table: &table };
    match op {
        Op::Insert { target, expected_name, placement, snippet, imports } => {
            let target = table.resolve_expected(&doc.locate(target)?, expected_name.as_deref())?;
            doc.insert(target, *placement, snippet, imports)
        }
        Op::InsertChild { parent, expected_name, index, snippet, imports } => {
            let parent = table.resolve_expected(&doc.locate(parent)?, expected_name.as_deref())?;
            let (target, placement) = doc.index_anchor(parent, *index)?;
            doc.insert(target, placement, snippet, imports)
        }
        Op::UpdateProp { target, expected_name, prop, value } => {
            let target = table.resolve_expected(&doc.locate(target)?, expected_name.as_deref())?;
            doc.update_prop(target, prop, value)
        }
        Op::SetText { target, expected_name, text } => {
            let target = table.resolve_expected(&doc.locate(target)?, expected_name.as_deref())?;
            doc.set_text(target, text)
        }
        Op::Remove { target, expected_name } => {
            let target = table.resolve_expected(&doc.locate(target)?, expected_name.as_deref())?;
            doc.remove(target)
        }
        Op::Move { source: from, expected_name, target, expected_target_name, placement } => {
            let from = table.resolve_expected(&doc.locate(from)?, expected_name.as_deref())?;
            let target = table.resolve_expected(&doc.locate(target)?, expected_target_name.as_deref())?;
            doc.move_to(from, target, *placement)
        }
        Op::MoveNode { source: from, expected_name, parent, expected_parent_name, index } => {
            let from = table.resolve_expected(&doc.locate(from)?, expected_name.as_deref())?;
            let parent = table.resolve_expected(&doc.locate(parent)?, expected_parent_name.as_deref())?;
            let (target, placement) = doc.index_anchor(parent, *index)?;
            doc.move_to(from, target, placement)
        }
        // Parses on its own: it edits a function body and imports, not just JSX.
        Op::BindQuery(binding) => bind_query::bind_query(source, file, binding),
        Op::CreateFile { .. } => Err(EngineError::InvalidOp(
            "createFile writes a new file: apply it through the workspace (applyOps), not to existing text".into(),
        )),
    }
}

/// The outcome of creating `file` with `content`: the content must parse as that file.
pub fn created(file: &str, content: &str) -> Result<Outcome> {
    let alloc = Allocator::default();
    parse(&alloc, content, file).map_err(|e| EngineError::InvalidResult(e.to_string()))?;
    Ok(Outcome { file: file.to_string(), changed: true, locator: None, code: content.to_string() })
}

/// Where an insertion lands, after resolving first/last-child placements.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Anchor {
    Before(usize),
    After(usize),
    /// Right after the opening tag (first content is text or an expression).
    AfterOpening(usize),
    /// Right before the closing tag (last content is text or an expression).
    BeforeClosing(usize),
    /// Inside an element that has no content yet.
    Empty(usize),
    /// Inside a self-closing element, which becomes open/close.
    SelfClosing(usize),
}

impl Anchor {
    fn node(self) -> usize {
        match self {
            Anchor::Before(i)
            | Anchor::After(i)
            | Anchor::AfterOpening(i)
            | Anchor::BeforeClosing(i)
            | Anchor::Empty(i)
            | Anchor::SelfClosing(i) => i,
        }
    }
}

struct Doc<'d, 'a> {
    src: &'d str,
    file: &'d str,
    program: &'d Program<'a>,
    table: &'d JsxTable,
}

impl Doc<'_, '_> {
    fn locate(&self, s: &str) -> Result<Locator> {
        let loc = Locator::parse(s)?;
        if loc.file != self.file {
            return Err(EngineError::Unsupported(format!(
                "`{s}` is in {} but this edit is applied to {}; only a move spans two files, through applyOps",
                loc.file, self.file
            )));
        }
        Ok(loc)
    }

    fn name(&self, idx: usize) -> String {
        format!("<{}>", self.table.nodes[idx].display_name())
    }

    fn index_anchor(&self, parent: usize, index: usize) -> Result<(usize, Placement)> {
        let children = &self.table.nodes[parent].children;
        match index.cmp(&children.len()) {
            std::cmp::Ordering::Less => Ok((children[index], Placement::Before)),
            std::cmp::Ordering::Equal => Ok((parent, Placement::LastChild)),
            std::cmp::Ordering::Greater => Err(EngineError::InvalidOp(format!(
                "index {index} is out of range: {} has {} children",
                self.name(parent),
                children.len()
            ))),
        }
    }

    fn anchor(&self, target: usize, placement: Placement) -> Result<Anchor> {
        let node = &self.table.nodes[target];
        let require_sibling_slot = || -> Result<()> {
            if node.parent.is_none() {
                return Err(EngineError::Unsupported(format!(
                    "{} is the root element of `{}`; a sibling would need a wrapper. Drop inside it instead",
                    self.name(target),
                    node.scope
                )));
            }
            if !node.direct {
                return Err(EngineError::Unsupported(format!(
                    "{} is rendered from a {{…}} expression; siblings cannot be added there",
                    self.name(target)
                )));
            }
            Ok(())
        };
        match placement {
            Placement::Before => require_sibling_slot().map(|()| Anchor::Before(target)),
            Placement::After => require_sibling_slot().map(|()| Anchor::After(target)),
            Placement::FirstChild | Placement::LastChild => {
                if node.kind == NodeKind::Element && node.closing.is_none() {
                    return Ok(Anchor::SelfClosing(target));
                }
                let edge = if placement == Placement::FirstChild { node.content.first() } else { node.content.last() };
                Ok(match edge {
                    None => Anchor::Empty(target),
                    Some(c) => match c.node {
                        Some(child) if self.table.nodes[child].direct => {
                            if placement == Placement::FirstChild { Anchor::Before(child) } else { Anchor::After(child) }
                        }
                        _ if placement == Placement::FirstChild => Anchor::AfterOpening(target),
                        _ => Anchor::BeforeClosing(target),
                    },
                })
            }
        }
    }

    /// The edit that places `text` at `anchor`, plus the offset of `text` within the edit's
    /// replacement. `body(indent)` renders `text` with its lines after the first indented
    /// for a node whose first line is indented by `indent`.
    fn anchor_edit(&self, anchor: Anchor, text: &str, body: &dyn Fn(&str) -> String) -> Result<(Edit, u32)> {
        let src = self.src;
        let nl = text::newline(src);
        let unit = text::indent_unit(src);
        let node = &self.table.nodes[anchor.node()];
        let closing = || {
            node.closing
                .ok_or_else(|| EngineError::Internal(format!("{} has no closing tag", self.name(anchor.node()))))
        };
        Ok(match anchor {
            Anchor::Before(_) => {
                let indent = text::line_indent(src, node.span.start);
                if text::starts_line(src, node.span.start) {
                    (Edit::insert(node.span.start, format!("{}{nl}{indent}", body(indent))), 0)
                } else {
                    (Edit::insert(node.span.start, body(indent)), 0)
                }
            }
            Anchor::After(_) => {
                let indent = text::line_indent(src, node.span.start);
                if text::ends_line(src, node.span.end) && text::starts_line(src, node.span.start) {
                    // Before the line terminator, so trailing whitespace stays on its line.
                    let at = text::line_content_end(src, node.span.end);
                    let prefix = format!("{nl}{indent}");
                    (Edit::insert(at, format!("{prefix}{}", body(indent))), prefix.len() as u32)
                } else {
                    (Edit::insert(node.span.end, body(indent)), 0)
                }
            }
            Anchor::AfterOpening(_) => {
                let first = node.content.first().map_or(node.opening.end, |c| text::skip_whitespace(src, c.span.start));
                if text::ends_line(src, node.opening.end) {
                    let indent = if text::starts_line(src, first) {
                        text::line_indent(src, first).to_string()
                    } else {
                        format!("{}{unit}", text::line_indent(src, node.span.start))
                    };
                    let at = text::line_content_end(src, node.opening.end);
                    let prefix = format!("{nl}{indent}");
                    (Edit::insert(at, format!("{prefix}{}", body(&indent))), prefix.len() as u32)
                } else {
                    (Edit::insert(node.opening.end, body(text::line_indent(src, node.opening.end))), 0)
                }
            }
            Anchor::BeforeClosing(_) => {
                let closing = closing()?;
                if text::starts_line(src, closing.start) {
                    let last = node.content.last().map_or(closing.start, |c| text::skip_whitespace(src, c.span.start));
                    let indent = if last < closing.start && text::starts_line(src, last) {
                        text::line_indent(src, last).to_string()
                    } else {
                        format!("{}{unit}", text::line_indent(src, closing.start))
                    };
                    let at = text::line_start(src, closing.start);
                    (Edit::insert(at, format!("{indent}{}{nl}", body(&indent))), indent.len() as u32)
                } else {
                    (Edit::insert(closing.start, body(text::line_indent(src, closing.start))), 0)
                }
            }
            Anchor::Empty(_) => {
                let closing = closing()?;
                let outer = if text::starts_line(src, closing.start) {
                    text::line_indent(src, closing.start)
                } else {
                    text::line_indent(src, node.span.start)
                };
                let inner = format!("{outer}{unit}");
                let interior = &src[node.opening.end as usize..closing.start as usize];
                if let Some(i) = interior.find('\n') {
                    // Already two lines: the new node gets its own line, the rest stays as is.
                    let at = text::line_content_end(src, node.opening.end + i as u32);
                    let prefix = format!("{nl}{inner}");
                    (Edit::insert(at, format!("{prefix}{}", body(&inner))), prefix.len() as u32)
                } else if !text.contains('\n') {
                    (Edit::insert(node.opening.end, body(outer)), 0)
                } else {
                    // Multi-line text into a one-line container: expand it.
                    let prefix = format!("{nl}{inner}");
                    let replacement = format!("{prefix}{}{nl}{outer}", body(&inner));
                    (Edit::replace(node.opening.end, closing.start, replacement), prefix.len() as u32)
                }
            }
            Anchor::SelfClosing(_) => {
                let name = node.name.as_deref().unwrap_or_default();
                let slash = self_closing_slash(src, node)?;
                // `<X a />` → `<X a>`; but a `/>` on its own line becomes a `>` on its own line.
                let cut = if text::starts_line(src, slash) {
                    slash
                } else {
                    src[..slash as usize].trim_end_matches([' ', '\t']).len() as u32
                };
                let outer = text::line_indent(src, node.span.start);
                let inner = format!("{outer}{unit}");
                let prefix = format!(">{nl}{inner}");
                let replacement = format!("{prefix}{}{nl}{outer}</{name}>", body(&inner));
                (Edit::replace(cut, node.opening.end, replacement), prefix.len() as u32)
            }
        })
    }

    /// The AST node of JSX node `idx`. Its scope is also its children's: JSX makes none.
    fn jsx_ast_node<'n, 'x>(&self, nodes: &'n AstNodes<'x>, idx: usize) -> Result<&'n AstNode<'x>> {
        let span = self.table.nodes[idx].span;
        nodes
            .iter()
            .find(|n| match n.kind() {
                AstKind::JSXElement(e) => e.span == span,
                AstKind::JSXFragment(f) => f.span == span,
                _ => false,
            })
            .ok_or_else(|| EngineError::Internal(format!("no AST node for {}", self.name(idx))))
    }
}

/// Validate the new code and compute the locator of the node now starting at `node_start`.
/// Each name in `imported` must now be bound by an import: an import the op meant to add
/// that binds nothing (written into a comment, say) makes the result broken, not a success.
fn finish(file: &str, original: &str, code: String, node_start: Option<u32>, imported: &[&str]) -> Result<Outcome> {
    let alloc = Allocator::default();
    let program = parse(&alloc, &code, file).map_err(|e| EngineError::InvalidResult(e.to_string()))?;
    if !imported.is_empty() {
        let semantic = SemanticBuilder::new().build(&program).semantic;
        let scoping = semantic.scoping();
        let is_import = |name: &str| {
            let binding = scoping.get_root_binding(name.into());
            binding.is_some_and(|id| scoping.symbol_flags(id).contains(SymbolFlags::Import))
        };
        if let Some(name) = imported.iter().find(|name| !is_import(name)) {
            return Err(EngineError::InvalidResult(format!("`{name}` would not be imported in the result")));
        }
    }
    let locator = match node_start {
        Some(start) => {
            let table = JsxTable::build(&program, file)?;
            table.node_starting_at(start).map(|i| table.locator(i, file).to_string())
        }
        None => None,
    };
    Ok(Outcome { file: file.to_string(), changed: code != original, locator, code })
}

/// Remove whole lines when the node sits alone on them; otherwise just its span (plus one
/// space when it is surrounded by spaces).
pub(crate) fn removal_range(src: &str, span: oxc_span::Span) -> (u32, u32) {
    let bytes = src.as_bytes();
    if text::starts_line(src, span.start) && text::ends_line(src, span.end) {
        let start = text::line_start(src, span.start);
        let end = text::line_end(src, span.end);
        if (end as usize) < src.len() {
            return (start, end + 1);
        }
        let mut start = start;
        if start > 0 && bytes[start as usize - 1] == b'\n' {
            start -= 1;
            if start > 0 && bytes[start as usize - 1] == b'\r' {
                start -= 1;
            }
        }
        return (start, end);
    }
    let spaced_before = span.start > 0 && bytes[span.start as usize - 1] == b' ';
    let spaced_after = bytes.get(span.end as usize) == Some(&b' ');
    (span.start, if spaced_before && spaced_after { span.end + 1 } else { span.end })
}

/// Offset of the `/` in a self-closing tag's `/>`.
fn self_closing_slash(src: &str, node: &JsxNode) -> Result<u32> {
    let head = &src[node.opening.start as usize..node.opening.end as usize - 1];
    let trimmed = head.trim_end();
    if !trimmed.ends_with('/') {
        return Err(EngineError::Internal(format!("<{}> is not self-closing", node.display_name())));
    }
    Ok(node.opening.start + trimmed.len() as u32 - 1)
}

/// Ranges of multi-line string and template literals inside `within`, relative to
/// `within.start`. Their line breaks are content, so re-indenting must leave them alone.
fn literal_ranges(src: &str, program: &Program<'_>, within: Span) -> Vec<(u32, u32)> {
    struct Literals<'s> {
        src: &'s str,
        within: Span,
        found: Vec<(u32, u32)>,
    }
    impl Literals<'_> {
        fn record(&mut self, span: Span) {
            let inside = self.within.start <= span.start && span.end <= self.within.end;
            if inside && self.src[span.start as usize..span.end as usize].contains('\n') {
                self.found.push((span.start - self.within.start, span.end - self.within.start));
            }
        }
    }
    impl<'a> Visit<'a> for Literals<'_> {
        fn visit_string_literal(&mut self, it: &StringLiteral<'a>) {
            self.record(it.span);
        }
        fn visit_template_literal(&mut self, it: &TemplateLiteral<'a>) {
            self.record(it.span);
            walk::walk_template_literal(self, it);
        }
    }
    let mut visitor = Literals { src, within, found: Vec::new() };
    visitor.visit_program(program);
    visitor.found
}
