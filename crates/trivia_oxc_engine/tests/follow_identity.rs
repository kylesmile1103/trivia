//! Every answer `follow::through` gives is the same element, by identity: before the op each
//! element carries a `data-ast-node` of its own (`annotate_source`), and the answer must land on
//! the element carrying it. And no element that is still there is answered `None`. Swept over
//! every JSX op between every pair of nodes, the value ops on JSX arrays and column objects, and
//! moves between two files (contributed by the review of `follow`, 2026-11-27).

use serde_json::json;
use trivia_oxc_engine::follow::{self, FileTexts};
use trivia_oxc_engine::locator::{AttrValue, JsxTable, NodeKind, annotate_source};
use trivia_oxc_engine::{Op, apply_op, parse};

const INLINE: &str = r#"export function Inline() {
  const header = <span>H</span>
  return (
    <main>
      <p><b>a</b><b>b</b> <i>c</i></p>
      <ul>{[1, 2].map((n) => <li key={n}>{n}</li>)}</ul>
      {cond && <b>x</b>}
      <Route element={<b>y</b>} />
      <><b>f1</b><b>f2</b></>
      <div><div>nested</div></div>
      <div>
        <div>
          <div>deep</div>
        </div>
      </div>
    </main>
  )
}
export function Other() {
  return <section><b>o</b></section>
}
"#;

fn id_of(_src: &str, table: &JsxTable, i: usize) -> Option<String> {
    table.nodes[i].attributes.iter().find(|a| a.name.as_deref() == Some("data-ast-node")).and_then(|a| match &a.value {
        Some(AttrValue::String { value, .. }) => Some(value.clone()),
        _ => None,
    })
}

fn sweep(file: &str, raw: &str) -> (usize, usize, usize, Vec<String>) {
    let alloc = oxc_allocator::Allocator::default();
    let program = parse(&alloc, raw, file).unwrap();
    let src = annotate_source(&program, file).unwrap();
    let alloc = oxc_allocator::Allocator::default();
    let program = parse(&alloc, &src, file).unwrap();
    let table = JsxTable::build(&program, file).unwrap();
    let n = table.nodes.len();
    let loc = |i: usize| table.locator(i, file).to_string();
    let name = |i: usize| table.nodes[i].display_name().to_string();
    let mut ops = Vec::new();
    for i in 0..n {
        for placement in ["before", "after", "firstChild", "lastChild"] {
            ops.push(json!({ "op": "insert", "target": loc(i), "expectedName": name(i), "placement": placement, "snippet": "<em>new</em>" }));
        }
        ops.push(json!({ "op": "remove", "target": loc(i), "expectedName": name(i) }));
        ops.push(json!({ "op": "updateProp", "target": loc(i), "expectedName": name(i), "prop": "className", "value": "z" }));
        ops.push(json!({ "op": "setText", "target": loc(i), "expectedName": name(i), "text": "t" }));
        for j in 0..n {
            for placement in ["before", "after", "firstChild", "lastChild"] {
                ops.push(json!({ "op": "move", "source": loc(i), "expectedName": name(i), "target": loc(j), "expectedTargetName": name(j), "placement": placement }));
            }
            for index in 0..=table.nodes[j].children.len() {
                ops.push(json!({ "op": "moveNode", "source": loc(i), "expectedName": name(i), "parent": loc(j), "expectedParentName": name(j), "index": index }));
            }
        }
    }
    let (mut applied, mut answered, mut lost) = (0, 0, 0);
    let mut wrong = Vec::new();
    for raw_op in ops {
        let op: Op = serde_json::from_value(raw_op.clone()).unwrap();
        let (outcome, stages) = follow::recording(|| apply_op(&src, file, &op));
        let Ok(outcome) = outcome else { continue };
        if !outcome.changed {
            continue;
        }
        applied += 1;
        let after = outcome.code.clone();
        let a_alloc = oxc_allocator::Allocator::default();
        let a_program = parse(&a_alloc, &after, file).unwrap();
        let a_table = JsxTable::build(&a_program, file).unwrap();
        let files = [FileTexts { file, before: Some(&src), after: Some(&after) }];
        for k in 0..n {
            if table.nodes[k].kind != NodeKind::Element {
                continue;
            }
            let want = id_of(&src, &table, k).unwrap();
            let answer = follow::through(&op, &stages, &files, outcome.locator.as_deref(), &table.locator(k, file));
            let still_there = (0..a_table.nodes.len()).any(|x| id_of(&after, &a_table, x).as_deref() == Some(want.as_str()));
            match answer {
                Some(answer) => {
                    answered += 1;
                    let Some(x) = a_table.find(&answer.scope, &answer.path) else {
                        wrong.push(format!("{raw_op}: {want} -> {answer} resolves to nothing"));
                        continue;
                    };
                    let got = id_of(&after, &a_table, x);
                    if got.as_deref() != Some(want.as_str()) {
                        wrong.push(format!("{raw_op}: {want} -> {answer}, which is {got:?}"));
                    }
                }
                None if still_there => lost += 1,
                None => {}
            }
        }
    }
    (applied, answered, lost, wrong)
}

#[test]
fn sweep_follow_by_identity() {
    let dash = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/Dashboard.tsx")).unwrap();
    for (file, src) in [("src/pages/Dashboard.tsx", dash.as_str()), ("src/Inline.tsx", INLINE)] {
        let (applied, answered, lost, wrong) = sweep(file, src);
        assert!(applied > 1000 && answered > 10_000, "{file}: {applied} ops, {answered} answers");
        assert!(wrong.is_empty(), "{file}: {} wrong answers, the first: {:#?}", wrong.len(), &wrong[..wrong.len().min(5)]);
        assert_eq!(lost, 0, "{file}: elements still there but answered None");
    }
}

const VALUES: &str = r#"export function Page() {
  const icons = [<Icon a />, <Icon b />, <Icon c />]
  const rows = [
    <Row>one</Row>,
    <Row>two</Row>,
    <Row>three</Row>,
  ]
  const columns = [
    { id: "a", header: <span>A</span>, cell: () => <b>a</b> },
    {
      id: "b",
      header: <span>B</span>,
      cell: () => <b>b</b>,
    },
    { id: "c", header: () => <span>C</span> },
  ]
  return (
    <main>
      <Table columns={[{ id: "x", header: <span>X</span> }, { id: "y", header: <span>Y</span> }]} />
      <span>tail</span>
    </main>
  )
}
"#;

#[test]
fn sweep_value_ops_by_identity() {
    let file = "src/Page.tsx";
    let alloc = oxc_allocator::Allocator::default();
    let program = parse(&alloc, VALUES, file).unwrap();
    let src = annotate_source(&program, file).unwrap();
    let alloc = oxc_allocator::Allocator::default();
    let program = parse(&alloc, &src, file).unwrap();
    let table = JsxTable::build(&program, file).unwrap();
    let n = table.nodes.len();
    let p = |s: &str| format!("{file}#Page#{s}");
    let mut ops = Vec::new();
    for (arr, elems) in [("icons", vec!["[0]", "[1]", "[2]"]), ("rows", vec!["[0]", "[1]", "[2]"]), ("columns", vec!["[id=a]", "[id=b]", "[id=c]"]), ("<Table>.columns", vec!["[id=x]", "[id=y]"])] {
        for (i, e) in elems.iter().enumerate() {
            ops.push(json!({ "op": "removeElement", "path": p(&format!("{arr}{e}")) }));
            for index in 0..elems.len() {
                if index != i {
                    ops.push(json!({ "op": "moveElement", "path": p(&format!("{arr}{e}")), "index": index }));
                }
            }
        }
        for index in 0..=elems.len() {
            let value = if arr.contains("olumns") { "{ id: \"n\", header: <span>N</span> }" } else { "<i>n</i>" };
            ops.push(json!({ "op": "insertElement", "path": p(arr), "index": index, "value": value, "imports": [] }));
        }
    }
    for e in ["[id=a]", "[id=b]", "[id=c]"] {
        // Not `header: <span>Z</span>`: a value replaced whole by one of its tag is the new element
        // by design (tests/follow.rs, replaceElement), which identity would call wrong.
        for (prop, value) in [("header", "<i>Z</i>"), ("cell", "() => <b>z</b>"), ("extra", "<u>e</u>")] {
            ops.push(json!({ "op": "setProperty", "path": p(&format!("columns{e}")), "prop": prop, "value": value, "imports": [] }));
        }
        for prop in ["header", "cell", "id"].into_iter().filter(|p| !(e == "[id=c]" && *p == "cell")) {
            ops.push(json!({ "op": "removeProperty", "path": p(&format!("columns{e}")), "prop": prop }));
        }
    }
    let (mut applied, mut answered, mut lost) = (0, 0, 0);
    let mut wrong = Vec::new();
    for raw_op in ops {
        let op: Op = serde_json::from_value(raw_op.clone()).unwrap();
        let (outcome, stages) = follow::recording(|| apply_op(&src, file, &op));
        let outcome = outcome.unwrap_or_else(|e| panic!("{raw_op}: {e}"));
        if !outcome.changed { continue; }
        applied += 1;
        let after = outcome.code.clone();
        let a_alloc = oxc_allocator::Allocator::default();
        let a_program = parse(&a_alloc, &after, file).unwrap();
        let a_table = JsxTable::build(&a_program, file).unwrap();
        let files = [FileTexts { file, before: Some(&src), after: Some(&after) }];
        for k in 0..n {
            let want = id_of(&src, &table, k).unwrap();
            let answer = follow::through(&op, &stages, &files, outcome.locator.as_deref(), &table.locator(k, file));
            let still_there = (0..a_table.nodes.len()).any(|x| id_of(&after, &a_table, x).as_deref() == Some(want.as_str()));
            match answer {
                Some(answer) => {
                    answered += 1;
                    let x = a_table.find(&answer.scope, &answer.path).unwrap();
                    let got = id_of(&after, &a_table, x);
                    if got.as_deref() != Some(want.as_str()) {
                        wrong.push(format!("{raw_op}: {want} -> {answer}, which is {got:?}"));
                    }
                }
                None if still_there => lost += 1,
                None => {}
            }
        }
    }
    assert!(applied > 60, "{applied} value ops applied");
    assert!(wrong.is_empty(), "{} wrong answers: {wrong:#?}", wrong.len());
    assert_eq!(lost, 0, "elements still there but answered None");
    let _ = answered;
}

fn annotated(file: &str, raw: &str) -> String {
    let alloc = oxc_allocator::Allocator::default();
    let program = parse(&alloc, raw, file).unwrap();
    annotate_source(&program, file).unwrap()
}

fn ids(file: &str, src: &str) -> Vec<(trivia_oxc_engine::Locator, String, String)> {
    let alloc = oxc_allocator::Allocator::default();
    let program = parse(&alloc, src, file).unwrap();
    let table = JsxTable::build(&program, file).unwrap();
    (0..table.nodes.len())
        .filter_map(|i| id_of(src, &table, i).map(|id| (table.locator(i, file), id, table.nodes[i].display_name().to_string())))
        .collect()
}

fn id_at(file: &str, src: &str, loc: &trivia_oxc_engine::Locator) -> Option<Option<String>> {
    let alloc = oxc_allocator::Allocator::default();
    let program = parse(&alloc, src, file).unwrap();
    let table = JsxTable::build(&program, file).unwrap();
    table.find(&loc.scope, &loc.path).map(|x| id_of(src, &table, x))
}

#[test]
fn sweep_across_files_by_identity() {
    let dash = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/Dashboard.tsx")).unwrap();
    let (fa, fb) = ("src/pages/Dashboard.tsx", "src/Inline.tsx");
    let a = annotated(fa, &dash);
    let b = annotated(fb, INLINE).replace("export function Inline", "import { Badge } from \"@/components/ui/badge\"\nimport { Button } from \"@/components/ui/button\"\nimport { Label } from \"@/components/ui/label\"\nexport function Inline");
    let (a_ids, b_ids) = (ids(fa, &a), ids(fb, &b));
    let (mut applied, mut answered, mut wrong) = (0, 0, Vec::new());
    for (src_loc, _, src_name) in &a_ids {
        for (dst_loc, _, dst_name) in &b_ids {
            for index in 0..3 {
                let raw = json!({ "op": "moveNode", "source": src_loc.to_string(), "expectedName": src_name, "parent": dst_loc.to_string(), "expectedParentName": dst_name, "index": index });
                let op: Op = serde_json::from_value(raw.clone()).unwrap();
                let (out, stages) = follow::recording(|| trivia_oxc_engine::apply_across(&a, fa, &b, fb, &op));
                let Ok(out) = out else { continue };
                applied += 1;
                let files = [FileTexts { file: fa, before: Some(&a), after: Some(&out.from) }, FileTexts { file: fb, before: Some(&b), after: Some(&out.to.code) }];
                for (loc, want, _) in a_ids.iter().chain(&b_ids) {
                    let Some(answer) = follow::through(&op, &stages, &files, out.to.locator.as_deref(), loc) else { continue };
                    answered += 1;
                    let text = if answer.file == fa { &out.from } else { &out.to.code };
                    let got = id_at(&answer.file, text, &answer).flatten();
                    if got.as_deref() != Some(want.as_str()) {
                        wrong.push(format!("{raw}: {want} -> {answer} is {got:?}"));
                    }
                }
            }
        }
    }
    assert!(applied > 100 && answered > 1000, "{applied} moves, {answered} answers");
    assert!(wrong.is_empty(), "{} wrong answers, the first: {:#?}", wrong.len(), &wrong[..wrong.len().min(5)]);
}
