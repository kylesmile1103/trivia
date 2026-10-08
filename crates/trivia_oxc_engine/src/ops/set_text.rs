//! `setText`: replace an element's plain-text content (`<Button>Save</Button>`).
//!
//! Only the text itself changes. Whitespace around it that holds a line break is layout (JSX
//! drops it), so it stays as written; whitespace on the text's own line is content and is
//! replaced. The new text is written as JSX text, escaping only what JSX text cannot hold
//! raw, and it must render as exactly the requested string: anything else is refused rather
//! than written approximately.

use oxc_syntax::identifier::is_white_space_single_line;
use oxc_syntax::line_terminator::is_line_terminator;

use super::{Doc, Outcome, finish, self_closing_slash};
use crate::error::{EngineError, Result};
use crate::text::{self, Edit};

/// HTML elements that cannot have children: React throws on text inside them.
const VOID_TAGS: &[&str] =
    &["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "textarea"];

impl Doc<'_, '_> {
    pub(super) fn set_text(&self, target: usize, value: &str) -> Result<Outcome> {
        let src = self.src;
        let node = &self.table.nodes[target];
        let unchanged = || finish(self.file, src, src.to_string(), Some(node.span.start), &[]);
        if node.name.as_deref().is_some_and(|tag| VOID_TAGS.contains(&tag)) {
            return Err(EngineError::Unsupported(format!("{} is a void element and cannot hold text", self.name(target))));
        }
        if value.chars().any(is_line_terminator) {
            return Err(EngineError::InvalidOp(
                "`text` has a line break, which JSX text cannot render (JSX joins lines with a space)".into(),
            ));
        }
        let edit = match node.closing {
            None if value.is_empty() => return unchanged(),
            // `<X a />` → `<X a>text</X>`, unless the `/>` sits on its own line.
            None => {
                let slash = self_closing_slash(src, node)?;
                let cut = if text::starts_line(src, slash) {
                    slash
                } else {
                    src[..slash as usize].trim_end_matches([' ', '\t']).len() as u32
                };
                let name = node.name.as_deref().unwrap_or_default();
                Edit::replace(cut, node.opening.end, format!(">{}</{name}>", jsx_text(value)))
            }
            Some(closing) => {
                let plain = match node.content.as_slice() {
                    [] => true,
                    [only] => only.node.is_none() && !src[only.span.start as usize..only.span.end as usize].starts_with('{'),
                    _ => false,
                };
                if !plain {
                    return Err(EngineError::Unsupported(format!(
                        "{} holds more than plain text (elements or {{…}} expressions); edit its children instead",
                        self.name(target)
                    )));
                }
                let interior = &src[node.opening.end as usize..closing.start as usize];
                if text::jsx_text_value(interior).unwrap_or_default() == value {
                    return unchanged();
                }
                let (lead, trail) = layout(interior);
                let written = jsx_text(value);
                let rendered = text::jsx_text_value(&format!("{lead}{written}{trail}")).unwrap_or_default();
                if rendered != value {
                    return Err(EngineError::InvalidOp(format!(
                        "`text` {value:?} would render as {rendered:?} here: whitespace next to a line break is layout in JSX"
                    )));
                }
                Edit::replace(node.opening.end + lead.len() as u32, closing.start - trail.len() as u32, written)
            }
        };
        let (code, _) = text::apply_edits(src, &[edit])?;
        finish(self.file, src, code, Some(node.span.start), &[])
    }
}

/// The layout around the text between an element's tags: leading and trailing whitespace that
/// holds a line break, kept as written. With no text at all, the text goes after the first
/// line break and its indentation, where it would have been (`<b>\n  \n</b>`).
fn layout(interior: &str) -> (&str, &str) {
    let is_space = |c: char| is_white_space_single_line(c) || is_line_terminator(c);
    let core = interior.trim_matches(is_space);
    if core.is_empty() {
        let Some(nl) = interior.find(is_line_terminator) else { return ("", "") };
        let after_break = nl + if interior[nl..].starts_with("\r\n") { 2 } else { 1 };
        let rest = &interior[after_break..];
        let lead = after_break + (rest.len() - rest.trim_start_matches(is_white_space_single_line).len());
        return (&interior[..lead], &interior[lead..]);
    }
    let start = interior.len() - interior.trim_start_matches(is_space).len();
    let end = interior.trim_end_matches(is_space).len();
    let lead = &interior[..start];
    let trail = &interior[end..];
    (if lead.contains(is_line_terminator) { lead } else { "" }, if trail.contains(is_line_terminator) { trail } else { "" })
}

/// `value` as JSX text: `{`, `}`, `<` and `>` as character references, `&` as `&amp;` only
/// when leaving it bare would decode into something else, and invisible control characters
/// (but tabs) as `&#N;`.
fn jsx_text(value: &str) -> String {
    use std::fmt::Write as _;
    let encode = |escape_amp: bool| {
        let mut out = String::with_capacity(value.len());
        for c in value.chars() {
            match c {
                '&' if escape_amp => out.push_str("&amp;"),
                '{' => out.push_str("&#123;"),
                '}' => out.push_str("&#125;"),
                '<' => out.push_str("&lt;"),
                '>' => out.push_str("&gt;"),
                c if c.is_control() && c != '\t' => {
                    let _ = write!(out, "&#{};", c as u32);
                }
                c => out.push(c),
            }
        }
        out
    };
    let minimal = encode(false);
    if text::decode_jsx_entities(&minimal) == value { minimal } else { encode(true) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_keeps_line_breaks_and_their_indentation() {
        assert_eq!(layout("Save"), ("", ""));
        assert_eq!(layout(" Save "), ("", ""));
        assert_eq!(layout("\n  Save\n"), ("\n  ", "\n"));
        assert_eq!(layout("\r\n  Save\r\n"), ("\r\n  ", "\r\n"));
        assert_eq!(layout("\n  \n"), ("\n  ", "\n"));
        assert_eq!(layout("\r\n    \r\n  "), ("\r\n    ", "\r\n  "));
        assert_eq!(layout(""), ("", ""));
    }

    #[test]
    fn jsx_text_escapes_minimally_and_round_trips() {
        for (value, expected) in [
            ("plain", "plain"),
            ("a < b > c", "a &lt; b &gt; c"),
            ("{x}", "&#123;x&#125;"),
            ("a & b", "a & b"),
            ("&amp;", "&amp;amp;"),
            ("tab\there", "tab\there"),
            ("bell\u{7}", "bell&#7;"),
        ] {
            assert_eq!(jsx_text(value), expected, "{value:?}");
            assert_eq!(text::decode_jsx_entities(&jsx_text(value)), value, "{value:?} decodes back");
        }
    }
}
