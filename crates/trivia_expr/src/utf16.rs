use oxc_span::Span;

/// Convert source-relative OXC bytes to JavaScript string offsets.
pub fn to_utf16(source: &str, span: Span) -> (usize, usize) {
    let start = source.floor_char_boundary(span.start as usize);
    let end = source.floor_char_boundary(span.end as usize).max(start);
    let start_units = source[..start].encode_utf16().count();
    (start_units, start_units + source[start..end].encode_utf16().count())
}

#[cfg(test)]
mod tests {
    use super::to_utf16;
    use oxc_span::Span;

    #[test]
    fn fr_ex_08_converts_byte_spans_after_astral_characters() {
        assert_eq!(to_utf16("'😀' + stat.x", Span::new(9, 13)), (7, 11));
        assert_eq!(to_utf16("é😀a", Span::new(2, 6)), (1, 3));
        assert_eq!(to_utf16("\r\n😀", Span::new(6, 6)), (4, 4));
    }

    #[test]
    fn clamps_parser_labels_to_character_boundaries() {
        assert_eq!(to_utf16("😀", Span::new(1, 9)), (0, 2));
    }
}
