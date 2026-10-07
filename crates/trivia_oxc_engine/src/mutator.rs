//! Atomic JSX mutations, each computed as byte-range [`Edit`]s against the original source.
//!
//! Nothing here re-prints the AST: OXC only tells us where things are. New text is limited
//! to the inserted fragment (indented to match its surroundings) and the touched import.

use std::collections::BTreeSet;

use oxc_allocator::Allocator;
use oxc_ast::ast::{Expression, Program, Statement};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{EngineError, Result};
use crate::import_manager::{self, ImportSpec};
use crate::locator::{JsxTable, Locator, NodeKind};
use crate::parse;
use crate::text::{self, Edit};

/// Where to put a node relative to a target node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Placement {
    Before,
    After,
    FirstChild,
    LastChild,
}

/// A serializable edit. This is the single action vocabulary shared by the designer, the
/// HTTP/napi boundary and (later) agents: every change to user code goes through it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Op {
    /// Insert `snippet` (one JSX element) relative to `target`.
    Insert {
        target: String,
        placement: Placement,
        snippet: String,
        #[serde(default)]
        imports: Vec<ImportSpec>,
    },
    /// Insert `snippet` before the parent's `index`-th child (`index == len` appends).
    InsertChild {
        parent: String,
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
    /// Remove a node; imports whose last reference it was are dropped.
    Remove {
        target: String,
        #[serde(default)]
        expected_name: Option<String>,
    },
    /// Move `source` relative to `target` (same file).
    Move {
        source: String,
        #[serde(default)]
        expected_name: Option<String>,
        target: String,
        placement: Placement,
    },
    /// Move `source` before the parent's `index`-th child, counted before the move.
    MoveNode {
        source: String,
        #[serde(default)]
        expected_name: Option<String>,
        parent: String,
        index: usize,
    },
}

impl Op {
    /// The file this op edits.
    pub fn file(&self) -> Result<String> {
        let primary = match self {
            Op::Insert { target, .. } | Op::UpdateProp { target, .. } | Op::Remove { target, .. } => target,
            Op::InsertChild { parent, .. } => parent,
            Op::Move { source, .. } | Op::MoveNode { source, .. } => source,
        };
        Ok(Locator::parse(primary)?.file)
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
    let table = JsxTable::build(&program);
    let doc = Doc { src: source, file, program: &program, table: &table };
    match op {
        Op::Insert { target, placement, snippet, imports } => {
            let target = table.resolve(&doc.locate(target)?)?;
            doc.insert(target, *placement, snippet, imports)
        }
        Op::InsertChild { parent, index, snippet, imports } => {
            let parent = table.resolve(&doc.locate(parent)?)?;
            let (target, placement) = doc.index_anchor(parent, *index)?;
            doc.insert(target, placement, snippet, imports)
        }
        Op::UpdateProp { target, expected_name, prop, value } => {
            let target = table.resolve_expected(&doc.locate(target)?, expected_name.as_deref())?;
            doc.update_prop(target, prop, value)
        }
        Op::Remove { target, expected_name } => {
            let target = table.resolve_expected(&doc.locate(target)?, expected_name.as_deref())?;
            doc.remove(target)
        }
        Op::Move { source: from, expected_name, target, placement } => {
            let from = table.resolve_expected(&doc.locate(from)?, expected_name.as_deref())?;
            let target = table.resolve(&doc.locate(target)?)?;
            doc.move_to(from, target, *placement)
        }
        Op::MoveNode { source: from, expected_name, parent, index } => {
            let from = table.resolve_expected(&doc.locate(from)?, expected_name.as_deref())?;
            let parent = table.resolve(&doc.locate(parent)?)?;
            let (target, placement) = doc.index_anchor(parent, *index)?;
            doc.move_to(from, target, placement)
        }
    }
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
                "`{s}` is in {} but this edit targets {}; cross-file edits are not supported yet",
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

    /// The edit that places `text` (whose lines after the first are indented relative to
    /// `text_indent`) at `anchor`, plus the offset of `text` within the edit's replacement.
    fn anchor_edit(&self, anchor: Anchor, text: &str, text_indent: &str) -> (Edit, u32) {
        let src = self.src;
        let nl = text::newline(src);
        let unit = text::indent_unit(src);
        let node = &self.table.nodes[anchor.node()];
        let body = |indent: &str| text::reindent(text, text_indent, indent, nl);
        match anchor {
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
                    let prefix = format!("{nl}{indent}");
                    (Edit::insert(node.span.end, format!("{prefix}{}", body(indent))), prefix.len() as u32)
                } else {
                    (Edit::insert(node.span.end, body(indent)), 0)
                }
            }
            Anchor::AfterOpening(_) => {
                let first = node.content.first().map(|c| c.span.start).unwrap_or(node.opening.end);
                if text::ends_line(src, node.opening.end) {
                    let indent = if text::starts_line(src, first) {
                        text::line_indent(src, first).to_string()
                    } else {
                        format!("{}{unit}", text::line_indent(src, node.span.start))
                    };
                    let prefix = format!("{nl}{indent}");
                    (Edit::insert(node.opening.end, format!("{prefix}{}", body(&indent))), prefix.len() as u32)
                } else {
                    (Edit::insert(node.opening.end, body(text::line_indent(src, node.opening.end))), 0)
                }
            }
            Anchor::BeforeClosing(_) => {
                let closing = node.closing.expect("anchor has a closing tag");
                if text::starts_line(src, closing.start) {
                    let last = node.content.last().map(|c| c.span.start).unwrap_or(closing.start);
                    let indent = if text::starts_line(src, last) && last != closing.start {
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
                let closing = node.closing.expect("anchor has a closing tag");
                let outer = text::line_indent(src, node.span.start);
                let inner = format!("{outer}{unit}");
                let prefix = format!("{nl}{inner}");
                let replacement = format!("{prefix}{}{nl}{outer}", body(&inner));
                (Edit::replace(node.opening.end, closing.start, replacement), prefix.len() as u32)
            }
            Anchor::SelfClosing(_) => {
                let name = node.name.as_deref().unwrap_or_default();
                let tag_end = node.attributes.last().map_or(node.attr_insert, |a| a.span.end);
                let outer = text::line_indent(src, node.span.start);
                let inner = format!("{outer}{unit}");
                let prefix = format!(">{nl}{inner}");
                let replacement = format!("{prefix}{}{nl}{outer}</{name}>", body(&inner));
                (Edit::replace(tag_end, node.opening.end, replacement), prefix.len() as u32)
            }
        }
    }

    fn insert(&self, target: usize, placement: Placement, snippet: &str, imports: &[ImportSpec]) -> Result<Outcome> {
        let snippet = snippet.trim();
        let refs = snippet_component_refs(snippet)?;
        let anchor = self.anchor(target, placement)?;
        let (edit, offset) = self.anchor_edit(anchor, snippet, "");
        let mut edits = vec![edit];
        edits.extend(import_manager::ensure_imports(self.src, self.program, imports, &refs)?);
        let (code, starts) = text::apply_edits(self.src, &edits)?;
        finish(self.file, self.src, code, Some(starts[0] + offset))
    }

    fn update_prop(&self, target: usize, prop: &str, value: &Value) -> Result<Outcome> {
        let src = self.src;
        let node = &self.table.nodes[target];
        if node.kind == NodeKind::Fragment {
            return Err(EngineError::Unsupported("fragments (<>) cannot have props".into()));
        }
        if !is_attr_name(prop) || prop == crate::locator::ATTR {
            return Err(EngineError::InvalidOp(format!("`{prop}` is not an editable prop name")));
        }
        let unchanged = || finish(self.file, src, src.to_string(), Some(node.span.start));
        // JSX lets a later duplicate win, so edit the last occurrence.
        let existing = node.attributes.iter().rposition(|a| a.name.as_deref() == Some(prop));
        let edit = match (existing, value) {
            (None, Value::Null) => return unchanged(),
            (Some(i), Value::Null) => {
                let prev_end = if i == 0 { node.attr_insert } else { node.attributes[i - 1].span.end };
                Edit::delete(prev_end, node.attributes[i].span.end)
            }
            (Some(i), value) => {
                let attr = &node.attributes[i];
                match &attr.value {
                    None if *value == Value::Bool(true) => return unchanged(),
                    None => Edit::insert(attr.name_end, format!("={}", render_value(value))),
                    Some(v) => {
                        let span = match v {
                            crate::locator::AttrValue::String { span, .. }
                            | crate::locator::AttrValue::Expression { span, .. }
                            | crate::locator::AttrValue::Element { span } => *span,
                        };
                        Edit::replace(span.start, span.end, render_value(value))
                    }
                }
            }
            (None, value) => {
                let rendered = format!("{prop}={}", render_value(value));
                match node.attributes.last() {
                    Some(last) if text::starts_line(src, last.span.start) => {
                        let indent = text::line_indent(src, last.span.start);
                        Edit::insert(last.span.end, format!("{}{indent}{rendered}", text::newline(src)))
                    }
                    Some(last) => Edit::insert(last.span.end, format!(" {rendered}")),
                    None => Edit::insert(node.attr_insert, format!(" {rendered}")),
                }
            }
        };
        let (code, _) = text::apply_edits(src, &[edit])?;
        finish(self.file, src, code, Some(node.span.start))
    }

    fn removable(&self, idx: usize, verb: &str) -> Result<()> {
        let node = &self.table.nodes[idx];
        if node.parent.is_none() {
            return Err(EngineError::Unsupported(format!(
                "cannot {verb} {}: it is the root element of `{}`",
                self.name(idx),
                node.scope
            )));
        }
        if !node.direct {
            return Err(EngineError::Unsupported(format!(
                "cannot {verb} {}: it is rendered from a {{…}} expression; edit that code by hand",
                self.name(idx)
            )));
        }
        Ok(())
    }

    fn remove(&self, target: usize) -> Result<Outcome> {
        self.removable(target, "remove")?;
        let (start, end) = removal_range(self.src, self.table.nodes[target].span);
        let refs: BTreeSet<String> = self
            .table
            .subtree(target)
            .into_iter()
            .filter_map(|i| self.table.nodes[i].component_ref().map(str::to_string))
            .collect();
        let (code, _) = text::apply_edits(self.src, &[Edit::delete(start, end)])?;
        let code = import_manager::prune_unused(&code, self.file, &refs)?;
        finish(self.file, self.src, code, None)
    }

    fn move_to(&self, from: usize, target: usize, placement: Placement) -> Result<Outcome> {
        self.removable(from, "move")?;
        let node = &self.table.nodes[from];
        if target != from && self.table.subtree(from).contains(&target) {
            return Err(EngineError::Unsupported(format!("cannot move {} into itself", self.name(from))));
        }
        let anchor = self.anchor(target, placement)?;
        if anchor.node() == from {
            // Before/after itself, or first/last child where it already is.
            return finish(self.file, self.src, self.src.to_string(), Some(node.span.start));
        }
        let moved = &self.src[node.span.start as usize..node.span.end as usize];
        let (insert, offset) = self.anchor_edit(anchor, moved, text::line_indent(self.src, node.span.start));
        let (start, end) = removal_range(self.src, node.span);
        let (code, starts) = text::apply_edits(self.src, &[insert, Edit::delete(start, end)])?;
        finish(self.file, self.src, code, Some(starts[0] + offset))
    }
}

/// Validate the new code and compute the locator of the node now starting at `node_start`.
fn finish(file: &str, original: &str, code: String, node_start: Option<u32>) -> Result<Outcome> {
    let alloc = Allocator::default();
    let program = parse(&alloc, &code, file).map_err(|e| EngineError::InvalidResult(e.to_string()))?;
    let locator = node_start.and_then(|start| {
        let table = JsxTable::build(&program);
        table.node_starting_at(start).map(|i| table.locator(i, file).to_string())
    });
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

/// Parse a snippet as a single JSX element/fragment; return the components it references.
fn snippet_component_refs(snippet: &str) -> Result<Vec<String>> {
    if snippet.is_empty() {
        return Err(EngineError::InvalidSnippet("empty snippet".into()));
    }
    let wrapped = format!("(\n{snippet}\n);");
    let alloc = Allocator::default();
    let program = parse(&alloc, &wrapped, "snippet.tsx").map_err(|e| EngineError::InvalidSnippet(e.to_string()))?;
    let is_single_jsx = match program.body.as_slice() {
        [Statement::ExpressionStatement(stmt)] => {
            matches!(stmt.expression.without_parentheses(), Expression::JSXElement(_) | Expression::JSXFragment(_))
        }
        _ => false,
    };
    if !is_single_jsx {
        return Err(EngineError::InvalidSnippet("expected exactly one JSX element".into()));
    }
    let table = JsxTable::build(&program);
    let refs: BTreeSet<String> =
        table.nodes.iter().filter_map(|n| n.component_ref().map(str::to_string)).collect();
    Ok(refs.into_iter().collect())
}

fn is_attr_name(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '-' | ':'))
}

/// Render a JSON value as a JSX attribute value.
pub(crate) fn render_value(value: &Value) -> String {
    match value {
        Value::String(s) if !s.contains(['"', '&']) => format!("\"{s}\""),
        Value::String(s) if !s.contains(['\'', '&']) => format!("'{s}'"),
        other => format!("{{{other}}}"),
    }
}
