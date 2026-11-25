mod cases;

use std::collections::BTreeMap;
use trivia_expr::{EmitRequest, ExpressionInput, emit};

fn request(sources: impl IntoIterator<Item = &'static str>, rename: &[(&str, &str)]) -> EmitRequest {
    EmitRequest {
        expressions: sources.into_iter().enumerate().map(|(i, source)| ExpressionInput {
            id: i.to_string(), source: source.into(), defines: None, locals: Default::default(),
        }).collect(),
        rename: BTreeMap::from_iter(rename.iter().map(|&(from, to)| (from.into(), to.into()))),
        arrow_body: false,
    }
}

#[test]
fn fr_ex_06_identity_preserves_every_accepted_form_byte_for_byte() {
    let results = emit(request(cases::ACCEPTED.iter().copied(), &[
        ("data", "data"), ("data.customers.total", "data.customers.total"),
        ("state.limit", "state.limit"), ("ui.search.value", "ui.search.value"), ("item", "item"),
    ])).results;
    assert_eq!(results.len(), cases::ACCEPTED.len());
    for (result, &source) in results.iter().zip(cases::ACCEPTED) {
        assert_eq!(result.ts.as_deref(), Some(source), "{:?}", result.diagnostics);
    }
}

#[test]
fn fr_ex_06_splices_longest_prefix_and_preserves_other_source_bytes() {
    let sources = [
        "data['customers'].total /* 😀 */ >  0 &&\r\n state.selectedId !== null",
        "`first\r\n${data.customers.total}\r\nlast`",
        "data.customers.items.map(state => state.selectedId) && state.selectedId",
        "data[params.id] ?? data.customers.items",
        "({ state, item: state.selectedId })",
    ];
    let results = emit(request(sources, &[
        ("data", "hooks"), ("data.customers", "customersQuery"),
        ("data.customers.total", "customers.total"), ("state", "localState"),
        ("state.selectedId", "selectedId"), ("params.id", "routeId"),
    ])).results;
    let expected = [
        "customers.total /* 😀 */ >  0 &&\r\n selectedId !== null",
        "`first\r\n${customers.total}\r\nlast`",
        "customersQuery.items.map(state => state.selectedId) && selectedId",
        "hooks[routeId] ?? customersQuery.items",
        "({ state: localState, item: selectedId })",
    ];
    for (result, expected) in results.iter().zip(expected) {
        assert_eq!(result.ts.as_deref(), Some(expected), "{:?}", result.diagnostics);
    }
}

#[test]
fn fr_ex_06_wraps_object_arrow_bodies_and_reparses_without_losing_siblings() {
    let mut input = request([" /* lead */ { x: state.x } // tail", "state.bad", "42", ""], &[
        ("state.x", "x"), ("state.bad", "broken..member"),
    ]);
    input.arrow_body = true;
    let results = emit(input).results;
    assert_eq!(results[0].ts.as_deref(), Some(" /* lead */ ({ x: x }) // tail"));
    assert!(results[1].ts.is_none());
    assert_eq!(results[1].diagnostics[0].code, "internal");
    assert_eq!(results[2].ts.as_deref(), Some("42"));
    assert_eq!(results[3].diagnostics[0].code, "expr_unsupported_syntax");
}

#[test]
fn fr_ex_06_refuses_sources_outside_the_expression_subset() {
    let results = emit(request(cases::REFUSED.iter().map(|case| case.0), &[])).results;
    for (result, &(source, code, _, _)) in results.iter().zip(cases::REFUSED) {
        assert!(result.ts.is_none() && result.diagnostics.iter().any(|d| d.code == code), "{source}: {result:?}");
    }
}

#[test]
fn fr_ex_06_rename_references_changes_only_free_ui_property_names() {
    let sources = [
        "ui /* keep */ .search.value + ui?.search.value + ui[ 'search' ].value",
        "ui[\"s\\u0065arch\"].value + ui[`search`].value + (ui as Ui).search.value",
        "'ui.search' + (item.ui.search ?? ui.searchElse) // ui.search",
        "[1].map(({ui}) => ui.search.value) && ui.search.value",
        "ui.search.value = 1",
        "bad +",
        "ui.search +",
        "() => { const ui = something; return ui.search.value }",
    ];
    let input = request(sources, &[]);
    let mut expressions = input.expressions;
    expressions.push(serde_json::from_str(r#"{"id":"local", "source":"ui.search.value", "locals":["ui"]}"#).unwrap());
    let results = trivia_expr::rename_references(trivia_expr::RenameRequest {
        expressions, from: "search".into(), to: "query".into(),
    }).unwrap().results;
    let expected = [
        "ui /* keep */ .query.value + ui?.query.value + ui[ 'query' ].value",
        "ui[\"query\"].value + ui[`query`].value + (ui as Ui).query.value",
        sources[2],
        "[1].map(({ui}) => ui.search.value) && ui.query.value",
        "ui.query.value = 1",
        sources[5],
    ];
    for (result, expected) in results.iter().zip(expected) {
        assert_eq!(result.ts.as_deref(), Some(expected), "{:?}", result.diagnostics);
    }
    for result in &results[6..8] {
        assert!(result.ts.is_none());
        assert_eq!(result.diagnostics[0].code, "expr_unsupported_syntax");
    }
    assert_eq!(results[8].ts.as_deref(), Some("ui.search.value"));
}

#[test]
fn rename_references_rejects_source_code_as_a_node_name() {
    let input = request(["ui.search.value"], &[]);
    let result = trivia_expr::rename_references(trivia_expr::RenameRequest {
        expressions: input.expressions, from: "search".into(), to: "query + anotherName".into(),
    });
    assert!(result.is_err());
}
