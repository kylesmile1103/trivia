mod cases;

use oxc_span::GetSpan;
use trivia_expr::parse::parse;

#[test]
fn fr_ex_01_accepted_table_contains_complete_expressions() {
    for source in cases::ACCEPTED {
        assert!(parse(source, |expr| expr.span()).is_ok(), "{source}");
    }
}

#[test]
fn fr_ex_01_refused_table_has_valid_source_spans() {
    for &(source, code, start, end) in cases::REFUSED {
        assert_eq!(code, "expr_unsupported_syntax", "{source}");
        assert!(start < end && end <= source.encode_utf16().count(), "{source}");
    }
    assert_eq!(cases::REFUSED.len(), 23);
}
