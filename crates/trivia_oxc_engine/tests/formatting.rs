//! Layout of generated text: it matches the file (line endings, indentation unit, quotes)
//! and the place it goes (own line or inline, self-closing and empty containers), and it
//! never disturbs multibyte text, entities or literal content around it.

mod common;

use common::*;
use trivia_oxc_engine::inspect::inspect;
use trivia_oxc_engine::{ImportSpec, Op, Placement};

const DASH: &str = "src/pages/Dashboard.tsx";

fn insert(src: &str, file: &str, target: &str, placement: Placement, snippet: &str, imports: Vec<ImportSpec>) -> String {
    apply(src, file, &Op::Insert { target: target.into(), expected_name: None, placement, snippet: snippet.into(), imports }).code
}

/// Insert `snippet` (no imports needed) relative to the first `<tag>` of `src`.
fn insert_at(src: &str, tag: &str, placement: Placement, snippet: &str) -> String {
    insert(src, "src/x.tsx", &locator_of(src, "src/x.tsx", tag), placement, snippet, vec![])
}

/// `body` as the JSX returned by component `X` (body lines indented for a `return (`).
fn component(body: &str) -> String {
    format!("export function X() {{\n  return (\n    {body}\n  )\n}}\n")
}

#[test]
fn crlf_files_get_crlf_everywhere() {
    let lf = read_fixture("Dashboard.tsx").replace("import { Button } from \"@/components/ui/button\"\n", "");
    let crlf = to_crlf(&lf);
    let op = |src: &str| Op::Insert {
        target: locator_of(src, DASH, "CardContent"),
        expected_name: None,
        placement: Placement::LastChild,
        snippet: "<Button variant=\"destructive\">\n  Delete\n</Button>".into(),
        imports: vec![spec("Button", "@/components/ui/button")],
    };
    let from_lf = apply(&lf, DASH, &op(&lf)).code;
    let from_crlf = apply(&crlf, DASH, &op(&crlf)).code;
    assert_text_eq(&from_crlf, &to_crlf(&from_lf), "CRLF insert = LF insert with CRLF");
    assert_consistent_line_endings(&crlf, &from_crlf, "CRLF insert");
    assert!(from_lf.contains("          </div>\n          <Button variant=\"destructive\">\n            Delete\n          </Button>\n        </CardContent>"));

    // A move keeps the moved text's own line breaks.
    let mv = |src: &str| Op::Move {
        source: locator_of(src, DASH, "Badge"),
        expected_name: None,
        target: locator_of(src, DASH, "CardFooter"),
        expected_target_name: None,
        placement: Placement::FirstChild,
    };
    let dash = read_fixture("Dashboard.tsx");
    assert_eq!(error_code(&dash, DASH, &mv(&dash)), "unsupported", "Badge is inside .map()");
    let mv = |src: &str| Op::Move {
        source: locator_of(src, DASH, "CardHeader"),
        expected_name: Some("CardHeader".into()),
        target: locator_of(src, DASH, "CardFooter"),
        expected_target_name: None,
        placement: Placement::LastChild,
    };
    let from_lf = apply(&dash, DASH, &mv(&dash)).code;
    let from_crlf = apply(&to_crlf(&dash), DASH, &mv(&to_crlf(&dash))).code;
    assert_text_eq(&from_crlf, &to_crlf(&from_lf), "CRLF move = LF move with CRLF");
}

#[test]
fn tab_and_four_space_files_get_their_own_indentation() {
    let dash = read_fixture("Dashboard.tsx");
    let snippet = "<Card>\n  <CardContent>Hi</CardContent>\n</Card>";
    for (unit, name) in [("\t", "tabs"), ("    ", "4sp")] {
        let src = reindent_leading(&dash, unit);
        let out = insert(&src, DASH, &locator_of(&src, DASH, "CardFooter"), Placement::LastChild, snippet, vec![]);
        let i = unit.repeat(5);
        let expected = src.replacen(
            &format!("{i}<Button>Save changes</Button>\n"),
            &format!("{i}<Button>Save changes</Button>\n{i}<Card>\n{i}{unit}<CardContent>Hi</CardContent>\n{i}</Card>\n"),
            1,
        );
        assert_text_eq(&out, &expected, name);
        // An empty two-line container gets one more indentation step of the same kind.
        let src = format!("export function X() {{\n{unit}return (\n{unit}{unit}<div>\n{unit}{unit}</div>\n{unit})\n}}\n");
        let out = insert_at(&src, "div", Placement::LastChild, "<b />");
        assert_text_eq(&out, &src.replace("<div>\n", &format!("<div>\n{unit}{unit}{unit}<b />\n")), name);
    }
}

#[test]
fn a_jsdoc_comment_does_not_make_the_indent_one_space() {
    let src = "/**\n * Docs.\n */\nexport function X() {\n  return (\n    <section>\n    </section>\n  )\n}\n";
    let out = insert_at(src, "section", Placement::LastChild, "<b />");
    assert_text_eq(&out, &src.replace("<section>\n", "<section>\n      <b />\n"), "two-space step");
}

#[test]
fn multibyte_text_before_and_inside_edits_is_untouched() {
    let src = component("<div title=\"日本語 🎉\">\n      <p>前 😀 text</p>\n      <span>後</span>\n    </div>");
    let after_p = insert_at(&src, "p", Placement::After, "<em>新 ✨</em>");
    assert_text_eq(&after_p, &src.replace("<p>前 😀 text</p>\n", "<p>前 😀 text</p>\n      <em>新 ✨</em>\n"), "after");
    let moved = apply(&src, "src/x.tsx", &Op::Move {
        source: locator_of(&src, "src/x.tsx", "span"),
        expected_name: Some("span".into()),
        target: locator_of(&src, "src/x.tsx", "p"),
        expected_target_name: None,
        placement: Placement::Before,
    });
    assert_text_eq(&moved.code, &src.replace("      <p>前 😀 text</p>\n      <span>後</span>\n", "      <span>後</span>\n      <p>前 😀 text</p>\n"), "move");
    let titled = apply(&src, "src/x.tsx", &Op::UpdateProp {
        target: locator_of(&src, "src/x.tsx", "div"),
        expected_name: Some("div".into()),
        prop: "title".into(),
        value: "画廊 ✨🎉".into(),
    });
    assert_text_eq(&titled.code, &src.replace("日本語 🎉", "画廊 ✨🎉"), "updateProp");
    assert_eq!(inspect(&src, &locator_of(&src, "src/x.tsx", "p")).unwrap().text.as_deref(), Some("前 😀 text"));
}

#[test]
fn self_closing_elements_expand_to_open_and_close_tags() {
    let src = component("<div>\n      <Input id=\"name\" />\n    </div>");
    assert_text_eq(
        &insert_at(&src, "Input", Placement::LastChild, "<span>x</span>"),
        &src.replace("<Input id=\"name\" />", "<Input id=\"name\">\n        <span>x</span>\n      </Input>"),
        "single line",
    );
    // `/>` on its own line becomes `>` on its own line.
    let src = component("<div>\n      <Input\n        id=\"name\"\n      />\n    </div>");
    assert_text_eq(
        &insert_at(&src, "Input", Placement::FirstChild, "<span>x</span>"),
        &src.replace("      />\n", "      >\n        <span>x</span>\n      </Input>\n"),
        "multi-line",
    );
    // A comment before `/>` stays.
    let src = component("<div>\n      <Input id=\"a\" /* keep */ />\n    </div>");
    assert_text_eq(
        &insert_at(&src, "Input", Placement::LastChild, "<span>x</span>"),
        &src.replace("<Input id=\"a\" /* keep */ />", "<Input id=\"a\" /* keep */>\n        <span>x</span>\n      </Input>"),
        "comment",
    );
    // Type arguments, no attributes.
    let src = component("<div>\n      <List<string> />\n    </div>");
    assert_text_eq(
        &insert_at(&src, "List", Placement::LastChild, "<i />"),
        &src.replace("<List<string> />", "<List<string>>\n        <i />\n      </List>"),
        "type arguments",
    );
}

#[test]
fn empty_containers_on_one_line_and_on_two_lines() {
    let src = component("<main>\n      <div></div>\n      <p> </p>\n      <section>\n      </section>\n      <aside>\n\n      </aside>\n    </main>");
    // One line, one-line snippet: stays on the line.
    assert_text_eq(&insert_at(&src, "div", Placement::LastChild, "<b>x</b>"), &src.replace("<div></div>", "<div><b>x</b></div>"), "one line");
    assert_text_eq(&insert_at(&src, "p", Placement::FirstChild, "<b>x</b>"), &src.replace("<p> </p>", "<p><b>x</b> </p>"), "space");
    // Two lines: its own line, one step in.
    assert_text_eq(
        &insert_at(&src, "section", Placement::FirstChild, "<b>x</b>"),
        &src.replace("<section>\n", "<section>\n        <b>x</b>\n"),
        "two lines",
    );
    // A blank line inside stays where it is.
    assert_text_eq(&insert_at(&src, "aside", Placement::LastChild, "<b>x</b>"), &src.replace("<aside>\n", "<aside>\n        <b>x</b>\n"), "blank line");
    // One line, multi-line snippet: the container expands.
    assert_text_eq(
        &insert_at(&src, "div", Placement::LastChild, "<b>\n  x\n</b>"),
        &src.replace("<div></div>", "<div>\n        <b>\n          x\n        </b>\n      </div>"),
        "expand",
    );
}

#[test]
fn inline_text_content_gets_inline_insertions() {
    let src = component("<p>Hello <b>world</b>, Tom &amp; Jerry</p>");
    let p = |s: &str| src.replace("<p>Hello <b>world</b>, Tom &amp; Jerry</p>", s);
    assert_text_eq(&insert_at(&src, "b", Placement::After, "<i>!</i>"), &p("<p>Hello <b>world</b><i>!</i>, Tom &amp; Jerry</p>"), "after");
    assert_text_eq(&insert_at(&src, "b", Placement::Before, "<i>!</i>"), &p("<p>Hello <i>!</i><b>world</b>, Tom &amp; Jerry</p>"), "before");
    assert_text_eq(&insert_at(&src, "p", Placement::FirstChild, "<i>!</i>"), &p("<p><i>!</i>Hello <b>world</b>, Tom &amp; Jerry</p>"), "first");
    assert_text_eq(&insert_at(&src, "p", Placement::LastChild, "<i>!</i>"), &p("<p>Hello <b>world</b>, Tom &amp; Jerry<i>!</i></p>"), "last");
    let removed = apply(&src, "src/x.tsx", &Op::Remove { target: locator_of(&src, "src/x.tsx", "b"), expected_name: Some("b".into()) });
    assert_text_eq(&removed.code, &p("<p>Hello , Tom &amp; Jerry</p>"), "remove");
    // Between two spaces, one of them goes.
    let src = component("<p>a <b /> c</p>");
    let removed = apply(&src, "src/x.tsx", &Op::Remove { target: locator_of(&src, "src/x.tsx", "b"), expected_name: None });
    assert_text_eq(&removed.code, &src.replace("a <b /> c", "a c"), "spaced");
    // The inspector shows the text as it renders: entities decoded.
    let src = component("<p>Tom &amp; Jerry</p>");
    assert_eq!(inspect(&src, &locator_of(&src, "src/x.tsx", "p")).unwrap().text.as_deref(), Some("Tom & Jerry"));
}

#[test]
fn text_or_expressions_at_the_edges_of_multi_line_content() {
    let src = read_fixture("hand/Directive.tsx");
    let file = "src/hand/Directive.tsx";
    let target = locator_of(&src, file, "p");
    assert_text_eq(
        &insert(&src, file, &target, Placement::FirstChild, "<i>!</i>", vec![]),
        &src.replace("      <p>\n        Text first\n", "      <p>\n        <i>!</i>\n        Text first\n"),
        "text first",
    );
    assert_text_eq(
        &insert(&src, file, &target, Placement::LastChild, "<i>!</i>", vec![]),
        &src.replace("<em>then an element</em>\n", "<em>then an element</em>\n        <i>!</i>\n"),
        "element last",
    );
    // An expression last: before the closing tag, at the children's indent.
    let src = component("<ul>\n      {items.map((i) => <li key={i} />)}\n    </ul>");
    assert_text_eq(
        &insert_at(&src, "ul", Placement::LastChild, "<li />"),
        &src.replace("<li key={i} />)}\n", "<li key={i} />)}\n      <li />\n"),
        "expression last",
    );
    // A comment first: before it.
    let dash = read_fixture("Dashboard.tsx");
    assert_text_eq(
        &insert(&dash, DASH, &locator_of(&dash, DASH, "CardContent"), Placement::FirstChild, "<hr />", vec![]),
        &dash.replace("<CardContent className=\"grid gap-4\">\n", "<CardContent className=\"grid gap-4\">\n          <hr />\n"),
        "comment first",
    );
}

#[test]
fn trailing_whitespace_stays_on_its_own_line() {
    let src = component("<div>\n      <a />   \n      <b />\n    </div>");
    assert_text_eq(&insert_at(&src, "a", Placement::After, "<i />"), &src.replace("<a />   \n", "<a />   \n      <i />\n"), "after");
    let src = component("<div>   \n      <a />\n    </div>");
    assert_text_eq(&insert_at(&src, "div", Placement::FirstChild, "<i />"), &src.replace("<div>   \n", "<div>   \n      <i />\n"), "first");
}

/// Remove the first `<tag>` of `src` (in file `src/x.tsx`).
fn remove_first(src: &str, tag: &str) -> String {
    apply(src, "src/x.tsx", &Op::Remove { target: locator_of(src, "src/x.tsx", tag), expected_name: Some(tag.into()) }).code
}

#[test]
fn pruning_an_import_never_removes_a_comment() {
    let body = "\nexport function X() {\n  return (\n    <main>\n      <Alpha />\n      <Beta />\n      <Gamma />\n    </main>\n  )\n}\n";
    let with = |imports: &str| format!("{imports}{body}");
    let without = |imports: &str, tag: &str| with(imports).replace(&format!("      <{tag} />\n"), "");
    for (imports, tag, expected) in [
        // A trailing comment on the pruned specifier's line stays, on its own line.
        ("import {\n  Alpha,\n  Beta, // why beta\n  Gamma,\n} from \"x\"\n", "Beta", "import {\n  Alpha,\n  // why beta\n  Gamma,\n} from \"x\"\n"),
        // A comment between the previous specifier and the pruned last one stays.
        ("import {\n  Alpha,\n  Beta, // why beta\n  Gamma\n} from \"x\"\n", "Gamma", "import {\n  Alpha,\n  Beta, // why beta\n} from \"x\"\n"),
        ("import { Alpha, /* note */ Beta, Gamma } from \"x\"\n", "Alpha", "import { /* note */ Beta, Gamma } from \"x\"\n"),
        ("import { Alpha, Beta, /* note */ Gamma } from \"x\"\n", "Gamma", "import { Alpha, Beta, /* note */ } from \"x\"\n"),
        // A comment after a whole pruned declaration stays on its line.
        ("import { Alpha } from \"a\" // the alpha\nimport { Beta, Gamma } from \"x\"\n", "Alpha", " // the alpha\nimport { Beta, Gamma } from \"x\"\n"),
    ] {
        let out = remove_first(&with(imports), tag);
        assert_text_eq(&out, &without(expected, tag), &format!("prune {tag} from {imports:?}"));
    }
}

#[test]
fn tool_directive_comments_stay_first_when_the_first_import_is_added() {
    let page = |head: &str| format!("{head}export function X() {{\n  return (\n    <main>\n    </main>\n  )\n}}\n");
    let with_zeta = |s: &str| s.replace("<main>\n", "<main>\n      <Zeta />\n");
    for (head, expected) in [
        ("// @ts-nocheck\n", "// @ts-nocheck\nimport { Zeta } from \"@/z\"\n\n"),
        ("/* eslint-disable react/jsx-key */\n/** Docs for X. */\n", "/* eslint-disable react/jsx-key */\nimport { Zeta } from \"@/z\"\n\n/** Docs for X. */\n"),
        ("/** @jsxImportSource @emotion/react */\n", "/** @jsxImportSource @emotion/react */\nimport { Zeta } from \"@/z\"\n\n"),
        // An ordinary doc comment stays attached to its statement.
        ("/** Docs for X. */\n", "import { Zeta } from \"@/z\"\n\n/** Docs for X. */\n"),
    ] {
        let src = page(head);
        let out = insert(&src, "src/x.tsx", &locator_of(&src, "src/x.tsx", "main"), Placement::LastChild, "<Zeta />", vec![spec("Zeta", "@/z")]);
        assert_text_eq(&out, &with_zeta(&page(expected)), head);
        let back = apply(&out, "src/x.tsx", &Op::Remove { target: "src/x.tsx#X#0.0".into(), expected_name: Some("Zeta".into()) });
        assert_text_eq(&back.code, &src, &format!("{head} (removed again)"));
    }
}

#[test]
fn literal_content_is_never_reindented() {
    let src = read_fixture("hand/Gallery.tsx");
    let file = "src/hand/Gallery.tsx";
    // Move `<code>{`…`}</code>` and the `<span data-note="…">` (both multi-line literals)
    // two levels deeper, then check the literal bytes.
    for (tag, literal) in [("code", "{`line one\n  line two`}"), ("span", "data-note=\"spans\ntwo lines\"")] {
        let source = nth_locator_of(&src, file, tag, if tag == "span" { 2 } else { 0 });
        let out = apply(&src, file, &Op::Move {
            source,
            expected_name: Some(tag.into()),
            target: locator_of(&src, file, "Badge"),
            expected_target_name: None,
            placement: Placement::LastChild,
        });
        assert!(out.code.contains(literal), "{tag}: literal changed:\n{}", out.code);
        assert_eq!(out.code.matches(literal).count(), 1);
    }
    // A snippet's template literal keeps its lines too.
    let dash = read_fixture("Dashboard.tsx");
    let out = insert(&dash, DASH, &locator_of(&dash, DASH, "CardFooter"), Placement::LastChild, "<pre>\n  {`a\n  b`}\n</pre>", vec![]);
    assert!(out.contains("          <pre>\n            {`a\n  b`}\n          </pre>\n"), "{out}");
}

/// Whitespace alone on one line is a rendered text child (`<span> </span>` renders a space;
/// only whitespace that spans lines is layout). Inserting or moving multi-line text into such
/// an element must keep it, and removing or moving that node out again must give the
/// original back.
#[test]
fn a_rendered_whitespace_child_survives_multi_line_inserts_and_moves() {
    let op = |v: serde_json::Value| -> Op { serde_json::from_value(v).unwrap() };
    let file = "src/x.tsx";
    for space in [" ", "\u{a0}", "  "] {
        let src = component(&format!(
            "<div>\n      <span>{space}</span>\n      <section>\n        <b>x</b>\n      </section>\n    </div>"
        ));
        let span = locator_of(&src, file, "span");
        for placement in ["firstChild", "lastChild"] {
            let what = format!("{space:?} {placement}");
            let kept = |code: &str, tag: &str| {
                code.contains(&format!("<span>{space}<{tag}>")) || code.contains(&format!("</{tag}>{space}</span>"))
            };
            let out = apply(&src, file, &op(serde_json::json!({
                "op": "insert", "target": span, "placement": placement, "snippet": "<div>\n  <b>y</b>\n</div>"
            })));
            assert!(kept(&out.code, "div"), "{what}: the text child was lost:\n{}", out.code);
            let back = apply(&out.code, file, &op(serde_json::json!({
                "op": "remove", "target": out.locator.unwrap(), "expectedName": "div"
            })));
            assert_text_eq(&back.code, &src, &format!("{what}, removed again"));

            // A multi-line node moved in, then back out.
            let section = locator_of(&src, file, "section");
            let moved = apply(&src, file, &op(serde_json::json!({
                "op": "move", "source": section, "expectedName": "section", "target": span, "placement": placement
            })));
            assert!(kept(&moved.code, "section"), "{what}: the text child was lost in the move:\n{}", moved.code);
            let back = apply(&moved.code, file, &op(serde_json::json!({
                "op": "move", "source": moved.locator.unwrap(), "expectedName": "section", "target": span, "placement": "after"
            })));
            assert_text_eq(&back.code, &src, &format!("{what}, moved back"));
        }
    }
}
