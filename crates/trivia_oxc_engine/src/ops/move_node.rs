//! `move` and `moveNode`: cut a node and splice its bytes elsewhere in the same file, only
//! when every name it uses still means the same thing where it lands.

use oxc_ast::AstKind;
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, Span};

use super::{Doc, Outcome, Placement, finish, literal_ranges, removal_range};
use crate::error::{EngineError, Result};
use crate::text::{self, Edit};

impl Doc<'_, '_> {
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

    pub(super) fn move_to(&self, from: usize, target: usize, placement: Placement) -> Result<Outcome> {
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
