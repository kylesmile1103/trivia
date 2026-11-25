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

#[test]
fn fr_ex_01_reports_the_subset_diagnostic_and_utf16_span() {
    use trivia_expr::{analyze, AnalyzeRequest, ExpressionInput, Scope};

    let expressions = cases::ACCEPTED.iter().copied().chain(cases::REFUSED.iter().map(|case| case.0))
        .enumerate().map(|(i, source)| ExpressionInput {
            id: i.to_string(), source: source.into(), defines: None, locals: Default::default(),
        }).collect();
    let scope: Scope = serde_json::from_str(r#"{"roots":{
        "data":{"tier":"query","members":["customers"]},
        "state":{"tier":"client","members":["limit","key","count"]},
        "ui":{"tier":"client","members":{"search":["value"]}}
    },"locals":["item"]}"#).unwrap();
    let analyzed = analyze(AnalyzeRequest { expressions, scope });
    for (source, result) in cases::ACCEPTED.iter().zip(&analyzed.results) {
        assert!(result.ok, "{source}: {:?}", result.diagnostics);
    }
    for (&(source, code, start, end), result) in cases::REFUSED.iter().zip(&analyzed.results[cases::ACCEPTED.len()..]) {
        assert!(!result.ok, "{source}");
        assert_eq!(result.diagnostics.iter().map(|d| (d.code, d.start, d.end)).collect::<Vec<_>>(),
            [(code, start, end)], "{source}");
    }
}

#[test]
fn batch_limits_and_parse_errors_keep_other_results() {
    let mut expressions = vec![serde_json::from_str(r#"{"id":"broken", "source":"  "}"#).unwrap()];
    expressions.extend(std::iter::repeat_n(serde_json::from_str(r#"{"id":"good", "source":"42"}"#).unwrap(), 10_000));
    let response = trivia_expr::analyze(trivia_expr::AnalyzeRequest { expressions, scope: Default::default() });
    assert_eq!(response.results.len(), 10_001);
    assert_eq!(response.results[0].diagnostics[0].code, "expr_unsupported_syntax");
    assert!(response.results[1..10_000].iter().all(|result| result.ok));
    assert_eq!(response.results[10_000].diagnostics[0].code, "expr_too_large");
}
