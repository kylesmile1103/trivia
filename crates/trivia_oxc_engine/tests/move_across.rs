//! `move` / `moveNode` between two files: the element's bytes leave one file and land in the
//! other, the imports it uses come with it (relative paths rewritten for the new directory),
//! the source drops imports nothing uses any more, and anything the destination can't see
//! (a prop, a local, a module-level constant) is refused instead of moved.

use trivia_oxc_engine::{Op, Placement, apply_across};

const PAGE: &str = "src/pages/Page.tsx";
const APP: &str = "src/App.tsx";

const PAGE_SRC: &str = r#"import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatName } from "../lib/format"

const LIMIT = 3

export function Page({ user }: { user: { name: string } }) {
  return (
    <div>
      <Button variant="ghost">Cancel</Button>
      <Badge>{formatName("x")}</Badge>
      <p>{user.name}</p>
      <span>{LIMIT}</span>
      <Button>Save</Button>
    </div>
  )
}
"#;

const APP_SRC: &str = r#"import { Page } from "@/pages/Page"

export default function App() {
  return (
    <main className="p-8">
      <Page />
    </main>
  )
}
"#;

fn page(path: &str) -> String {
    format!("{PAGE}#Page#{path}")
}

fn app(path: &str) -> String {
    format!("{APP}#App#{path}")
}

fn move_to_app(source: &str, name: &str, placement: Placement) -> Op {
    Op::Move {
        source: page(source),
        expected_name: Some(name.into()),
        target: app("0.0"),
        expected_target_name: Some("Page".into()),
        placement,
    }
}

#[test]
fn moves_the_bytes_and_brings_the_import_along() {
    let out = apply_across(PAGE_SRC, PAGE, APP_SRC, APP, &move_to_app("0.0", "Button", Placement::Before)).unwrap();
    assert_eq!(
        out.to.code,
        "import { Page } from \"@/pages/Page\"\nimport { Button } from \"@/components/ui/button\"\n\nexport default function App() {\n  return (\n    <main className=\"p-8\">\n      <Button variant=\"ghost\">Cancel</Button>\n      <Page />\n    </main>\n  )\n}\n"
    );
    assert_eq!(out.to.locator.as_deref(), Some(app("0.0").as_str()));
    assert_eq!(out.to.file, APP);
    // The source keeps its import: the Save button still uses it.
    assert_eq!(out.from, PAGE_SRC.replace("      <Button variant=\"ghost\">Cancel</Button>\n", ""));
}

#[test]
fn rewrites_a_relative_import_for_the_new_directory_and_prunes_the_source() {
    let out = apply_across(PAGE_SRC, PAGE, APP_SRC, APP, &move_to_app("0.1", "Badge", Placement::After)).unwrap();
    assert!(out.to.code.contains("import { Badge } from \"@/components/ui/badge\"\n"), "{}", out.to.code);
    assert!(out.to.code.contains("import { formatName } from \"./lib/format\"\n"), "{}", out.to.code);
    assert!(out.to.code.contains("      <Page />\n      <Badge>{formatName(\"x\")}</Badge>\n"), "{}", out.to.code);
    // Nothing else in Page uses Badge or formatName: both imports go, the rest stays.
    let expected = PAGE_SRC
        .replace("import { Badge } from \"@/components/ui/badge\"\n", "")
        .replace("import { formatName } from \"../lib/format\"\n", "")
        .replace("      <Badge>{formatName(\"x\")}</Badge>\n", "");
    assert_eq!(out.from, expected);
}

#[test]
fn reuses_an_import_the_destination_already_has() {
    let app_with_button = APP_SRC.replace("import { Page }", "import { Button } from \"@/components/ui/button\"\nimport { Page }");
    let out = apply_across(PAGE_SRC, PAGE, &app_with_button, APP, &move_to_app("0.0", "Button", Placement::Before)).unwrap();
    assert_eq!(out.to.code.matches("import { Button }").count(), 1, "{}", out.to.code);
}

#[test]
fn refuses_names_the_destination_cannot_see() {
    for (source, name, word) in [("0.2", "p", "`user`"), ("0.3", "span", "`LIMIT`")] {
        let err = apply_across(PAGE_SRC, PAGE, APP_SRC, APP, &move_to_app(source, name, Placement::Before)).unwrap_err();
        assert_eq!(err.code(), "unsupported", "{err}");
        assert!(err.to_string().contains(word) && err.to_string().contains(APP), "{err}");
    }
}

#[test]
fn refuses_an_aliased_or_namespace_import() {
    let aliased = PAGE_SRC.replace("import { Button } from", "import { Button as Btn } from").replace("<Button", "<Btn").replace("</Button>", "</Btn>");
    let err = apply_across(&aliased, PAGE, APP_SRC, APP, &move_to_app("0.0", "Btn", Placement::Before)).unwrap_err();
    assert_eq!(err.code(), "unsupported", "{err}");
    assert!(err.to_string().contains("`Btn`"), "{err}");
}

#[test]
fn checks_both_files_tag_names() {
    let stale_source = Op::Move { source: page("0.0"), expected_name: Some("Badge".into()), target: app("0.0"), expected_target_name: Some("Page".into()), placement: Placement::Before };
    assert_eq!(apply_across(PAGE_SRC, PAGE, APP_SRC, APP, &stale_source).unwrap_err().code(), "stale_locator");
    let stale_target = Op::Move { source: page("0.0"), expected_name: Some("Button".into()), target: app("0.0"), expected_target_name: Some("Card".into()), placement: Placement::Before };
    assert_eq!(apply_across(PAGE_SRC, PAGE, APP_SRC, APP, &stale_target).unwrap_err().code(), "stale_locator");
}

#[test]
fn move_node_lands_at_an_index_of_the_other_file() {
    let op = Op::MoveNode { source: page("0.4"), expected_name: Some("Button".into()), parent: app("0"), expected_parent_name: Some("main".into()), index: 1 };
    let out = apply_across(PAGE_SRC, PAGE, APP_SRC, APP, &op).unwrap();
    assert!(out.to.code.contains("      <Page />\n      <Button>Save</Button>\n    </main>"), "{}", out.to.code);
    assert_eq!(out.to.locator.as_deref(), Some(app("0.1").as_str()));
}

#[test]
fn same_file_ops_are_not_for_it() {
    let op = Op::Move { source: page("0.0"), expected_name: None, target: page("0.1"), expected_target_name: None, placement: Placement::After };
    assert_eq!(apply_across(PAGE_SRC, PAGE, PAGE_SRC, PAGE, &op).unwrap_err().code(), "invalid_op");
    assert_eq!(op.files().unwrap(), [PAGE]);
    assert_eq!(move_to_app("0.0", "Button", Placement::Before).files().unwrap(), [PAGE, APP]);
}
