//! Byte-range text editing. Every mutation in Trivia is a set of [`Edit`]s applied to the
//! original source, so bytes outside the edited ranges are preserved exactly.

use std::borrow::Cow;
use std::collections::BTreeMap;

use oxc_syntax::xml_entities::XML_ENTITIES;

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

/// Byte offset where the line terminator (`\n` or `\r\n`) of the line containing `pos`
/// starts, or `src.len()`. Text inserted here lands *before* the terminator, which keeps
/// CRLF pairs intact (inserting at [`line_end`] would split `\r` from `\n`).
pub fn line_content_end(src: &str, pos: u32) -> u32 {
    let end = line_end(src, pos);
    if end > 0 && src.as_bytes().get(end as usize) == Some(&b'\n') && src.as_bytes()[end as usize - 1] == b'\r' {
        end - 1
    } else {
        end
    }
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

/// Offset of the first character at or after `pos` that is not a space or tab.
pub fn skip_spaces(src: &str, pos: u32) -> u32 {
    let rest = &src[pos as usize..];
    pos + (rest.len() - rest.trim_start_matches([' ', '\t']).len()) as u32
}

/// Offset of the first non-whitespace character at or after `pos` (or `src.len()`).
pub fn skip_whitespace(src: &str, pos: u32) -> u32 {
    let rest = &src[pos as usize..];
    pos + (rest.len() - rest.trim_start().len()) as u32
}

/// The file's line terminator: `\r\n` when most of its line breaks are CRLF, else `\n`.
/// (A majority, so one stray CRLF in an LF file does not make every inserted line CRLF.)
/// Lone-`\r` line breaks (classic Mac) are not recognized by any helper here.
pub fn newline(src: &str) -> &'static str {
    let crlf = src.matches("\r\n").count();
    if crlf > 0 && crlf * 2 >= src.matches('\n').count() { "\r\n" } else { "\n" }
}

/// One level of indentation, guessed from the file: a tab when most indented lines start with
/// one, otherwise the most common increase in leading spaces between consecutive lines (ties
/// go to the smaller step; default two).
///
/// Measuring steps rather than the smallest indent keeps odd lines from deciding: JSDoc
/// continuation lines (` * …`) are skipped, and a single 1- or 3-space aligned line is outvoted.
pub fn indent_unit(src: &str) -> String {
    let (mut tab_lines, mut space_lines) = (0usize, 0usize);
    let mut steps: BTreeMap<usize, usize> = BTreeMap::new();
    let mut prev = 0usize;
    for line in src.lines() {
        let content = line.trim_start_matches([' ', '\t']);
        if content.is_empty() || content.starts_with('*') {
            continue;
        }
        let ws = &line[..line.len() - content.len()];
        if ws.starts_with('\t') {
            tab_lines += 1;
            continue;
        }
        let n = ws.len();
        if n > 0 {
            space_lines += 1;
        }
        if n > prev {
            *steps.entry(n - prev).or_default() += 1;
        }
        prev = n;
    }
    if tab_lines > space_lines {
        return "\t".into();
    }
    let step = steps.iter().max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0))).map_or(2, |(step, _)| *step);
    " ".repeat(step.clamp(1, 8))
}

/// Re-indent every line after the first: strip `from` (when present) and prefix `to`.
pub fn reindent(text: &str, from: &str, to: &str, nl: &str) -> String {
    reindent_frozen(text, from, to, nl, &[])
}

/// [`reindent`], except lines that start inside one of the `frozen` byte ranges of `text`
/// keep their indentation: their leading whitespace is content (multi-line string or
/// template literals), not layout.
pub fn reindent_frozen(text: &str, from: &str, to: &str, nl: &str, frozen: &[(u32, u32)]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut offset = 0usize;
    for (i, raw) in text.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if i > 0 {
            out.push_str(nl);
            if is_frozen(frozen, offset) {
                out.push_str(line);
            } else if !line.trim().is_empty() {
                out.push_str(to);
                out.push_str(line.strip_prefix(from).unwrap_or_else(|| line.trim_start()));
            }
        } else {
            out.push_str(line);
        }
        offset += raw.len() + 1;
    }
    out
}

/// Indent new text (a snippet) for its place: lines after the first get `to` in front, and
/// each leading `text_unit` (the snippet's own indentation step) becomes the file's `unit`,
/// so a snippet written with two-space steps lands tab-indented in a tab-indented file.
/// Line breaks become `nl`; blank lines stay empty; lines starting inside a `frozen` range
/// (multi-line string or template literal content) are kept as they are.
pub fn reindent_snippet(text: &str, to: &str, nl: &str, frozen: &[(u32, u32)], text_unit: &str, unit: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut offset = 0usize;
    for (i, raw) in text.split('\n').enumerate() {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if i > 0 {
            out.push_str(nl);
            if is_frozen(frozen, offset) {
                out.push_str(line);
            } else if !line.trim().is_empty() {
                out.push_str(to);
                let mut rest = line;
                while !text_unit.is_empty()
                    && let Some(after) = rest.strip_prefix(text_unit)
                {
                    out.push_str(unit);
                    rest = after;
                }
                out.push_str(rest);
            }
        } else {
            out.push_str(line);
        }
        offset += raw.len() + 1;
    }
    out
}

/// Re-indent existing source text (a moved node) without changing anything else about it:
/// line terminators are kept as they are, blank and whitespace-only lines are kept verbatim,
/// and so are lines starting inside a `frozen` range. Moving text there and back therefore
/// restores it exactly, as long as its lines are indented at least by `from`.
pub fn reindent_verbatim(text: &str, from: &str, to: &str, frozen: &[(u32, u32)]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut offset = 0usize;
    for (i, line) in text.split_inclusive('\n').enumerate() {
        let body = line.trim_end_matches(['\r', '\n']);
        if i == 0 || body.trim().is_empty() || is_frozen(frozen, offset) {
            out.push_str(line);
        } else {
            out.push_str(to);
            out.push_str(line.strip_prefix(from).unwrap_or_else(|| line.trim_start_matches([' ', '\t'])));
        }
        offset += line.len();
    }
    out
}

fn is_frozen(frozen: &[(u32, u32)], line_start: usize) -> bool {
    frozen.iter().any(|&(s, e)| (s as usize) < line_start && line_start < e as usize)
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

/// Decode the HTML character references (`&amp;`, `&#169;`, `&#x1F600;`) in JSX text or a
/// JSX attribute string, exactly like the OXC (and TypeScript) JSX transform does: what this
/// returns is the string React receives at runtime. Unknown or unterminated references are
/// left as written.
pub fn decode_jsx_entities(s: &str) -> Cow<'_, str> {
    if !s.contains('&') {
        return Cow::Borrowed(s);
    }
    // Same scan as `oxc_syntax::xml_entities::decode_entities` (which needs an arena).
    let mut out = String::with_capacity(s.len());
    let mut chars = s.char_indices();
    let mut prev = 0;
    while let Some((i, c)) = chars.next() {
        if c != '&' {
            continue;
        }
        let mut start = i;
        let mut end = None;
        for (j, c) in chars.by_ref() {
            if c == ';' {
                end = Some(j);
                break;
            } else if c == '&' {
                start = j;
            }
        }
        let Some(end) = end else { break };
        out.push_str(&s[prev..start]);
        prev = end + 1;
        let word = &s[start + 1..end];
        let decoded = match word.strip_prefix('#') {
            Some(num) => match num.strip_prefix('x') {
                Some(hex) => u32::from_str_radix(hex, 16).ok().and_then(char::from_u32),
                None => num.parse::<u32>().ok().and_then(char::from_u32),
            },
            None => XML_ENTITIES.get(word).copied(),
        };
        match decoded {
            Some(c) => out.push(c),
            None => {
                out.push('&');
                out.push_str(word);
                out.push(';');
            }
        }
    }
    out.push_str(&s[prev..]);
    Cow::Owned(out)
}

/// The string a JSX text child renders as, following the OXC/TypeScript JSX transform: one
/// line is kept as written; across several lines, each is trimmed (except the first line's
/// leading and the last line's trailing whitespace), blank lines are dropped and the rest are
/// joined with a space. Character references are decoded per line. `None` when the text is
/// only whitespace spanning lines (it renders nothing).
pub fn jsx_text_value(raw: &str) -> Option<String> {
    use oxc_syntax::identifier::is_white_space_single_line;
    use oxc_syntax::line_terminator::is_line_terminator;

    let mut lines: Vec<&str> = Vec::new();
    let mut first: Option<usize> = Some(0);
    let mut last: Option<usize> = None;
    for (i, c) in raw.char_indices() {
        if is_line_terminator(c) {
            if let (Some(f), Some(l)) = (first, last)
                && l > f
            {
                lines.push(&raw[f..l]);
            }
            first = None;
        } else if !is_white_space_single_line(c) {
            last = Some(i + c.len_utf8());
            first.get_or_insert(i);
        }
    }
    if let Some(f) = first {
        lines.push(&raw[f..]);
    }
    let decoded: Vec<Cow<'_, str>> = lines.into_iter().map(decode_jsx_entities).collect();
    (!decoded.is_empty()).then(|| decoded.join(" "))
}

/// Whether a (non-empty) JSX text child renders anything, by the rule [`jsx_text_value`]
/// follows: whitespace that spans lines is layout and renders nothing; any other text,
/// including whitespace on a single line (`<span> </span>` renders a space), is content.
pub fn jsx_text_renders(raw: &str) -> bool {
    use oxc_syntax::identifier::is_white_space_single_line;
    use oxc_syntax::line_terminator::is_line_terminator;

    let mut spans_lines = false;
    for c in raw.chars() {
        if is_line_terminator(c) {
            spans_lines = true;
        } else if !is_white_space_single_line(c) {
            return true;
        }
    }
    !spans_lines && !raw.is_empty()
}

/// Most tags and brackets (`<`, `(`, `[` and `{` bytes, wherever they are) that untrusted
/// source text — an insert's snippet, bindQuery's `optionsArgs` — may contain.
///
/// The nesting estimates ([`nesting_depth`], and the one for `optionsArgs`) can be misled:
/// `x.in/((((…` reads as the start of a regex to them, `[/[//]/, ((((…` as a comment. This
/// count cannot, and every bracket level starts at one of these bytes, so it bounds what any
/// spelling can nest with brackets. A bracket level costs the parser up to about 3.6 KB of
/// stack in a debug build (`{a:` objects; about 0.5 KB in release), so 1024 of them stay
/// under 4 MB of the 8 MiB a main thread has, leaving room for the operator chains the byte
/// limits allow (see `mutator::MAX_SNIPPET_BYTES`).
pub const MAX_TAGS_AND_BRACKETS: usize = 1024;

/// The number of `<`, `(`, `[` and `{` bytes in `src` (see [`MAX_TAGS_AND_BRACKETS`]).
pub fn tags_and_brackets(src: &str) -> usize {
    src.bytes().filter(|b| matches!(b, b'<' | b'(' | b'[' | b'{')).count()
}

/// Nesting depth of JSX/TSX source text such as a snippet: elements and fragments, `{…}`
/// containers, `(…)`, `[…]`, `{…}` and template substitutions, from one pass over the bytes,
/// so a deep input can be refused before the (recursive) parser sees it.
///
/// It follows enough of the lexical grammar not to count what is only text: JSX text,
/// attribute strings, string, template and regex literals, and comments. It is an estimate
/// for well-formed code: a regex right after `)` or `}` is read as a division, and TypeScript
/// type arguments on a tag may read as a tag. Every level it counts starts at a `<`, `(`, `[`
/// or `{`, so the result never exceeds the number of those bytes; a caller that needs a
/// bound that no spelling can get around limits that number as well.
pub fn nesting_depth(src: &str) -> usize {
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Mode {
        /// Expression code; also the outermost level.
        Code,
        /// Inside `<name …` up to its `>` or `/>`.
        Tag,
        /// Between an element's opening and closing tags.
        Children,
        /// Inside a template literal's text (not counted: only its `${` is a level).
        Template,
    }
    /// Words after which an expression (so a regex or a JSX tag) may start.
    const BEFORE_EXPRESSION: [&[u8]; 15] = [
        b"return", b"typeof", b"instanceof", b"in", b"of", b"new", b"delete", b"void", b"throw", b"case", b"do",
        b"else", b"yield", b"await", b"extends",
    ];
    let b = src.as_bytes();
    let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'$' || c >= 0x80;
    let opens_tag = |i: usize| b.get(i + 1).is_some_and(|&c| c == b'>' || (ident(c) && !c.is_ascii_digit()));
    let mut stack = vec![Mode::Code];
    let (mut depth, mut max) = (0usize, 0usize);
    // In code: whether the last token ends an operand, so `/` divides and `<` compares.
    let mut operand = false;
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let mode = stack.last().copied().unwrap_or(Mode::Code);
        let mut push = None;
        let mut pop = false;
        match mode {
            Mode::Code => match c {
                b'"' | b'\'' => {
                    i = skip_quoted(b, i, true);
                    operand = true;
                    continue;
                }
                b'/' if matches!(b.get(i + 1), Some(b'/' | b'*')) => {
                    i = skip_comment(b, i);
                    continue;
                }
                b'/' if !operand => {
                    i = skip_regex(b, i);
                    operand = true;
                    continue;
                }
                b'`' => {
                    stack.push(Mode::Template);
                    operand = false;
                }
                b'(' | b'[' | b'{' => {
                    push = Some(Mode::Code);
                    operand = false;
                }
                b')' | b']' | b'}' => {
                    pop = true;
                    operand = true;
                }
                b'<' if !operand && opens_tag(i) => {
                    if b[i + 1] == b'>' {
                        i += 1;
                        push = Some(Mode::Children);
                    } else {
                        push = Some(Mode::Tag);
                    }
                }
                c if ident(c) => {
                    let start = i;
                    while i < b.len() && ident(b[i]) {
                        i += 1;
                    }
                    operand = !BEFORE_EXPRESSION.contains(&&b[start..i]);
                    continue;
                }
                c if c.is_ascii_whitespace() => {}
                _ => operand = false,
            },
            Mode::Tag => match c {
                b'"' | b'\'' => {
                    i = skip_quoted(b, i, false);
                    continue;
                }
                b'/' if matches!(b.get(i + 1), Some(b'/' | b'*')) => {
                    i = skip_comment(b, i);
                    continue;
                }
                b'/' if b.get(i + 1) == Some(&b'>') => {
                    i += 1;
                    pop = true;
                    operand = true;
                }
                b'>' => {
                    if let Some(top) = stack.last_mut() {
                        *top = Mode::Children;
                    }
                }
                b'{' => {
                    push = Some(Mode::Code);
                    operand = false;
                }
                // An element as an attribute value (`icon=<X />`).
                b'<' if opens_tag(i) => push = Some(if b[i + 1] == b'>' { Mode::Children } else { Mode::Tag }),
                _ => {}
            },
            Mode::Children => match c {
                b'<' if b.get(i + 1) == Some(&b'/') => {
                    // The closing tag: skip to its `>`.
                    i = b[i..].iter().position(|&c| c == b'>').map_or(b.len(), |p| i + p);
                    pop = true;
                    operand = true;
                }
                b'<' if opens_tag(i) => {
                    if b[i + 1] == b'>' {
                        i += 1;
                        push = Some(Mode::Children);
                    } else {
                        push = Some(Mode::Tag);
                    }
                }
                b'{' => {
                    push = Some(Mode::Code);
                    operand = false;
                }
                _ => {}
            },
            Mode::Template => match c {
                b'`' => {
                    stack.pop();
                    operand = true;
                }
                b'\\' => i += 1,
                b'$' if b.get(i + 1) == Some(&b'{') => {
                    i += 1;
                    push = Some(Mode::Code);
                    operand = false;
                }
                _ => {}
            },
        }
        if let Some(mode) = push {
            stack.push(mode);
            depth += 1;
            max = max.max(depth);
        } else if pop && stack.len() > 1 {
            stack.pop();
            depth = depth.saturating_sub(1);
        }
        i += 1;
    }
    max
}

/// Offset just past the string literal starting at `b[i]` (a quote). JS strings have
/// backslash escapes and end at a line break; JSX attribute strings have neither.
fn skip_quoted(b: &[u8], i: usize, escapes: bool) -> usize {
    let quote = b[i];
    let mut j = i + 1;
    while j < b.len() {
        match b[j] {
            b'\\' if escapes => j += 1,
            b'\n' if escapes => return j,
            c if c == quote => return j + 1,
            _ => {}
        }
        j += 1;
    }
    b.len()
}

/// Offset just past the `//` or `/* */` comment starting at `b[i]`.
fn skip_comment(b: &[u8], i: usize) -> usize {
    if b[i + 1] == b'/' {
        return b[i..].iter().position(|&c| c == b'\n').map_or(b.len(), |p| i + p);
    }
    b[i + 2..].windows(2).position(|w| w == b"*/").map_or(b.len(), |p| i + 2 + p + 2)
}

/// Offset just past the regex literal starting at `b[i]` (its flags are read as a word).
fn skip_regex(b: &[u8], i: usize) -> usize {
    let mut class = false;
    let mut j = i + 1;
    while j < b.len() {
        match b[j] {
            b'\\' => j += 1,
            b'[' => class = true,
            b']' => class = false,
            b'/' if !class => return j + 1,
            b'\n' => return j,
            _ => {}
        }
        j += 1;
    }
    b.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsx_text_follows_the_transform_whitespace_rules() {
        assert_eq!(jsx_text_value("Hello  world ").as_deref(), Some("Hello  world "));
        assert_eq!(jsx_text_value("\n    Save\n    changes &amp; exit\n  ").as_deref(), Some("Save changes & exit"));
        assert_eq!(jsx_text_value("  a\n\n  b  ").as_deref(), Some("  a b  "));
        assert_eq!(jsx_text_value("\r\n   \r\n  ").as_deref(), None);
        assert_eq!(jsx_text_value("Tom&nbsp;&amp;&nbsp;Jerry").as_deref(), Some("Tom\u{a0}&\u{a0}Jerry"));
    }

    #[test]
    fn jsx_text_renders_agrees_with_jsx_text_value() {
        let samples = [" ", "  ", "\u{a0}", "\t", "x", " x ", "\n", "  \n  ", "\r\n", "\n  x\n", "&nbsp;", "\u{a0}\n", "\u{2028}"];
        for raw in samples {
            assert_eq!(jsx_text_renders(raw), jsx_text_value(raw).is_some(), "{raw:?}");
        }
        assert!(jsx_text_renders(" ") && !jsx_text_renders("\n    "));
    }

    #[test]
    fn nesting_depth_counts_levels_not_width() {
        let deep = |n: usize| format!("{}{}", "<a>".repeat(n), "</a>".repeat(n));
        assert_eq!(nesting_depth(&deep(1)), 1);
        assert_eq!(nesting_depth(&deep(300)), 300);
        assert_eq!(nesting_depth("<a><b /><c /><d>x</d></a>"), 2);
        assert_eq!(nesting_depth("<><a /></>"), 2);
        assert_eq!(nesting_depth("<a b={<c />} />"), 3);
        assert_eq!(nesting_depth("<a>{f((x) => [x])}</a>"), 4);
        assert_eq!(nesting_depth("<a>{`x ${`y ${z}`}`}</a>"), 4);
        // What is only text does not count.
        assert_eq!(nesting_depth("<p>((( [[[ ))) </p>"), 1);
        assert_eq!(nesting_depth("<p title=\"<(({{\" t='/>'>x</p>"), 1);
        assert_eq!(nesting_depth("<p>{\"((\" + '}}' + `[[` /* (( */}</p>"), 2);
        assert_eq!(nesting_depth("<p>{a < b ? <i /> : x / 2}</p>"), 3);
        assert_eq!(nesting_depth("<p>{/[(</p>]/.test(s) && <i />}</p>"), 3);
        // Never more than the `<`, `(`, `[` and `{` bytes it saw.
        for s in ["<a b=\"c\">", "(((", "`${`${", "<<<<", "{/*", "<a>{x}</a>"] {
            assert!(nesting_depth(s) <= s.bytes().filter(|b| b"<([{".contains(b)).count(), "{s}");
        }
    }

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
    fn rejects_overlap_out_of_range_and_split_characters() {
        assert!(apply_edits("abcdef", &[Edit::delete(1, 4), Edit::delete(3, 5)]).is_err());
        assert!(apply_edits("abc", &[Edit::delete(2, 9)]).is_err());
        assert!(apply_edits("abc", &[Edit::delete(2, 1)]).is_err());
        let err = apply_edits("é", &[Edit::insert(1, "x")]).unwrap_err();
        assert_eq!(err.code(), "internal");
    }

    #[test]
    fn indentation_helpers() {
        let src = "a\n    <B />\n  c";
        let b = src.find('<').unwrap() as u32;
        assert_eq!(line_indent(src, b), "    ");
        assert!(starts_line(src, b));
        assert!(ends_line(src, b + 5));
        assert_eq!(reindent("<A>\n  <B />\n</A>", "", "    ", "\n"), "<A>\n      <B />\n    </A>");
    }

    #[test]
    fn indent_unit_follows_the_common_step() {
        assert_eq!(indent_unit("a\n  b\n    <B />\n  c"), "  ");
        assert_eq!(indent_unit("a\n    b\n        c\n    d"), "    ");
        assert_eq!(indent_unit("a\n\tb\n\t\tc"), "\t");
        assert_eq!(indent_unit("x"), "  ");
        // JSDoc continuation lines (one space) and one odd aligned line do not decide.
        let src = "/**\n * Doc\n */\nfunction f() {\n  if (a) {\n    b(1,\n       2)\n  }\n  return (\n    <A />\n  )\n}\n";
        assert_eq!(indent_unit(src), "  ");
    }

    #[test]
    fn newline_follows_the_majority() {
        assert_eq!(newline("a\nb\n"), "\n");
        assert_eq!(newline("a\r\nb\r\n"), "\r\n");
        assert_eq!(newline("a\r\nb\nc\nd\n"), "\n", "one stray CRLF");
        assert_eq!(newline("a\r\nb\r\nc\n"), "\r\n", "one stray LF");
        assert_eq!(newline("one line"), "\n");
    }

    #[test]
    fn reindent_snippet_converts_the_indentation_step() {
        let snippet = "<A>\n  <B>\n    {`x\n  y`}\n  </B>\n\n</A>";
        let start = snippet.find('`').unwrap() as u32;
        let frozen = [(start, start + "`x\n  y`".len() as u32)];
        assert_eq!(
            reindent_snippet(snippet, "\t", "\r\n", &frozen, "  ", "\t"),
            "<A>\r\n\t\t<B>\r\n\t\t\t{`x\r\n  y`}\r\n\t\t</B>\r\n\r\n\t</A>"
        );
        assert_eq!(reindent_snippet("<A>\n  <B />\n</A>", "  ", "\n", &[], "  ", "    "), "<A>\n      <B />\n  </A>");
    }

    #[test]
    fn line_content_end_keeps_crlf_pairs() {
        let src = "ab\r\ncd\nef";
        assert_eq!(line_content_end(src, 0), 2);
        assert_eq!(line_content_end(src, 3), 2, "from the `\\n` itself");
        assert_eq!(line_end(src, 0), 3);
        assert_eq!(line_content_end(src, 4), 6);
        assert_eq!(line_content_end(src, 8), 9);
    }

    #[test]
    fn reindent_verbatim_keeps_terminators_blank_and_frozen_lines() {
        let text = "<A>\r\n    <B />\n  \n    {`x\n  y`}\r\n  </A>";
        let template = |s: &str| {
            let start = s.find('`').unwrap() as u32;
            [(start, start + "`x\n  y`".len() as u32)]
        };
        let moved = reindent_verbatim(text, "  ", "\t", &template(text));
        assert_eq!(moved, "<A>\r\n\t  <B />\n  \n\t  {`x\n  y`}\r\n\t</A>");
        assert_eq!(reindent_verbatim(&moved, "\t", "  ", &template(&moved)), text);
    }

    #[test]
    fn utf16_conversion() {
        let src = "é😀x";
        assert_eq!(utf16_offsets(src, &[0, 2, 6, 7]), vec![0, 1, 3, 4]);
    }

    #[test]
    fn decodes_entities_like_the_jsx_transform() {
        assert_eq!(decode_jsx_entities("Tom &amp; Jerry"), "Tom & Jerry");
        assert_eq!(decode_jsx_entities("&quot;&apos;&#169;&#x1F600;&nbsp;"), "\"'©😀\u{a0}");
        assert_eq!(decode_jsx_entities("a & b"), "a & b");
        assert_eq!(decode_jsx_entities("?a=1&b=2"), "?a=1&b=2");
        assert_eq!(decode_jsx_entities("& &amp;"), "& &");
        assert_eq!(decode_jsx_entities("&bogus; &#xZZ;"), "&bogus; &#xZZ;");
        assert!(matches!(decode_jsx_entities("plain"), Cow::Borrowed(_)));
    }
}
