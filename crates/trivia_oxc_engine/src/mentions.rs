//! Mentions: where a file still names something, for adapters that remove it and must say what
//! else uses it. A form field gone from the contract may still be read in a `.refine(…)`
//! (`data.email`), watched (`watch("email")`) or destructured (`({ email }) => …`).
//!
//! A mention is a member access `x.email` (not a method call, `z.email()`), a string literal
//! `"email"` (except a JSX attribute's plain string value, which names DOM things like
//! `type="email"`, and imports and types), an object key `email:` or a destructured
//! `{ email }`. Comments are not code, so they never count. The adapter decides which mentions
//! are the thing's own definition (its rule, its default) and which are uses.

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    BindingProperty, CallExpression, ExportAllDeclaration, ExportFromDeclaration, ExportNamedDeclaration, Expression,
    ImportDeclaration, JSXAttribute, JSXAttributeValue, ObjectProperty, PropertyKey, StaticMemberExpression,
    StringLiteral, TSType,
};
use oxc_ast_visit::{Visit, walk};
use oxc_span::{GetSpan, Span};
use serde::Serialize;

use crate::error::Result;
use crate::{parse, text};

/// Longest line excerpt a mention carries.
const MAX_LINE: usize = 160;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MentionKind {
    /// `values.email`
    Member,
    /// `watch("email")`, `["email"]`
    String,
    /// `{ email: … }` in an object literal
    Key,
    /// `const { email } = values`, `({ email }) => …`
    Binding,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mention {
    pub kind: MentionKind,
    /// 1-based line and column (in characters) of the name.
    pub line: u32,
    pub column: u32,
    /// The line, trimmed (cut at 160 bytes, with `…`).
    pub text: String,
}

struct Finder<'s> {
    src: &'s str,
    name: &'s str,
    /// String literals that are JSX attribute values or object keys, and called methods' names.
    skip: Vec<Span>,
    out: Vec<Mention>,
}

impl Finder<'_> {
    fn push(&mut self, kind: MentionKind, at: u32) {
        let (line, column) = text::line_col(self.src, at);
        let start = text::line_start(self.src, at) as usize;
        let end = text::line_end(self.src, at) as usize;
        let full = self.src[start..end].trim();
        let text = if full.len() <= MAX_LINE {
            full.to_string()
        } else {
            let mut cut = MAX_LINE;
            while !full.is_char_boundary(cut) {
                cut -= 1;
            }
            format!("{}…", &full[..cut])
        };
        self.out.push(Mention { kind, line, column, text });
    }
}

impl<'a> Visit<'a> for Finder<'_> {
    // A method called (`z.email()`) is not a field read.
    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        if let Expression::StaticMemberExpression(m) = it.callee.without_parentheses()
            && m.property.name == self.name
        {
            self.skip.push(m.property.span);
        }
        walk::walk_call_expression(self, it);
    }

    fn visit_static_member_expression(&mut self, it: &StaticMemberExpression<'a>) {
        if it.property.name == self.name && !self.skip.contains(&it.property.span) {
            self.push(MentionKind::Member, it.property.span.start);
        }
        walk::walk_static_member_expression(self, it);
    }

    fn visit_string_literal(&mut self, it: &StringLiteral<'a>) {
        if it.value == self.name && !self.skip.contains(&it.span) {
            self.push(MentionKind::String, it.span.start);
        }
    }

    fn visit_object_property(&mut self, it: &ObjectProperty<'a>) {
        if !it.computed && it.key.static_name().as_deref() == Some(self.name) {
            self.push(MentionKind::Key, it.key.span().start);
            if let PropertyKey::StringLiteral(s) = &it.key {
                self.skip.push(s.span);
            }
        }
        walk::walk_object_property(self, it);
    }

    fn visit_binding_property(&mut self, it: &BindingProperty<'a>) {
        if !it.computed && it.key.static_name().as_deref() == Some(self.name) {
            if let PropertyKey::StringLiteral(s) = &it.key {
                self.skip.push(s.span);
            }
            self.push(MentionKind::Binding, it.key.span().start);
        }
        walk::walk_binding_property(self, it);
    }

    fn visit_jsx_attribute(&mut self, it: &JSXAttribute<'a>) {
        if let Some(JSXAttributeValue::StringLiteral(s)) = &it.value {
            self.skip.push(s.span);
        }
        walk::walk_jsx_attribute(self, it);
    }

    // Module specifiers and types name other things.
    fn visit_import_declaration(&mut self, _: &ImportDeclaration<'a>) {}
    fn visit_export_all_declaration(&mut self, _: &ExportAllDeclaration<'a>) {}
    fn visit_export_named_declaration(&mut self, _: &ExportNamedDeclaration<'a>) {}
    fn visit_export_from_declaration(&mut self, _: &ExportFromDeclaration<'a>) {}
    fn visit_ts_type(&mut self, _: &TSType<'a>) {}
}

/// Every mention of `name` in `source` (the content of `file`), in source order.
pub fn mentions(source: &str, file: &str, name: &str) -> Result<Vec<Mention>> {
    let alloc = Allocator::default();
    let program = parse(&alloc, source, file)?;
    let mut finder = Finder { src: source, name, skip: Vec::new(), out: Vec::new() };
    finder.visit_program(&program);
    finder.out.sort_by_key(|m| (m.line, m.column));
    Ok(finder.out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FORM: &str = r#"import { email } from "./email";
import type { Pick } from "./types";

// The email field is checked below.
const schema = z
  .object({
    email: z.email(),
    "email-2": z.string(),
  })
  .refine((data) => data.email.endsWith(".com"), { path: ["email"] });

type Row = Pick<Dto, "email">;

export function Form() {
  const watched = form.watch("email");
  const { email: address } = form.getValues();
  return <Input name="email" type="email" placeholder={"email"} />;
}
"#;

    #[test]
    fn finds_members_strings_keys_and_bindings_but_not_attributes_imports_types_or_comments() {
        let all = mentions(FORM, "src/form.tsx", "email").unwrap();
        let found: Vec<(MentionKind, u32)> = all.iter().map(|m| (m.kind, m.line)).collect();
        assert_eq!(
            found,
            [
                (MentionKind::Key, 7),
                (MentionKind::Member, 10),
                (MentionKind::String, 10),
                (MentionKind::String, 15),
                (MentionKind::Binding, 16),
                // An attribute's expression is code, not a DOM name.
                (MentionKind::String, 17),
            ]
        );
        assert_eq!(all[3].text, "const watched = form.watch(\"email\");");
        assert_eq!(all[3].column, 30);
        assert!(mentions(FORM, "src/form.tsx", "nothing").unwrap().is_empty());
    }
}
