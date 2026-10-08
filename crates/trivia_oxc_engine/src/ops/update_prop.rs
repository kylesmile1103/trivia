//! `updateProp`: set, change or remove one attribute, keeping its form (quote, literal kind,
//! braces) and the file's layout.

use std::fmt::Write as _;

use oxc_span::Span;
use serde_json::Value;

use super::{Doc, Outcome, finish};
use crate::error::{EngineError, Result};
use crate::locator::{Attr, AttrValue, JsxNode, NodeKind};
use crate::text::{self, Edit};

impl Doc<'_, '_> {
    pub(super) fn update_prop(&self, target: usize, prop: &str, value: &Value) -> Result<Outcome> {
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
