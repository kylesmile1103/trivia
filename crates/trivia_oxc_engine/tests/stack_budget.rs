//! Untrusted text — an insert's `snippet`, a bindQuery's `optionsArgs` — is bounded so that
//! nothing the engine accepts can overflow the stack of the thread it runs on. OXC's parser,
//! the semantic pass and every visitor recurse once per nesting level, and operator chains
//! nest without a single bracket: `!!!!x`, `x!!!!`, `x+x+…`, `a?b:a?b:…`, `a=>a=>…`.
//!
//! These tests run the worst inputs the limits let through on an 8 MiB thread (the default
//! main-thread stack) in a plain `cargo test` build, where a level costs the most stack:
//! about 1.2 KB per `!` in the semantic pass and up to 3.6 KB per bracket in the parser
//! (release builds use about 15 times less). They live in their own test binary because a
//! stack overflow aborts the whole process instead of failing one test.

use serde_json::json;
use trivia_oxc_engine::{Op, Outcome, QueryBinding, annotate, apply_op, bind_query, inspect::inspect};

const STACK: usize = 8 << 20;
/// `ops::MAX_SNIPPET_BYTES`, `ops::bind_query::MAX_ARGS_LEN`, `text::MAX_TAGS_AND_BRACKETS`.
const SNIPPET_LIMIT: usize = 4096;
const ARGS_LIMIT: usize = 4096;
const BRACKETS_LIMIT: usize = 1024;

const FILE: &str = "src/x.tsx";
const SRC: &str = "export function X() {\n  return (\n    <main>\n      <p />\n    </main>\n  )\n}\n";

fn on_an_8_mib_stack<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new().stack_size(STACK).spawn(work).unwrap().join().expect("the work thread panicked")
}

fn insert(snippet: &str) -> trivia_oxc_engine::Result<Outcome> {
    let op: Op = serde_json::from_value(json!({
        "op": "insert", "target": format!("{FILE}#X#0"), "placement": "lastChild", "snippet": snippet
    }))
    .unwrap();
    apply_op(SRC, FILE, &op)
}

/// Insert `snippet`, then do with the result what later requests do with a file: annotate
/// it, inspect the new node, move another node across it and remove the new node again.
fn insert_and_use(snippet: &str) -> trivia_oxc_engine::Result<()> {
    let out = insert(snippet)?;
    annotate(&out.code, FILE).expect("annotate the result");
    let locator = out.locator.expect("the inserted node has a locator");
    inspect(&out.code, &locator).expect("inspect the inserted node");
    let moved: Op = serde_json::from_value(json!({
        "op": "moveNode", "source": format!("{FILE}#X#0.0"), "parent": format!("{FILE}#X#0"), "index": 2
    }))
    .unwrap();
    let moved = apply_op(&out.code, FILE, &moved).expect("move the sibling past the inserted node");
    let back: Op = serde_json::from_value(json!({
        "op": "moveNode", "source": format!("{FILE}#X#0.1"), "parent": format!("{FILE}#X#0"), "index": 0
    }))
    .unwrap();
    let back = apply_op(&moved.code, FILE, &back).expect("move it back");
    assert_eq!(back.code, out.code, "move and move back restore the file");
    let remove: Op = serde_json::from_value(json!({ "op": "remove", "target": locator })).unwrap();
    assert_eq!(apply_op(&out.code, FILE, &remove).expect("remove the inserted node").code, SRC);
    Ok(())
}

/// `prefix + unit * n + suffix`, with the largest `n` that keeps it within `limit` bytes.
fn longest(prefix: &str, unit: &str, suffix: &str, limit: usize) -> String {
    let n = (limit - prefix.len() - suffix.len()) / unit.len();
    format!("{prefix}{}{suffix}", unit.repeat(n))
}

/// Operator chains: one nesting level per one to four bytes, and no bracket to count.
const CHAINS: [(&str, &str, &str); 16] = [
    ("<a>{", "!", "x}</a>"),
    ("<a>{", "~", "x}</a>"),
    ("<a>{", "-+", "x}</a>"),
    ("<a>{x", "!", "}</a>"),
    ("<a>{", "x+", "x}</a>"),
    ("<a>{", "x=", "x}</a>"),
    ("<a>{", "x**", "x}</a>"),
    ("<a>{", "x??", "x}</a>"),
    ("<a>{", "a?b:", "x}</a>"),
    ("<a onClick={", "a=>", "a} />"),
    ("<a>{x", ".y", "}</a>"),
    ("<a>{x", "?.y", "}</a>"),
    ("<a>{x", "``", "}</a>"),
    ("<a>{x", " as T", "}</a>"),
    ("<a>{x as A", ".B", "}</a>"),
    ("<a>{", "new ", "X}</a>"),
];

#[test]
fn snippets_are_at_most_4_kib() {
    let at_limit = longest("<p>", "x", "</p>", SNIPPET_LIMIT);
    assert_eq!(at_limit.len(), SNIPPET_LIMIT);
    assert!(insert(&at_limit).is_ok());
    let over = format!("<p>x{}", &at_limit[3..]);
    let err = insert(&over).expect_err("one byte over the limit");
    assert_eq!(err.code(), "invalid_snippet", "{err}");
    assert!(err.to_string().contains("4096"), "{err}");
    // Surrounding whitespace is trimmed before anything else, so it does not count.
    assert!(insert(&format!("\n\n  {at_limit}  \n")).is_ok());
}

/// The review's payloads: a 16 KiB `!!!!x` chain overflowed an 8 MiB stack in the semantic
/// pass. Now refused on its size, before anything parses it.
#[test]
fn sixteen_kib_operator_chains_are_refused_not_crashed_on() {
    on_an_8_mib_stack(|| {
        for (prefix, unit, suffix) in CHAINS {
            let snippet = longest(prefix, unit, suffix, 16 << 10);
            let err = insert(&snippet).expect_err(&format!("{unit:?} × 16 KiB"));
            assert_eq!(err.code(), "invalid_snippet", "{unit:?}: {err}");
        }
    });
}

#[test]
fn the_longest_operator_chains_a_snippet_may_hold_fit_an_8_mib_stack() {
    on_an_8_mib_stack(|| {
        for (prefix, unit, suffix) in CHAINS {
            let snippet = longest(prefix, unit, suffix, SNIPPET_LIMIT);
            insert_and_use(&snippet).unwrap_or_else(|e| panic!("{unit:?} × {}: {e}", snippet.len()));
        }
    });
}

/// Brackets the depth estimate sees are refused past 256 levels. Brackets it is fooled into
/// skipping (`/` after `x.in` reads as the start of a regex) are bounded by the total count
/// of `<`, `(`, `[` and `{` bytes, and the deepest ones that count allows fit too.
#[test]
fn the_deepest_brackets_a_snippet_may_hold_fit_an_8_mib_stack() {
    on_an_8_mib_stack(|| {
        for (open, inner, close) in [("(", "x", ")"), ("[", "x", "]"), ("{a:", "1", "}"), ("f(", "x", ")")] {
            // `<a>{x.in/` and `}</a>` hold three of the counted bytes.
            let fixed = "<a>{x.in//1}</a>".len() + inner.len();
            let levels = (BRACKETS_LIMIT - 3).min((SNIPPET_LIMIT - fixed) / (open.len() + close.len()));
            let fooled = format!("<a>{{x.in/{}{inner}{}/1}}</a>", open.repeat(levels), close.repeat(levels));
            insert_and_use(&fooled).unwrap_or_else(|e| panic!("{open:?} × {levels}: {e}"));
            // Unclosed, the parser still descends every level before it fails.
            let unclosed = format!("<a>{{x.in/{}{inner}}}</a>", open.repeat(levels));
            assert_eq!(insert(&unclosed).unwrap_err().code(), "invalid_snippet", "unclosed {open:?} × {levels}");
            // One counted byte more than the limit is refused before parsing, whatever the
            // estimate says.
            let over = format!("<a>{{x.in/{}{inner}}}</a>", open.repeat(BRACKETS_LIMIT - 2));
            assert!(over.len() <= SNIPPET_LIMIT);
            let err = insert(&over).unwrap_err();
            assert!(err.code() == "invalid_snippet" && err.to_string().contains("1024"), "{open:?}: {err}");
        }
        // Honest nesting: the 256 levels the estimate allows (`<a>` and `{` are two of them).
        insert_and_use(&format!("{}{}", "<a>".repeat(256), "</a>".repeat(256))).unwrap();
        insert_and_use(&format!("<a>{{{}x{}}}</a>", "(".repeat(254), ")".repeat(254))).unwrap();
    });
}

fn binding(args: &str) -> QueryBinding {
    QueryBinding {
        target: format!("{FILE}#X#0"),
        expected_name: Some("DataTable".into()),
        options_fn: "listCustomersOptions".into(),
        options_import: "@/api/generated/@tanstack/react-query.gen".into(),
        options_args: Some(args.into()),
        resource: "Customer".into(),
        items_path: None,
        data_prop: "data".into(),
        loading_prop: Some("isLoading".into()),
    }
}

const TABLE: &str = "import { DataTable } from \"@/components/data-table\"\n\nexport function X() {\n  return (\n    <DataTable>\n      <p />\n    </DataTable>\n  )\n}\n";

/// Bind with `args`, then insert into and annotate the bound file: every later request
/// parses the args as part of the file, and the insert runs the semantic pass over them.
fn bind_and_use(args: &str) -> trivia_oxc_engine::Result<()> {
    let out = bind_query(TABLE, FILE, &binding(args))?;
    annotate(&out.code, FILE).expect("annotate the bound file");
    let op: Op = serde_json::from_value(json!({
        "op": "insert", "target": format!("{FILE}#X#0"), "placement": "lastChild", "snippet": "<b />"
    }))
    .unwrap();
    apply_op(&out.code, FILE, &op).expect("insert into the bound file");
    Ok(())
}

#[test]
fn the_longest_options_args_fit_an_8_mib_stack() {
    on_an_8_mib_stack(|| {
        for (prefix, unit, suffix) in [
            ("", "!", "x"),
            ("x", "!", ""),
            ("{ q: ", "-+", "x }"),
            ("{ q: ", "x+", "x }"),
            ("{ q: ", "x=", "x }"),
            ("{ q: ", "a?b:", "x }"),
            ("{ q: ", "a=>", "a }"),
            ("{ q: x", ".y", " }"),
            ("{ q: x", "``", " }"),
            ("{ q: x", " as T", " }"),
        ] {
            let args = longest(prefix, unit, suffix, ARGS_LIMIT);
            bind_and_use(&args).unwrap_or_else(|e| panic!("{unit:?} × {}: {e}", args.len()));
        }
    });
}

/// The args' depth scan reads `//` in a regex character class as a comment, so the brackets
/// after it go uncounted: a 4 KiB run of `(` used to reach the parser and overflow. The total
/// count of `(`, `[`, `{` and `<` bytes now bounds what any spelling can nest.
#[test]
fn brackets_hidden_from_the_args_depth_scan_are_bounded_too() {
    on_an_8_mib_stack(|| {
        let unclosed = format!("[/[//]/, {}x", "(".repeat(ARGS_LIMIT - 10));
        assert!(unclosed.len() <= ARGS_LIMIT);
        let err = bind_query(TABLE, FILE, &binding(&unclosed)).unwrap_err();
        assert_eq!(err.code(), "invalid_op", "{err}");

        // `[/[//]/, ` holds two of the counted bytes.
        let levels = BRACKETS_LIMIT - 2;
        let closed = format!("[/[//]/, {}x{}]", "(".repeat(levels), ")".repeat(levels));
        bind_and_use(&closed).unwrap();
        let over = format!("[/[//]/, {}x{}]", "(".repeat(levels + 1), ")".repeat(levels + 1));
        let err = bind_query(TABLE, FILE, &binding(&over)).unwrap_err();
        assert!(err.code() == "invalid_op" && err.to_string().contains("1024"), "{err}");
    });
}
