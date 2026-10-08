//! `setText`: an element's plain-text content, replaced byte for byte. The line breaks and
//! indentation around the text are layout and stay; whitespace on the text's own line is
//! content. Every case also checks that the inspector reads the text back, that the locator is
//! unchanged, and that setting the old text again restores the original bytes.

mod common;

use common::*;
use trivia_oxc_engine::inspect::inspect;
use trivia_oxc_engine::{Op, apply_op};

const FILE: &str = "src/P.tsx";
const TARGET: &str = "src/P.tsx#P#0.0";

/// `element` as the only child of a `<div>` root. Lines after the first are written already
/// indented for their place (four spaces).
fn page(element: &str) -> String {
    format!("export const P = () => (\n  <div>\n    {element}\n  </div>\n)\n")
}

fn set_text(src: &str, text: &str) -> Op {
    let name = table(src, FILE).nodes[1].display_name().to_string();
    Op::SetText { target: TARGET.into(), expected_name: Some(name), text: text.into() }
}

/// The text the inspector reports for the target ("" when it has none).
fn text_of(src: &str) -> String {
    inspect(src, TARGET).unwrap().text.unwrap_or_default()
}

/// Setting `text` on `before` gives exactly `after` (LF and CRLF), and setting the old text
/// again gives `before` back.
#[track_caller]
fn check(before: &str, text: &str, after: &str) {
    for (src, expected) in [(page(before), page(after)), (to_crlf(&page(before)), to_crlf(&page(after)))] {
        let what = format!("setText {text:?} on {before:?}");
        let out = apply(&src, FILE, &set_text(&src, text));
        assert_text_eq(&out.code, &expected, &what);
        assert_eq!(out.changed, src != expected, "{what}");
        assert_eq!(out.locator.as_deref(), Some(TARGET), "{what}");
        assert_eq!(text_of(&out.code), text, "{what}: reads back differently");

        let old = text_of(&src);
        let back = apply(&out.code, FILE, &set_text(&out.code, &old));
        assert_text_eq(&back.code, &src, &format!("{what}, then back to {old:?}"));
    }
}

#[track_caller]
fn refused(before: &str, text: &str) -> (&'static str, String) {
    let src = page(before);
    let err = apply_op(&src, FILE, &set_text(&src, text)).expect_err("setText should be refused");
    (err.code(), err.to_string())
}

#[test]
fn replaces_text_on_one_line() {
    check("<Button>Save</Button>", "Save changes", "<Button>Save changes</Button>");
    check(r#"<Button variant="outline">Save</Button>"#, "Go", r#"<Button variant="outline">Go</Button>"#);
    check("<Card.Title>Old</Card.Title>", "New", "<Card.Title>New</Card.Title>");
    check("<>Hi</>", "Hello", "<>Hello</>");
    check("<b>✨ 画廊</b>", "😀 ok", "<b>😀 ok</b>");
}

#[test]
fn keeps_the_line_breaks_and_indentation_around_the_text() {
    check("<Button>\n      Save\n    </Button>", "Submit", "<Button>\n      Submit\n    </Button>");
    check("<Button\n      size=\"sm\"\n    >\n      Save\n    </Button>", "Go", "<Button\n      size=\"sm\"\n    >\n      Go\n    </Button>");
    // Text that starts on the opening tag's line and ends on its own.
    check("<p>Save\n    </p>", "Go", "<p>Go\n    </p>");
}

#[test]
fn whitespace_on_the_text_line_is_content() {
    check("<b> Save </b>", "Go", "<b>Go</b>");
    check("<b>Save</b>", " Go ", "<b> Go </b>");
    check("<span> </span>", "x", "<span>x</span>");
}

#[test]
fn escapes_only_what_jsx_text_cannot_hold() {
    check("<p>a</p>", "a < b > c", "<p>a &lt; b &gt; c</p>");
    check("<p>a</p>", "{name}", "<p>&#123;name&#125;</p>");
    // `&` stays bare unless it would decode into something else.
    check("<p>a</p>", "Terms & Conditions", "<p>Terms & Conditions</p>");
    check("<p>a</p>", "&amp;", "<p>&amp;amp;</p>");
    check("<p>a</p>", "50% off — \"quoted\" and 'single'", "<p>50% off — \"quoted\" and 'single'</p>");
}

#[test]
fn fills_an_empty_element() {
    check("<Button></Button>", "Go", "<Button>Go</Button>");
    check("<Button>\n      \n    </Button>", "Go", "<Button>\n      Go\n    </Button>");
    // Emptying keeps the layout, so the text goes back where it was.
    check("<Button>\n      Save\n    </Button>", "", "<Button>\n      \n    </Button>");
    check("<b>Save</b>", "", "<b></b>");
}

#[test]
fn opens_a_self_closing_element() {
    let src = page(r#"<Button variant="ghost" />"#);
    let out = apply(&src, FILE, &set_text(&src, "Go"));
    assert_text_eq(&out.code, &page(r#"<Button variant="ghost">Go</Button>"#), "self-closing");
    assert_eq!(text_of(&out.code), "Go");
    let src = page("<Badge/>");
    assert_text_eq(&apply(&src, FILE, &set_text(&src, "New")).code, &page("<Badge>New</Badge>"), "no space");
    // Nothing to write: the element stays self-closing.
    let src = page("<Badge />");
    let out = apply(&src, FILE, &set_text(&src, ""));
    assert!(!out.changed);
    assert_eq!(out.code, src);
}

#[test]
fn the_text_it_already_has_is_a_no_op() {
    for (before, text) in [("<b>Save</b>", "Save"), ("<b>\n      Save\n    </b>", "Save"), ("<b>Tom &amp; Jerry</b>", "Tom & Jerry")] {
        let src = page(before);
        let out = apply(&src, FILE, &set_text(&src, text));
        assert!(!out.changed, "{before:?}");
        assert_eq!(out.code, src);
        assert_eq!(out.locator.as_deref(), Some(TARGET));
    }
}

#[test]
fn refuses_what_is_not_plain_text() {
    for before in ["<p>Hi <b>there</b></p>", "<p>{name}</p>", "<p>Hi {name}</p>", "<p>{/* note */}Hi</p>", "<p><b /></p>"] {
        let (code, message) = refused(before, "x");
        assert_eq!(code, "unsupported", "{before}: {message}");
        assert!(message.contains("more than plain text"), "{before}: {message}");
    }
    for before in ["<input />", "<img src=\"a.png\" />", "<br />"] {
        let (code, message) = refused(before, "x");
        assert_eq!(code, "unsupported", "{before}: {message}");
        assert!(message.contains("void element"), "{before}: {message}");
    }
}

#[test]
fn refuses_text_jsx_cannot_render_as_given() {
    let (code, message) = refused("<b>Save</b>", "one\ntwo");
    assert_eq!(code, "invalid_op", "{message}");
    assert!(message.contains("line break"), "{message}");
    // Next to a line break, leading and trailing spaces are layout: they would not render.
    let (code, message) = refused("<b>\n      Save\n    </b>", " Go ");
    assert_eq!(code, "invalid_op", "{message}");
    assert!(message.contains("would render as \"Go\""), "{message}");
}

#[test]
fn a_stale_locator_is_refused() {
    let src = page("<Button>Save</Button>");
    let op = Op::SetText { target: TARGET.into(), expected_name: Some("Badge".into()), text: "x".into() };
    assert_eq!(error_code(&src, FILE, &op), "stale_locator");
}

#[test]
fn deserializes_from_the_api_shape() {
    let op: Op = serde_json::from_str(r#"{ "op": "setText", "target": "a.tsx#A#0", "expectedName": "Button", "text": "Save" }"#).unwrap();
    assert_eq!(op, Op::SetText { target: "a.tsx#A#0".into(), expected_name: Some("Button".into()), text: "Save".into() });
    assert!(serde_json::from_str::<Op>(r#"{ "op": "setText", "target": "a.tsx#A#0" }"#).is_err(), "text is required");
}
