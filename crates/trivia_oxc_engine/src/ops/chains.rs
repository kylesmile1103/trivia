//! Edits to one call of a method chain, addressed by value path (`crate::values`):
//! `setCallArgument`, `insertCall` and `removeCall`. A zod rule is a chain
//! (`z.string().min(2, "Too short.").optional()`), and so is anything built with a fluent API.
//! Editing one call leaves the others, and the developer's messages and custom calls, as
//! written.
//!
//! Layout follows the chain's own. When the call after the insertion point starts its own line
//! (`\n    .optional()`), the new call gets its own line at that indentation; at the end of the
//! chain, the last call decides. Otherwise it goes inline. Inserting a call and removing it
//! again restores the original bytes (`tests` below).

use oxc_allocator::Allocator;
use oxc_ast::ast::{Expression, Program, Statement};
use oxc_span::GetSpan;

use super::Outcome;
use super::values::{ValueDoc, ValueSnippet, parse_value_snippet, remove_and_prune};
use crate::error::{EngineError, Result};
use crate::parse;
use crate::text::{self, Edit};
use crate::values::{self, Link, ValuePath, chain, kind_name};

/// The calls of the chain at the doc's path.
fn links_at<'p, 'a>(program: &'p Program<'a>, doc: &ValueDoc<'_>) -> Result<Vec<Link<'p, 'a>>> {
    let expr = values::resolve(program, &doc.path)?.expr;
    chain(expr).ok_or_else(|| {
        EngineError::Unsupported(format!("`{}` holds {}, not a call chain such as `z.string().max(100)`", doc.path, kind_name(expr.without_parentheses())))
    })
}

fn names(links: &[Link<'_, '_>]) -> String {
    links.iter().map(|l| l.name.as_str()).collect::<Vec<_>>().join(", ")
}

/// The one call to `method` in the chain, and its index.
fn find<'l, 'p, 'a>(links: &'l [Link<'p, 'a>], path: &ValuePath, method: &str) -> Result<(usize, &'l Link<'p, 'a>)> {
    let mut hits = links.iter().enumerate().filter(|(_, l)| l.name == method);
    let hit = hits.next().ok_or_else(|| EngineError::ValueNotFound {
        path: path.to_string(),
        why: format!("the chain has no `{method}(…)` call (it has {})", names(links)),
    })?;
    if hits.next().is_some() {
        return Err(EngineError::Unsupported(format!("`{path}` calls `{method}` more than once; edit it by hand")));
    }
    Ok(hit)
}

/// `call` (`max(500)`) parsed as one method call.
fn parse_call_snippet(call: &str) -> Result<ValueSnippet> {
    let call = call.trim();
    let bad = || EngineError::InvalidSnippet(format!("expected one method call such as `max(500)`, got `{call}`"));
    // Parsed on a placeholder receiver: `_.max(500)` is one expression.
    let snippet = parse_value_snippet(&format!("_.{call}")).map_err(|_| bad())?;
    let alloc = Allocator::default();
    let wrapped = format!("_.{call};");
    let program = parse(&alloc, &wrapped, "call.tsx").map_err(|_| bad())?;
    let [Statement::ExpressionStatement(stmt)] = program.body.as_slice() else { return Err(bad()) };
    let Expression::CallExpression(c) = &stmt.expression else { return Err(bad()) };
    let Expression::StaticMemberExpression(m) = &c.callee else { return Err(bad()) };
    match &m.object {
        Expression::Identifier(id) if id.name == "_" && id.span.start == 0 => Ok(snippet),
        _ => Err(bad()),
    }
}

/// True when the chain's layout puts the call's `.` on a line of its own.
fn own_line(src: &str, link: &Link<'_, '_>) -> bool {
    link.gap.is_some_and(|(end, name)| src[end as usize..name as usize].contains('\n'))
}

pub(super) fn set_call_argument(src: &str, file: &str, path: &str, method: &str, index: usize, value: &str) -> Result<Outcome> {
    let doc = ValueDoc::new(src, file, path)?;
    let snippet = parse_value_snippet(value)?;
    let alloc = Allocator::default();
    let program = parse(&alloc, src, file)?;
    let links = links_at(&program, &doc)?;
    let (_, link) = find(&links, &doc.path, method)?;
    let args = &link.call.arguments;
    let edit = if let Some(arg) = args.get(index) {
        let span = arg.span();
        Edit::replace(span.start, span.end, snippet.indented(src, text::line_indent(src, span.start)))
    } else if index == args.len() {
        let value = snippet.indented(src, text::line_indent(src, link.call.span.start));
        match args.last() {
            Some(last) => Edit::insert(last.span().end, format!(", {value}")),
            None => {
                let close = link.call.span.end - 1;
                if src.as_bytes()[close as usize] != b')' {
                    return Err(EngineError::Internal(format!("`{method}(…)` at `{}` does not end with `)`", doc.path)));
                }
                Edit::insert(close, value)
            }
        }
    } else {
        return Err(EngineError::InvalidOp(format!(
            "argument {index} is out of range: `{method}(…)` at `{}` has {} arguments",
            doc.path,
            args.len()
        )));
    };
    doc.commit(&program, vec![edit], None)
}

pub(super) fn insert_call(src: &str, file: &str, path: &str, call: &str, before: &[String]) -> Result<Outcome> {
    let doc = ValueDoc::new(src, file, path)?;
    let snippet = parse_call_snippet(call)?;
    let alloc = Allocator::default();
    let program = parse(&alloc, src, file)?;
    let links = links_at(&program, &doc)?;
    // Before the first call named in `before` (never before the chain's first call), else last.
    let at = links.iter().skip(1).position(|l| before.contains(&l.name)).map_or(links.len(), |i| i + 1);
    let anchor = links[at - 1].call.span.end;
    let layout = links.get(at).unwrap_or(&links[at - 1]);
    // The snippet is `_.call(…)`: everything after the placeholder goes in.
    let edit = if own_line(src, layout) {
        let (_, name) = layout.gap.expect("own_line has a gap");
        let indent = text::line_indent(src, name);
        let text = snippet.indented(src, indent);
        Edit::insert(anchor, format!("{}{indent}{}", text::newline(src), &text[1..]))
    } else {
        let text = snippet.indented(src, text::line_indent(src, anchor));
        Edit::insert(anchor, text[1..].to_string())
    };
    doc.commit(&program, vec![edit], None)
}

pub(super) fn remove_call(src: &str, file: &str, path: &str, method: &str) -> Result<Outcome> {
    let doc = ValueDoc::new(src, file, path)?;
    let alloc = Allocator::default();
    let program = parse(&alloc, src, file)?;
    let links = links_at(&program, &doc)?;
    let (index, link) = find(&links, &doc.path, method)?;
    let Some((receiver_end, name)) = link.gap.filter(|_| index > 0) else {
        return Err(EngineError::Unsupported(format!(
            "`{method}(…)` starts the chain at `{}`; only the calls after the first can be removed",
            doc.path
        )));
    };
    // From the line break before its `.` when it has a line of its own, else from the `.`:
    // a comment after the previous call stays with it.
    let gap = &src[receiver_end as usize..name as usize];
    let start = match gap.rfind('\n') {
        Some(nl) => {
            let at = receiver_end + nl as u32;
            if at > receiver_end && src.as_bytes()[at as usize - 1] == b'\r' { at - 1 } else { at }
        }
        None => receiver_end,
    };
    remove_and_prune(&doc, &program, vec![Edit::delete(start, link.call.span.end)])
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = "src/form.tsx";
    const FORM: &str = r#"import { z } from "zod";
import { isIban } from "@/lib/iban";

const schema = z
  .object({
    name: z.string().min(2, "Enter at least 2 characters.").optional(),
    notes: z
      .string()
      .max(100, "Notes must be 100 characters or fewer")
      .optional(),
    iban: z.string().refine(isIban, "Enter an IBAN."),
    plain: z.string(),
    segment: z.enum(["retail", "private"]),
    tags: z.array(z.string()).max(3).max(4),
    other: someRule,
  })
  .refine((v) => v.name !== v.notes, { message: "Different, please.", path: ["notes"] });
"#;

    fn path(p: &str) -> String {
        format!("{FILE}#module#schema.{p}")
    }

    #[test]
    fn a_path_reaches_the_object_through_a_schema_level_refine() {
        let code = super::super::values::set_property(FORM, FILE, &format!("{FILE}#module#schema"), "email", "z.email()", &[]).unwrap().code;
        assert!(code.contains("    other: someRule,\n    email: z.email(),\n  })\n  .refine("), "{code}");
    }

    #[test]
    fn sets_replaces_and_appends_call_arguments() {
        let set = |p: &str, m: &str, i: usize, v: &str| set_call_argument(FORM, FILE, &path(p), m, i, v).map(|o| o.code);
        let code = set("notes", "max", 0, "500").unwrap();
        assert!(code.contains("      .max(500, \"Notes must be 100 characters or fewer\")\n"), "{code}");
        assert_eq!(set_call_argument(&code, FILE, &path("notes"), "max", 0, "100").unwrap().code, FORM);
        let code = set("name", "min", 1, "\"Too short.\"").unwrap();
        assert!(code.contains("name: z.string().min(2, \"Too short.\").optional(),"), "{code}");
        let code = set("plain", "z.string", 0, "\"Required.\"").unwrap();
        assert!(code.contains("plain: z.string(\"Required.\"),"), "{code}");
        let code = set("segment", "z.enum", 1, "{ error: \"Choose one.\" }").unwrap();
        assert!(code.contains("segment: z.enum([\"retail\", \"private\"], { error: \"Choose one.\" }),"), "{code}");
        let code = set("segment", "z.enum", 0, "[\"retail\", \"private\", \"business\"]").unwrap();
        assert!(code.contains("segment: z.enum([\"retail\", \"private\", \"business\"]),"), "{code}");
    }

    #[test]
    fn inserts_a_call_in_the_chains_layout_and_removing_it_restores_the_bytes() {
        let before = ["optional".to_string(), "refine".to_string()];
        let cases = [
            ("name", "max(80)", "name: z.string().min(2, \"Enter at least 2 characters.\").max(80).optional(),"),
            ("notes", "min(1)", "      .max(100, \"Notes must be 100 characters or fewer\")\n      .min(1)\n      .optional(),"),
            ("iban", "max(34)", "iban: z.string().max(34).refine(isIban, \"Enter an IBAN.\"),"),
            ("plain", "optional()", "plain: z.string().optional(),"),
        ];
        for (field, call, expected) in cases {
            let code = insert_call(FORM, FILE, &path(field), call, &before).unwrap().code;
            assert!(code.contains(expected), "{field}: {code}");
            let method = &call[..call.find('(').unwrap()];
            assert_eq!(remove_call(&code, FILE, &path(field), method).unwrap().code, FORM, "{field}");
        }
        // At the end of a multi-line chain: on a line of its own.
        let code = insert_call(FORM, FILE, &path("notes"), "nullable()", &[]).unwrap().code;
        assert!(code.contains("      .optional()\n      .nullable(),"), "{code}");
        assert_eq!(remove_call(&code, FILE, &path("notes"), "nullable").unwrap().code, FORM);
    }

    #[test]
    fn removes_a_call_and_the_imports_only_it_used() {
        let code = remove_call(FORM, FILE, &path("notes"), "optional").unwrap().code;
        assert!(code.contains("      .max(100, \"Notes must be 100 characters or fewer\"),\n    iban"), "{code}");
        let code = remove_call(FORM, FILE, &path("iban"), "refine").unwrap().code;
        assert!(code.contains("iban: z.string(),"));
        assert!(!code.contains("import { isIban }"), "{code}");
    }

    #[test]
    fn keeps_the_file_s_line_endings() {
        let crlf = FORM.replace('\n', "\r\n");
        let code = insert_call(&crlf, FILE, &path("notes"), "min(1)", &["optional".to_string()]).unwrap().code;
        assert!(code.contains("\r\n      .min(1)\r\n      .optional(),"), "{code:?}");
        assert_eq!(remove_call(&code, FILE, &path("notes"), "min").unwrap().code, crlf);
    }

    #[test]
    fn refuses_what_it_cannot_do_safely() {
        let err = |r: Result<Outcome>| r.unwrap_err().to_string();
        assert!(err(remove_call(FORM, FILE, &path("plain"), "z.string")).contains("starts the chain"));
        assert!(err(remove_call(FORM, FILE, &path("plain"), "max")).contains("has no `max(…)` call (it has z.string)"));
        assert!(err(set_call_argument(FORM, FILE, &path("tags"), "max", 0, "5")).contains("more than once"));
        assert!(err(set_call_argument(FORM, FILE, &path("name"), "min", 5, "1")).contains("out of range"));
        assert!(err(insert_call(FORM, FILE, &path("other"), "max(1)", &[])).contains("an identifier, not a call chain"));
        for bad in ["max", "max(1).min(2)", "[0]", "max(1); x", ""] {
            let e = insert_call(FORM, FILE, &path("plain"), bad, &[]).unwrap_err();
            assert_eq!(e.code(), "invalid_snippet", "{bad}");
        }
        assert_eq!(set_call_argument(FORM, FILE, &path("name"), "min", 0, "1, 2").unwrap_err().code(), "invalid_snippet");
    }
}
