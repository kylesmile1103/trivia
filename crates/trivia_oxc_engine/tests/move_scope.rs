//! A move must not change what the moved code refers to. Every identifier inside the moved
//! node that it does not declare itself must resolve to the same binding at the destination:
//! moving `<span>{item.name}</span>` out of the `.map((item) => …)` callback, or `<b>{label}</b>`
//! into another component that has its own `label`, is refused (`unsupported`) instead of
//! writing code that throws at render or silently means something else.
//!
//! Ops are written as JSON here, the way the designer and agents send them.

mod common;

use common::*;
use serde_json::{Value, json};
use trivia_oxc_engine::{Op, apply_op};

const FILE: &str = "src/App.tsx";

fn op(value: Value) -> Op {
    serde_json::from_value(value.clone()).unwrap_or_else(|e| panic!("{value}: {e}"))
}

/// The op must be refused as `unsupported`, naming `ident` in its message.
#[track_caller]
fn refused(src: &str, value: Value, ident: &str) {
    let op = op(value);
    let err = match apply_op(src, FILE, &op) {
        Ok(out) => panic!("{op:?} should be refused but wrote:\n{}", out.code),
        Err(e) => e,
    };
    assert_eq!(err.code(), "unsupported", "{err}");
    assert!(err.to_string().contains(&format!("`{ident}`")), "message should name `{ident}`: {err}");
}

const LIST: &str = r#"export function App({ items }: { items: { id: string; name: string }[] }) {
  return (
    <ul>
      <li>header</li>
      {items.map((item) => (
        <li key={item.id}>
          <span>{item.name}</span>
          <i />
        </li>
      ))}
    </ul>
  )
}
"#;

#[test]
fn moving_out_of_a_map_callback_is_refused() {
    let span = locator_of(LIST, FILE, "span");
    let header = locator_of(LIST, FILE, "li");
    let ul = locator_of(LIST, FILE, "ul");
    refused(LIST, json!({ "op": "move", "source": span, "expectedName": "span", "target": header, "placement": "after" }), "item");
    refused(LIST, json!({ "op": "moveNode", "source": span, "expectedName": "span", "parent": ul, "index": 0 }), "item");
}

#[test]
fn moving_within_the_callback_that_binds_it_is_fine() {
    let span = locator_of(LIST, FILE, "span");
    let i = locator_of(LIST, FILE, "i");
    let out = apply(LIST, FILE, &op(json!({ "op": "move", "source": span, "expectedName": "span", "target": i, "placement": "after" })));
    assert!(out.code.contains("<i />\n          <span>{item.name}</span>\n        </li>"), "{}", out.code);
}

const TWO: &str = r#"function A() {
  const label = "a"
  const [count] = useState(0)
  return (
    <div>
      <b>{label}</b>
      <span>{count}</span>
      <em>static</em>
    </div>
  )
}

function B() {
  const label = 42
  return (
    <section>
      <i />
    </section>
  )
}
"#;

#[test]
fn moving_into_another_component_that_rebinds_the_name_is_refused() {
    let b = locator_of(TWO, FILE, "b");
    let i = locator_of(TWO, FILE, "i");
    refused(TWO, json!({ "op": "move", "source": b, "expectedName": "b", "target": i, "placement": "after" }), "label");
}

#[test]
fn moving_into_another_component_without_the_binding_is_refused() {
    let span = locator_of(TWO, FILE, "span");
    let section = locator_of(TWO, FILE, "section");
    refused(TWO, json!({ "op": "moveNode", "source": span, "expectedName": "span", "parent": section, "index": 0 }), "count");
}

#[test]
fn static_jsx_and_module_level_names_move_across_components() {
    let src = r#"import { Button } from "@/ui/button"

const TITLE = "t"

function A() {
  return (
    <div>
      <Button onClick={(e) => console.log(e)}>{TITLE}</Button>
      <em>static</em>
    </div>
  )
}

function B() {
  return (
    <section>
      <i />
    </section>
  )
}
"#;
    let i = locator_of(src, FILE, "i");
    for name in ["Button", "em"] {
        let source = locator_of(src, FILE, name);
        let out = apply(src, FILE, &op(json!({ "op": "move", "source": source, "expectedName": name, "target": i, "placement": "before" })));
        assert!(out.changed);
        assert!(out.locator.as_deref().is_some_and(|l| l.contains("#B#0.0")), "{name}: {:?}", out.locator);
    }
}

#[test]
fn a_render_prop_parameter_cannot_leave_its_callback() {
    let src = r#"export function Form() {
  return (
    <form>
      <FormField render={({ field }) => (
        <FormItem>
          <FormControl>
            <input {...field} />
          </FormControl>
        </FormItem>
      )} />
      <button>Save</button>
    </form>
  )
}
"#;
    let control = locator_of(src, FILE, "FormControl");
    let button = locator_of(src, FILE, "button");
    refused(src, json!({ "op": "move", "source": control, "expectedName": "FormControl", "target": button, "placement": "after" }), "field");
}

#[test]
fn a_global_must_not_be_captured_by_a_local_at_the_destination() {
    let src = r#"function A() {
  return (
    <div>
      <b>{window.innerWidth}</b>
    </div>
  )
}

function B() {
  const window = { innerWidth: 0 }
  return (
    <section>
      <i />
    </section>
  )
}
"#;
    let b = locator_of(src, FILE, "b");
    let i = locator_of(src, FILE, "i");
    refused(src, json!({ "op": "move", "source": b, "expectedName": "b", "target": i, "placement": "after" }), "window");
}

#[test]
fn this_does_not_move_between_class_components() {
    let src = r#"class A extends React.Component {
  render() {
    return (
      <div>
        <b>{this.props.title}</b>
        <i />
      </div>
    )
  }
}

class B extends React.Component {
  render() {
    return (
      <section>
        <u />
      </section>
    )
  }
}
"#;
    let b = locator_of(src, FILE, "b");
    let u = locator_of(src, FILE, "u");
    refused(src, json!({ "op": "move", "source": b, "expectedName": "b", "target": u, "placement": "after" }), "this");
    // Within the same render method `this` is the same object.
    let i = locator_of(src, FILE, "i");
    let out = apply(src, FILE, &op(json!({ "op": "move", "source": b, "expectedName": "b", "target": i, "placement": "after" })));
    assert!(out.code.contains("<i />\n        <b>{this.props.title}</b>"), "{}", out.code);
}

#[test]
fn types_the_moved_node_references_follow_the_same_rule() {
    let src = r#"function A() {
  type Row = { id: string }
  return (
    <div>
      <Table<Row> rows={[]} />
    </div>
  )
}

function B() {
  return (
    <section>
      <i />
    </section>
  )
}
"#;
    let table = locator_of(src, FILE, "Table");
    let i = locator_of(src, FILE, "i");
    refused(src, json!({ "op": "move", "source": table, "expectedName": "Table", "target": i, "placement": "after" }), "Row");
}
