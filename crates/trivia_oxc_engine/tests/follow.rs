//! Following a node through an op (`trivia_oxc_engine::follow`): where a selected element is
//! after an edit renumbered the file's locators, on a page shaped like a Refine list (columns in
//! a `useMemo` before the returned tree, so their JSX is numbered first).

use serde_json::json;
use trivia_oxc_engine::follow::{self, FileTexts};
use trivia_oxc_engine::locator::JsxTable;
use trivia_oxc_engine::{Locator, Op, apply_across, apply_op, parse};

const FILE: &str = "src/pages/customers/list.tsx";

const LIST: &str = r#"import { useMemo } from "react"
import { Badge } from "@/components/ui/badge"

export function CustomerList() {
  const columns = useMemo(
    () => [
      {
        id: "name",
        header: () => <span>Name</span>,
        cell: ({ row }) => <Badge>{row.name}</Badge>,
      },
      {
        id: "status",
        header: () => <span>Status</span>,
        cell: ({ row }) => <Badge>{row.status}</Badge>,
      },
      {
        id: "tier",
        header: () => <span>Tier</span>,
        cell: ({ row }) => <Badge>{row.tier}</Badge>,
      },
    ],
    [],
  )
  return (
    <ListView>
      <h1>Customers</h1>
      <DataTable columns={columns} />
    </ListView>
  )
}
"#;

/// Apply `op` to `src` and follow each of `locators` through it: the result's text and answers.
fn follow_op(src: &str, op: serde_json::Value, locators: &[&str]) -> (String, Vec<Option<String>>) {
    let op: Op = serde_json::from_value(op).expect("an op");
    let (outcome, stages) = follow::recording(|| apply_op(src, FILE, &op));
    let outcome = outcome.expect("the op applies");
    let files = [FileTexts { file: FILE, before: Some(src), after: Some(&outcome.code) }];
    let answers = locators
        .iter()
        .map(|l| follow::through(&op, &stages, &files, outcome.locator.as_deref(), &Locator::parse(l).unwrap()).map(|l| l.to_string()))
        .collect();
    (outcome.code, answers)
}

/// The tag and text of the node at `locator` in `src`, to say which node an answer names.
fn node_at(src: &str, locator: &str) -> String {
    let alloc = oxc_allocator::Allocator::default();
    let program = parse(&alloc, src, FILE).unwrap();
    let table = JsxTable::build(&program, FILE).unwrap();
    let loc = Locator::parse(locator).unwrap();
    let node = &table.nodes[table.find(&loc.scope, &loc.path).unwrap_or_else(|| panic!("no node at {locator}"))];
    src[node.span.start as usize..node.span.end as usize].to_string()
}

/// Every locator of `src` whose node's text is `text`, in table order.
fn locators_of(src: &str, text: &str) -> Vec<String> {
    let alloc = oxc_allocator::Allocator::default();
    let program = parse(&alloc, src, FILE).unwrap();
    let table = JsxTable::build(&program, FILE).unwrap();
    (0..table.nodes.len())
        .filter(|&i| &src[table.nodes[i].span.start as usize..table.nodes[i].span.end as usize] == text)
        .map(|i| table.locator(i, FILE).to_string())
        .collect()
}

fn one(src: &str, text: &str) -> String {
    let found = locators_of(src, text);
    assert_eq!(found.len(), 1, "{text} once in the file: {found:?}");
    found[0].clone()
}

#[test]
fn removing_a_column_moves_the_page_tree_up_and_drops_only_what_was_in_the_column() {
    let heading = one(LIST, "<h1>Customers</h1>");
    let status = one(LIST, "<span>Status</span>");
    let tier = one(LIST, "<span>Tier</span>");
    let (after, answers) = follow_op(
        LIST,
        json!({ "op": "removeElement", "path": format!("{FILE}#CustomerList#columns[id=status]") }),
        &[&heading, &status, &tier],
    );
    assert_ne!(one(&after, "<h1>Customers</h1>"), heading, "the removal renumbered the page tree");
    assert_eq!(answers[0].as_deref().map(|l| node_at(&after, l)).as_deref(), Some("<h1>Customers</h1>"));
    assert_eq!(answers[1], None, "the removed column's header is gone");
    assert_eq!(answers[2].as_deref().map(|l| node_at(&after, l)).as_deref(), Some("<span>Tier</span>"));
}

#[test]
fn removing_the_first_of_two_same_shaped_cells_keeps_the_second_never_its_neighbour() {
    // Two columns whose cells are the same bytes: the first goes, the second must follow.
    let src = LIST.replace("{row.status}", "{row.name}");
    let cells = locators_of(&src, "<Badge>{row.name}</Badge>");
    assert_eq!(cells.len(), 2);
    let (after, answers) = follow_op(&src, json!({ "op": "removeElement", "path": format!("{FILE}#CustomerList#columns[id=name]") }), &[&cells[0], &cells[1]]);
    let left = locators_of(&after, "<Badge>{row.name}</Badge>");
    assert_eq!(left.len(), 1);
    assert_eq!(answers[0], None, "the removed column's cell is gone");
    assert_eq!(answers[1].as_deref(), Some(left[0].as_str()), "the second cell, now the only one");
    assert_eq!(cells[0], left[0], "and the neighbour's old locator is the one it now has: guessing by locator would be wrong");
}

#[test]
fn inserting_a_column_with_a_jsx_header_and_an_import_shifts_the_page_tree() {
    let heading = one(LIST, "<h1>Customers</h1>");
    let table = one(LIST, "<DataTable columns={columns} />");
    let (after, answers) = follow_op(
        LIST,
        json!({
            "op": "insertElement",
            "path": format!("{FILE}#CustomerList#columns"),
            "index": 0,
            "value": "{ id: \"since\", header: () => <Label>Since</Label> }",
            "imports": [{ "name": "Label", "source": "@/components/ui/label" }],
        }),
        &[&heading, &table],
    );
    assert!(after.contains("import { Label } from \"@/components/ui/label\""), "{after}");
    assert_eq!(answers[0].as_deref().map(|l| node_at(&after, l)).as_deref(), Some("<h1>Customers</h1>"));
    assert_eq!(answers[1].as_deref().map(|l| node_at(&after, l)).as_deref(), Some("<DataTable columns={columns} />"));
    assert_ne!(answers[0].as_deref(), Some(heading.as_str()));
}

#[test]
fn moving_a_column_takes_its_cells_along_and_renumbers_the_columns_it_passed() {
    let status = one(LIST, "<Badge>{row.status}</Badge>");
    let name = one(LIST, "<span>Name</span>");
    let heading = one(LIST, "<h1>Customers</h1>");
    let (after, answers) = follow_op(
        LIST,
        json!({ "op": "moveElement", "path": format!("{FILE}#CustomerList#columns[id=tier]"), "index": 0 }),
        &[&status, &name, &heading],
    );
    let tier_after = one(&after, "<span>Tier</span>");
    assert!(after.find("<span>Tier</span>").unwrap() < after.find("<span>Name</span>").unwrap(), "{after}");
    let (_, moved) = follow_op(LIST, json!({ "op": "moveElement", "path": format!("{FILE}#CustomerList#columns[id=tier]"), "index": 0 }), &[&one(LIST, "<span>Tier</span>")]);
    assert_eq!(moved[0].as_deref(), Some(tier_after.as_str()), "a node inside the moved column goes with it");
    assert_eq!(answers[0].as_deref().map(|l| node_at(&after, l)).as_deref(), Some("<Badge>{row.status}</Badge>"));
    assert_eq!(answers[1].as_deref().map(|l| node_at(&after, l)).as_deref(), Some("<span>Name</span>"));
    assert_eq!(answers[2].as_deref(), Some(heading.as_str()), "the page tree comes after the columns either way");
}

#[test]
fn setting_a_property_that_holds_the_selected_element_keeps_it_when_its_tag_stays() {
    let status = one(LIST, "<span>Status</span>");
    let tier = one(LIST, "<span>Tier</span>");
    let (after, answers) = follow_op(
        LIST,
        json!({ "op": "setProperty", "path": format!("{FILE}#CustomerList#columns[id=status]"), "prop": "header", "value": "() => <strong>State</strong>", "imports": [] }),
        &[&status, &tier],
    );
    assert!(after.contains("<strong>State</strong>"), "{after}");
    assert_eq!(answers[0], None, "the header it replaced was a span inside the old value");
    assert_eq!(answers[1].as_deref().map(|l| node_at(&after, l)).as_deref(), Some("<span>Tier</span>"));
}

#[test]
fn jsx_ops_follow_too_an_insert_a_removal_and_a_move_with_its_subtree() {
    let heading = one(LIST, "<h1>Customers</h1>");
    let table = one(LIST, "<DataTable columns={columns} />");
    // An insert before the heading shifts it and the table.
    let (after, answers) = follow_op(
        LIST,
        json!({ "op": "insert", "target": heading, "expectedName": "h1", "placement": "before", "snippet": "<p>Intro</p>" }),
        &[&heading, &table],
    );
    assert_eq!(answers[0].as_deref().map(|l| node_at(&after, l)).as_deref(), Some("<h1>Customers</h1>"));
    assert_eq!(answers[1].as_deref().map(|l| node_at(&after, l)).as_deref(), Some("<DataTable columns={columns} />"));
    // Removing the heading drops it and moves the table up.
    let (after, answers) = follow_op(LIST, json!({ "op": "remove", "target": heading, "expectedName": "h1" }), &[&heading, &table]);
    assert_eq!(answers[0], None);
    assert_eq!(answers[1].as_deref().map(|l| node_at(&after, l)).as_deref(), Some("<DataTable columns={columns} />"));
    // Moving the heading after the table: it goes along, the table moves up.
    let (after, answers) = follow_op(
        LIST,
        json!({ "op": "move", "source": heading, "expectedName": "h1", "target": table, "expectedTargetName": "DataTable", "placement": "after" }),
        &[&heading, &table],
    );
    assert_eq!(answers[0].as_deref().map(|l| node_at(&after, l)).as_deref(), Some("<h1>Customers</h1>"));
    assert_eq!(answers[1].as_deref().map(|l| node_at(&after, l)).as_deref(), Some("<DataTable columns={columns} />"));
    assert!(after.find("<DataTable").unwrap() < after.find("<h1>").unwrap());
}

#[test]
fn an_edit_inside_the_selected_element_keeps_it_and_one_of_its_tag_keeps_it_only_as_written() {
    let heading = one(LIST, "<h1>Customers</h1>");
    let (after, answers) = follow_op(
        LIST,
        json!({ "op": "updateProp", "target": heading, "expectedName": "h1", "prop": "className", "value": "text-xl" }),
        &[&heading],
    );
    assert_eq!(answers[0].as_deref().map(|l| node_at(&after, l)).as_deref(), Some("<h1 className=\"text-xl\">Customers</h1>"));
    let (after, answers) = follow_op(LIST, json!({ "op": "setText", "target": heading, "expectedName": "h1", "text": "Clients" }), &[&heading]);
    assert_eq!(answers[0].as_deref().map(|l| node_at(&after, l)).as_deref(), Some("<h1>Clients</h1>"));
    // Replaced whole by an element of the same tag: the one in its place now.
    let (after, answers) = follow_op(LIST, json!({ "op": "replaceElement", "target": heading, "expectedName": "h1", "snippet": "<h1>Accounts</h1>" }), &[&heading]);
    assert_eq!(answers[0].as_deref().map(|l| node_at(&after, l)).as_deref(), Some("<h1>Accounts</h1>"));
    // By another tag: gone.
    let (_, answers) = follow_op(LIST, json!({ "op": "replaceElement", "target": heading, "expectedName": "h1", "snippet": "<h2>Accounts</h2>" }), &[&heading]);
    assert_eq!(answers[0], None);
}

#[test]
fn a_locator_that_resolves_to_nothing_is_none_and_an_unchanged_file_keeps_it() {
    let (_, answers) = follow_op(LIST, json!({ "op": "removeElement", "path": format!("{FILE}#CustomerList#columns[id=tier]") }), &[&format!("{FILE}#CustomerList#9.9")]);
    assert_eq!(answers[0], None);
    let heading = one(LIST, "<h1>Customers</h1>");
    let (after, answers) = follow_op(LIST, json!({ "op": "moveElement", "path": format!("{FILE}#CustomerList#columns[id=name]"), "index": 0 }), &[&heading]);
    assert_eq!(after, LIST, "moving the first column to the front writes nothing");
    assert_eq!(answers[0].as_deref(), Some(heading.as_str()));
}

#[test]
fn a_move_to_another_file_takes_the_subtree_there_and_shifts_what_stays() {
    let other = "src/pages/Other.tsx";
    let other_src = "export function Other() {\n  return (\n    <section>\n      <p>Hello</p>\n    </section>\n  )\n}\n";
    let heading = one(LIST, "<h1>Customers</h1>");
    let table = one(LIST, "<DataTable columns={columns} />");
    let op: Op = serde_json::from_value(json!({
        "op": "moveNode", "source": heading, "expectedName": "h1",
        "parent": format!("{other}#Other#0"), "expectedParentName": "section", "index": 0,
    }))
    .unwrap();
    let (across, stages) = follow::recording(|| apply_across(LIST, FILE, other_src, other, &op));
    let across = across.expect("the move applies");
    let files = [
        FileTexts { file: FILE, before: Some(LIST), after: Some(&across.from) },
        FileTexts { file: other, before: Some(other_src), after: Some(&across.to.code) },
    ];
    let follow = |l: &str| follow::through(&op, &stages, &files, across.to.locator.as_deref(), &Locator::parse(l).unwrap()).map(|l| l.to_string());
    assert_eq!(follow(&heading).as_deref(), Some(format!("{other}#Other#0.0").as_str()));
    let paragraph = follow(&format!("{other}#Other#0.0"));
    assert_eq!(paragraph.as_deref(), Some(format!("{other}#Other#0.1").as_str()), "the paragraph it landed before");
    let table_after = follow(&table).expect("the table stays");
    assert_eq!(node_at(&across.from, &table_after), "<DataTable columns={columns} />");
}

#[test]
fn removing_each_element_of_the_dashboard_drops_its_subtree_and_follows_everything_else() {
    let file = "src/pages/Dashboard.tsx";
    let src = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/Dashboard.tsx")).unwrap();
    let alloc = oxc_allocator::Allocator::default();
    let program = parse(&alloc, &src, file).unwrap();
    let table = JsxTable::build(&program, file).unwrap();
    let text = |s: &str, n: &trivia_oxc_engine::locator::JsxNode| s[n.span.start as usize..n.span.end as usize].to_string();
    let mut removed = 0;
    for (i, node) in table.nodes.iter().enumerate() {
        let target = table.locator(i, file).to_string();
        let op: Op = serde_json::from_value(json!({ "op": "remove", "target": target, "expectedName": node.display_name() })).unwrap();
        let (outcome, stages) = follow::recording(|| apply_op(&src, file, &op));
        let Ok(outcome) = outcome else { continue }; // a root the engine won't remove
        removed += 1;
        let after_alloc = oxc_allocator::Allocator::default();
        let after_program = parse(&after_alloc, &outcome.code, file).unwrap();
        let after_table = JsxTable::build(&after_program, file).unwrap();
        let files = [FileTexts { file, before: Some(&src), after: Some(&outcome.code) }];
        let gone = table.subtree(i);
        for (j, other) in table.nodes.iter().enumerate() {
            let loc = table.locator(j, file);
            let answer = follow::through(&op, &stages, &files, outcome.locator.as_deref(), &loc);
            if gone.contains(&j) {
                assert_eq!(answer, None, "removing {target}: {loc} was inside it");
                continue;
            }
            let answer = answer.unwrap_or_else(|| panic!("removing {target}: {loc} stays, but was not followed"));
            let found = &after_table.nodes[after_table.find(&answer.scope, &answer.path).unwrap()];
            assert_eq!(found.name, other.name, "removing {target}: {loc} -> {answer}");
            if !table.subtree(j).contains(&i) {
                assert_eq!(text(&outcome.code, found), text(&src, other), "removing {target}: {loc} -> {answer} is untouched");
            }
        }
    }
    assert!(removed > 10, "the sweep removed {removed} elements");
}
