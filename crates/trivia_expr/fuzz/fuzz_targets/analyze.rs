#![no_main]

use std::collections::BTreeMap;
use std::sync::LazyLock;

use libfuzzer_sys::fuzz_target;
use trivia_expr::{AnalyzeRequest, ExpressionInput, Root, RootTier, Scope, analyze};

static SCOPE: LazyLock<Scope> = LazyLock::new(|| Scope {
    roots: BTreeMap::from([
        ("params".into(), Root { tier: RootTier::Server, members: None }),
        ("data".into(), Root { tier: RootTier::Query, members: None }),
        ("state".into(), Root { tier: RootTier::Client, members: None }),
    ]),
    ..Scope::default()
});

fuzz_target!(|input: &[u8]| {
    let source = String::from_utf8_lossy(input).into_owned();
    let response = analyze(AnalyzeRequest {
        scope: SCOPE.clone(),
        expressions: vec![ExpressionInput {
            id: "fuzz".into(), source, locals: Default::default(), defines: None,
        }],
    });
    assert_eq!(response.results.len(), 1);
});
