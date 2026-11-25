use std::{hint::black_box, time::{Duration, Instant}};

use criterion::{BatchSize, Criterion};
use trivia_expr::{AnalyzeRequest, ExpressionInput, analyze};

const LIMIT: Duration = Duration::from_millis(50);
const BATCH_SIZE: usize = 1000;
const EXPRESSIONS: &[&str] = &[
    "'Customers'",
    "state.selectedId === null || data.customers.isLoading",
    "`${data.customers.total} of ${state.limit} customers`",
    "ui.search?.value?.trim().toLowerCase() ?? ''",
    "data.customers.items.map(customer => customer.fullName)",
    "params.id && String(params.id).trim()",
    "[...data.customers.items].filter((customer, index) => index < state.limit && customer.name.toLowerCase().includes(ui.search.value.toLowerCase()))",
    "{ id: params.id, active: true, name: user.name }",
];

fn workload() -> AnalyzeRequest {
    let mut request: AnalyzeRequest = serde_json::from_str(r#"{
      "scope":{"roots":{
        "params":{"tier":"server","members":["id"]},
        "user":{"tier":"server","members":["name"]},
        "state":{"tier":"client","members":["limit","selectedId"]},
        "data":{"tier":"query","members":{"customers":["items","total","isLoading"]}},
        "ui":{"tier":"client","members":{"search":["value"]}}
      }},
      "expressions":[{"id":"/queries/customers/params/id","source":"params.id","defines":"data.customers"}]
    }"#).expect("benchmark request parses");
    request.expressions.extend((0..BATCH_SIZE - 1).map(|index| ExpressionInput {
        id: format!("/bindings/{index}/children"), source: EXPRESSIONS[index % EXPRESSIONS.len()].into(),
        defines: None, locals: Default::default(),
    }));
    request
}

fn main() {
    let request = workload();
    // NFR-04 is a steady-state budget: one untimed run first, so first-touch allocation and page
    // faults (5x the warm time here) do not make the gate flaky on a busy machine.
    black_box(analyze(request.clone()));
    let timings = &mut [Duration::ZERO; 5];
    for elapsed in timings.iter_mut() {
        let input = request.clone();
        let start = Instant::now();
        let result = analyze(black_box(input));
        *elapsed = start.elapsed();
        assert_eq!(result.results.len(), BATCH_SIZE);
        assert!(result.results.iter().all(|expression| expression.ok), "benchmark must analyze valid expressions");
    }
    timings.sort_unstable();
    let median = timings[timings.len() / 2];
    println!("NFR-04: 1,000 expressions in {median:.2?} (median of five runs, limit {LIMIT:?})");
    assert!(median < LIMIT, "NFR-04: analysis exceeded the 50 ms budget");

    let mut criterion = Criterion::default().warm_up_time(Duration::from_millis(250))
        .measurement_time(Duration::from_secs(1)).sample_size(20).configure_from_args();
    criterion.bench_function("analyze 1,000 expressions", |bencher| {
        bencher.iter_batched(|| request.clone(), |input| black_box(analyze(input)), BatchSize::LargeInput);
    });
    criterion.final_summary();
}
