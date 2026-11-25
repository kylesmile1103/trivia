use trivia_expr::parse::{parse, MAX_BYTES, MAX_DEPTH};
use oxc_span::{GetSpan, Span};

#[test]
fn fr_ex_01_parses_one_expression_with_source_relative_byte_spans() {
    for (source, span) in [(" /*x*/ {a: 1} // tail", Span::new(7, 13)), ("'😀'", Span::new(0, 6))] {
        assert_eq!(parse(source, |expression| expression.span()).unwrap(), span);
    }
    let error = parse("'😀'; 2", |expression| expression.span()).unwrap_err();
    assert_eq!(error.code, "expr_unsupported_syntax");
    assert_eq!(error.span, Span::new(6, 7));
    for source in ["", " \t\r\n", "/* comment */"] {
        let error = parse(source, |expression| expression.span()).unwrap_err();
        assert_eq!(error.code, "expr_unsupported_syntax");
        assert!(error.span.end as usize <= source.len());
    }
}

#[test]
fn enforces_expression_byte_and_depth_limits() {
    let literal = format!("'{}'", "é".repeat((MAX_BYTES - 2) / 2));
    assert!(parse(&literal, |expression| expression.span()).is_ok());
    assert_eq!(parse(&(literal + " "), |expression| expression.span()).unwrap_err().code, "expr_too_large");

    let nested = |depth: usize| format!("{}0{}", "(".repeat(depth - 1), ")".repeat(depth - 1));
    assert!(parse(&nested(MAX_DEPTH), |expression| expression.span()).is_ok());
    assert_eq!(parse(&nested(MAX_DEPTH + 1), |expression| expression.span()).unwrap_err().code, "expr_too_large");
    assert_eq!(parse(&nested(MAX_BYTES / 2), |expression| expression.span()).unwrap_err().code, "expr_too_large");
    assert_eq!(parse(&("!".repeat(MAX_BYTES - 1) + "0"), |expression| expression.span()).unwrap_err().code, "expr_too_large");
    assert_eq!(parse(&format!("a{}", ".b".repeat(MAX_DEPTH)), |expression| expression.span()).unwrap_err().code, "expr_too_large");
    assert!(parse(&format!("[{}0]", "0,".repeat(1000)), |expression| expression.span()).is_ok());
}
