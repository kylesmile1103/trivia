//! Byte-range text editing. Every mutation in Trivia is a set of [`Edit`]s applied to the
//! original source, so bytes outside the edited ranges are preserved exactly.

use crate::error::EngineError;

/// Replace `source[start..end]` with `text`. Offsets are UTF-8 byte offsets (OXC spans).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edit {
    pub start: u32,
    pub end: u32,
    pub text: String,
}

impl Edit {
    pub fn insert(at: u32, text: impl Into<String>) -> Self {
        Self { start: at, end: at, text: text.into() }
    }

    pub fn delete(start: u32, end: u32) -> Self {
        Self { start, end, text: String::new() }
    }

    pub fn replace(start: u32, end: u32, text: impl Into<String>) -> Self {
        Self { start, end, text: text.into() }
    }
}

/// Apply non-overlapping edits. Returns the new text and, for each input edit (in input
/// order), the offset where its replacement text starts in the new text.
///
/// A zero-width insert and a deletion may share a start offset: the insert lands first.
pub fn apply_edits(source: &str, edits: &[Edit]) -> Result<(String, Vec<u32>), EngineError> {
    let mut order: Vec<usize> = (0..edits.len()).collect();
    order.sort_by_key(|&i| (edits[i].start, edits[i].end));

    let mut out = String::with_capacity(source.len() + 64);
    let mut new_starts = vec![0u32; edits.len()];
    let mut cursor = 0usize;
    for &i in &order {
        let e = &edits[i];
        let (start, end) = (e.start as usize, e.end as usize);
        if start < cursor || end < start || end > source.len() {
            return Err(EngineError::Internal(format!(
                "overlapping or out-of-range edit {start}..{end} (cursor {cursor})"
            )));
        }
        if !source.is_char_boundary(start) || !source.is_char_boundary(end) {
            return Err(EngineError::Internal(format!("edit {start}..{end} splits a character")));
        }
        out.push_str(&source[cursor..start]);
        new_starts[i] = out.len() as u32;
        out.push_str(&e.text);
        cursor = end;
    }
    out.push_str(&source[cursor..]);
    Ok((out, new_starts))
}

/// Byte offset of the first character of the line containing `pos`.
pub fn line_start(src: &str, pos: u32) -> u32 {
    src[..pos as usize].rfind('\n').map_or(0, |i| i as u32 + 1)
}

/// Byte offset of the `\n` ending the line containing `pos` (or `src.len()`).
pub fn line_end(src: &str, pos: u32) -> u32 {
    src[pos as usize..].find('\n').map_or(src.len() as u32, |i| pos + i as u32)
}

/// Leading whitespace of the line containing `pos`.
pub fn line_indent(src: &str, pos: u32) -> &str {
    let ls = line_start(src, pos) as usize;
    let rest = &src[ls..];
    let n = rest.len() - rest.trim_start_matches([' ', '\t']).len();
    &rest[..n]
}

/// True when only spaces/tabs sit between the start of the line and `pos`.
pub fn starts_line(src: &str, pos: u32) -> bool {
    src[line_start(src, pos) as usize..pos as usize].chars().all(|c| c == ' ' || c == '\t')
}

/// True when only whitespace sits between `pos` and the end of its line.
pub fn ends_line(src: &str, pos: u32) -> bool {
    src[pos as usize..line_end(src, pos) as usize].chars().all(char::is_whitespace)
}

/// The file's line terminator.
pub fn newline(src: &str) -> &'static str {
    if src.contains("\r\n") { "\r\n" } else { "\n" }
}

/// One level of indentation, guessed from the file: a tab if lines are tab-indented,
/// otherwise the smallest non-zero run of leading spaces (default two).
pub fn indent_unit(src: &str) -> String {
    let mut min_spaces: Option<usize> = None;
    for line in src.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if line.starts_with('\t') {
            return "\t".into();
        }
        let n = line.len() - line.trim_start_matches(' ').len();
        if n > 0 && min_spaces.is_none_or(|m| n < m) {
            min_spaces = Some(n);
        }
    }
    " ".repeat(min_spaces.unwrap_or(2).clamp(1, 8))
}

/// Re-indent every line after the first: strip `from` (when present) and prefix `to`.
pub fn reindent(text: &str, from: &str, to: &str, nl: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for (i, line) in text.split('\n').enumerate() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if i > 0 {
            out.push_str(nl);
            if !line.trim().is_empty() {
                out.push_str(to);
                out.push_str(line.strip_prefix(from).unwrap_or_else(|| line.trim_start()));
            }
        } else {
            out.push_str(line);
        }
    }
    out
}

/// 1-based line and column (in characters) for a byte offset.
pub fn line_col(src: &str, pos: u32) -> (u32, u32) {
    let before = &src[..pos as usize];
    let line = before.matches('\n').count() as u32 + 1;
    let col = before[line_start(src, pos) as usize..].chars().count() as u32 + 1;
    (line, col)
}

/// Convert sorted UTF-8 byte offsets to UTF-16 code-unit offsets (what JavaScript strings,
/// `magic-string` and `oxc-parser` on npm use).
pub fn utf16_offsets(src: &str, sorted_byte_offsets: &[u32]) -> Vec<u32> {
    let mut out = Vec::with_capacity(sorted_byte_offsets.len());
    let mut utf16 = 0u32;
    let mut chars = src.char_indices().peekable();
    for &target in sorted_byte_offsets {
        while let Some(&(i, c)) = chars.peek() {
            if i as u32 >= target {
                break;
            }
            utf16 += c.len_utf16() as u32;
            chars.next();
        }
        out.push(utf16);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn applies_edits_in_any_order_and_reports_new_starts() {
        let src = "abcdef";
        let edits = [Edit::replace(4, 5, "XY"), Edit::insert(1, "_"), Edit::delete(2, 3)];
        let (out, starts) = apply_edits(src, &edits).unwrap();
        assert_eq!(out, "a_bdXYf");
        assert_eq!(starts, vec![4, 1, 3]);
    }

    #[test]
    fn insert_and_delete_at_same_offset() {
        let (out, starts) = apply_edits("abc", &[Edit::delete(1, 2), Edit::insert(1, "Z")]).unwrap();
        assert_eq!(out, "aZc");
        assert_eq!(starts, vec![2, 1]);
    }

    #[test]
    fn rejects_overlap() {
        assert!(apply_edits("abcdef", &[Edit::delete(1, 4), Edit::delete(3, 5)]).is_err());
    }

    #[test]
    fn indentation_helpers() {
        let src = "a\n    <B />\n  c";
        let b = src.find('<').unwrap() as u32;
        assert_eq!(line_indent(src, b), "    ");
        assert!(starts_line(src, b));
        assert!(ends_line(src, b + 5));
        assert_eq!(indent_unit(src), "  ");
        assert_eq!(reindent("<A>\n  <B />\n</A>", "", "    ", "\n"), "<A>\n      <B />\n    </A>");
    }

    #[test]
    fn utf16_conversion() {
        let src = "é😀x";
        assert_eq!(utf16_offsets(src, &[0, 2, 6, 7]), vec![0, 1, 3, 4]);
    }
}
