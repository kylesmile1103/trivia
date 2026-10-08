//! `outline`: a file's JSX as a tree of locators, for agents (`trivia_outline`, docs/mcp.md).

use trivia_oxc_engine::inspect::{OutlineNode, outline};

const FILE: &str = "src/P.tsx";

fn names(nodes: &[OutlineNode]) -> Vec<String> {
    nodes.iter().map(|n| format!("{}@{}", n.name, n.locator.rsplit('#').next().unwrap())).collect()
}

#[test]
fn lists_every_component_s_tree_with_locators_lines_and_text() {
    let src = "\
export function P() {
  return (
    <Card>
      <CardTitle>Hello</CardTitle>
      {show && <Badge>New</Badge>}
      <>
        <b />
      </>
    </Card>
  )
}

export const Q = () => <p>Q</p>
";
    let tree = outline(src, FILE).unwrap();
    assert_eq!(names(&tree), ["Card@0", "p@0"]);
    assert_eq!(tree[0].locator, "src/P.tsx#P#0");
    assert_eq!(tree[1].locator, "src/P.tsx#Q#0");
    assert_eq!(tree[0].line, 3);
    assert_eq!(names(&tree[0].children), ["CardTitle@0.0", "Badge@0.1", "<>@0.2"]);
    assert_eq!(tree[0].children[0].text.as_deref(), Some("Hello"));
    assert!(tree[0].children[0].is_direct);
    assert!(!tree[0].children[1].is_direct, "rendered from {{…}}");
    assert_eq!(names(&tree[0].children[2].children), ["b@0.2.0"]);
    assert_eq!(tree[1].text.as_deref(), Some("Q"));
}

#[test]
fn serializes_for_the_wire_in_camel_case_without_empty_text() {
    let tree = outline("export const A = () => <div><i /></div>\n", FILE).unwrap();
    let json = serde_json::to_value(&tree).unwrap();
    assert_eq!(
        json,
        serde_json::json!([{ "locator": "src/P.tsx#A#0", "name": "div", "line": 1, "isDirect": false, "children": [
            { "locator": "src/P.tsx#A#0.0", "name": "i", "line": 1, "isDirect": true, "children": [] }
        ] }])
    );
}

#[test]
fn a_file_without_jsx_has_an_empty_outline_and_a_broken_one_is_an_error() {
    assert!(outline("export const x = 1\n", FILE).unwrap().is_empty());
    assert_eq!(outline("export const A = () => <div>", FILE).unwrap_err().code(), "parse_error");
}
