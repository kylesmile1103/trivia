//! The brief's Step 2 acceptance criteria, against a realistic shadcn page.

use trivia_oxc_engine::{Op, Placement, annotate, apply_op, ImportSpec};

const FILE: &str = "src/pages/Dashboard.tsx";
const SRC: &str = include_str!("fixtures/Dashboard.tsx");

/// Locator of the first element named `name` (via the same annotation the Vite plugin uses).
fn locator_of(src: &str, name: &str) -> String {
    let ins = annotate(src, FILE).unwrap();
    ins.iter()
        .find(|i| src[..i.offset as usize].ends_with(&format!("<{name}")))
        .map(|i| i.text.trim().trim_start_matches("data-ast-node=\"").trim_end_matches('"').to_string())
        .unwrap_or_else(|| panic!("no <{name}> in fixture"))
}

#[test]
fn parses_tsx_with_comments_and_annotates_every_element() {
    let ins = annotate(SRC, FILE).unwrap();
    let elements = SRC.matches('<').count() - SRC.matches("</").count() - SRC.matches("<>").count();
    assert_eq!(ins.len(), elements, "every opening tag gets a locator");
    assert!(ins.iter().any(|i| i.text == r#" data-ast-node="src/pages/Dashboard.tsx#Dashboard#0""#));
    assert!(ins.iter().any(|i| i.text.contains("#Dashboard#0.0.1\"")), "CardContent is 0.0.1");
}

#[test]
fn injects_destructive_button_into_card_content_with_import() {
    let card_content = locator_of(SRC, "CardContent");
    assert!(card_content.ends_with("#Dashboard#0.0.1"));
    // The fixture already imports Button; drop that import to prove it gets added back.
    let src = SRC.replace("import { Button } from \"@/components/ui/button\"\n", "");
    let card_content = locator_of(&src, "CardContent");
    let out = apply_op(&src, FILE, &Op::Insert {
        target: card_content,
        expected_name: None,
        placement: Placement::LastChild,
        snippet: r#"<Button variant="destructive">Delete</Button>"#.into(),
        imports: vec![ImportSpec { name: "Button".into(), source: "@/components/ui/button".into(), default: false }],
    }).unwrap();
    assert!(out.changed);
    assert!(out.code.contains("import { Button } from \"@/components/ui/button\"\n"), "{}", out.code);
    assert!(out.code.contains("          </div>\n          <Button variant=\"destructive\">Delete</Button>\n        </CardContent>"), "{}", out.code);
    // New node's locator: 4th child of CardContent (after the comment, which takes no index).
    assert_eq!(out.locator.as_deref(), Some("src/pages/Dashboard.tsx#Dashboard#0.0.1.3"));

    // Byte preservation: removing exactly the two inserted lines restores the input.
    let restored = out.code
        .replacen("import { Button } from \"@/components/ui/button\"\n", "", 1)
        .replacen("          <Button variant=\"destructive\">Delete</Button>\n", "", 1);
    assert_eq!(restored, src);
}

#[test]
fn keeps_existing_import_untouched_when_already_bound() {
    let out = apply_op(SRC, FILE, &Op::Insert {
        target: locator_of(SRC, "CardFooter"),
        expected_name: None,
        placement: Placement::FirstChild,
        snippet: "<Button variant=\"destructive\">Delete</Button>".into(),
        imports: vec![ImportSpec { name: "Button".into(), source: "@/components/ui/button".into(), default: false }],
    }).unwrap();
    assert_eq!(out.code.matches("from \"@/components/ui/button\"").count(), 1);
    assert_eq!(
        out.code.replacen("          <Button variant=\"destructive\">Delete</Button>\n", "", 1),
        SRC
    );
}

#[test]
fn update_prop_changes_only_the_value() {
    let ghost = locator_of(SRC, "Button");
    let out = apply_op(SRC, FILE, &Op::UpdateProp {
        target: ghost, expected_name: Some("Button".into()), prop: "variant".into(), value: "outline".into(),
    }).unwrap();
    assert_eq!(out.code, SRC.replacen(r#"<Button variant="ghost">"#, r#"<Button variant="outline">"#, 1));
}

#[test]
fn remove_prunes_only_the_now_unused_import() {
    // Remove the Switch row's <Switch>: Switch has no other reference, Label still does.
    let out = apply_op(SRC, FILE, &Op::Remove { target: locator_of(SRC, "Switch"), expected_name: Some("Switch".into()) }).unwrap();
    let expected = SRC
        .replacen("import { Switch } from \"@/components/ui/switch\"\n", "", 1)
        .replacen("            <Switch id=\"public\" />\n", "", 1);
    assert_eq!(out.code, expected);
}

#[test]
fn move_reindents_and_preserves_everything_else() {
    // Move the Cancel button to be the first child of CardContent.
    let out = apply_op(SRC, FILE, &Op::Move {
        source: locator_of(SRC, "Button"),
        expected_name: Some("Button".into()),
        target: locator_of(SRC, "CardContent"),
        expected_target_name: None,
        placement: Placement::FirstChild,
    }).unwrap();
    let expected = SRC
        .replacen("          <Button variant=\"ghost\">Cancel</Button>\n", "", 1)
        // First child means before all content, including the leading `{/* … */}` comment.
        .replacen(
            "<CardContent className=\"grid gap-4\">\n",
            "<CardContent className=\"grid gap-4\">\n          <Button variant=\"ghost\">Cancel</Button>\n",
            1,
        );
    assert_eq!(out.code, expected);
    assert_eq!(out.locator.as_deref(), Some("src/pages/Dashboard.tsx#Dashboard#0.0.1.0"));
}

#[test]
fn stale_locator_fails_loudly() {
    let err = apply_op(SRC, FILE, &Op::Remove { target: locator_of(SRC, "Switch"), expected_name: Some("Button".into()) }).unwrap_err();
    assert_eq!(err.code(), "stale_locator");
}
