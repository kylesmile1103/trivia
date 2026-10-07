//! `updateProp`: every value shape, in the attribute's existing form, with exact output.
//! Each case also checks that the inspector reads back the value that was written.

mod common;

use common::*;
use serde_json::{Value, json};
use trivia_oxc_engine::inspect::inspect;
use trivia_oxc_engine::{Op, apply_op};

const FILE: &str = "src/P.tsx";
const TARGET: &str = "src/P.tsx#P#0.0";

/// `element` as the only child of a `<div>` root. Lines after the first are written already
/// indented for their place (four spaces).
fn page(element: &str) -> String {
    format!("export const P = () => (\n  <div>\n    {element}\n  </div>\n)\n")
}

fn update(src: &str, prop: &str, value: &Value) -> Op {
    let name = table(src, FILE).nodes[1].display_name().to_string();
    Op::UpdateProp { target: TARGET.into(), expected_name: Some(name), prop: prop.into(), value: value.clone() }
}

/// Setting `prop` to `value` on `before` gives exactly `after` (LF and CRLF), the locator is
/// unchanged, and the inspector reads the value back.
#[track_caller]
fn check(before: &str, prop: &str, value: Value, after: &str) {
    check_variants(before, prop, value, after, true);
}

#[track_caller]
fn check_variants(before: &str, prop: &str, value: Value, after: &str, crlf: bool) {
    let mut cases = vec![(page(before), page(after))];
    if crlf {
        cases.push((to_crlf(&page(before)), to_crlf(&page(after))));
    }
    for (src, expected) in cases {
        let what = format!("{prop}={value} on {before:?}");
        let out = apply(&src, FILE, &update(&src, prop, &value));
        assert_text_eq(&out.code, &expected, &what);
        assert_eq!(out.changed, src != expected, "{what}");
        assert_eq!(out.locator.as_deref(), Some(TARGET), "{what}");
        let attrs = inspect(&out.code, TARGET).unwrap().attributes;
        let read_back = attrs.iter().rev().find(|a| a.name.as_deref() == Some(prop)).and_then(|a| a.value.clone());
        match &value {
            Value::Null => assert!(attrs.iter().all(|a| a.name.as_deref() != Some(prop)), "{what}: still there"),
            Value::Array(_) | Value::Object(_) => {}
            Value::Number(n) => {
                assert_eq!(read_back.as_ref().and_then(Value::as_f64), n.as_f64(), "{what}: reads back differently");
            }
            v => assert_eq!(read_back.as_ref(), Some(v), "{what}: reads back differently"),
        }
    }
}

#[test]
fn strings_keep_the_attribute_quote_and_escape_only_what_jsx_needs() {
    check(r#"<B v="a" />"#, "v", json!("plain"), r#"<B v="plain" />"#);
    check(r#"<B v='a' />"#, "v", json!("plain"), r#"<B v='plain' />"#);
    // JSX attribute strings have no backslash escapes: the quote becomes an entity.
    check(r#"<B v="a" />"#, "v", json!(r#"say "hi""#), r#"<B v="say &quot;hi&quot;" />"#);
    check(r#"<B v='a' />"#, "v", json!("it's"), r#"<B v='it&#39;s' />"#);
    check(r#"<B v="a" />"#, "v", json!("it's"), r#"<B v="it's" />"#);
    // `&` stays bare unless it would decode into something else.
    check(r#"<B v="a" />"#, "v", json!("Terms & Conditions"), r#"<B v="Terms & Conditions" />"#);
    check(r#"<B v="a" />"#, "v", json!("/x?a=1&b=2"), r#"<B v="/x?a=1&b=2" />"#);
    check(r#"<B v="a" />"#, "v", json!("&amp;"), r#"<B v="&amp;amp;" />"#);
    check(r#"<B v="a" />"#, "v", json!(r"C:\path\n"), r#"<B v="C:\path\n" />"#);
    check(r#"<B v="a" />"#, "v", json!("✨ 画廊 😀"), r#"<B v="✨ 画廊 😀" />"#);
    // A raw line break stays a raw line break in an existing string attribute.
    check_variants(r#"<B v="a" />"#, "v", json!("one\ntwo"), "<B v=\"one\ntwo\" />", false);
}

#[test]
fn reading_an_entity_spelled_string_gives_its_runtime_value() {
    let src = page(r#"<B v="Tom &amp; Jerry &quot;&#169;&quot;" />"#);
    let attrs = inspect(&src, TARGET).unwrap().attributes;
    assert_eq!(attrs[0].value, Some(json!("Tom & Jerry \"©\"")));
    assert_eq!(attrs[0].source, r#""Tom &amp; Jerry &quot;&#169;&quot;""#);
    // Setting the value it already has is not an edit (no respelling).
    let out = apply(&src, FILE, &update(&src, "v", &json!("Tom & Jerry \"©\"")));
    assert!(!out.changed);
    assert_eq!(out.code, src);
}

#[test]
fn new_string_props_use_the_files_jsx_quote_or_an_expression() {
    check(r#"<B a="x" />"#, "v", json!("y"), r#"<B a="x" v="y" />"#);
    check(r#"<B a='x' />"#, "v", json!("y"), r#"<B a='x' v='y' />"#);
    check("<B />", "v", json!(r#"say "hi""#), r#"<B v={"say \"hi\""} />"#);
    check("<B />", "v", json!("one\ntwo"), r#"<B v={"one\ntwo"} />"#);
    check("<B />", "v", json!("a & b"), r#"<B v="a & b" />"#);
}

#[test]
fn string_expressions_keep_their_literal_kind() {
    check("<B v={'a'} />", "v", json!("it's"), r"<B v={'it\'s'} />");
    check(r#"<B v={"a"} />"#, "v", json!("x"), r#"<B v={"x"} />"#);
    check("<B v={`a`} />", "v", json!("x`${y}"), r"<B v={`x\`\${y}`} />");
    check("<B v={ /* why */ 'a' } />", "v", json!("b"), "<B v={ /* why */ 'b' } />");
    // A computed value is replaced as a whole by the literal.
    check(r#"<B v={on ? "a" : "b"} />"#, "v", json!("x"), r#"<B v="x" />"#);
}

#[test]
fn numbers_booleans_objects_and_arrays_are_expressions() {
    check("<B />", "n", json!(3), "<B n={3} />");
    check("<B />", "n", json!(-1), "<B n={-1} />");
    check("<B />", "n", json!(1.5), "<B n={1.5} />");
    check(r#"<B n="3" />"#, "n", json!(3), "<B n={3} />");
    check("<B n={-1} />", "n", json!(2), "<B n={2} />");
    // The braces and the spacing inside them are kept.
    check("<B n={ 7 } />", "n", json!(8), "<B n={ 8 } />");
    check("<B />", "on", json!(true), "<B on={true} />");
    check("<B on={false} />", "on", json!(true), "<B on={true} />");
    check("<B style={{}} />", "style", json!({"color": "red", "gap": 2}), r#"<B style={{"color":"red","gap":2}} />"#);
    check("<B />", "items", json!([1, "a", true, null]), r#"<B items={[1,"a",true,null]} />"#);
    check(r#"<B v="x" />"#, "v", json!(false), "<B v={false} />");
    // The value it already has (numerically): nothing is respelled.
    check("<B n={1.0} />", "n", json!(1), "<B n={1.0} />");
    check("<B n={3} />", "n", json!(3.0), "<B n={3} />");
}

#[test]
fn shorthand_attributes() {
    check("<B disabled />", "disabled", json!(true), "<B disabled />");
    check("<B disabled />", "disabled", json!(false), "<B disabled={false} />");
    check("<B disabled />", "disabled", json!("x"), r#"<B disabled="x" />"#);
    check("<B disabled />", "disabled", Value::Null, "<B />");
}

#[test]
fn element_values_are_replaced_whole() {
    check("<B icon={<X />} />", "icon", json!("x"), r#"<B icon="x" />"#);
    check("<B icon=<X /> />", "icon", json!("x"), r#"<B icon="x" />"#);
}

#[test]
fn null_removes_single_line_attributes_and_their_space() {
    check(r#"<B a="1" b="2" c="3" />"#, "a", Value::Null, r#"<B b="2" c="3" />"#);
    check(r#"<B a="1" b="2" c="3" />"#, "b", Value::Null, r#"<B a="1" c="3" />"#);
    check(r#"<B a="1" b="2" c="3" />"#, "c", Value::Null, r#"<B a="1" b="2" />"#);
    check(r#"<B a="1">x</B>"#, "a", Value::Null, "<B>x</B>");
    // Absent: nothing to do.
    check(r#"<B a="1" />"#, "zzz", Value::Null, r#"<B a="1" />"#);
}

#[test]
fn null_removes_multi_line_attributes_line_by_line() {
    let before = "<B\n      a=\"1\"\n      b=\"2\"\n      c=\"3\"\n    />";
    check(before, "a", Value::Null, "<B\n      b=\"2\"\n      c=\"3\"\n    />");
    check(before, "b", Value::Null, "<B\n      a=\"1\"\n      c=\"3\"\n    />");
    check(before, "c", Value::Null, "<B\n      a=\"1\"\n      b=\"2\"\n    />");
    // The tag end on the attribute's line joins the previous attribute.
    check("<B\n      a=\"1\"\n      b=\"2\">\n      x\n    </B>", "b", Value::Null, "<B\n      a=\"1\">\n      x\n    </B>");
    // First attribute on the tag's line.
    check("<B a=\"1\"\n      b=\"2\"\n    />", "a", Value::Null, "<B\n      b=\"2\"\n    />");
}

#[test]
fn removing_an_attribute_never_removes_a_comment() {
    check(
        "<B\n      a=\"1\"\n      b=\"2\" // why b\n      c=\"3\"\n    />",
        "b",
        Value::Null,
        "<B\n      a=\"1\"\n      // why b\n      c=\"3\"\n    />",
    );
    check(r#"<B a="1" /* note */ b="2" />"#, "b", Value::Null, r#"<B a="1" /* note */ />"#);
    check(r#"<B /* note */ a="1" />"#, "a", Value::Null, "<B /* note */ />");
}

#[test]
fn new_props_go_on_their_own_line_in_multi_line_tags() {
    let before = "<B\n      a=\"1\"\n      {...rest}\n    />";
    check(before, "c", json!("3"), "<B\n      a=\"1\"\n      {...rest}\n      c=\"3\"\n    />");
    // After a trailing comment, which belongs to the line it is on.
    check("<B\n      a=\"1\" // why\n    />", "c", json!("3"), "<B\n      a=\"1\" // why\n      c=\"3\"\n    />");
    // Before a `>` that shares the last attribute's line.
    check("<B\n      a=\"1\">\n      x\n    </B>", "c", json!("3"), "<B\n      a=\"1\"\n      c=\"3\">\n      x\n    </B>");
    // Tabs.
    check("<B\n\t\ta=\"1\"\n    />", "c", json!(3), "<B\n\t\ta=\"1\"\n\t\tc={3}\n    />");
    // After type arguments when there are no attributes yet.
    check("<B<string> />", "c", json!(3), "<B<string> c={3} />");
}

#[test]
fn duplicates_and_spreads() {
    // JSX: the last duplicate wins, so that is the one edited...
    check(r#"<B v="1" v="2" />"#, "v", json!("3"), r#"<B v="1" v="3" />"#);
    // ...and removing the prop removes every occurrence, or an earlier one would take effect.
    check(r#"<B v="1" v="2" />"#, "v", Value::Null, "<B />");
    check(r#"<B v="1" {...p} v="2" w />"#, "v", Value::Null, "<B {...p} w />");
    check(r#"<B {...p} v="1" />"#, "v", json!("2"), r#"<B {...p} v="2" />"#);
    check(r#"<B {...p} v="1" />"#, "v", Value::Null, "<B {...p} />");
    // New props go after a trailing spread, so the designer's value wins.
    check(r#"<B v="1" {...p} />"#, "w", json!("x"), r#"<B v="1" {...p} w="x" />"#);
}

#[test]
fn fragments_and_the_locator_attribute_are_refused() {
    let src = "export const P = () => (\n  <>\n    <React.Fragment key=\"a\"><i /></React.Fragment>\n  </>\n)\n";
    let op = |target: &str, prop: &str| Op::UpdateProp {
        target: format!("{FILE}#P#{target}"),
        expected_name: None,
        prop: prop.into(),
        value: json!("b"),
    };
    assert_eq!(error_code(src, FILE, &op("0", "key")), "unsupported");
    let out = apply(src, FILE, &op("0.0", "key"));
    assert!(out.code.contains("<React.Fragment key=\"b\">"));
    assert_eq!(error_code(src, FILE, &op("0.0.0", "data-ast-node")), "invalid_op");
    for bad in ["", "1a", "a b", "{x}", "a=b", "-a"] {
        assert_eq!(error_code(src, FILE, &op("0.0.0", bad)), "invalid_op", "{bad:?}");
    }
    // Passes the name check but cannot be JSX: the re-parse catches it.
    assert_eq!(error_code(src, FILE, &op("0.0.0", "a::b")), "invalid_result");
    // Namespaced names are fine.
    assert!(apply_op(src, FILE, &op("0.0.0", "xlink:href")).is_ok());
}

#[test]
fn a_stale_expected_name_refuses_the_edit() {
    let src = page(r#"<B v="a" />"#);
    let op = Op::UpdateProp { target: TARGET.into(), expected_name: Some("C".into()), prop: "v".into(), value: json!("x") };
    assert_eq!(error_code(&src, FILE, &op), "stale_locator");
}
