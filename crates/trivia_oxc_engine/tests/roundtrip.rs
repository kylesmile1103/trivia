//! Exhaustive round-trip properties over every node of every fixture (and its CRLF, tab and
//! 4-space variants). These are the strongest evidence for the byte-preservation promise:
//! an edit followed by its inverse must give back the original file, byte for byte.
//!
//! Ops the engine legitimately refuses (siblings of roots or of nodes rendered from `{…}`,
//! moves into a node's own subtree) are skipped and counted, after checking that the refusal
//! carries the documented error code.

mod common;

use common::*;
use serde_json::Value;
use trivia_oxc_engine::inspect::{AttrKind, inspect};
use trivia_oxc_engine::locator::{AttrValue, JsxNode, JsxTable, NodeKind};
use trivia_oxc_engine::{ImportSpec, Op, Placement, apply_op};

const PLACEMENTS: [Placement; 4] = [Placement::Before, Placement::After, Placement::FirstChild, Placement::LastChild];

struct Snippet {
    name: &'static str,
    text: &'static str,
    imports: Vec<ImportSpec>,
}

/// Single-line snippets: a component needing a new import declaration, an intrinsic element,
/// and two components merged into an existing named import (sorting first and last).
fn snippets(fx: &Fixture, all: bool) -> Vec<Snippet> {
    let mut out = vec![
        Snippet { name: "Zeta", text: r#"<Zeta tone="new" />"#, imports: vec![spec("Zeta", "@/components/ui/zeta")] },
        Snippet { name: "span", text: "<span>new</span>", imports: vec![] },
    ];
    if all && let Some(source) = first_named_import_source(&fx.src, &fx.file) {
        out.push(Snippet { name: "Aardvark", text: "<Aardvark />", imports: vec![spec("Aardvark", &source)] });
        out.push(Snippet { name: "Zebra", text: "<Zebra>z</Zebra>", imports: vec![spec("Zebra", &source)] });
    }
    out
}

/// Every line break an edit writes matches the file's: never `\r\r`, never a bare `\n` or
/// `\r` in a CRLF file, never a `\r` in an LF file.
#[track_caller]
fn assert_line_endings(fx: &Fixture, code: &str, what: &str) {
    assert_consistent_line_endings(&fx.src, code, what);
}

fn is_sibling(p: Placement) -> bool {
    matches!(p, Placement::Before | Placement::After)
}

fn self_closing(node: &JsxNode) -> bool {
    node.kind == NodeKind::Element && node.closing.is_none()
}

/// `<div></div>` (no content, opening and closing tag on one line).
fn one_line_empty(src: &str, node: &JsxNode) -> bool {
    node.content.is_empty()
        && node.closing.is_some_and(|c| !src[node.opening.end as usize..c.start as usize].contains('\n'))
}

/// `<div></div>` after multi-line text went in and came out again: `<div>` + newline + `</div>`.
fn expanded_empty(src: &str, node: &JsxNode) -> String {
    let closing = node.closing.unwrap();
    format!(
        "{}{}{}{}",
        &src[..node.opening.end as usize],
        newline_of(src),
        indent_at(src, node.span.start as usize),
        &src[closing.start as usize..]
    )
}

/// What a self-closing element looks like after a child was inserted and removed again:
/// `<X a />` becomes `<X a>` + newline + `</X>` (the engine's documented expansion).
fn expanded(src: &str, node: &JsxNode) -> String {
    let end = node.opening.end as usize;
    assert_eq!(&src[end - 2..end], "/>", "self-closing tag ends with `/>`");
    let slash = end - 2;
    let slash_starts_line = indent_at(src, slash).len() == slash - src[..slash].rfind('\n').map_or(0, |i| i + 1);
    let cut = if slash_starts_line { slash } else { src[..slash].trim_end_matches([' ', '\t']).len() };
    let outer = indent_at(src, node.span.start as usize);
    let name = node.name.as_deref().unwrap();
    format!("{}>{}{outer}</{name}>{}", &src[..cut], newline_of(src), &src[end..])
}

#[test]
fn insert_then_remove_restores_every_byte() {
    let mut tally = Tally::default();
    for fx in fixture_variants() {
        let as_written = !fx.label.contains('[');
        let t = table(&fx.src, &fx.file);
        for (i, node) in t.nodes.iter().enumerate() {
            let target = loc(&t, i, &fx.file);
            for placement in PLACEMENTS {
                for snippet in snippets(&fx, as_written) {
                    let what = format!("{}: insert {:?} {} at {target}", fx.label, placement, snippet.text);
                    let op = Op::Insert {
                        target: target.clone(),
                        expected_name: Some(node.display_name().into()),
                        placement,
                        snippet: snippet.text.into(),
                        imports: snippet.imports.clone(),
                    };
                    let out = match apply_op(&fx.src, &fx.file, &op) {
                        Ok(out) => out,
                        Err(e) => {
                            assert!(
                                is_sibling(placement) && (node.parent.is_none() || !node.direct),
                                "{what}: unexpected refusal: {e}"
                            );
                            assert_eq!(e.code(), "unsupported", "{what}");
                            tally.skip("refused: sibling of a root or of a node inside {…}");
                            continue;
                        }
                    };
                    assert!(out.changed, "{what}");
                    assert_line_endings(&fx, &out.code, &what);
                    let inserted = out.locator.clone().unwrap_or_else(|| panic!("{what}: no locator returned"));
                    let removed = apply_op(
                        &out.code,
                        &fx.file,
                        &Op::Remove { target: inserted.clone(), expected_name: Some(snippet.name.into()) },
                    )
                    .unwrap_or_else(|e| panic!("{what}: removing {inserted} failed: {e}\n{}", out.code));
                    if !is_sibling(placement) && self_closing(node) {
                        assert_text_eq(&removed.code, &expanded(&fx.src, node), &what);
                        tally.skip("checked against the self-closing expansion instead of the original");
                    } else {
                        assert_text_eq(&removed.code, &fx.src, &what);
                        tally.ok += 1;
                    }
                }
            }
        }
    }
    tally.finish("insert → remove", 2000);
}

#[test]
fn insert_child_at_every_index_then_remove_restores_every_byte() {
    let mut tally = Tally::default();
    for fx in fixture_variants() {
        let t = table(&fx.src, &fx.file);
        for (i, node) in t.nodes.iter().enumerate() {
            let parent = loc(&t, i, &fx.file);
            for index in 0..=node.children.len() {
                let what = format!("{}: insertChild {parent} @{index}", fx.label);
                let op = Op::InsertChild {
                    parent: parent.clone(),
                    expected_name: Some(node.display_name().into()),
                    index,
                    snippet: "<Zeta />".into(),
                    imports: vec![spec("Zeta", "@/components/ui/zeta")],
                };
                let out = match apply_op(&fx.src, &fx.file, &op) {
                    Ok(out) => out,
                    Err(e) => {
                        assert!(index < node.children.len() && !t.nodes[node.children[index]].direct, "{what}: {e}");
                        assert_eq!(e.code(), "unsupported", "{what}");
                        tally.skip("refused: index names a child rendered from {…}");
                        continue;
                    }
                };
                assert_line_endings(&fx, &out.code, &what);
                let inserted = out.locator.clone().unwrap();
                // The new node takes exactly the requested index.
                let mut expected_path = t.nodes[i].path.clone();
                expected_path.push(index as u32);
                assert_eq!(trivia_oxc_engine::Locator::parse(&inserted).unwrap().path, expected_path, "{what}");
                let removed = apply(&out.code, &fx.file, &Op::Remove { target: inserted, expected_name: Some("Zeta".into()) });
                if self_closing(node) {
                    assert_text_eq(&removed.code, &expanded(&fx.src, node), &what);
                    tally.skip("checked against the self-closing expansion instead of the original");
                } else {
                    assert_text_eq(&removed.code, &fx.src, &what);
                    tally.ok += 1;
                }
            }
        }
    }
    tally.finish("insertChild → remove", 400);
}

/// A multi-line snippet (with a template literal whose lines must not be re-indented) goes
/// in and comes out again everywhere.
#[test]
fn multi_line_snippet_insert_then_remove_restores_every_byte() {
    const SNIPPET: &str = "<Card>\n  <CardContent>\n    <pre>{`keep\n  this`}</pre>\n  </CardContent>\n</Card>";
    let imports = || vec![spec("Card", "@/components/ui/card"), spec("CardContent", "@/components/ui/card")];
    let mut tally = Tally::default();
    for fx in fixture_variants() {
        let t = table(&fx.src, &fx.file);
        // A file that declares `Card` itself (the shadcn card.tsx) cannot also import it.
        let declares_card = ["Card", "CardContent"].iter().any(|name| root_binding(&fx.src, &fx.file, name) == Some(false));
        for (i, node) in t.nodes.iter().enumerate() {
            for placement in PLACEMENTS {
                let target = loc(&t, i, &fx.file);
                let what = format!("{}: insert {placement:?} multi-line at {target}", fx.label);
                let expected_name = Some(node.display_name().into());
                let op = Op::Insert { target, expected_name, placement, snippet: SNIPPET.into(), imports: imports() };
                let out = match apply_op(&fx.src, &fx.file, &op) {
                    Ok(out) => out,
                    Err(e) if is_sibling(placement) && (node.parent.is_none() || !node.direct) => {
                        assert_eq!(e.code(), "unsupported", "{what}: {e}");
                        tally.skip("refused: sibling of a root or of a node inside {…}");
                        continue;
                    }
                    Err(e) => {
                        assert!(declares_card && e.to_string().contains("is already declared in this file"), "{what}: {e}");
                        assert_eq!(e.code(), "unsupported", "{what}: {e}");
                        tally.skip("refused: the file declares the component it would import");
                        continue;
                    }
                };
                assert_line_endings(&fx, &out.code, &what);
                assert!(out.code.contains("{`keep\n  this`}") || out.code.contains("{`keep\r\n  this`}"), "{what}: template literal re-indented:\n{}", out.code);
                let inserted = out.locator.clone().unwrap();
                let removed = apply(&out.code, &fx.file, &Op::Remove { target: inserted, expected_name: Some("Card".into()) });
                if !is_sibling(placement) && self_closing(node) {
                    assert_text_eq(&removed.code, &expanded(&fx.src, node), &what);
                    tally.skip("checked against the self-closing expansion instead of the original");
                } else if !is_sibling(placement) && one_line_empty(&fx.src, node) {
                    assert_text_eq(&removed.code, &expanded_empty(&fx.src, node), &what);
                    tally.skip("checked against the expanded one-line container instead of the original");
                } else {
                    assert_text_eq(&removed.code, &fx.src, &what);
                    tally.ok += 1;
                }
            }
        }
    }
    tally.finish("multi-line insert → remove", 500);
}

/// The name a move's scope refusal is about (`cannot move <b>: `label` there is …`).
fn scope_refusal(e: &trivia_oxc_engine::EngineError) -> Option<String> {
    let message = e.to_string();
    let scoped = message.contains("where it would go") || message.contains("not the one it uses here");
    let name = message.split_once(">: `")?.1.split('`').next()?;
    (e.code() == "unsupported" && scoped).then(|| name.to_string())
}

/// `text` contains `word` as a whole identifier.
fn uses_word(text: &str, word: &str) -> bool {
    let ident = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
    text.match_indices(word).any(|(i, _)| {
        !text[..i].chars().next_back().is_some_and(ident) && !text[i + word.len()..].chars().next().is_some_and(ident)
    })
}

/// Where a node sits relative to its siblings, as a (target, placement) a move can aim at.
fn home(t: &JsxTable, idx: usize) -> Option<(usize, Placement)> {
    let parent = t.nodes[idx].parent?;
    let content = &t.nodes[parent].content;
    let ci = content.iter().position(|c| c.node == Some(idx))?;
    if let Some(next) = content.get(ci + 1).and_then(|c| c.node) {
        return Some((next, Placement::Before));
    }
    if let Some(prev) = ci.checked_sub(1).and_then(|p| content[p].node) {
        return Some((prev, Placement::After));
    }
    if ci == 0 {
        return Some((parent, Placement::FirstChild));
    }
    (ci + 1 == content.len()).then_some((parent, Placement::LastChild))
}

#[test]
fn move_then_move_back_restores_every_byte() {
    let mut tally = Tally::default();
    let mut sources: Vec<Fixture> = Vec::new();
    for fx in fixtures() {
        sources.push(Fixture { file: fx.file.clone(), src: to_crlf(&fx.src), label: format!("{}[crlf]", fx.label) });
        sources.push(fx);
    }
    for fx in sources {
        let t = table(&fx.src, &fx.file);
        let n = t.nodes.len();
        for a in 0..n {
            let node = &t.nodes[a];
            let subtree = t.subtree(a);
            for target in 0..n {
                for placement in PLACEMENTS {
                    let what = format!(
                        "{}: move {} <{}> {:?} {} <{}>",
                        fx.label,
                        loc(&t, a, &fx.file),
                        node.display_name(),
                        placement,
                        loc(&t, target, &fx.file),
                        t.nodes[target].display_name()
                    );
                    let op = Op::Move {
                        source: loc(&t, a, &fx.file),
                        expected_name: Some(node.display_name().into()),
                        target: loc(&t, target, &fx.file),
                        expected_target_name: Some(t.nodes[target].display_name().into()),
                        placement,
                    };
                    let out = match apply_op(&fx.src, &fx.file, &op) {
                        Ok(out) => out,
                        Err(e) => {
                            let tn = &t.nodes[target];
                            let reason = if node.parent.is_none() || !node.direct {
                                assert_eq!(e.code(), "unsupported", "{what}: {e}");
                                "refused: source is a root or inside {…}"
                            } else if subtree.contains(&target) && (target != a || !is_sibling(placement)) {
                                assert_eq!(e.code(), "invalid_op", "{what}: {e}");
                                "refused: into its own subtree"
                            } else if is_sibling(placement) && (tn.parent.is_none() || !tn.direct) {
                                assert_eq!(e.code(), "unsupported", "{what}: {e}");
                                "refused: sibling of a root or of a node inside {…}"
                            } else if let Some(name) = scope_refusal(&e) {
                                // The refusal must be about a name the moved code really uses,
                                // and a module-level name is in scope everywhere.
                                let moved = &fx.src[node.span.start as usize..node.span.end as usize];
                                assert!(uses_word(moved, &name), "{what}: refused over `{name}`, which it does not use: {e}");
                                if e.to_string().contains("is not in scope where it would go") {
                                    assert_eq!(root_binding(&fx.src, &fx.file, &name), None, "{what}: {e}");
                                }
                                "refused: the moved code would refer to something else where it lands"
                            } else {
                                panic!("{what}: unexpected refusal: {e} [{}]", e.code());
                            };
                            tally.skip(reason);
                            continue;
                        }
                    };
                    if !out.changed {
                        assert_eq!(out.code, fx.src, "{what}");
                        tally.skip("no-op move (already there)");
                        continue;
                    }
                    assert_line_endings(&fx, &out.code, &what);
                    let moved = out.locator.clone().unwrap_or_else(|| panic!("{what}: no locator returned"));
                    let t2 = table(&out.code, &fx.file);
                    let moved_idx = resolve(&t2, &moved);
                    assert_eq!(t2.nodes[moved_idx].display_name(), node.display_name(), "{what}");

                    // A move never reorders other nodes: match them up by rank in source order.
                    let rest1: Vec<usize> = (0..n).filter(|i| !subtree.contains(i)).collect();
                    let moved_subtree = t2.subtree(moved_idx);
                    let rest2: Vec<usize> = (0..t2.nodes.len()).filter(|i| !moved_subtree.contains(i)).collect();
                    let names = |t: &JsxTable, v: &[usize]| v.iter().map(|&i| t.nodes[i].display_name().to_string()).collect::<Vec<_>>();
                    assert_eq!(names(&t, &rest1), names(&t2, &rest2), "{what}: other nodes changed");
                    assert_eq!(subtree.len(), moved_subtree.len(), "{what}: moved subtree changed");

                    let Some((home_node, home_placement)) = home(&t, a) else {
                        tally.skip("source sits between text/expressions: no anchor to move it back");
                        continue;
                    };
                    let home_new = rest2[rest1.iter().position(|&i| i == home_node).unwrap()];
                    let back = Op::Move {
                        source: moved.clone(),
                        expected_name: Some(node.display_name().into()),
                        target: loc(&t2, home_new, &fx.file),
                        expected_target_name: Some(t2.nodes[home_new].display_name().into()),
                        placement: home_placement,
                    };
                    let restored = apply_op(&out.code, &fx.file, &back)
                        .unwrap_or_else(|e| panic!("{what}: moving back failed: {e}\n{}", out.code));
                    let tn = &t.nodes[target];
                    let multiline = fx.src[node.span.start as usize..node.span.end as usize].contains('\n');
                    if !is_sibling(placement) && self_closing(tn) {
                        // Moving into `<X />` expanded it; moving out leaves `<X>` + `</X>`.
                        assert_text_eq(&restored.code, &expanded(&fx.src, tn), &format!("{what}, then back"));
                        tally.skip("checked against the self-closing expansion instead of the original");
                    } else if !is_sibling(placement) && multiline && one_line_empty(&fx.src, tn) {
                        // A multi-line node expanded `<div></div>`; moving it out leaves two lines.
                        assert_text_eq(&restored.code, &expanded_empty(&fx.src, tn), &format!("{what}, then back"));
                        tally.skip("checked against the expanded one-line container instead of the original");
                    } else {
                        assert_text_eq(&restored.code, &fx.src, &format!("{what}, then back"));
                        tally.ok += 1;
                    }
                }
            }
        }
    }
    tally.finish("move → move back", 2000);
}

/// A value of the same type that differs from `v` (strings get two: plain, and one that needs
/// every kind of escaping).
fn probes(v: &Value) -> Vec<Value> {
    match v {
        Value::String(s) => vec![Value::String(format!("{s}-probe")), Value::String(r#"x"y'z&amp;\ ✓ &"#.into())],
        Value::Bool(b) => vec![Value::Bool(!b)],
        Value::Number(n) if n.is_i64() => vec![Value::from(n.as_i64().unwrap() + 1)],
        Value::Number(n) => vec![Value::from(n.as_f64().unwrap() + 1.0)],
        _ => vec![],
    }
}

#[test]
fn update_prop_then_restore_restores_every_byte() {
    let mut tally = Tally::default();
    for fx in fixture_variants() {
        let t = table(&fx.src, &fx.file);
        for (i, node) in t.nodes.iter().enumerate() {
            if node.kind == NodeKind::Fragment {
                continue;
            }
            let target = loc(&t, i, &fx.file);
            let expected_name = Some(node.display_name().to_string());
            let details = inspect(&fx.src, &target).unwrap();
            for (k, attr) in details.attributes.iter().enumerate() {
                let Some(name) = &attr.name else { continue };
                // JSX lets the last duplicate win, and so does the engine.
                if details.attributes[k + 1..].iter().any(|a| a.name.as_ref() == Some(name)) {
                    tally.skip("shadowed duplicate attribute");
                    continue;
                }
                if attr.kind == AttrKind::Shorthand {
                    tally.skip("shorthand attribute (true → false → true gives `={true}`)");
                    continue;
                }
                let Some(original) = attr.value.clone() else {
                    tally.skip("non-literal value");
                    continue;
                };
                for probe in probes(&original) {
                    let what = format!("{}: {target} {name}={original} → {probe} → back", fx.label);
                    let set = |src: &str, value: &Value| {
                        apply(src, &fx.file, &Op::UpdateProp {
                            target: target.clone(),
                            expected_name: expected_name.clone(),
                            prop: name.clone(),
                            value: value.clone(),
                        })
                    };
                    let changed = set(&fx.src, &probe);
                    assert!(changed.changed, "{what}");
                    assert_line_endings(&fx, &changed.code, &what);
                    let now = inspect(&changed.code, &target).unwrap();
                    let written = now.attributes.iter().rev().find(|a| a.name.as_ref() == Some(name)).unwrap();
                    assert_eq!(written.value.as_ref(), Some(&probe), "{what}: the engine wrote a different value\n{}", changed.code);
                    let restored = set(&changed.code, &original);
                    if restored.code != fx.src && attr.kind == AttrKind::String && attr.source.contains('&') {
                        // Documented: a value spelled with character references (`"a &amp; b"`)
                        // comes back in its minimal spelling (`"a & b"`). Same runtime value,
                        // and nothing but the value's bytes may differ.
                        let span = match &node.attributes.iter().rev().find(|a| a.name.as_ref() == Some(name)).unwrap().value {
                            Some(AttrValue::String { span, .. }) => *span,
                            other => panic!("{what}: expected a string attribute, got {other:?}"),
                        };
                        let (head, tail) = (&fx.src[..span.start as usize], &fx.src[span.end as usize..]);
                        assert!(restored.code.starts_with(head) && restored.code.ends_with(tail), "{what}: bytes outside the value changed");
                        let back = inspect(&restored.code, &target).unwrap();
                        let value = back.attributes.iter().rev().find(|a| a.name.as_ref() == Some(name)).unwrap().value.clone();
                        assert_eq!(value, Some(original.clone()), "{what}");
                        tally.skip("entity spelling canonicalized (value bytes only)");
                        continue;
                    }
                    assert_text_eq(&restored.code, &fx.src, &what);
                    tally.ok += 1;
                }
            }

            // A brand-new prop, then removing it again.
            let what = format!("{}: {target} add data-probe then remove it", fx.label);
            let added = apply(&fx.src, &fx.file, &Op::UpdateProp {
                target: target.clone(),
                expected_name: expected_name.clone(),
                prop: "data-probe".into(),
                value: "1".into(),
            });
            assert!(added.changed, "{what}");
            assert_line_endings(&fx, &added.code, &what);
            let removed = apply(&added.code, &fx.file, &Op::UpdateProp {
                target: target.clone(),
                expected_name,
                prop: "data-probe".into(),
                value: Value::Null,
            });
            assert_text_eq(&removed.code, &fx.src, &what);
            tally.ok += 1;
        }
    }
    tally.finish("updateProp → restore", 500);
}

/// Removing any node: line breaks stay consistent, every other node survives in order, and
/// only imports the removed subtree used (and nothing left uses) are dropped.
#[test]
fn remove_every_node_keeps_everything_else() {
    let mut tally = Tally::default();
    for fx in fixture_variants() {
        let t = table(&fx.src, &fx.file);
        let imports_before = import_locals(&fx.src, &fx.file);
        for (i, node) in t.nodes.iter().enumerate() {
            let what = format!("{}: remove {} <{}>", fx.label, loc(&t, i, &fx.file), node.display_name());
            let op = Op::Remove { target: loc(&t, i, &fx.file), expected_name: Some(node.display_name().into()) };
            let out = match apply_op(&fx.src, &fx.file, &op) {
                Ok(out) => out,
                Err(e) => {
                    assert!(node.parent.is_none() || !node.direct, "{what}: unexpected refusal: {e}");
                    assert_eq!(e.code(), "unsupported", "{what}");
                    tally.skip("refused: root or inside {…}");
                    continue;
                }
            };
            assert!(out.changed && out.locator.is_none(), "{what}");
            assert_line_endings(&fx, &out.code, &what);

            let subtree = t.subtree(i);
            let t2 = table(&out.code, &fx.file);
            let kept: Vec<&str> =
                (0..t.nodes.len()).filter(|k| !subtree.contains(k)).map(|k| t.nodes[k].display_name()).collect();
            let now: Vec<&str> = t2.nodes.iter().map(JsxNode::display_name).collect();
            assert_eq!(kept, now, "{what}: other nodes changed");

            let used: std::collections::BTreeSet<&str> = subtree.iter().filter_map(|&k| t.nodes[k].component_ref()).collect();
            for name in imports_before.difference(&import_locals(&out.code, &fx.file)) {
                assert!(used.contains(name.as_str()), "{what}: pruned `{name}`, which the removed subtree did not use");
                assert!(
                    !t2.nodes.iter().any(|n| n.component_ref() == Some(name.as_str())),
                    "{what}: pruned `{name}` but it is still used"
                );
            }
            tally.ok += 1;
        }
    }
    tally.finish("remove", 200);
}
