//! Every failure is loud, specific and stable: each `EngineError` path is reached here and
//! checked by `code()` (the filesystem ones are in `workspace.rs`), and no input — partial,
//! mutated or plain garbage — makes the engine panic.

mod common;

use std::collections::BTreeSet;

use common::*;
use serde_json::json;
use trivia_oxc_engine::inspect::inspect;
use trivia_oxc_engine::text::{Edit, apply_edits};
use trivia_oxc_engine::{EngineError, Op, Placement, annotate, annotate_utf16, apply_op};

const FILE: &str = "src/x.tsx";
const SRC: &str = r#"import { Button } from "@/ui/button"

export function X({ on }: { on: boolean }) {
  return (
    <main>
      <Button>Go</Button>
      {on && <p>maybe</p>}
      <>
        <i />
      </>
    </main>
  )
}
"#;

fn at(path: &str) -> String {
    format!("{FILE}#X#{path}")
}

/// Run `op` on `SRC`, expect failure, record and return its code.
fn fails(seen: &mut BTreeSet<&'static str>, op: Op) -> &'static str {
    let err = apply_op(SRC, FILE, &op).expect_err(&format!("{op:?} should fail"));
    check_payload(&err);
    seen.insert(err.code());
    err.code()
}

fn check_payload(err: &EngineError) {
    let payload = err.to_payload();
    assert_eq!(payload.code, err.code());
    assert!(!payload.message.is_empty(), "{err:?} has no message");
}

fn remove(target: &str, expected: Option<&str>) -> Op {
    Op::Remove { target: target.into(), expected_name: expected.map(Into::into) }
}

fn insert(target: &str, placement: Placement, snippet: &str) -> Op {
    Op::Insert { target: target.into(), expected_name: None, placement, snippet: snippet.into(), imports: vec![] }
}

fn move_to(source: &str, target: &str, placement: Placement) -> Op {
    Op::Move { source: source.into(), expected_name: None, target: target.into(), expected_target_name: None, placement }
}

#[test]
fn every_op_error_path_has_its_code() {
    let mut seen = BTreeSet::new();
    let s = &mut seen;

    assert_eq!(fails(s, remove("nope", None)), "invalid_locator");
    assert_eq!(fails(s, remove(&at("0.x"), None)), "invalid_locator");
    assert_eq!(fails(s, remove(&at("0.9"), None)), "node_not_found");
    assert_eq!(fails(s, remove(&format!("{FILE}#Nope#0"), None)), "node_not_found");

    // Stale: the locator now names a different tag. Every op that takes an expected name checks it.
    assert_eq!(fails(s, remove(&at("0.0"), Some("Badge"))), "stale_locator");
    let stale = |op: Op| apply_op(SRC, FILE, &op).unwrap_err().code();
    assert_eq!(stale(Op::UpdateProp { target: at("0.0"), expected_name: Some("B".into()), prop: "a".into(), value: json!(1) }), "stale_locator");
    assert_eq!(stale(Op::Move { source: at("0.0"), expected_name: Some("B".into()), target: at("0"), expected_target_name: None, placement: Placement::LastChild }), "stale_locator");
    assert_eq!(stale(Op::MoveNode { source: at("0.0"), expected_name: Some("B".into()), parent: at("0"), expected_parent_name: None, index: 0 }), "stale_locator");
    // …and so does every locator an op names: insert targets, insertChild parents, move destinations.
    let named = |name: &str| Some(name.to_string());
    assert_eq!(stale(Op::Insert { target: at("0"), expected_name: named("div"), placement: Placement::LastChild, snippet: "<b />".into(), imports: vec![] }), "stale_locator");
    assert_eq!(stale(Op::InsertChild { parent: at("0"), expected_name: named("div"), index: 0, snippet: "<b />".into(), imports: vec![] }), "stale_locator");
    assert_eq!(stale(Op::Move { source: at("0.0"), expected_name: named("Button"), target: at("0"), expected_target_name: named("div"), placement: Placement::LastChild }), "stale_locator");
    assert_eq!(stale(Op::MoveNode { source: at("0.0"), expected_name: named("Button"), parent: at("0"), expected_parent_name: named("div"), index: 0 }), "stale_locator");

    // Roots, nodes inside `{…}`, fragments, other files.
    assert_eq!(fails(s, insert(&at("0"), Placement::Before, "<b />")), "unsupported");
    assert_eq!(fails(s, insert(&at("0.1"), Placement::After, "<b />")), "unsupported");
    assert_eq!(fails(s, remove(&at("0"), None)), "unsupported");
    assert_eq!(fails(s, remove(&at("0.1"), None)), "unsupported");
    assert_eq!(fails(s, move_to(&at("0.1"), &at("0"), Placement::LastChild)), "unsupported");
    assert_eq!(fails(s, Op::UpdateProp { target: at("0.2"), expected_name: None, prop: "a".into(), value: json!(1) }), "unsupported");
    assert_eq!(fails(s, move_to(&at("0.0"), "src/other.tsx#X#0", Placement::LastChild)), "unsupported");

    for snippet in ["", "   ", "hello", "<A /><B />", "<b /> // c", "/* c */ <b />", "(<b />)", "<b>", "{x}", "<b />; <i />", "<b />); f(<i />", "1 + <b />", "<b /> as any"] {
        assert_eq!(fails(s, insert(&at("0"), Placement::LastChild, snippet)), "invalid_snippet", "{snippet:?}");
    }
    assert_eq!(fails(s, insert(&at("0"), Placement::LastChild, "<Missing />")), "unresolved_component");
    assert_eq!(fails(s, insert(&at("0"), Placement::LastChild, "<Card.Header />")), "unresolved_component");

    // The edit itself would not parse.
    assert_eq!(fails(s, Op::UpdateProp { target: at("0.0"), expected_name: None, prop: "a::b".into(), value: json!(1) }), "invalid_result");

    assert_eq!(fails(s, Op::InsertChild { parent: at("0"), expected_name: None, index: 4, snippet: "<b />".into(), imports: vec![] }), "invalid_op");
    assert_eq!(fails(s, Op::MoveNode { source: at("0.0"), expected_name: None, parent: at("0.2"), expected_parent_name: None, index: 2 }), "invalid_op");
    assert_eq!(fails(s, Op::UpdateProp { target: at("0.0"), expected_name: None, prop: "data-ast-node".into(), value: json!("x") }), "invalid_op");
    assert_eq!(fails(s, Op::UpdateProp { target: at("0.0"), expected_name: None, prop: "bad name".into(), value: json!("x") }), "invalid_op");
    // Into itself or its own subtree (`0.2` is the fragment holding `<i />`).
    assert_eq!(fails(s, move_to(&at("0.0"), &at("0.0"), Placement::FirstChild)), "invalid_op");
    assert_eq!(fails(s, move_to(&at("0.2"), &at("0.2.0"), Placement::LastChild)), "invalid_op");
    assert_eq!(fails(s, move_to(&at("0.2"), &at("0.2.0"), Placement::Before)), "invalid_op");
    assert_eq!(fails(s, Op::MoveNode { source: at("0.2"), expected_name: None, parent: at("0.2.0"), expected_parent_name: None, index: 0 }), "invalid_op");
    let bad_import = Op::Insert {
        target: at("0"),
        expected_name: None,
        placement: Placement::LastChild,
        snippet: "<Z />".into(),
        imports: vec![spec("Z", "")],
    };
    assert_eq!(fails(s, bad_import), "invalid_op");

    // Unparsable input.
    let err = apply_op("export const = <", FILE, &remove(&at("0"), None)).unwrap_err();
    check_payload(&err);
    assert_eq!(err.code(), "parse_error");
    seen.insert(err.code());
    assert_eq!(inspect("<<", &at("0")).unwrap_err().code(), "parse_error");

    // An internal invariant (overlapping edits) is reported, never applied.
    let err = apply_edits("abcdef", &[Edit::delete(1, 4), Edit::delete(3, 5)]).unwrap_err();
    check_payload(&err);
    seen.insert(err.code());

    let expected: BTreeSet<&str> = [
        "internal",
        "invalid_locator",
        "invalid_op",
        "invalid_result",
        "invalid_snippet",
        "node_not_found",
        "parse_error",
        "stale_locator",
        "unresolved_component",
        "unsupported",
    ]
    .into();
    assert_eq!(seen, expected);
}

#[test]
fn names_bound_only_as_types_are_refused() {
    let src = "import type { Button } from \"@/ui/button\"\nimport { type Icon } from \"lucide-react\"\ntype Card = { title: string }\n\nexport const X = () => <main />\n";
    let insert = |snippet: &str| Op::Insert {
        target: format!("{FILE}#X#0"),
        expected_name: None,
        placement: Placement::LastChild,
        snippet: snippet.into(),
        imports: vec![spec("Button", "@/ui/button"), spec("Icon", "lucide-react"), spec("Card", "@/ui/card")],
    };
    for snippet in ["<Button />", "<Card />", "<p icon={Icon} />"] {
        let err = apply_op(src, FILE, &insert(snippet)).unwrap_err();
        assert_eq!(err.code(), "unsupported", "{snippet}");
        assert!(err.to_string().contains("only a type"), "{err}");
    }
}

#[test]
fn successful_no_ops_say_unchanged() {
    // Moving next to itself, removing a prop that is not there, setting the same value.
    let same = |op: Op| {
        let out = apply(SRC, FILE, &op);
        assert!(!out.changed, "{op:?}");
        assert_eq!(out.code, SRC);
    };
    same(move_to(&at("0.0"), &at("0.0"), Placement::Before));
    same(move_to(&at("0.0"), &at("0"), Placement::FirstChild));
    same(Op::MoveNode { source: at("0.0"), expected_name: Some("Button".into()), parent: at("0"), expected_parent_name: None, index: 0 });
    same(Op::UpdateProp { target: at("0.0"), expected_name: None, prop: "variant".into(), value: json!(null) });
}

#[test]
fn ops_from_the_api_doc_deserialize() {
    let doc = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/api.md")).unwrap();
    // Examples start with `{ "op"` and may wrap over several lines until the braces balance.
    let mut ops = Vec::new();
    let mut pending: Option<String> = None;
    for line in doc.lines() {
        if line.starts_with("{ \"op\"") {
            pending = Some(String::new());
        }
        let Some(text) = pending.as_mut() else { continue };
        text.push_str(line);
        if text.matches('{').count() == text.matches('}').count() {
            // The doc lists the placements as alternatives; any one of them must parse.
            let text = pending.take().unwrap().replace("before|after|firstChild|lastChild", "firstChild");
            let op: Op = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{text}: {e}"));
            ops.push(op);
        }
    }
    assert_eq!(ops.len(), 17, "one example per op: {ops:?}");
    assert!(matches!(&ops[0], Op::Insert { placement: Placement::FirstChild, imports, expected_name: Some(n), .. } if imports.len() == 1 && n == "CardContent"));
    assert!(matches!(&ops[1], Op::InsertChild { expected_name: Some(n), .. } if n == "CardContent"));
    assert!(matches!(&ops[2], Op::UpdateProp { expected_name: Some(n), .. } if n == "Button"));
    assert!(matches!(&ops[4], Op::Move { expected_name: Some(n), expected_target_name: Some(t), .. } if n == "Button" && t == "CardFooter"));
    assert!(matches!(&ops[5], Op::MoveNode { expected_name: Some(n), expected_parent_name: Some(p), .. } if n == "Button" && p == "CardFooter"));
    assert!(matches!(&ops[6], Op::BindQuery(b) if b.options_fn == "listCustomersOptions" && b.items_path.as_deref() == Some("items")));
    assert!(matches!(&ops[7], Op::SetText { expected_name: Some(n), text, .. } if n == "Button" && text == "Save changes"));
    assert!(matches!(&ops[8], Op::CreateFile { file, .. } if file == "src/components/forms/customer-form.tsx"));
    assert!(matches!(&ops[9], Op::InsertElement { index: Some(2), .. }));
    assert!(matches!(&ops[10], Op::RemoveElement { path } if path.ends_with("#columns[id=segment]")));
    assert!(matches!(&ops[11], Op::MoveElement { index: 0, .. }));
    assert!(matches!(&ops[12], Op::SetProperty { prop, value, .. } if prop == "enableSorting" && value == "false"));
    assert!(matches!(&ops[13], Op::RemoveProperty { prop, .. } if prop == "enableSorting"));
    assert!(matches!(&ops[14], Op::SetCallArgument { method, index: 0, value, .. } if method == "max" && value == "500"));
    assert!(matches!(&ops[15], Op::InsertCall { before, .. } if before == &["optional", "refine"]));
    assert!(matches!(&ops[16], Op::RemoveCall { method, .. } if method == "optional"));
    for placement in ["before", "after", "firstChild", "lastChild"] {
        let text = format!(r#"{{ "op": "move", "source": "a#B#0", "target": "a#B#0", "placement": "{placement}" }}"#);
        assert!(serde_json::from_str::<Op>(&text).is_ok(), "{placement}");
    }
    assert!(serde_json::from_str::<Op>(r#"{ "op": "explode", "target": "x" }"#).is_err());
    assert!(serde_json::from_str::<Op>(r#"{ "op": "remove" }"#).is_err());
    assert!(serde_json::from_str::<Op>(r#"{ "op": "insert", "target": "x", "placement": "inside", "snippet": "<b />" }"#).is_err());
}

/// Byte offsets at char boundaries, every `step` bytes.
fn boundaries(src: &str, step: usize) -> impl Iterator<Item = usize> + '_ {
    (0..=src.len()).step_by(step).filter(|&i| src.is_char_boundary(i))
}

/// Every engine entry point on `src`, with locators that may or may not exist in it.
/// Returns whether `src` parsed (and so went through every op).
fn exercise(src: &str, file: &str, locators: &[String]) -> bool {
    let _ = annotate_utf16(src, file);
    if let Err(e) = annotate(src, file) {
        // Unparsable: every entry point must say so (cheaply: once each).
        assert_eq!(e.code(), "parse_error");
        assert_eq!(inspect(src, &locators[0]).unwrap_err().code(), "parse_error");
        let op = Op::Remove { target: locators[0].clone(), expected_name: None };
        assert_eq!(apply_op(src, file, &op).unwrap_err().code(), "parse_error");
        return false;
    }
    for loc in locators {
        let _ = inspect(src, loc);
        for op in [
            Op::Remove { target: loc.clone(), expected_name: None },
            Op::Insert { target: loc.clone(), expected_name: None, placement: Placement::LastChild, snippet: "<b>x</b>".into(), imports: vec![] },
            Op::Insert { target: loc.clone(), expected_name: None, placement: Placement::Before, snippet: "<Zeta />".into(), imports: vec![spec("Zeta", "@/z")] },
            Op::UpdateProp { target: loc.clone(), expected_name: None, prop: "title".into(), value: json!("a\"b&c") },
            Op::UpdateProp { target: loc.clone(), expected_name: None, prop: "className".into(), value: json!(null) },
            Op::Move { source: loc.clone(), expected_name: None, target: locators[0].clone(), expected_target_name: None, placement: Placement::FirstChild },
        ] {
            if let Ok(out) = apply_op(src, file, &op) {
                // Whatever succeeds must have produced code that parses.
                assert!(annotate(&out.code, file).is_ok(), "{op:?} produced unparsable code");
            }
        }
    }
    true
}

#[test]
fn no_panic_on_any_prefix_of_any_fixture() {
    for fx in fixtures() {
        let t = table(&fx.src, &fx.file);
        let locators: Vec<String> = (0..t.nodes.len()).step_by(3).map(|i| loc(&t, i, &fx.file)).collect();
        let step = if fx.src.len() > 3000 { 13 } else { 3 };
        let parsed = boundaries(&fx.src, step).filter(|&end| exercise(&fx.src[..end], &fx.file, &locators)).count();
        assert!(parsed > 0, "{}: no prefix parsed, so no op ran on a partial file", fx.label);
    }
}

/// xorshift64*: deterministic, so a failure reproduces.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

#[test]
fn no_panic_on_mutated_sources() {
    const PIECES: [&str; 16] = ["<", ">", "/>", "{", "}", "\"", "'", "`", "=", ";", "\r\n", "</a>", "<b>", "&amp;", "😀", "/*"];
    let mut rng = Rng(0x7269_7669_6121);
    let mut parsed = 0;
    for fx in fixtures() {
        let t = table(&fx.src, &fx.file);
        let locators: Vec<String> = (0..t.nodes.len()).step_by(4).map(|i| loc(&t, i, &fx.file)).collect();
        for _ in 0..60 {
            let mut src = fx.src.clone();
            for _ in 0..1 + rng.below(3) {
                let at = loop {
                    let i = rng.below(src.len() + 1);
                    if src.is_char_boundary(i) {
                        break i;
                    }
                };
                let len = rng.below(4);
                let end = (at + len..=src.len()).find(|&e| src.is_char_boundary(e)).unwrap_or(src.len());
                src.replace_range(at..end, PIECES[rng.below(PIECES.len())]);
            }
            parsed += usize::from(exercise(&src, &fx.file, &locators));
        }
    }
    assert!(parsed >= 50, "only {parsed} mutated sources parsed: the sweep barely ran any op");
}

#[test]
fn no_panic_on_garbage() {
    let garbage = [
        "", " ", "\n", "\r\n", "\u{feff}", "\u{feff}export const X = () => <div />", "<", ">", "<>", "</>", "<<>>", "}{", "{",
        "<div>{</div>", "<div attr=></div>", "<div {...}></div>", "<a></b>", "'unterminated", "`${", "/* open", "\0",
        "export default <></>", "<x:y z:w=\"1\" />", "<A.B.C />", "<this.x />", "x = <a>&#xZZZZZZZZ;&;&#;</a>",
    ];
    let locators = vec![format!("{FILE}#module#0"), format!("{FILE}#default#0"), format!("{FILE}#X#0.0")];
    for g in garbage {
        exercise(g, FILE, &locators);
    }
    // Deep nesting stays well within the stack.
    let deep = format!("export const X = () => {}{}", "<a>".repeat(300), "</a>".repeat(300));
    assert_eq!(annotate(&deep, FILE).unwrap().len(), 300);
    exercise(&deep, FILE, &[format!("{FILE}#X#0"), format!("{FILE}#X#0{}", ".0".repeat(298))]);
}

/// The parser recurses once per nesting level, so a snippet nested thousands of levels deep
/// would overflow the native stack and take the whole dev server down with it. Such snippets
/// are refused before parsing (`invalid_snippet`). Runs on a thread with a large stack, so
/// that if the check were missing this test would fail on its assertion instead of crashing.
#[test]
fn deeply_nested_snippets_are_refused_before_parsing() {
    std::thread::Builder::new()
        .stack_size(256 << 20)
        .spawn(|| {
            let insert = |snippet: String| -> Result<(), String> {
                let op: Op = serde_json::from_value(json!({
                    "op": "insert", "target": at("0"), "placement": "lastChild", "snippet": snippet
                }))
                .unwrap();
                match apply_op(SRC, FILE, &op) {
                    Ok(_) => Ok(()),
                    Err(e) if e.code() == "invalid_snippet" => Err(e.to_string()),
                    Err(e) => panic!("unexpected {}: {e}", e.code()),
                }
            };
            let nested = |open: &str, inner: &str, close: &str, n: usize| format!("{}{inner}{}", open.repeat(n), close.repeat(n));

            // The report's payload (140 KB) is refused on its size alone; and the documented
            // depth limit (256 levels).
            let err = insert(nested("<a>", "", "</a>", 20_000)).expect_err("20k levels");
            assert!(err.contains("4096"), "{err}");
            assert!(insert(nested("<a>", "", "</a>", 255)).is_ok());
            let err = insert(nested("<a>", "", "</a>", 257)).expect_err("257 levels");
            assert!(err.contains("257 levels") && err.contains("256"), "{err}");
            // Brackets, `{…}` and attribute values count too.
            assert!(insert(format!("<a>{{{}}}</a>", nested("(", "x", ")", 300))).is_err());
            assert!(insert(format!("<a>{{{}}}</a>", nested("[", "x", "]", 300))).is_err());
            assert!(insert(format!("<a>{{{}}}</a>", nested("{a:", "1", "}", 300))).is_err());
            assert!(insert(nested("<a b={", "1", "} />", 300)).is_err());
            assert!(insert(format!("<a>{{{}}}</a>", nested("`${", "x", "}`", 300))).is_err());

            // Width is not depth: many siblings, and brackets inside text, strings, comments
            // and templates, are fine.
            assert!(insert(format!("<ul>{}</ul>", "<li>(x) [y] {'{'}</li>".repeat(150))).is_ok());
            assert!(insert(format!("<p title=\"{}\">{}</p>", "(<[{".repeat(100), "(".repeat(300))).is_ok());
            assert!(insert(format!("<p>{{/* {} */ `{}` + \"{}\"}}</p>", "(".repeat(300), "[".repeat(300), "{".repeat(300))).is_ok());

            // Text that only looks like closing tags does not hide real nesting from the
            // estimate. (Snippets that deep are also over the size limit.)
            for (open, close) in [("<a t=\"/></a>\">", "</a>"), ("<a>{\"</a>\"}", "</a>"), ("<a>{/[</a>]/}", "</a>")] {
                let deep = nested(open, "", close, 20_000);
                assert!(trivia_oxc_engine::text::nesting_depth(&deep) >= 20_000, "{open}");
                assert!(insert(deep).is_err(), "{open}");
            }
            // And whatever the depth estimate says, a snippet with more than 1024 tags and
            // brackets in total is refused, so no spelling can get a deeper one to the parser.
            let err = insert(format!("<p>{}</p>", "(".repeat(1100))).expect_err("1100 brackets");
            assert!(err.contains("1024"), "{err}");
        })
        .unwrap()
        .join()
        .unwrap();
}
