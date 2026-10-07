//! CLAUDE.md rule 4: every op can carry the tag name the caller saw at each locator it
//! names, and the engine fails loudly (`stale_locator`) when the locator now resolves to
//! something else, e.g. after a hand edit in the IDE inserted a node above it. A guard the
//! caller believes it sent must never be dropped silently: unknown or misspelled fields are
//! rejected when the op is deserialized.
//!
//! Ops are written as JSON, the way the designer and agents send them.

mod common;

use common::*;
use serde_json::{Value, json};
use trivia_oxc_engine::{Op, apply_op};

const FILE: &str = "src/App.tsx";

/// The designer saw `<Card>` at `#App#0.0`; the user has since added `<Separator />` above it.
const SRC: &str = r#"import { Card } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"

export function App() {
  return (
    <div>
      <Separator />
      <Card>
        <p>body</p>
      </Card>
      <footer>tail</footer>
    </div>
  )
}
"#;

const STALE: &str = "src/App.tsx#App#0.0";

fn op(value: Value) -> Op {
    serde_json::from_value(value.clone()).unwrap_or_else(|e| panic!("{value}: {e}"))
}

#[track_caller]
fn stale(value: Value) {
    let op = op(value);
    match apply_op(SRC, FILE, &op) {
        Ok(out) => panic!("{op:?} should be refused as stale but wrote:\n{}", out.code),
        Err(e) => {
            assert_eq!(e.code(), "stale_locator", "{e}");
            assert!(e.to_string().contains("expected <Card> but found <Separator>"), "{e}");
        }
    }
}

#[test]
fn insert_checks_the_target_name() {
    stale(json!({ "op": "insert", "target": STALE, "expectedName": "Card", "placement": "lastChild", "snippet": "<span>new</span>" }));
    let ok = apply(SRC, FILE, &op(json!({
        "op": "insert", "target": STALE, "expectedName": "Separator", "placement": "after", "snippet": "<span>new</span>"
    })));
    assert!(ok.code.contains("<Separator />\n      <span>new</span>\n      <Card>"), "{}", ok.code);
}

#[test]
fn insert_child_checks_the_parent_name() {
    stale(json!({ "op": "insertChild", "parent": STALE, "expectedName": "Card", "index": 0, "snippet": "<span>new</span>" }));
    let ok = apply(SRC, FILE, &op(json!({
        "op": "insertChild", "parent": "src/App.tsx#App#0.1", "expectedName": "Card", "index": 0, "snippet": "<span>new</span>"
    })));
    assert!(ok.code.contains("<Card>\n        <span>new</span>\n        <p>body</p>"), "{}", ok.code);
}

#[test]
fn move_checks_the_target_name() {
    stale(json!({
        "op": "move", "source": "src/App.tsx#App#0.2", "expectedName": "footer",
        "target": STALE, "expectedTargetName": "Card", "placement": "lastChild"
    }));
    let ok = apply(SRC, FILE, &op(json!({
        "op": "move", "source": "src/App.tsx#App#0.2", "expectedName": "footer",
        "target": "src/App.tsx#App#0.1", "expectedTargetName": "Card", "placement": "lastChild"
    })));
    assert!(ok.code.contains("<p>body</p>\n        <footer>tail</footer>\n      </Card>"), "{}", ok.code);
}

#[test]
fn move_node_checks_the_parent_name() {
    stale(json!({
        "op": "moveNode", "source": "src/App.tsx#App#0.2", "expectedName": "footer",
        "parent": STALE, "expectedParentName": "Card", "index": 0
    }));
    let ok = apply(SRC, FILE, &op(json!({
        "op": "moveNode", "source": "src/App.tsx#App#0.2", "expectedName": "footer",
        "parent": "src/App.tsx#App#0.1", "expectedParentName": "Card", "index": 0
    })));
    assert!(ok.code.contains("<Card>\n        <footer>tail</footer>\n        <p>body</p>"), "{}", ok.code);
}

/// A guard field that is misspelled (or any field the op does not have) is an error, so a
/// caller can never believe it is protected when it is not.
#[test]
fn unknown_fields_are_rejected_on_every_op() {
    let target = "src/App.tsx#App#0.1";
    let cases = [
        json!({ "op": "updateProp", "target": target, "expectedname": "Card", "prop": "id", "value": "x" }),
        json!({ "op": "remove", "target": target, "expectedName": "Card", "force": true }),
        json!({ "op": "insert", "target": target, "placement": "lastChild", "snippet": "<b />", "totallyBogus": 1 }),
        json!({ "op": "insert", "target": target, "placement": "lastChild", "snippet": "<b />", "targetExpectedName": "Card" }),
        json!({ "op": "insertChild", "parent": target, "index": 0, "snippet": "<b />", "expectedParentName": "Card" }),
        json!({ "op": "move", "source": target, "target": target, "placement": "before", "targetExpectedName": "Card" }),
        json!({ "op": "moveNode", "source": target, "parent": target, "index": 0, "parentExpectedName": "Card" }),
        json!({ "op": "insert", "target": target, "placement": "lastChild", "snippet": "<Card />",
                "imports": [{ "name": "Card", "source": "@/components/ui/card", "defualt": true }] }),
        json!({ "op": "bindQuery", "target": target, "expectedName": "Card", "optionsFn": "listCustomersOptions",
                "optionsImport": "@/api/gen", "resource": "Customer", "dataProp": "data", "loadingPorp": "isLoading" }),
    ];
    for case in cases {
        let err = serde_json::from_value::<Op>(case.clone()).expect_err(&format!("{case} should not deserialize"));
        assert!(err.to_string().contains("unknown field"), "{case}: {err}");
    }
    // The tag itself is not an unknown field, wherever it sits.
    assert!(serde_json::from_value::<Op>(json!({ "target": target, "expectedName": "Card", "op": "remove" })).is_ok());
}
