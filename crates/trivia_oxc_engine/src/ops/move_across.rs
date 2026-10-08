//! `move` and `moveNode` between two files. The element's bytes leave one file and land in the
//! other, re-indented as a move within a file would be. What it refers to must mean the same
//! there:
//! * a name the moved code imports comes along: the destination gets the same import (merged
//!   into one it already has; a relative source is rewritten for its directory), and the
//!   source file drops imports nothing else uses any more;
//! * a global stays a global, unless the destination declares that name where it lands;
//! * anything else (a prop, a local, a module-level declaration, `this`) is not visible in the
//!   other file, so the move is refused instead of breaking the code.

use oxc_allocator::Allocator;
use oxc_ast::AstKind;
use oxc_ast::ast::{ImportDeclarationSpecifier, Statement};
use oxc_semantic::SemanticBuilder;
use oxc_span::Span;
use oxc_syntax::symbol::SymbolFlags;

use super::{Doc, Op, Outcome, finish, literal_ranges, removal_range};
use crate::error::{EngineError, Result};
use crate::import_manager::{self, ImportSpec};
use crate::locator::JsxTable;
use crate::parse;
use crate::text::{self, Edit};

/// A move between files: the source file's new text, and the destination's outcome (its new
/// text and the moved element's locator there).
#[derive(Debug, Clone)]
pub struct AcrossOutcome {
    pub from: String,
    pub to: Outcome,
}

/// What the moved code needs where it lands.
struct Needs {
    imports: Vec<ImportSpec>,
    /// Names it uses as globals (bound nowhere in the source file).
    globals: Vec<String>,
    /// Component names its tags use: each must be imported where it lands.
    components: Vec<String>,
}

/// Apply a `move`/`moveNode` whose source is in `from_file` and whose destination is in
/// `to_file` (another file). Pure: the caller reads and writes both files.
pub fn apply_across(from_src: &str, from_file: &str, to_src: &str, to_file: &str, op: &Op) -> Result<AcrossOutcome> {
    let (source, expected_name) = match op {
        Op::Move { source, expected_name, .. } | Op::MoveNode { source, expected_name, .. } => (source, expected_name),
        _ => return Err(EngineError::InvalidOp("only move and moveNode can take an element to another file".into())),
    };
    if from_file == to_file {
        return Err(EngineError::InvalidOp(format!("both ends are in {from_file}: a move within one file is apply_op's")));
    }

    let alloc_from = Allocator::default();
    let program_from = parse(&alloc_from, from_src, from_file)?;
    let table_from = JsxTable::build(&program_from, from_file)?;
    let from_doc = Doc { src: from_src, file: from_file, program: &program_from, table: &table_from };
    let from = table_from.resolve_expected(&from_doc.locate(source)?, expected_name.as_deref())?;
    from_doc.removable(from, "move")?;
    let needs = from_doc.needs_across(from, to_file)?;

    let alloc_to = Allocator::default();
    let program_to = parse(&alloc_to, to_src, to_file)?;
    let table_to = JsxTable::build(&program_to, to_file)?;
    let to_doc = Doc { src: to_src, file: to_file, program: &program_to, table: &table_to };
    let (target, placement) = match op {
        Op::Move { target, expected_target_name, placement, .. } => {
            (table_to.resolve_expected(&to_doc.locate(target)?, expected_target_name.as_deref())?, *placement)
        }
        Op::MoveNode { parent, expected_parent_name, index, .. } => {
            let parent = table_to.resolve_expected(&to_doc.locate(parent)?, expected_parent_name.as_deref())?;
            to_doc.index_anchor(parent, *index)?
        }
        _ => unreachable!("checked above"),
    };
    let anchor = to_doc.anchor(target, placement)?;
    if !needs.imports.is_empty() {
        to_doc.check_not_shadowed(anchor.node(), &needs.imports)?;
    }
    to_doc.check_globals(anchor.node(), &needs.globals, from_doc.name(from))?;

    // The destination: the element's bytes, re-indented and in its line endings, plus imports.
    let node = &table_from.nodes[from];
    let moved = &from_src[node.span.start as usize..node.span.end as usize];
    let from_indent = text::line_indent(from_src, node.span.start);
    let frozen = literal_ranges(from_src, &program_from, node.span);
    let (from_nl, to_nl) = (text::newline(from_src), text::newline(to_src));
    let body = |indent: &str| {
        let text = text::reindent_verbatim(moved, from_indent, indent, &frozen);
        if from_nl == to_nl { text } else { text.replace(from_nl, to_nl) }
    };
    let (insert, offset) = to_doc.anchor_edit(anchor, moved, &body)?;
    let mut edits = vec![insert];
    edits.extend(import_manager::ensure_imports(to_src, to_file, &program_to, &needs.imports, &needs.components)?);
    let (to_code, starts) = text::apply_edits(to_src, &edits)?;
    let imported: Vec<&str> = needs.imports.iter().map(|s| s.name.as_str()).collect();
    let to = finish(to_file, to_src, to_code, Some(starts[0] + offset), &imported)?;

    // The source: the element goes, and so do the imports only it used.
    let (start, end) = removal_range(from_src, node.span);
    let before = import_manager::import_reference_counts(&program_from);
    let (from_code, _) = text::apply_edits(from_src, &[Edit::delete(start, end)])?;
    let from_code = import_manager::prune_dropped(&from_code, from_file, &before)?;
    let from_out = finish(from_file, from_src, from_code, None, &[])?;
    Ok(AcrossOutcome { from: from_out.code, to })
}

impl Doc<'_, '_> {
    /// What the element at `from` refers to that must come along to `to_file`, or why it can't.
    fn needs_across(&self, from: usize, to_file: &str) -> Result<Needs> {
        let semantic = SemanticBuilder::new().with_build_nodes(true).build(self.program).semantic;
        let (scoping, nodes) = (semantic.scoping(), semantic.nodes());
        let moved = self.table.nodes[from].span;
        let inside = |span: Span| moved.start <= span.start && span.end <= moved.end;
        let refuse = |why: String| {
            Err(EngineError::Unsupported(format!("cannot move {} to {to_file}: {why}; move it by hand", self.name(from))))
        };
        let mut needs = Needs { imports: Vec::new(), globals: Vec::new(), components: Vec::new() };
        for node in nodes.iter() {
            match node.kind() {
                AstKind::IdentifierReference(ident) if inside(ident.span) => {
                    let name = ident.name.as_str();
                    let Some(symbol) = scoping.get_reference(ident.reference_id()).symbol_id() else {
                        if !needs.globals.iter().any(|g| g == name) {
                            needs.globals.push(name.to_string());
                        }
                        continue;
                    };
                    let declared = scoping.symbol_span(symbol);
                    if inside(declared) || needs.imports.iter().any(|s| s.name == name) {
                        continue;
                    }
                    if !scoping.symbol_flags(symbol).contains(SymbolFlags::Import) {
                        let line = text::line_col(self.src, declared.start).0;
                        return refuse(format!("`{name}` (declared on line {line} of {}) is not visible there", self.file));
                    }
                    match self.import_of(declared, to_file) {
                        Ok(spec) => needs.imports.push(spec),
                        Err(why) => return refuse(why),
                    }
                }
                AstKind::ThisExpression(this) if inside(this.span) => {
                    return refuse("`this` would refer to something else there".into());
                }
                _ => {}
            }
        }
        for idx in self.table.subtree(from) {
            if let Some(name) = self.table.nodes[idx].component_ref()
                && !needs.components.iter().any(|c| c == name)
            {
                needs.components.push(name.to_string());
            }
        }
        Ok(needs)
    }

    /// The import that binds the local declared at `local`, as `to_file` would write it.
    fn import_of(&self, local: Span, to_file: &str) -> std::result::Result<ImportSpec, String> {
        for stmt in &self.program.body {
            let Statement::ImportDeclaration(decl) = stmt else { continue };
            for spec in decl.specifiers.iter().flatten() {
                if spec.local().span != local {
                    continue;
                }
                let name = spec.local().name.to_string();
                let source = rebase_source(decl.source.value.as_str(), self.file, to_file);
                return match spec {
                    ImportDeclarationSpecifier::ImportSpecifier(s) if s.imported.name() == s.local.name => {
                        Ok(ImportSpec { name, source, default: false })
                    }
                    ImportDeclarationSpecifier::ImportSpecifier(s) => {
                        Err(format!("`{name}` is imported under another name (`{} as {name}`)", s.imported.name()))
                    }
                    ImportDeclarationSpecifier::ImportDefaultSpecifier(_) => Ok(ImportSpec { name, source, default: true }),
                    ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => {
                        Err(format!("`{name}` is a namespace import (`* as {name}`)"))
                    }
                };
            }
        }
        Err(format!("no import declaration binds the `{}` it uses", &self.src[local.start as usize..local.end as usize]))
    }

    /// Refuse when a global the moved code uses is a local where it lands (next to or inside
    /// `dest`): the code would read that local instead.
    fn check_globals(&self, dest: usize, globals: &[String], what: String) -> Result<()> {
        if globals.is_empty() {
            return Ok(());
        }
        let semantic = SemanticBuilder::new().with_build_nodes(true).build(self.program).semantic;
        let scoping = semantic.scoping();
        let dest = self.jsx_ast_node(semantic.nodes(), dest)?;
        for name in globals {
            if let Some(local) = scoping.find_binding(dest.scope_id(), name.as_str().into()) {
                let line = text::line_col(self.src, scoping.symbol_span(local).start).0;
                return Err(EngineError::Unsupported(format!(
                    "cannot move {what} to {}: `{name}` there is the local declared on line {line}, not the global it uses; \
                     move it by hand",
                    self.file
                )));
            }
        }
        Ok(())
    }
}

/// `source` as written in `from_file`, for an import in `to_file`: a relative path is resolved
/// and made relative to the new directory; anything else (`@/x`, a package) stays.
fn rebase_source(source: &str, from_file: &str, to_file: &str) -> String {
    if !(source.starts_with("./") || source.starts_with("../")) {
        return source.to_string();
    }
    let dir = |file: &str| -> Vec<String> {
        let mut parts: Vec<String> = file.split('/').map(str::to_string).collect();
        parts.pop();
        parts
    };
    let mut target = dir(from_file);
    for seg in source.split('/') {
        match seg {
            "." | "" => {}
            ".." => {
                target.pop();
            }
            seg => target.push(seg.to_string()),
        }
    }
    let base = dir(to_file);
    let common = base.iter().zip(&target).take_while(|(a, b)| a == b).count();
    let mut out: Vec<String> = std::iter::repeat_n("..".to_string(), base.len() - common).collect();
    out.extend(target[common..].iter().cloned());
    let joined = out.join("/");
    if joined.starts_with("..") { joined } else { format!("./{joined}") }
}

#[cfg(test)]
mod tests {
    use super::rebase_source;

    #[test]
    fn rebases_relative_sources_only() {
        assert_eq!(rebase_source("../lib/format", "src/pages/Page.tsx", "src/App.tsx"), "./lib/format");
        assert_eq!(rebase_source("./x", "src/pages/Page.tsx", "src/App.tsx"), "./pages/x");
        assert_eq!(rebase_source("./x", "src/App.tsx", "src/pages/deep/Page.tsx"), "../../x");
        assert_eq!(rebase_source("../../a/b", "src/x/y/F.tsx", "src/x/y/G.tsx"), "../../a/b");
        assert_eq!(rebase_source("@/components/ui/button", "src/a/A.tsx", "src/B.tsx"), "@/components/ui/button");
        assert_eq!(rebase_source("react", "src/a/A.tsx", "src/B.tsx"), "react");
    }
}
