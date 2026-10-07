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

use std::collections::BTreeSet;
use std::fmt::Write as _;

use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast::ast::{Expression, Program, Statement, StringLiteral, TemplateLiteral};
use oxc_ast_visit::{Visit, walk};
use oxc_semantic::{AstNode, AstNodes, SemanticBuilder};
use oxc_span::{GetSpan, Span};
use oxc_syntax::symbol::SymbolFlags;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{EngineError, Result};
use crate::import_manager::{self, ImportSpec};
use crate::locator::{Attr, AttrValue, JsxNode, JsxTable, Locator, NodeKind};
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
    /// data/loading props (see `data_binder`).
    BindQuery(crate::data_binder::QueryBinding),
}

impl Op {
    /// The file this op edits.
    pub fn file(&self) -> Result<String> {
        let primary = match self {
            Op::Insert { target, .. } | Op::UpdateProp { target, .. } | Op::Remove { target, .. } => target,
            Op::InsertChild { parent, .. } => parent,
            Op::Move { source, .. } | Op::MoveNode { source, .. } => source,
            Op::BindQuery(binding) => &binding.target,
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
        Op::BindQuery(binding) => crate::data_binder::bind_query(source, file, binding),
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

    fn insert(&self, target: usize, placement: Placement, snippet: &str, imports: &[ImportSpec]) -> Result<Outcome> {
        let snippet = snippet.trim();
        let parsed = parse_snippet(snippet)?;
        import_manager::validate_specs(imports)?;
        let anchor = self.anchor(target, placement)?;
        let nl = text::newline(self.src);
        let (snippet_unit, unit) = (text::indent_unit(snippet), text::indent_unit(self.src));
        let body = |indent: &str| text::reindent_snippet(snippet, indent, nl, &parsed.frozen, &snippet_unit, &unit);
        let (edit, offset) = self.anchor_edit(anchor, snippet, &body)?;
        // Only the imports the snippet actually references: the op touches nothing else.
        let used: Vec<ImportSpec> = imports.iter().filter(|s| parsed.free.contains(&s.name)).cloned().collect();
        if !used.is_empty() {
            self.check_not_shadowed(anchor.node(), &used)?;
        }
        let mut edits = vec![edit];
        edits.extend(import_manager::ensure_imports(self.src, self.program, &used, &parsed.components)?);
        let (code, starts) = text::apply_edits(self.src, &edits)?;
        let imported: Vec<&str> = used.iter().map(|s| s.name.as_str()).collect();
        finish(self.file, self.src, code, Some(starts[0] + offset), &imported)
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

    /// Refuse a move that would change what the moved code refers to. Each identifier the
    /// moved node uses without declaring it must resolve to the same binding where it lands
    /// (next to or inside `dest`), or stay a global there; `this` (and `arguments`) must keep
    /// their function. Module-level names always pass, and so does any move within one scope;
    /// what fails is moving out of the callback or component that declares a name
    /// (`.map((item) => …)`, a render prop's `{ field }`, a component's `useState`), or into
    /// one that declares the same name for something else.
    fn check_scope(&self, from: usize, dest: usize) -> Result<()> {
        let semantic = SemanticBuilder::new().with_build_nodes(true).build(self.program).semantic;
        let (scoping, nodes) = (semantic.scoping(), semantic.nodes());
        let moved = self.table.nodes[from].span;
        let inside = |span: Span| moved.start <= span.start && span.end <= moved.end;
        let line = |span: Span| text::line_col(self.src, span.start).0;
        let dest = self.jsx_ast_node(nodes, dest)?;
        // What `this` is bound by: the nearest non-arrow function, class or static block.
        let this_binder = |id| {
            nodes
                .ancestors(id)
                .find(|n| {
                    let kind = n.kind();
                    matches!(kind, AstKind::Function(_) | AstKind::Class(_) | AstKind::StaticBlock(_) | AstKind::Program(_))
                })
                .map(|n| (n.id(), n.kind().span()))
        };
        let refuse = |why: String| {
            Err(EngineError::Unsupported(format!("cannot move {}: {why}; move it by hand", self.name(from))))
        };
        // `this` at node `id` keeps its meaning: bound inside the moved code, or by the same
        // function where it lands.
        let this_moves = |id| {
            let here = this_binder(id);
            let there = this_binder(dest.id());
            here.is_some_and(|(_, span)| inside(span)) || here.map(|(id, _)| id) == there.map(|(id, _)| id)
        };
        for node in nodes.iter() {
            match node.kind() {
                AstKind::IdentifierReference(ident) if inside(ident.span) => {
                    let here = scoping.get_reference(ident.reference_id()).symbol_id();
                    if here.is_some_and(|symbol| inside(scoping.symbol_span(symbol))) {
                        continue;
                    }
                    let name = ident.name.as_str();
                    let there = scoping.find_binding(dest.scope_id(), ident.name);
                    let why = match (here, there) {
                        (None, None) if name == "arguments" && !this_moves(node.id()) => {
                            "`arguments` would belong to a different function where it would go".to_string()
                        }
                        _ if here == there => continue,
                        (Some(symbol), None) => format!(
                            "`{name}` (declared on line {}) is not in scope where it would go",
                            line(scoping.symbol_span(symbol))
                        ),
                        (Some(symbol), Some(other)) => format!(
                            "`{name}` there is the binding declared on line {}, not the one it uses here (line {})",
                            line(scoping.symbol_span(other)),
                            line(scoping.symbol_span(symbol))
                        ),
                        (None, Some(other)) => format!(
                            "`{name}` there would be the local declared on line {} instead of the global it is here",
                            line(scoping.symbol_span(other))
                        ),
                        (None, None) => continue,
                    };
                    return refuse(why);
                }
                AstKind::ThisExpression(this) if inside(this.span) && !this_moves(node.id()) => {
                    return refuse("`this` would refer to a different object where it would go".into());
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Refuse an insert whose requested imports would be shadowed where the snippet lands
    /// (next to or inside `dest`): a `<Button>` placed in a scope that declares its own
    /// `Button` would render that one, not the import.
    fn check_not_shadowed(&self, dest: usize, used: &[ImportSpec]) -> Result<()> {
        let semantic = SemanticBuilder::new().with_build_nodes(true).build(self.program).semantic;
        let scoping = semantic.scoping();
        let dest = self.jsx_ast_node(semantic.nodes(), dest)?;
        for spec in used {
            let there = scoping.find_binding(dest.scope_id(), spec.name.as_str().into());
            if let Some(local) = there
                && there != scoping.get_root_binding(spec.name.as_str().into())
            {
                return Err(EngineError::Unsupported(format!(
                    "`{}` where the element would go is the local declared on line {}, which would shadow `{}`; \
                     rename that local first",
                    spec.name,
                    text::line_col(self.src, scoping.symbol_span(local).start).0,
                    spec.declaration()
                )));
            }
        }
        Ok(())
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
        let unchanged = || finish(self.file, src, src.to_string(), Some(node.span.start), &[]);
        let occurrences: Vec<usize> =
            (0..node.attributes.len()).filter(|&i| node.attributes[i].name.as_deref() == Some(prop)).collect();
        let edits = match (occurrences.last(), value) {
            (None, Value::Null) => return unchanged(),
            // Remove every occurrence: removing only the last would un-shadow an earlier one.
            (Some(_), Value::Null) => merge_ranges(occurrences.iter().map(|&i| self.attr_removal(node, i)).collect())
                .into_iter()
                .map(|(start, end)| Edit::delete(start, end))
                .collect(),
            // JSX lets a later duplicate win, so edit the last occurrence.
            (Some(&i), value) => {
                let attr = &node.attributes[i];
                if current_value(attr).is_some_and(|v| same_value(&v, value)) {
                    return unchanged();
                }
                vec![self.value_edit(attr, value)]
            }
            (None, value) => {
                let rendered = format!("{prop}={}", self.fresh_value(value));
                vec![match node.attributes.last() {
                    Some(last) if text::starts_line(src, last.span.start) => {
                        // Own line, same indent; after a trailing `// comment` that belongs to `last`.
                        let line_end = text::line_content_end(src, last.span.end);
                        let rest = src[last.span.end as usize..line_end as usize].trim_start_matches([' ', '\t']);
                        let at = if rest.is_empty() || rest.starts_with("//") { line_end } else { last.span.end };
                        let indent = text::line_indent(src, last.span.start);
                        Edit::insert(at, format!("{}{indent}{rendered}", text::newline(src)))
                    }
                    Some(last) => Edit::insert(last.span.end, format!(" {rendered}")),
                    None => Edit::insert(node.attr_insert, format!(" {rendered}")),
                }]
            }
        };
        let (code, _) = text::apply_edits(src, &edits)?;
        finish(self.file, src, code, Some(node.span.start), &[])
    }

    /// The byte range that removing attribute `i` deletes: the attribute and the whitespace
    /// that separates it, never a comment (`size="sm" // compact` leaves the comment on its
    /// own line; `/* note */ a="1"` keeps the note).
    fn attr_removal(&self, node: &JsxNode, i: usize) -> (u32, u32) {
        let src = self.src;
        let (start, end) = (node.attributes[i].span.start, node.attributes[i].span.end);
        let prev_end = if i == 0 { node.attr_insert } else { node.attributes[i - 1].span.end };
        let gap_is_blank = src[prev_end as usize..start as usize].trim().is_empty();
        let rest = src[end as usize..text::line_content_end(src, end) as usize].trim_start_matches([' ', '\t']);
        if text::starts_line(src, start) {
            if rest.is_empty() {
                // Alone on its line: the whole line goes.
                let next = text::line_end(src, end);
                return (text::line_start(src, start), if (next as usize) < src.len() { next + 1 } else { next });
            }
            // `  size="sm">`: join the tag end to the previous line, as if it was never there.
            let ends_tag = rest.starts_with('>') || rest.starts_with("/>");
            return if ends_tag && gap_is_blank { (prev_end, end) } else { (start, text::skip_spaces(src, end)) };
        }
        if gap_is_blank {
            (prev_end, end)
        } else {
            (src[..start as usize].trim_end_matches([' ', '\t']).len() as u32, end)
        }
    }

    /// The edit that sets an existing attribute to `value`, keeping the attribute's form:
    /// a `"…"`/`'…'` string stays a string with the same quote, `{'…'}`/`` {`…`} `` keep
    /// their literal kind, and other `{…}` values keep their braces (and the spacing inside).
    fn value_edit(&self, attr: &Attr, value: &Value) -> Edit {
        let src = self.src;
        match (&attr.value, value) {
            (None, value) => Edit::insert(attr.name_end, format!("={}", self.fresh_value(value))),
            (Some(AttrValue::String { span, .. }), Value::String(s)) => {
                let quote = src.as_bytes()[span.start as usize] as char;
                Edit::replace(span.start, span.end, format!("{quote}{}{quote}", jsx_attr_text(s, quote)))
            }
            (Some(AttrValue::Expression { span, source, literal }), value) => {
                let Some(inner) = inner_expression(src, *span, source) else {
                    return Edit::replace(span.start, span.end, self.fresh_value(value));
                };
                let rendered = match value {
                    Value::String(s) => match (literal, source.chars().next()) {
                        (Some(Value::String(_)), Some(q @ ('"' | '\''))) => js_string(s, q),
                        (Some(Value::String(_)), Some('`')) => js_template(s),
                        _ => return Edit::replace(span.start, span.end, self.fresh_value(value)),
                    },
                    other => other.to_string(),
                };
                Edit::replace(inner.start, inner.end, rendered)
            }
            (Some(AttrValue::String { span, .. } | AttrValue::Element { span }), value) => {
                Edit::replace(span.start, span.end, self.fresh_value(value))
            }
        }
    }

    /// A new attribute value: `"text"` (in the file's prevailing JSX quote) when the string
    /// needs no escaping beyond `&amp;`, else a `{…}` expression with a JSON literal.
    fn fresh_value(&self, value: &Value) -> String {
        match value {
            Value::String(s) => {
                let quote = self.preferred_quote();
                if s.contains(quote) || s.chars().any(char::is_control) {
                    format!("{{{value}}}")
                } else {
                    format!("{quote}{}{quote}", jsx_attr_text(s, quote))
                }
            }
            other => format!("{{{other}}}"),
        }
    }

    /// The quote most JSX string attributes in this file use (`"` on a tie).
    fn preferred_quote(&self) -> char {
        let (mut single, mut double) = (0usize, 0usize);
        for attr in self.table.nodes.iter().flat_map(|n| &n.attributes) {
            if let Some(AttrValue::String { span, .. }) = &attr.value {
                match self.src.as_bytes()[span.start as usize] {
                    b'\'' => single += 1,
                    _ => double += 1,
                }
            }
        }
        if single > double { '\'' } else { '"' }
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
        let before = import_manager::import_reference_counts(self.program);
        let (code, _) = text::apply_edits(self.src, &[Edit::delete(start, end)])?;
        let code = import_manager::prune_dropped(&code, self.file, &before)?;
        finish(self.file, self.src, code, None, &[])
    }

    fn move_to(&self, from: usize, target: usize, placement: Placement) -> Result<Outcome> {
        self.removable(from, "move")?;
        let node = &self.table.nodes[from];
        let into_itself = if target == from { !placement.is_sibling() } else { self.table.subtree(from).contains(&target) };
        if into_itself {
            return Err(EngineError::InvalidOp(format!(
                "cannot move {} into itself or its own children",
                self.name(from)
            )));
        }
        let anchor = self.anchor(target, placement)?;
        if anchor.node() == from {
            // Before/after itself, or first/last child where it already is.
            return finish(self.file, self.src, self.src.to_string(), Some(node.span.start), &[]);
        }
        self.check_scope(from, anchor.node())?;
        let moved = &self.src[node.span.start as usize..node.span.end as usize];
        let from_indent = text::line_indent(self.src, node.span.start);
        let frozen = literal_ranges(self.src, self.program, node.span);
        let body = |indent: &str| text::reindent_verbatim(moved, from_indent, indent, &frozen);
        let (insert, offset) = self.anchor_edit(anchor, moved, &body)?;
        let (start, end) = removal_range(self.src, node.span);
        let (code, starts) = text::apply_edits(self.src, &[insert, Edit::delete(start, end)])?;
        finish(self.file, self.src, code, Some(starts[0] + offset), &[])
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

/// Offset of the `/` in a self-closing tag's `/>`.
fn self_closing_slash(src: &str, node: &JsxNode) -> Result<u32> {
    let head = &src[node.opening.start as usize..node.opening.end as usize - 1];
    let trimmed = head.trim_end();
    if !trimmed.ends_with('/') {
        return Err(EngineError::Internal(format!("<{}> is not self-closing", node.display_name())));
    }
    Ok(node.opening.start + trimmed.len() as u32 - 1)
}

/// Merge overlapping or touching `[start, end)` ranges.
fn merge_ranges(mut ranges: Vec<(u32, u32)>) -> Vec<(u32, u32)> {
    ranges.sort_unstable();
    let mut out: Vec<(u32, u32)> = Vec::with_capacity(ranges.len());
    for (start, end) in ranges {
        match out.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => out.push((start, end)),
        }
    }
    out
}

/// What a parsed snippet needs from the file it goes into.
struct SnippetInfo {
    /// Component names its tags use (`Button`, `Card` in `Card.Header`): each must be bound
    /// in the file or come with an import.
    components: Vec<String>,
    /// Every name it references without binding it (components and `{…}` identifiers):
    /// the imports worth adding.
    free: BTreeSet<String>,
    /// Multi-line string/template literal ranges (relative to the snippet) not to re-indent.
    frozen: Vec<(u32, u32)>,
}

/// Deepest nesting a snippet may have, counting elements, `{…}` containers, brackets and
/// template substitutions ([`text::nesting_depth`]).
pub const MAX_SNIPPET_DEPTH: usize = 256;

/// Most tags and brackets (`<`, `(`, `[`, `{` bytes) a snippet may contain. The depth above
/// is an estimate; this bounds the real depth however the snippet is spelled.
pub const MAX_SNIPPET_TAGS_AND_BRACKETS: usize = 2048;

/// The parser, and every visitor after it, recurses once per nesting level, and a snippet
/// comes from outside the process: thousands of levels would overflow the native stack and
/// kill the host (the user's dev server) instead of failing. So the nesting is checked on the
/// bytes before anything parses them.
fn check_snippet_nesting(snippet: &str) -> Result<()> {
    let openers = snippet.bytes().filter(|b| matches!(b, b'<' | b'(' | b'[' | b'{')).count();
    if openers <= MAX_SNIPPET_DEPTH {
        // Every level starts at one of them.
        return Ok(());
    }
    let depth = text::nesting_depth(snippet);
    if depth > MAX_SNIPPET_DEPTH {
        return Err(EngineError::InvalidSnippet(format!(
            "it nests {depth} levels deep (elements, `{{…}}` and brackets); the limit is {MAX_SNIPPET_DEPTH}"
        )));
    }
    if openers > MAX_SNIPPET_TAGS_AND_BRACKETS {
        return Err(EngineError::InvalidSnippet(format!(
            "it has {openers} tags and brackets; the limit is {MAX_SNIPPET_TAGS_AND_BRACKETS}"
        )));
    }
    Ok(())
}

/// Parse a snippet as exactly one JSX element/fragment, with nothing else around it (no
/// comments, no parentheses: those would become JSX text once spliced into children).
fn parse_snippet(snippet: &str) -> Result<SnippetInfo> {
    if snippet.is_empty() {
        return Err(EngineError::InvalidSnippet("empty snippet".into()));
    }
    check_snippet_nesting(snippet)?;
    const PREFIX: &str = "(\n";
    let wrapped = format!("{PREFIX}{snippet}\n);");
    let alloc = Allocator::default();
    let program = parse(&alloc, &wrapped, "snippet.tsx").map_err(|e| EngineError::InvalidSnippet(e.to_string()))?;
    let jsx = match program.body.as_slice() {
        [Statement::ExpressionStatement(stmt)] => match stmt.expression.without_parentheses() {
            e @ (Expression::JSXElement(_) | Expression::JSXFragment(_)) => Some(e.span()),
            _ => None,
        },
        _ => None,
    };
    let exact = Span::new(PREFIX.len() as u32, (PREFIX.len() + snippet.len()) as u32);
    match jsx {
        Some(span) if span == exact => {}
        Some(_) => {
            return Err(EngineError::InvalidSnippet(
                "expected exactly one JSX element, without surrounding parentheses or comments".into(),
            ));
        }
        None => return Err(EngineError::InvalidSnippet("expected exactly one JSX element".into())),
    }
    let table = JsxTable::build(&program);
    let components: BTreeSet<String> =
        table.nodes.iter().filter_map(|n| n.component_ref().map(str::to_string)).collect();
    let semantic = oxc_semantic::SemanticBuilder::new().build(&program).semantic;
    let free = semantic.scoping().root_unresolved_references().keys().map(|name| name.to_string()).collect();
    let frozen = literal_ranges(&wrapped, &program, exact);
    Ok(SnippetInfo { components: components.into_iter().collect(), free, frozen })
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

fn is_attr_name(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '-' | ':'))
}

/// The value an attribute currently has, when it is a literal (shorthand = `true`).
fn current_value(attr: &Attr) -> Option<Value> {
    match &attr.value {
        None => Some(Value::Bool(true)),
        Some(AttrValue::String { value, .. }) => Some(Value::String(value.clone())),
        Some(AttrValue::Expression { literal, .. }) => literal.clone(),
        Some(AttrValue::Element { .. }) => None,
    }
}

/// JSON equality, except numbers compare by value (`1` == `1.0`).
fn same_value(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        _ => a == b,
    }
}

/// The span of the expression inside a `{…}` container whose expression source is `source`
/// (skipping whitespace and comments after the `{`).
fn inner_expression(src: &str, container: Span, source: &str) -> Option<Span> {
    let mut pos = container.start as usize + 1;
    loop {
        let rest = &src[pos..container.end as usize];
        let trimmed = rest.trim_start();
        pos += rest.len() - trimmed.len();
        if let Some(after) = trimmed.strip_prefix("/*") {
            pos += 2 + after.find("*/")? + 2;
        } else if let Some(after) = trimmed.strip_prefix("//") {
            pos += 2 + after.find('\n')?;
        } else {
            break;
        }
    }
    src[pos..].starts_with(source).then(|| Span::new(pos as u32, (pos + source.len()) as u32))
}

/// The text between the quotes of a JSX attribute string whose runtime value is `s`.
///
/// JSX attribute strings have no backslash escapes, but HTML character references are
/// decoded. So the quote becomes `&quot;`/`&#39;`, invisible control characters (other than
/// tab and line breaks) become `&#N;`, and `&` is written as `&amp;` only when leaving it
/// bare would decode into something else (`a & b` and `?a=1&b=2` stay as they are).
fn jsx_attr_text(s: &str, quote: char) -> String {
    let encode = |escape_amp: bool| {
        let mut out = String::with_capacity(s.len());
        for c in s.chars() {
            match c {
                '&' if escape_amp => out.push_str("&amp;"),
                '"' if quote == '"' => out.push_str("&quot;"),
                '\'' if quote == '\'' => out.push_str("&#39;"),
                c if c.is_control() && !matches!(c, '\t' | '\n' | '\r') => {
                    let _ = write!(out, "&#{};", c as u32);
                }
                c => out.push(c),
            }
        }
        out
    };
    let minimal = encode(false);
    if text::decode_jsx_entities(&minimal) == s { minimal } else { encode(true) }
}

/// A JS string literal for `s` with the given quote.
fn js_string(s: &str, quote: char) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push(quote);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

/// A template literal (no substitutions) for `s`. Line feeds stay literal; carriage returns
/// are escaped because template literals normalize raw CRLF to LF.
fn js_template(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('`');
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' => out.push_str("\\\\"),
            '`' => out.push_str("\\`"),
            '$' if chars.peek() == Some(&'{') => out.push_str("\\$"),
            '\r' => out.push_str("\\r"),
            c if c.is_control() && !matches!(c, '\n' | '\t') => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('`');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsx_attr_text_escapes_minimally_and_round_trips() {
        for (s, q, expected) in [
            ("plain", '"', "plain"),
            ("a & b", '"', "a & b"),
            ("?a=1&b=2", '"', "?a=1&b=2"),
            ("&amp;", '"', "&amp;amp;"),
            ("say \"hi\"", '"', "say &quot;hi&quot;"),
            ("it's", '\'', "it&#39;s"),
            ("it's", '"', "it's"),
            ("tab\tnew\nline", '"', "tab\tnew\nline"),
            ("bell\u{7}", '"', "bell&#7;"),
        ] {
            let encoded = jsx_attr_text(s, q);
            assert_eq!(encoded, expected, "{s:?}");
            assert_eq!(text::decode_jsx_entities(&encoded), s, "{s:?} decodes back");
        }
    }

    #[test]
    fn js_literals_escape_what_they_must() {
        assert_eq!(js_string(r#"a"b'c\d"#, '\''), r#"'a"b\'c\\d'"#);
        assert_eq!(js_string("x\ny\u{2028}", '"'), "\"x\\ny\\u2028\"");
        assert_eq!(js_template("a`b${c}\r\nd$e"), "`a\\`b\\${c}\\r\nd$e`");
    }

    #[test]
    fn merges_touching_ranges() {
        assert_eq!(merge_ranges(vec![(5, 9), (0, 3), (3, 4), (8, 12)]), vec![(0, 4), (5, 12)]);
    }

}
