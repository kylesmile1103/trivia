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

#[test]
fn fr_ex_07_checks_call_targets_and_reports_the_callee_span() {
    use trivia_expr::{analyze, AnalyzeRequest, ExpressionInput, Scope};

    let accepted = [
        "' hi '.trim().toLowerCase().toUpperCase().replaceAll('I', 'i').padStart(3).padEnd(4).slice(0, 2)",
        "'hi'.startsWith('h') && 'hi'.endsWith('i') && 'hi'.includes('i')",
        "'hi'.split('').filter(x => x).flatMap(x => [x]).map((x => x)).toSorted().join('')",
        "[1].find(x => x) && [1].some(x => x) && [1].every(x => x) && [1].includes(1)",
        "[1].reduce((a, b) => a + b, 0) + [1].at(0) + [1].slice().length",
        "(1).toFixed(2)",
        "Boolean(String(Number('3'))) && Math['max'](1, 2) <= Math.abs(-2)",
        "Object.keys({}) && Object.values({}) && Object.entries({}) && JSON.stringify({})",
        "Intl.NumberFormat('vi').format(123) + Intl.DateTimeFormat('vi').format(Date.now())",
        "item?.['trim']?.()",
    ];
    let refused = [
        ("fetch('/x')", 0, 5),
        ("'😀' + Math.random()", 7, 18),
        ("[1].push(2)", 0, 8),
        ("item[state.key]()", 0, 15),
        ("item.format(1)", 0, 11),
        ("Intl.NumberFormat('vi')", 0, 17),
        ("Intl.NumberFormat('vi').resolvedOptions()", 0, 39),
        ("JSON.parse('{}')", 0, 10),
    ];
    let expressions = accepted.into_iter().chain(refused.map(|case| case.0)).map(|source| ExpressionInput {
        id: source.into(), source: source.into(), defines: None, locals: Default::default(),
    }).collect();
    let scope: Scope = serde_json::from_str(r#"{"roots":{"state":{"tier":"client","members":["key"]}},"locals":["item"]}"#).unwrap();
    let results = analyze(AnalyzeRequest { scope, expressions }).results;
    for (source, result) in accepted.iter().zip(&results) {
        assert!(result.ok, "{source}: {:?}", result.diagnostics);
    }
    for ((source, start, end), result) in refused.into_iter().zip(&results[accepted.len()..]) {
        assert!(!result.ok, "{source}");
        assert_eq!(result.diagnostics.iter().map(|d| (d.code, d.start, d.end)).collect::<Vec<_>>(),
            [("expr_impure_call", start, end)], "{source}");
    }
}
