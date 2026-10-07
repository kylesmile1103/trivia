//! The locator algorithm: what each JSX node is called, that reformatting never renames
//! anything, and that `annotate` (what the Vite plugin injects) agrees with resolution.

mod common;

use common::*;
use oxc_allocator::Allocator;
use trivia_oxc_engine::inspect::inspect;
use trivia_oxc_engine::locator::{self, JsxTable, NodeKind};
use trivia_oxc_engine::{Locator, annotate, annotate_utf16, parse};

/// `(locator suffix, tag, direct)`, as written in expectations.
type Expected<'a> = (&'a str, &'a str, bool);

/// `(locator, tag, direct)` for every node, in source order.
fn shape(src: &str, file: &str) -> Vec<(String, String, bool)> {
    let t = table(src, file);
    (0..t.nodes.len()).map(|i| (loc(&t, i, file), t.nodes[i].display_name().to_string(), t.nodes[i].direct)).collect()
}

fn assert_shape(src: &str, file: &str, expected: &[Expected<'_>]) {
    let actual = shape(src, file);
    let expected: Vec<(String, String, bool)> =
        expected.iter().map(|(l, n, d)| (format!("{file}#{l}"), n.to_string(), *d)).collect();
    assert_eq!(actual, expected);
}

#[test]
fn scopes_and_paths_for_every_shape_of_component() {
    let gallery = read_fixture("hand/Gallery.tsx");
    assert_shape(&gallery, "src/hand/Gallery.tsx", &[
        // Two `return`s: two roots, numbered in source order.
        ("Gallery#0", "p", false),
        ("Gallery#1", "<>", false),
        ("Gallery#1.0", "header", true),
        ("Gallery#1.0.0", "h1", true),
        ("Gallery#1.0.1", "Badge", true),
        // `{open && <Card/>}`: indexed under the fragment, but not direct.
        ("Gallery#1.1", "Card", false),
        ("Gallery#1.2", "ul", true),
        // `.map()` callback.
        ("Gallery#1.2.0", "li", false),
        ("Gallery#1.3", "Button", true),
        ("Gallery#1.3.0", "Icons.X", true),
        ("Gallery#1.4", "Button", true),
        // `icon={<Icons.Plus />}`: attribute values come first (source order), not direct.
        ("Gallery#1.4.0", "Icons.Plus", false),
        ("Gallery#1.5", "p", true),
        ("Gallery#1.5.0", "b", true),
        ("Gallery#1.6", "div", true),
        ("Gallery#1.7", "div", true),
        ("Gallery#1.8", "section", true),
        ("Gallery#1.9", "Fragment", true),
        ("Gallery#1.9.0", "span", true),
        ("Gallery#1.9.1", "span", true),
        // Arrow component in an exported const.
        ("Toolbar#0", "div", false),
        ("Toolbar#0.0", "Button", true),
        // A `{/* comment */}`-only child takes no index.
        ("Toolbar#0.1", "CardContent", true),
        // Class component: scope is the class name.
        ("Legacy#0", "Card", false),
        ("Legacy#0.0", "CardContent", true),
        ("Code#0", "pre", false),
        ("Code#0.0", "code", true),
        ("Code#0.1", "span", true),
    ]);

    let anonymous = read_fixture("hand/Anonymous.tsx");
    assert_shape(&anonymous, "src/hand/Anonymous.tsx", &[
        ("banner#0", "div", false),
        // Anonymous default export.
        ("default#0", "main", false),
        // `{banner}` takes no index.
        ("default#0.0", "Button", true),
        ("default#0.1", "Button", true),
    ]);

    // Top-level JSX outside any component: the `module` scope.
    let main = read_fixture("hand/main.tsx");
    assert_shape(&main, "src/main.tsx", &[("module#0", "StrictMode", false), ("module#0.0", "App", true)]);
}

#[test]
fn scope_names_for_less_common_declarations() {
    let cases: &[(&str, &[Expected<'_>])] = &[
        ("export default () => <div />", &[("default#0", "div", false)]),
        ("export default class extends Component { render() { return <p /> } }", &[("default#0", "p", false)]),
        ("const A = memo(() => <div><i /></div>)", &[("A#0", "div", false), ("A#0.0", "i", true)]),
        ("export const a = 1, B = () => <i />", &[("B#0", "i", false)]),
        ("function X() { return <b /> }\nexport { X as default }", &[("X#0", "b", false)]),
        // A component nested in another belongs to the outer top-level statement.
        (
            "function Outer() {\n  function Inner() { return <b /> }\n  return <div><Inner /></div>\n}",
            &[("Outer#0", "b", false), ("Outer#1", "div", false), ("Outer#1.0", "Inner", true)],
        ),
        // Several module-level statements share one counter.
        ("render(<A />)\nrender(<B />)", &[("module#0", "A", false), ("module#1", "B", false)]),
        // Fragments take an index even though they cannot carry a locator attribute.
        ("const F = () => <><a /><><b /></></>", &[("F#0", "<>", false), ("F#0.0", "a", true), ("F#0.1", "<>", true), ("F#0.1.0", "b", true)]),
        // Conditional branches and nested expressions are not direct.
        (
            "const C = ({ x }) => <div>{x ? <a /> : <b />}{[1].map(() => <i />)}</div>",
            &[("C#0", "div", false), ("C#0.0", "a", false), ("C#0.1", "b", false), ("C#0.2", "i", false)],
        ),
    ];
    for (src, expected) in cases {
        assert_shape(src, "src/x.tsx", expected);
    }
}

/// Programmatic reformatting that keeps the element structure: line endings, indentation
/// style, blank lines between every line, and comment-only `{/* … */}` children.
fn reformattings(src: &str) -> Vec<(&'static str, String)> {
    let blank_lines: String = src.split_inclusive('\n').map(|l| format!("{l}\n")).collect();
    let mut commented = String::new();
    let mut prev_ends_tag = false;
    for line in src.split_inclusive('\n') {
        let body = line.trim();
        if prev_ends_tag && body.starts_with('<') {
            commented.push_str(&format!("{}{{/* reformatted */}}\n", indent_at(line, 0)));
        }
        prev_ends_tag = body.ends_with('>') && !body.ends_with("=>");
        commented.push_str(line);
    }
    vec![
        ("crlf", to_crlf(src)),
        ("tabs", reindent_leading(src, "\t")),
        ("4sp", reindent_leading(src, "    ")),
        ("blank lines", blank_lines),
        ("comment children", commented),
    ]
}

#[test]
fn reformatting_never_changes_a_locator() {
    for fx in fixtures() {
        let before = shape(&fx.src, &fx.file);
        for (how, src) in reformattings(&fx.src) {
            assert_eq!(shape(&src, &fx.file), before, "{} ({how}) changed locators", fx.label);
            let texts = |s: &str| annotate(s, &fx.file).unwrap().into_iter().map(|i| i.text).collect::<Vec<_>>();
            assert_eq!(texts(&src), texts(&fx.src), "{} ({how}): annotate disagrees", fx.label);
        }
    }
    // A hand-reformatted copy: imports joined, `return` without parentheses, children joined
    // onto shared lines, attributes wrapped, extra comments and blank lines.
    let file = "src/pages/Dashboard.tsx";
    assert_eq!(shape(&read_fixture("Dashboard.reformatted.tsx"), file), shape(&read_fixture("Dashboard.tsx"), file));
}

#[test]
fn locator_strings_are_canonical() {
    let loc = Locator::parse("src/a#b/c.tsx#Card#0.12.3").unwrap();
    assert_eq!(loc.file, "src/a#b/c.tsx", "files may contain `#`");
    assert_eq!(loc.scope, "Card");
    assert_eq!(loc.path, vec![0, 12, 3]);
    assert_eq!(loc.to_string(), "src/a#b/c.tsx#Card#0.12.3");
    for bad in ["", "x", "f#C", "f#C#", "#C#0", "f##0", "f#C#1..2", "f#C#.1", "f#C#01", "f#C#+1", "f#C#-1", "f#C# 1", "f#C#4294967296"] {
        let err = Locator::parse(bad).unwrap_err();
        assert_eq!(err.code(), "invalid_locator", "{bad:?}");
    }
    let a = Locator::parse("f#C#0.1").unwrap();
    assert!(a.is_ancestor_of(&Locator::parse("f#C#0.1.0").unwrap()));
    assert!(!a.is_ancestor_of(&a));
    assert!(!a.is_ancestor_of(&Locator::parse("f#D#0.1.0").unwrap()));
    assert!(!a.is_ancestor_of(&Locator::parse("f#C#0.10").unwrap()));
}

fn eligible(t: &JsxTable, i: usize, fragments: &[&str]) -> bool {
    let n = &t.nodes[i];
    n.kind == NodeKind::Element
        && !n.name.as_deref().is_some_and(|name| fragments.contains(&name))
        && !n.attributes.iter().any(|a| a.name.as_deref() == Some(locator::ATTR))
}

#[test]
fn annotate_puts_exactly_one_locator_right_after_each_tag_name() {
    for fx in fixture_variants() {
        let t = table(&fx.src, &fx.file);
        let ins = annotate(&fx.src, &fx.file).unwrap();
        let expected: Vec<(u32, String)> = (0..t.nodes.len())
            .filter(|&i| eligible(&t, i, &["Fragment", "React.Fragment"]))
            .map(|i| (t.nodes[i].attr_insert, format!(" data-ast-node=\"{}\"", loc(&t, i, &fx.file))))
            .collect();
        let actual: Vec<(u32, String)> = ins.iter().map(|i| (i.offset, i.text.clone())).collect();
        assert_eq!(actual, expected, "{}", fx.label);
        for i in &ins {
            // Right after the tag name (or its type arguments): never inside an attribute.
            let before = &fx.src[..i.offset as usize];
            let tag = before.rsplit('<').next().unwrap();
            assert!(!tag.contains([' ', '\n', '=', '"']), "{}: insertion at {} is not right after a tag name", fx.label, i.offset);
        }

        // The annotated source parses, keeps every locator, and annotating it again adds nothing.
        let alloc = Allocator::default();
        let program = parse(&alloc, &fx.src, &fx.file).unwrap();
        let annotated = locator::annotate_source(&program, &fx.file).unwrap();
        assert_eq!(shape(&annotated, &fx.file), shape(&fx.src, &fx.file), "{}", fx.label);
        assert!(annotate(&annotated, &fx.file).unwrap().is_empty(), "{}: second pass annotated again", fx.label);
        // And each injected value reads back (decoded) as the element's own locator.
        let t2 = table(&annotated, &fx.file);
        for i in (0..t2.nodes.len()).filter(|&i| t2.nodes[i].kind == NodeKind::Element) {
            let me = loc(&t2, i, &fx.file);
            let details = inspect(&annotated, &me).unwrap();
            if let Some(attr) = details.attributes.iter().find(|a| a.name.as_deref() == Some(locator::ATTR)) {
                assert_eq!(attr.value.as_ref().and_then(|v| v.as_str()), Some(me.as_str()), "{}", fx.label);
                assert_eq!(details.attributes[0].name.as_deref(), Some(locator::ATTR), "{}: not the first attribute", fx.label);
            }
        }
    }
}

#[test]
fn annotate_goes_after_type_arguments_and_skips_existing_locators() {
    let src = "const X = () => <Select<string> value=\"a\"><div data-ast-node=\"kept\"><b /></div></Select>";
    let alloc = Allocator::default();
    let program = parse(&alloc, src, "src/x.tsx").unwrap();
    assert_eq!(
        locator::annotate_source(&program, "src/x.tsx").unwrap(),
        "const X = () => <Select<string> data-ast-node=\"src/x.tsx#X#0\" value=\"a\"><div data-ast-node=\"kept\"><b data-ast-node=\"src/x.tsx#X#0.0.0\" /></div></Select>"
    );
}

#[test]
fn annotate_skips_every_spelling_of_react_fragment() {
    let src = r#"import React, { Fragment as F } from "react"
import * as R from "react"
export const X = () => (
  <F>
    <React.Fragment key="a"><R.Fragment><Fragment><Frag /></Fragment></R.Fragment></React.Fragment>
  </F>
)
"#;
    let ins = annotate(src, "src/x.tsx").unwrap();
    // Only `<Frag />` (an ordinary component): every other tag is a React fragment.
    assert_eq!(ins.len(), 1, "{ins:?}");
    assert_eq!(ins[0].text, " data-ast-node=\"src/x.tsx#X#0.0.0.0.0\"");
    assert!(src[..ins[0].offset as usize].ends_with("<Frag"));
}

#[test]
fn annotate_escapes_the_locator_for_an_attribute_string() {
    let file = "src/a&b\"c.tsx";
    let src = "export const X = () => <div />";
    let ins = annotate(src, file).unwrap();
    assert_eq!(ins[0].text, " data-ast-node=\"src/a&amp;b&quot;c.tsx#X#0\"");
    // Decoded, the attribute is the locator again.
    let alloc = Allocator::default();
    let program = parse(&alloc, src, file).unwrap();
    let annotated = locator::annotate_source(&program, file).unwrap();
    let details = inspect(&annotated, "src/a&b\"c.tsx#X#0").unwrap();
    assert_eq!(details.attributes[0].value.as_ref().and_then(|v| v.as_str()), Some("src/a&b\"c.tsx#X#0"));
}

#[test]
fn annotate_utf16_offsets_count_utf16_code_units() {
    let src = "// 😀 émoji and 漢字 before\nexport const X = () => (\n  <p title=\"🎉\">\n    日本語 <b>👍🏽</b> <i />\n  </p>\n)\n";
    let bytes = annotate(src, "src/x.tsx").unwrap();
    let utf16 = annotate_utf16(src, "src/x.tsx").unwrap();
    assert_eq!(bytes.len(), 3);
    assert_eq!(utf16.len(), 3);
    for (b, u) in bytes.iter().zip(&utf16) {
        assert_eq!(b.text, u.text);
        let expected = src[..b.offset as usize].encode_utf16().count() as u32;
        assert_eq!(u.offset, expected, "{}", b.text);
        assert!(u.offset < b.offset, "multibyte text before every element");
    }
}

#[test]
fn annotate_refuses_unparsable_source() {
    assert_eq!(annotate("export const X = () => <div>", "src/x.tsx").unwrap_err().code(), "parse_error");
    assert_eq!(annotate_utf16("<", "src/x.tsx").unwrap_err().code(), "parse_error");
}
