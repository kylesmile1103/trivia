//! Edits to object and array literals, addressed by value path (`crate::values`):
//! `insertElement`, `removeElement`, `moveElement`, `setProperty`, `removeProperty`.
//!
//! Layout follows the literal's own:
//! * When its first item starts a line, each item gets its own line at the items'
//!   indentation. A trailing comma is kept when there is one, and an appended item gets one
//!   only then.
//! * When it is one line (`[a, b]`, `{ a: 1 }`), items are joined with `, `.
//! * An empty literal takes a one-line value inline (`[x]`, `{ k: v }`); a multi-line one
//!   expands it, with a trailing comma.
//!
//! Inserting an item and removing it again restores the original bytes, and so does moving an
//! item there and back (`tests` below).

use std::collections::BTreeSet;

use oxc_allocator::Allocator;
use oxc_ast::ast::{ArrayExpressionElement, Expression, ObjectPropertyKind, Program, Statement};
use oxc_span::{GetSpan, Span};

use super::{Outcome, finish, literal_ranges};
use crate::error::{EngineError, Result};
use crate::import_manager::{self, ImportSpec};
use crate::locator::JsxTable;
use crate::parse;
use crate::text::{self, Edit};
use crate::values::{self, ValuePath, is_identifier, unwrap_literal};

/// A literal's items, for splicing.
struct Seq {
    /// Offset of `[` or `{`.
    open: u32,
    /// Offset of `]` or `}`.
    close: u32,
    items: Vec<Span>,
    is_object: bool,
}

impl Seq {
    fn of(e: &Expression<'_>, path: &ValuePath) -> Result<Self> {
        let span = e.span();
        let (items, is_object) = match e {
            Expression::ArrayExpression(arr) => {
                let mut items = Vec::with_capacity(arr.elements.len());
                for el in &arr.elements {
                    if let ArrayExpressionElement::Elision(_) = el {
                        return Err(EngineError::Unsupported(format!("the array at `{path}` has holes (`[a, , b]`); edit it by hand")));
                    }
                    items.push(el.span());
                }
                (items, false)
            }
            Expression::ObjectExpression(obj) => (obj.properties.iter().map(GetSpan::span).collect(), true),
            other => {
                return Err(EngineError::Unsupported(format!(
                    "`{path}` holds {}, not an object or array literal",
                    match other {
                        Expression::Identifier(id) => format!("`{}` (a reference)", id.name),
                        _ => "an expression".into(),
                    }
                )));
            }
        };
        Ok(Self { open: span.start, close: span.end - 1, items, is_object })
    }

    fn multiline(&self, src: &str) -> bool {
        match self.items.first() {
            Some(first) => text::starts_line(src, first.start),
            None => src[self.open as usize..self.close as usize].contains('\n'),
        }
    }

    /// Offset just after the comma that follows item `i`, when one does.
    fn comma_after(&self, src: &str, i: usize) -> Option<u32> {
        let mut at = self.items[i].end as usize;
        let bytes = src.as_bytes();
        while at < self.close as usize && matches!(bytes[at], b' ' | b'\t' | b'\r' | b'\n') {
            at += 1;
        }
        (bytes.get(at) == Some(&b',')).then_some(at as u32 + 1)
    }

    /// Indentation for an item: the items' own, else one step inside the closing bracket.
    fn item_indent(&self, src: &str) -> String {
        match self.items.first() {
            Some(first) if text::starts_line(src, first.start) => text::line_indent(src, first.start).to_string(),
            _ => format!("{}{}", text::line_indent(src, self.close), text::indent_unit(src)),
        }
    }

    /// The edit that inserts `item` (already indented for `indent`) before item `index`
    /// (`index == len` appends), and the offset of `item` within the edit's text.
    fn insert(&self, src: &str, index: usize, item: &str) -> (Edit, u32) {
        let nl = text::newline(src);
        let len = self.items.len();
        if len == 0 {
            let inner = self.item_indent(src);
            let outer = text::line_indent(src, self.close);
            if self.multiline(src) {
                let at = text::line_content_end(src, self.open + 1);
                let prefix = format!("{nl}{inner}");
                return (Edit::insert(at, format!("{prefix}{item},")), prefix.len() as u32);
            }
            if item.contains('\n') {
                let prefix = format!("{nl}{inner}");
                return (Edit::replace(self.open + 1, self.close, format!("{prefix}{item},{nl}{outer}")), prefix.len() as u32);
            }
            let pad = if self.is_object { " " } else { "" };
            return (Edit::replace(self.open + 1, self.close, format!("{pad}{item}{pad}")), pad.len() as u32);
        }
        let indent = self.item_indent(src);
        if self.multiline(src) {
            if index < len {
                return (Edit::insert(self.items[index].start, format!("{item},{nl}{indent}")), 0);
            }
            return match self.comma_after(src, len - 1) {
                Some(after) => {
                    let at = if text::ends_line(src, after) { text::line_content_end(src, after) } else { after };
                    let prefix = format!("{nl}{indent}");
                    (Edit::insert(at, format!("{prefix}{item},")), prefix.len() as u32)
                }
                None => {
                    let prefix = format!(",{nl}{indent}");
                    (Edit::insert(self.items[len - 1].end, format!("{prefix}{item}")), prefix.len() as u32)
                }
            };
        }
        if index < len {
            (Edit::insert(self.items[index].start, format!("{item}, ")), 0)
        } else {
            (Edit::insert(self.items[len - 1].end, format!(", {item}")), 2)
        }
    }

    /// The range that removing item `i` deletes: its lines (with its comma) when it sits on
    /// lines of its own, else the item and one separator.
    fn removal(&self, src: &str, i: usize) -> (u32, u32) {
        let item = self.items[i];
        let last = i + 1 == self.items.len();
        let comma = self.comma_after(src, i);
        let through = comma.unwrap_or(item.end);
        if text::starts_line(src, item.start) && text::ends_line(src, through) && (comma.is_some() || i == 0) {
            let start = text::line_start(src, item.start);
            let end = text::line_end(src, through);
            let end = if (end as usize) < src.len() { end + 1 } else { end };
            return (start, end);
        }
        if last && i > 0 {
            // `a,\n  b` or `a, b` → `a`: the separator before it goes.
            return (self.items[i - 1].end, item.end);
        }
        if !last {
            return (item.start, self.items[i + 1].start);
        }
        // The only item on one line: `[a]` → `[]`, `{ a }` → `{}`.
        (self.open + 1, self.close)
    }
}

/// A parsed value snippet: one expression, with what it needs from the file.
pub(super) struct ValueSnippet {
    text: String,
    components: Vec<String>,
    free: BTreeSet<String>,
    frozen: Vec<(u32, u32)>,
}

pub(super) fn parse_value_snippet(snippet: &str) -> Result<ValueSnippet> {
    let snippet = snippet.trim();
    if snippet.is_empty() {
        return Err(EngineError::InvalidSnippet("empty value".into()));
    }
    super::insert::check_snippet_size(snippet)?;
    const PREFIX: &str = "(\n";
    let wrapped = format!("{PREFIX}{snippet}\n);");
    let alloc = Allocator::default();
    let program = parse(&alloc, &wrapped, "value.tsx").map_err(|e| EngineError::InvalidSnippet(e.to_string()))?;
    let exact = Span::new(PREFIX.len() as u32, (PREFIX.len() + snippet.len()) as u32);
    // `a, b` parses as one (sequence) expression, but in a list it would be two items.
    let ok = matches!(program.body.as_slice(), [Statement::ExpressionStatement(stmt)]
        if stmt.expression.without_parentheses().span() == exact
            && !matches!(stmt.expression.without_parentheses(), Expression::SequenceExpression(_)));
    if !ok {
        return Err(EngineError::InvalidSnippet("expected exactly one expression, without comments around it".into()));
    }
    let table = JsxTable::build(&program, "value.tsx").map_err(|e| EngineError::InvalidSnippet(e.to_string()))?;
    let components: BTreeSet<String> = table.nodes.iter().filter_map(|n| n.component_ref().map(str::to_string)).collect();
    let semantic = oxc_semantic::SemanticBuilder::new().build(&program).semantic;
    let free = semantic.scoping().root_unresolved_references().keys().map(|n| n.to_string()).collect();
    let frozen = literal_ranges(&wrapped, &program, exact);
    Ok(ValueSnippet { text: snippet.to_string(), components: components.into_iter().collect(), free, frozen })
}

impl ValueSnippet {
    pub(super) fn indented(&self, src: &str, indent: &str) -> String {
        let nl = text::newline(src);
        text::reindent_snippet(&self.text, indent, nl, &self.frozen, &text::indent_unit(&self.text), &text::indent_unit(src))
    }
}

/// A file parsed for a value edit.
pub(super) struct ValueDoc<'d> {
    pub(super) src: &'d str,
    pub(super) file: &'d str,
    pub(super) path: ValuePath,
}

impl ValueDoc<'_> {
    pub(super) fn new<'d>(src: &'d str, file: &'d str, path: &str) -> Result<ValueDoc<'d>> {
        let path = ValuePath::parse(path)?;
        if path.file != file {
            return Err(EngineError::Unsupported(format!("`{path}` is in {} but this edit is applied to {file}", path.file)));
        }
        Ok(ValueDoc { src, file, path })
    }

    /// Write `edits` (with the snippet's imports, if any) and validate the result.
    pub(super) fn commit(&self, program: &Program<'_>, mut edits: Vec<Edit>, snippet: Option<(&ValueSnippet, &[ImportSpec])>) -> Result<Outcome> {
        let mut imported: Vec<String> = Vec::new();
        if let Some((snippet, imports)) = snippet {
            import_manager::validate_specs(imports)?;
            let used: Vec<ImportSpec> = imports.iter().filter(|s| snippet.free.contains(&s.name)).cloned().collect();
            edits.extend(import_manager::ensure_imports(self.src, self.file, program, &used, &snippet.components)?);
            imported = used.into_iter().map(|s| s.name).collect();
        }
        let (code, _) = text::apply_edits(self.src, &edits)?;
        let imported: Vec<&str> = imported.iter().map(String::as_str).collect();
        finish(self.file, self.src, code, None, &imported)
    }
}

pub(super) fn insert_element(src: &str, file: &str, path: &str, index: Option<usize>, value: &str, imports: &[ImportSpec]) -> Result<Outcome> {
    let doc = ValueDoc::new(src, file, path)?;
    let snippet = parse_value_snippet(value)?;
    let alloc = Allocator::default();
    let program = parse(&alloc, src, file)?;
    let target = unwrap_literal(values::resolve(&program, &doc.path)?.expr);
    if !matches!(target, Expression::ArrayExpression(_)) {
        return Err(EngineError::Unsupported(format!("`{}` is not an array literal; insertElement adds to arrays", doc.path)));
    }
    let seq = Seq::of(target, &doc.path)?;
    let index = index.unwrap_or(seq.items.len());
    if index > seq.items.len() {
        return Err(EngineError::InvalidOp(format!("index {index} is out of range: `{}` has {} elements", doc.path, seq.items.len())));
    }
    let (edit, _) = seq.insert(src, index, &snippet.indented(src, &seq.item_indent(src)));
    doc.commit(&program, vec![edit], Some((&snippet, imports)))
}

pub(super) fn remove_element(src: &str, file: &str, path: &str) -> Result<Outcome> {
    let doc = ValueDoc::new(src, file, path)?;
    let alloc = Allocator::default();
    let program = parse(&alloc, src, file)?;
    let slot = element_slot(&program, &doc.path)?;
    let seq = Seq::of(slot.container, &doc.path)?;
    let (start, end) = seq.removal(src, slot.index);
    remove_and_prune(&doc, &program, vec![Edit::delete(start, end)])
}

pub(super) fn move_element(src: &str, file: &str, path: &str, index: usize) -> Result<Outcome> {
    let doc = ValueDoc::new(src, file, path)?;
    let alloc = Allocator::default();
    let program = parse(&alloc, src, file)?;
    let slot = element_slot(&program, &doc.path)?;
    let seq = Seq::of(slot.container, &doc.path)?;
    let len = seq.items.len();
    if index >= len {
        return Err(EngineError::InvalidOp(format!("index {index} is out of range: the array has {len} elements")));
    }
    if index == slot.index {
        return Ok(Outcome { file: file.to_string(), changed: false, locator: None, code: src.to_string() });
    }
    let moved = seq.items[slot.index];
    let text = &src[moved.start as usize..moved.end as usize];
    // The array without the moved element, where the element goes back in at `index`.
    let others = Seq {
        open: seq.open,
        close: seq.close,
        items: seq.items.iter().enumerate().filter(|(i, _)| *i != slot.index).map(|(_, s)| *s).collect(),
        is_object: false,
    };
    // The removal and the insertion never overlap: the insertion point is the start or the
    // end of another element (or the comma after the last one), outside the removed lines.
    let (insert, _) = others.insert(src, index, text);
    let (start, end) = seq.removal(src, slot.index);
    doc.commit(&program, vec![Edit::delete(start, end), insert], None)
}

pub(super) fn set_property(src: &str, file: &str, path: &str, prop: &str, value: &str, imports: &[ImportSpec]) -> Result<Outcome> {
    let doc = ValueDoc::new(src, file, path)?;
    if prop.is_empty() {
        return Err(EngineError::InvalidOp("prop must not be empty".into()));
    }
    let snippet = parse_value_snippet(value)?;
    let alloc = Allocator::default();
    let program = parse(&alloc, src, file)?;
    let target = unwrap_literal(values::resolve(&program, &doc.path)?.expr);
    let Expression::ObjectExpression(obj) = target else {
        return Err(EngineError::Unsupported(format!("`{}` is not an object literal; setProperty sets object properties", doc.path)));
    };
    let key = if is_identifier(prop) { prop.to_string() } else { serde_json::to_string(prop).expect("a string serializes") };
    let existing = obj.properties.iter().find_map(|p| match p {
        ObjectPropertyKind::ObjectProperty(p) if !p.computed && p.key.static_name().as_deref() == Some(prop) => Some(p),
        _ => None,
    });
    let edit = match existing {
        Some(p) if !p.shorthand && !p.method => {
            let indent = text::line_indent(src, p.span.start);
            let value = snippet.indented(src, indent);
            Edit::replace(p.value.span().start, p.value.span().end, value)
        }
        Some(p) => {
            let indent = text::line_indent(src, p.span.start);
            Edit::replace(p.span.start, p.span.end, format!("{key}: {}", snippet.indented(src, indent)))
        }
        None => {
            // Before trailing spreads (`{ name: "", ...defaults }`): what they pass in still wins.
            let mut at = obj.properties.len();
            while at > 0 && matches!(obj.properties[at - 1], ObjectPropertyKind::SpreadProperty(_)) {
                at -= 1;
            }
            let seq = Seq::of(target, &doc.path)?;
            let indent = seq.item_indent(src);
            let item = format!("{key}: {}", snippet.indented(src, &indent));
            seq.insert(src, at, &item).0
        }
    };
    doc.commit(&program, vec![edit], Some((&snippet, imports)))
}

pub(super) fn remove_property(src: &str, file: &str, path: &str, prop: &str) -> Result<Outcome> {
    let doc = ValueDoc::new(src, file, path)?;
    let alloc = Allocator::default();
    let program = parse(&alloc, src, file)?;
    let target = unwrap_literal(values::resolve(&program, &doc.path)?.expr);
    let Expression::ObjectExpression(obj) = target else {
        return Err(EngineError::Unsupported(format!("`{}` is not an object literal", doc.path)));
    };
    let index = obj
        .properties
        .iter()
        .position(|p| matches!(p, ObjectPropertyKind::ObjectProperty(p) if !p.computed && p.key.static_name().as_deref() == Some(prop)))
        .ok_or_else(|| EngineError::ValueNotFound { path: doc.path.to_string(), why: format!("the object has no property `{prop}`") })?;
    let seq = Seq::of(target, &doc.path)?;
    let (start, end) = seq.removal(src, index);
    remove_and_prune(&doc, &program, vec![Edit::delete(start, end)])
}

/// Apply a removal, then drop the imports only the removed code used (CLAUDE.md rule 9).
pub(super) fn remove_and_prune(doc: &ValueDoc<'_>, program: &Program<'_>, edits: Vec<Edit>) -> Result<Outcome> {
    let before = import_manager::import_reference_counts(program);
    let (code, _) = text::apply_edits(doc.src, &edits)?;
    let code = import_manager::prune_dropped(&code, doc.file, &before)?;
    finish(doc.file, doc.src, code, None, &[])
}

/// The slot of the array element a path selects (`[key=value]` or `[i]`).
fn element_slot<'p, 'a>(program: &'p Program<'a>, path: &ValuePath) -> Result<values::Slot<'p, 'a>> {
    if !matches!(path.steps.last(), Some(values::Step::Key { .. } | values::Step::Index(_))) {
        return Err(EngineError::InvalidOp(format!("`{path}` does not select an array element; end it with [key=value] or [i]")));
    }
    let resolved = values::resolve(program, path)?;
    resolved.slot.ok_or_else(|| EngineError::Internal(format!("`{path}` resolved without a slot")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = "src/list.tsx";
    const LIST: &str = r#"import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";

export function List() {
  const columns = useMemo(
    () => [
      {
        id: "name",
        header: "Name",
      },
      {
        id: "status",
        header: "Status",
        cell: ({ getValue }) => <Badge>{getValue()}</Badge>,
      },
      {
        id: "email",
        header: "Email",
      },
    ],
    [],
  );
  const inline = [1, 2, 3];
  const empty = [];
  const options = { a: 1, b: "two" };
  const multi = {
    resource: "customers",
    pageSize: 10
  };
  return null;
}
"#;

    fn path(p: &str) -> String {
        format!("{FILE}#List#{p}")
    }

    fn ins(src: &str, p: &str, index: Option<usize>, snippet: &str) -> String {
        insert_element(src, FILE, &path(p), index, snippet, &[]).unwrap().code
    }

    #[test]
    fn inserts_an_element_on_its_own_lines_and_removing_it_restores_the_bytes() {
        let column = "{\n  id: \"segment\",\n  header: \"Segment\",\n}";
        for (index, key) in [(Some(0), "segment"), (Some(1), "segment"), (None, "segment")] {
            let code = ins(LIST, "columns", index, column);
            assert!(code.contains("      {\n        id: \"segment\",\n        header: \"Segment\",\n      },\n"), "{code}");
            let back = remove_element(&code, FILE, &path(&format!("columns[id={key}]"))).unwrap().code;
            assert_eq!(back, LIST, "index {index:?}");
        }
    }

    #[test]
    fn inserts_inline_and_into_empty_literals() {
        let code = ins(LIST, "inline", Some(1), "9");
        assert!(code.contains("const inline = [1, 9, 2, 3];"));
        let code = ins(LIST, "inline", None, "9");
        assert!(code.contains("const inline = [1, 2, 3, 9];"));
        assert_eq!(remove_element(&code, FILE, &path("inline[3]")).unwrap().code, LIST);
        let code = ins(LIST, "empty", None, "9");
        assert!(code.contains("const empty = [9];"));
        let code = ins(LIST, "empty", None, "{\n  id: \"x\",\n}");
        assert!(code.contains("const empty = [\n    {\n      id: \"x\",\n    },\n  ];"), "{code}");
    }

    #[test]
    fn removes_middle_last_and_only_elements() {
        let code = remove_element(LIST, FILE, &path("columns[id=status]")).unwrap().code;
        assert!(!code.contains("Status"));
        assert!(code.contains("        header: \"Name\",\n      },\n      {\n        id: \"email\""));
        // Its import lost its last reference.
        assert!(!code.contains("import { Badge }"));
        let code = remove_element(LIST, FILE, &path("inline[2]")).unwrap().code;
        assert!(code.contains("const inline = [1, 2];"));
        let code = remove_element(LIST, FILE, &path("inline[0]")).unwrap().code;
        assert!(code.contains("const inline = [2, 3];"));
    }

    #[test]
    fn moves_an_element_and_back() {
        for (from, to) in [("name", 2), ("email", 0), ("status", 0), ("status", 2), ("name", 1)] {
            let moved = move_element(LIST, FILE, &path(&format!("columns[id={from}]")), to).unwrap();
            assert!(moved.changed);
            let order: Vec<&str> = moved.code.match_indices("id: \"").map(|(i, _)| &moved.code[i + 5..i + 9]).collect();
            assert_eq!(order.iter().position(|o| from.starts_with(*o)), Some(to), "{from} → {to}: {}", moved.code);
            let original = LIST.match_indices("id: \"").position(|(i, _)| LIST[i + 5..].starts_with(from)).unwrap();
            let back = move_element(&moved.code, FILE, &path(&format!("columns[id={from}]")), original).unwrap().code;
            assert_eq!(back, LIST, "{from} → {to} and back");
        }
        let same = move_element(LIST, FILE, &path("columns[id=name]"), 0).unwrap();
        assert!(!same.changed);
        let code = move_element(LIST, FILE, &path("inline[0]"), 2).unwrap().code;
        assert!(code.contains("const inline = [2, 3, 1];"), "{code}");
    }

    #[test]
    fn sets_and_removes_properties() {
        let code = set_property(LIST, FILE, &path("columns[id=name]"), "header", "\"Full name\"", &[]).unwrap().code;
        assert!(code.contains("        header: \"Full name\","));
        let code = set_property(LIST, FILE, &path("columns[id=name]"), "enableSorting", "false", &[]).unwrap().code;
        assert!(code.contains("        header: \"Name\",\n        enableSorting: false,\n      },"), "{code}");
        assert_eq!(remove_property(&code, FILE, &path("columns[id=name]"), "enableSorting").unwrap().code, LIST);
        let code = set_property(LIST, FILE, &path("options"), "c", "3", &[]).unwrap().code;
        assert!(code.contains("const options = { a: 1, b: \"two\", c: 3 };"));
        let code = set_property(LIST, FILE, &path("multi"), "sorters", "[]", &[]).unwrap().code;
        assert!(code.contains("    pageSize: 10,\n    sorters: []\n  };"), "{code}");
        assert_eq!(remove_property(&code, FILE, &path("multi"), "sorters").unwrap().code, LIST);
        let code = set_property(LIST, FILE, &path("options"), "data-x", "1", &[]).unwrap().code;
        assert!(code.contains("\"data-x\": 1"));
    }

    #[test]
    fn adds_a_property_before_trailing_spreads() {
        const FORM: &str = "export function Form({ initial }) {\n  const inline = { name: \"\", ...initial };\n  const lines = {\n    name: \"\",\n    ...initial,\n  };\n  const only = { ...initial };\n  const after = { ...initial, name: \"\" };\n  return null;\n}\n";
        let p = |b: &str| format!("{FILE}#Form#{b}");
        let set = |b: &str| set_property(FORM, FILE, &p(b), "email", "\"\"", &[]).unwrap().code;
        let cases = [
            ("inline", "const inline = { name: \"\", email: \"\", ...initial };"),
            ("lines", "    name: \"\",\n    email: \"\",\n    ...initial,\n"),
            ("only", "const only = { email: \"\", ...initial };"),
            ("after", "const after = { ...initial, name: \"\", email: \"\" };"),
        ];
        for (binding, expected) in cases {
            let code = set(binding);
            assert!(code.contains(expected), "{binding}: {code}");
            assert_eq!(remove_property(&code, FILE, &p(binding), "email").unwrap().code, FORM, "{binding}");
        }
    }

    #[test]
    fn adds_the_imports_a_value_uses() {
        let cell = "{\n  id: \"kyc\",\n  cell: () => <Tag>kyc</Tag>,\n}";
        let imports = [ImportSpec { name: "Tag".into(), source: "@/components/ui/tag".into(), default: false }];
        let code = insert_element(LIST, FILE, &path("columns"), None, cell, &imports).unwrap().code;
        assert!(code.contains("import { Tag } from \"@/components/ui/tag\";"), "{code}");
        let err = insert_element(LIST, FILE, &path("columns"), None, cell, &[]).unwrap_err();
        assert_eq!(err.code(), "unresolved_component");
    }

    #[test]
    fn refuses_what_it_cannot_do_safely() {
        let err = |r: Result<Outcome>| r.unwrap_err().to_string();
        assert!(err(insert_element(LIST, FILE, &path("options"), None, "1", &[])).contains("not an array literal"));
        assert!(err(set_property(LIST, FILE, &path("inline"), "a", "1", &[])).contains("not an object literal"));
        assert!(err(remove_element(LIST, FILE, &path("columns"))).contains("does not select an array element"));
        assert!(err(remove_element(LIST, FILE, &path("columns[id=nope]"))).contains("no element has id \"nope\""));
        assert_eq!(insert_element(LIST, FILE, &path("columns"), None, "1; 2", &[]).unwrap_err().code(), "invalid_snippet");
        assert!(err(insert_element(LIST, FILE, &path("columns"), None, "1), (2", &[])).contains("exactly one expression"));
        assert!(err(insert_element(LIST, FILE, &path("columns"), None, "1, 2", &[])).contains("exactly one expression"));
        assert!(err(insert_element(LIST, FILE, &path("columns"), Some(9), "1", &[])).contains("out of range"));
        assert!(err(move_element(LIST, FILE, &path("columns[id=name]"), 3)).contains("out of range"));
        assert!(err(remove_property(LIST, FILE, &path("options"), "zzz")).contains("no property `zzz`"));
        assert!(err(insert_element(LIST, "src/other.tsx", &path("columns"), None, "1", &[])).contains("is in src/list.tsx"));
    }
}
