//! Import bookkeeping: merging into existing declarations in the file's own style, new
//! declarations, and pruning only what an op removed. Every case runs on LF and CRLF copies,
//! and every insert is checked in reverse (removing the node restores the input exactly).

mod common;

use common::*;
use oxc_allocator::Allocator;
use trivia_oxc_engine::import_manager::ensure_imports;
use trivia_oxc_engine::text::apply_edits;
use trivia_oxc_engine::{ImportSpec, Op, Placement, apply_op, parse};

const FILE: &str = "src/Page.tsx";

/// `imports` + a `Page` component whose `<main>` holds `children`, one per line.
fn page(imports: &str, children: &[&str]) -> String {
    let mut s = String::from(imports);
    s.push_str("\nexport function Page() {\n  return (\n    <main>\n");
    for child in children {
        s.push_str(&format!("      {child}\n"));
    }
    s.push_str("    </main>\n  )\n}\n");
    s
}

/// Insert `snippet` as `<main>`'s last child and expect exactly `expected`; then remove it
/// again and expect `src` back. Runs on LF and CRLF copies.
#[track_caller]
fn check_insert_src(src: &str, snippet: &str, specs: Vec<ImportSpec>, expected: &str) {
    check_insert_into(src, "main", snippet, specs, expected);
}

/// [`check_insert_src`] with the first `<parent>` element as the target.
#[track_caller]
fn check_insert_into(src: &str, parent: &str, snippet: &str, specs: Vec<ImportSpec>, expected: &str) {
    for (src, expected) in [(src.to_string(), expected.to_string()), (to_crlf(src), to_crlf(expected))] {
        let what = format!("insert {snippet} into\n{src}");
        let target = locator_of(&src, FILE, parent);
        let out = apply(&src, FILE, &Op::Insert {
            target,
            expected_name: None,
            placement: Placement::LastChild,
            snippet: snippet.into(),
            imports: specs.clone(),
        });
        assert_text_eq(&out.code, &expected, &what);
        assert_consistent_line_endings(&src, &out.code, &what);
        let name = table(snippet, "snippet.tsx").nodes[0].display_name().to_string();
        let back = apply(&out.code, FILE, &Op::Remove { target: out.locator.unwrap(), expected_name: Some(name) });
        assert_text_eq(&back.code, &src, &format!("{what}\n(removing it again)"));
    }
}

#[track_caller]
fn check_insert(imports: &str, children: &[&str], snippet: &str, specs: Vec<ImportSpec>, imports_after: &str) {
    let mut after = children.to_vec();
    after.push(snippet);
    check_insert_src(&page(imports, children), snippet, specs, &page(imports_after, &after));
}

/// Remove `<main>`'s `index`-th child and expect the imports to become `imports_after`.
#[track_caller]
fn check_remove(imports: &str, children: &[&str], index: usize, imports_after: &str) {
    let mut rest = children.to_vec();
    rest.remove(index);
    let (src, expected) = (page(imports, children), page(imports_after, &rest));
    for (src, expected) in [(src.clone(), expected.clone()), (to_crlf(&src), to_crlf(&expected))] {
        let what = format!("remove child {index} of\n{src}");
        let out = apply(&src, FILE, &Op::Remove { target: format!("{FILE}#Page#0.{index}"), expected_name: None });
        assert_text_eq(&out.code, &expected, &what);
        assert_consistent_line_endings(&src, &out.code, &what);
    }
}

// --- merging into an existing declaration -------------------------------------------------

#[test]
fn merges_into_a_single_line_sorted_list_at_its_alphabetical_position() {
    let imports = "import { Badge, Card } from \"@/ui\"\n";
    check_insert(imports, &[], "<Button />", vec![spec("Button", "@/ui")], "import { Badge, Button, Card } from \"@/ui\"\n");
    check_insert(imports, &[], "<Alert />", vec![spec("Alert", "@/ui")], "import { Alert, Badge, Card } from \"@/ui\"\n");
    check_insert(imports, &[], "<Zeta />", vec![spec("Zeta", "@/ui")], "import { Badge, Card, Zeta } from \"@/ui\"\n");
}

#[test]
fn merges_several_names_into_their_own_positions() {
    check_insert(
        "import { Badge, Card } from \"@/ui\"\n",
        &[],
        "<Zeta><Alert /><Button /></Zeta>",
        vec![spec("Zeta", "@/ui"), spec("Button", "@/ui"), spec("Alert", "@/ui")],
        "import { Alert, Badge, Button, Card, Zeta } from \"@/ui\"\n",
    );
}

#[test]
fn merges_into_a_multi_line_list_keeping_the_trailing_comma() {
    let imports = "import {\n  Card,\n  CardContent,\n  CardTitle,\n} from \"@/ui/card\"\n";
    check_insert(
        imports,
        &[],
        "<CardAction />",
        vec![spec("CardAction", "@/ui/card")],
        "import {\n  Card,\n  CardAction,\n  CardContent,\n  CardTitle,\n} from \"@/ui/card\"\n",
    );
    check_insert(
        imports,
        &[],
        "<CardZ />",
        vec![spec("CardZ", "@/ui/card")],
        "import {\n  Card,\n  CardContent,\n  CardTitle,\n  CardZ,\n} from \"@/ui/card\"\n",
    );
}

#[test]
fn merges_into_a_multi_line_list_without_a_trailing_comma() {
    check_insert(
        "import {\n  Alpha,\n  Beta\n} from \"x\"\n",
        &[],
        "<Gamma />",
        vec![spec("Gamma", "x")],
        "import {\n  Alpha,\n  Beta,\n  Gamma\n} from \"x\"\n",
    );
}

#[test]
fn appending_to_a_multi_line_list_keeps_a_trailing_comment_on_its_line() {
    check_insert(
        "import {\n  Alpha,\n  Beta, // keep me\n} from \"x\"\n",
        &[],
        "<Gamma />",
        vec![spec("Gamma", "x")],
        "import {\n  Alpha,\n  Beta, // keep me\n  Gamma,\n} from \"x\"\n",
    );
}

#[test]
fn unsorted_lists_get_new_names_appended() {
    check_insert(
        "import { ChevronDownIcon, CheckIcon, ChevronUpIcon } from \"lucide-react\"\n",
        &[],
        "<AlertIcon />",
        vec![spec("AlertIcon", "lucide-react")],
        "import { ChevronDownIcon, CheckIcon, ChevronUpIcon, AlertIcon } from \"lucide-react\"\n",
    );
}

#[test]
fn case_insensitively_sorted_lists_stay_sorted() {
    // `cva, VariantProps` is sorted ignoring case (TypeScript's organize-imports), not by code point.
    check_insert(
        "import { cva, VariantProps } from \"cva\"\n",
        &[],
        "<Slot />",
        vec![spec("Slot", "cva")],
        "import { cva, Slot, VariantProps } from \"cva\"\n",
    );
}

#[test]
fn inline_type_specifiers_are_part_of_a_value_import() {
    check_insert(
        "import { type ButtonProps } from \"@/ui/button\"\n",
        &[],
        "<Button />",
        vec![spec("Button", "@/ui/button")],
        "import { Button, type ButtonProps } from \"@/ui/button\"\n",
    );
}

#[test]
fn default_and_named_imports_combine() {
    // New declaration with both.
    check_insert(
        "import { Badge } from \"@/ui\"\n",
        &[],
        "<Foo.Bar>{helper}</Foo.Bar>",
        vec![default_spec("Foo", "foo"), spec("helper", "foo")],
        "import { Badge } from \"@/ui\"\nimport Foo, { helper } from \"foo\"\n",
    );
    // A default goes in front of an existing named list, and named after an existing default.
    check_insert("import { helper } from \"foo\"\n", &[], "<Foo />", vec![default_spec("Foo", "foo")], "import Foo, { helper } from \"foo\"\n");
    check_insert("import Foo from \"foo\"\n", &["<Foo />"], "<p>{helper}</p>", vec![spec("helper", "foo")], "import Foo, { helper } from \"foo\"\n");
}

#[test]
fn namespace_imports_are_not_merged_into() {
    check_insert(
        "import * as Icons from \"lucide-react\"\n",
        &[],
        "<X />",
        vec![spec("X", "lucide-react")],
        "import * as Icons from \"lucide-react\"\nimport { X } from \"lucide-react\"\n",
    );
    // A default can still go in front of a namespace import.
    check_insert("import * as R from \"react\"\n", &[], "<React.Suspense />", vec![default_spec("React", "react")], "import React, * as R from \"react\"\n");
}

#[test]
fn side_effect_imports_are_not_merged_into() {
    check_insert(
        "import \"@/ui/button\"\n",
        &[],
        "<Button />",
        vec![spec("Button", "@/ui/button")],
        "import \"@/ui/button\"\nimport { Button } from \"@/ui/button\"\n",
    );
}

#[test]
fn type_only_imports_from_the_same_source_are_never_merged_into() {
    check_insert(
        "import type { ButtonProps } from \"@/ui/button\"\n",
        &[],
        "<Button />",
        vec![spec("Button", "@/ui/button")],
        "import type { ButtonProps } from \"@/ui/button\"\nimport { Button } from \"@/ui/button\"\n",
    );
}

#[test]
fn already_bound_names_and_unused_specs_add_nothing() {
    let src = page("import { Button } from \"@/ui/button\"\n", &["<Button />"]);
    let expected = page("import { Button } from \"@/ui/button\"\n", &["<Button />", "<Button />"]);
    // `Button` is bound by the requested import; `Unused` is not referenced by the snippet:
    // neither is imported. (A requested import the file binds differently is refused, see
    // `a_name_bound_to_another_module_or_a_local_is_refused`.)
    check_insert_src(&src, "<Button />", vec![spec("Button", "@/ui/button"), spec("Unused", "@/ui/unused")], &expected);
}

/// Rule 9 applied literally: a remove that takes away a name's last reference prunes its
/// import, even when that import was unused before the matching insert. (Undo does not go
/// through ops: it restores the exact earlier bytes.)
#[test]
fn removing_the_only_use_of_a_previously_unused_import_prunes_it() {
    let src = page("import { Button } from \"@/ui/button\"\n", &[]);
    let target = locator_of(&src, FILE, "main");
    let out = apply(&src, FILE, &Op::Insert {
        target,
        expected_name: None,
        placement: Placement::LastChild,
        snippet: "<Button />".into(),
        imports: vec![],
    });
    assert_text_eq(&out.code, &page("import { Button } from \"@/ui/button\"\n", &["<Button />"]), "uses the existing import");
    let back = apply(&out.code, FILE, &Op::Remove { target: out.locator.unwrap(), expected_name: Some("Button".into()) });
    assert_text_eq(&back.code, page("", &[]).strip_prefix('\n').unwrap(), "the remove took the last reference");
}

// --- new declarations ---------------------------------------------------------------------

#[test]
fn new_declarations_copy_the_last_imports_quotes_and_semicolons() {
    check_insert(
        "import { useState } from 'react';\nimport { Badge } from '@/ui';\n",
        &[],
        "<Zeta />",
        vec![spec("Zeta", "@/z")],
        "import { useState } from 'react';\nimport { Badge } from '@/ui';\nimport { Zeta } from '@/z';\n",
    );
}

#[test]
fn new_declarations_go_after_the_last_imports_line_including_its_comment() {
    check_insert(
        "import { Badge } from \"@/ui\" // the badge\n",
        &[],
        "<Zeta />",
        vec![spec("Zeta", "@/z")],
        "import { Badge } from \"@/ui\" // the badge\nimport { Zeta } from \"@/z\"\n",
    );
}

#[test]
fn files_without_imports_get_one_at_the_top_in_their_own_style() {
    // Semicolons and single quotes, from the file's own statements.
    let src = "const title = 'Page';\n\nexport const Page = () => (\n  <main>\n    <h1>{title}</h1>\n  </main>\n);\n";
    let expected = "import { Zeta } from '@/z';\n\nconst title = 'Page';\n\nexport const Page = () => (\n  <main>\n    <h1>{title}</h1>\n    <Zeta />\n  </main>\n);\n";
    check_insert_src(src, "<Zeta />", vec![spec("Zeta", "@/z")], expected);

    // No strings, no semicolons: double quotes, no semicolon. JSX attribute quotes don't count.
    let src = "export function Page() {\n  return (\n    <main className='x'>\n    </main>\n  )\n}\n";
    let expected = "import { Zeta } from \"@/z\"\n\nexport function Page() {\n  return (\n    <main className='x'>\n      <Zeta />\n    </main>\n  )\n}\n";
    check_insert_src(src, "<Zeta />", vec![spec("Zeta", "@/z")], expected);
}

#[test]
fn a_new_first_import_does_not_separate_a_statement_from_its_comment() {
    let src = read_fixture("hand/NoImports.tsx");
    let expected = format!("import {{ Zeta }} from \"@/z\";\n\n{}", src.replace("      <input type=\"text\" />\n", "      <input type=\"text\" />\n      <Zeta />\n"));
    check_insert_into(&src, "div", "<Zeta />", vec![spec("Zeta", "@/z")], &expected);

    // A header separated by a blank line is not attached: it stays above the imports.
    let src = "// header\n\nexport function Page() {\n  return (\n    <main>\n    </main>\n  )\n}\n";
    let expected = "// header\n\nimport { Zeta } from \"@/z\"\n\nexport function Page() {\n  return (\n    <main>\n      <Zeta />\n    </main>\n  )\n}\n";
    check_insert_src(src, "<Zeta />", vec![spec("Zeta", "@/z")], expected);
}

#[test]
fn use_client_directive_stays_first() {
    let src = read_fixture("hand/Directive.tsx");
    let expected = src
        .replacen("\"use client\"\n\n", "\"use client\"\n\nimport { Zeta } from \"@/z\"\n\n", 1)
        .replacen("      </p>\n", "      </p>\n      <Zeta />\n", 1);
    let target = locator_of(&src, "src/hand/Directive.tsx", "aside");
    for (src, expected) in [(src.clone(), expected.clone()), (to_crlf(&src), to_crlf(&expected))] {
        let out = apply(&src, "src/hand/Directive.tsx", &Op::Insert {
            target: target.clone(),
            expected_name: None,
            placement: Placement::LastChild,
            snippet: "<Zeta />".into(),
            imports: vec![spec("Zeta", "@/z")],
        });
        assert_text_eq(&out.code, &expected, "use client");
        assert_consistent_line_endings(&src, &out.code, "use client");
        let back = apply(&out.code, "src/hand/Directive.tsx", &Op::Remove { target: out.locator.unwrap(), expected_name: None });
        assert_text_eq(&back.code, &src, "use client, removed again");
    }
}

/// The two insertion points that had `line_end` (the `\n`) and so split CRLF pairs.
#[test]
fn crlf_new_declaration_after_the_last_import_and_after_a_directive() {
    // After the last import.
    let src = "import x from 'y'\r\nimport { A } from \"a\"\r\n\r\nexport const P = () => (\r\n  <main>\r\n  </main>\r\n)\r\n";
    let target = locator_of(src, FILE, "main");
    let out = apply(src, FILE, &Op::Insert {
        target,
        expected_name: None,
        placement: Placement::LastChild,
        snippet: "<B />".into(),
        imports: vec![spec("B", "b")],
    });
    assert_text_eq(
        &out.code,
        "import x from 'y'\r\nimport { A } from \"a\"\r\nimport { B } from \"b\"\r\n\r\nexport const P = () => (\r\n  <main>\r\n    <B />\r\n  </main>\r\n)\r\n",
        "after the last import",
    );
    assert_consistent_line_endings(src, &out.code, "after the last import");

    // A file that is only a directive (the no-imports, no-statements branch).
    for src in ["\"use client\"\r\n", "\"use client\";\r\n// note\r\n", "\"use client\""] {
        let alloc = Allocator::default();
        let program = parse(&alloc, src, FILE).unwrap();
        let edits = ensure_imports(src, FILE, &program, &[spec("B", "b")], &["B".to_string()]).unwrap();
        let (code, _) = apply_edits(src, &edits).unwrap();
        assert_consistent_line_endings(src, &code, src);
        let nl = if src.contains('\r') { "\r\n" } else { "\n" };
        let directive_end = src.find("client\"").unwrap() + "client\"".len() + usize::from(src.contains(';'));
        let expected = format!("{}{nl}{nl}import {{ B }} from \"b\"{}{}", &src[..directive_end], if src.contains(';') { ";" } else { "" }, &src[directive_end..]);
        assert_text_eq(&code, &expected, src);
        let alloc = Allocator::default();
        parse(&alloc, &code, FILE).unwrap();
    }
}

#[test]
fn crlf_merges_and_prunes_in_multi_line_lists() {
    let imports = "import {\n  Alpha,\n  Beta,\n  Gamma,\n} from \"x\"\n";
    // Merge at the end and in the middle (check_insert runs CRLF too).
    check_insert(imports, &["<Alpha />", "<Beta />", "<Gamma />"], "<Zed />", vec![spec("Zed", "x")], "import {\n  Alpha,\n  Beta,\n  Gamma,\n  Zed,\n} from \"x\"\n");
    check_insert(imports, &["<Alpha />", "<Beta />", "<Gamma />"], "<Bravo />", vec![spec("Bravo", "x")], "import {\n  Alpha,\n  Beta,\n  Bravo,\n  Gamma,\n} from \"x\"\n");
    // Pruning a whole specifier line.
    check_remove(imports, &["<Alpha />", "<Beta />", "<Gamma />"], 1, "import {\n  Alpha,\n  Gamma,\n} from \"x\"\n");
}

// --- pruning --------------------------------------------------------------------------------

#[test]
fn prune_drops_only_names_the_op_removed() {
    // `Unused` was already unused: an unrequested edit to remove it, so it stays.
    check_remove("import { Badge, Unused } from \"@/ui\"\n", &["<Badge />"], 0, "import { Unused } from \"@/ui\"\n");
    // `Badge` is still used by its sibling.
    check_remove("import { Badge } from \"@/ui\"\n", &["<Badge />", "<Badge>2</Badge>"], 0, "import { Badge } from \"@/ui\"\n");
    // `Badge` is still referenced outside JSX.
    let src = "import { Badge } from \"@/ui\"\n\nconst Alias = Badge\n\nexport function Page() {\n  return (\n    <main>\n      <Badge />\n      <Alias />\n    </main>\n  )\n}\n";
    let out = apply(src, FILE, &Op::Remove { target: format!("{FILE}#Page#0.0"), expected_name: Some("Badge".into()) });
    assert_text_eq(&out.code, &src.replacen("      <Badge />\n", "", 1), "non-JSX reference keeps the import");
}

#[test]
fn prune_removes_runs_of_adjacent_specifiers() {
    check_remove("import { A, B, C, D } from \"x\"\n", &["<A />", "<B><C /></B>", "<D />"], 1, "import { A, D } from \"x\"\n");
    check_remove("import { A, B, C } from \"x\"\n", &["<A />", "<B><C /></B>"], 1, "import { A } from \"x\"\n");
    check_remove("import { A, B, C } from \"x\"\n", &["<A><B /></A>", "<C />"], 0, "import { C } from \"x\"\n");
    check_remove(
        "import {\n  A,\n  B,\n  C,\n  D,\n} from \"x\"\n",
        &["<A />", "<B><C /></B>", "<D />"],
        1,
        "import {\n  A,\n  D,\n} from \"x\"\n",
    );
    check_remove("import {\n  A,\n  B\n} from \"x\"\n", &["<A />", "<B />"], 1, "import {\n  A\n} from \"x\"\n");
}

#[test]
fn prune_removes_a_whole_declaration_and_its_blank_line_when_none_remain() {
    // The only import: the blank line that separated it from the code goes with it.
    let src = page("import { Badge } from \"@/ui\"\n", &["<Badge />", "<p>x</p>"]);
    let expected = page("", &["<p>x</p>"]);
    let expected = expected.strip_prefix('\n').unwrap();
    for (src, expected) in [(src.clone(), expected.to_string()), (to_crlf(&src), to_crlf(expected))] {
        let out = apply(&src, FILE, &Op::Remove { target: format!("{FILE}#Page#0.0"), expected_name: None });
        assert_text_eq(&out.code, &expected, "only import pruned");
        assert_consistent_line_endings(&src, &out.code, "only import pruned");
    }
    // One of several: just its line.
    check_remove("import { A } from \"a\"\nimport { B } from \"b\"\n", &["<A />", "<B />"], 0, "import { B } from \"b\"\n");
}

#[test]
fn prune_default_and_namespace_parts_while_others_remain() {
    check_remove("import Foo, { Bar } from \"x\"\n", &["<Foo />", "<Bar />"], 0, "import { Bar } from \"x\"\n");
    check_remove("import Foo, { Bar } from \"x\"\n", &["<Foo />", "<Bar />"], 1, "import Foo from \"x\"\n");
    check_remove("import Foo, { Bar, Baz } from \"x\"\n", &["<Foo />", "<Bar />", "<Baz />"], 2, "import Foo, { Bar } from \"x\"\n");
    check_remove("import D, * as NS from \"x\"\n", &["<D />", "<NS.Item />"], 1, "import D from \"x\"\n");
    check_remove("import D, * as NS from \"x\"\n", &["<D />", "<NS.Item />"], 0, "import * as NS from \"x\"\n");
}

#[test]
fn conflicting_or_malformed_import_specs_are_refused() {
    let src = page("", &[]);
    let target = locator_of(&src, FILE, "main");
    let insert = |imports: Vec<ImportSpec>| Op::Insert {
        target: target.clone(),
        expected_name: None,
        placement: Placement::LastChild,
        snippet: "<Zeta />".into(),
        imports,
    };
    assert_eq!(error_code(&src, FILE, &insert(vec![spec("Zeta", "a"), spec("Zeta", "b")])), "invalid_op");
    assert_eq!(error_code(&src, FILE, &insert(vec![spec("Ze ta", "a")])), "invalid_op");
    assert_eq!(error_code(&src, FILE, &insert(vec![spec("Zeta", "")])), "invalid_op");
    assert_eq!(error_code(&src, FILE, &insert(vec![])), "unresolved_component");
    assert_eq!(error_code(&src, FILE, &insert(vec![spec("Other", "o")])), "unresolved_component");
    // Two different defaults from one module.
    let op = Op::Insert {
        target: target.clone(),
        expected_name: None,
        placement: Placement::LastChild,
        snippet: "<A><B /></A>".into(),
        imports: vec![default_spec("A", "m"), default_spec("B", "m")],
    };
    assert_eq!(error_code(&src, FILE, &op), "invalid_op");
    // The same spec twice is fine (deduplicated).
    let out = apply(&src, FILE, &insert(vec![spec("Zeta", "z"), spec("Zeta", "z")]));
    assert_eq!(out.code.matches("import { Zeta } from \"z\"").count(), 1);
    assert!(apply_op(&src, FILE, &insert(vec![spec("Zeta", "z")])).is_ok());
}

// --- names that are already bound ---------------------------------------------------------

/// Insert `snippet` into `<main>` with `imports` (built from JSON, as the designer sends it)
/// and return the error code and message.
fn refusal(src: &str, snippet: &str, imports: serde_json::Value) -> (&'static str, String) {
    let op: Op = serde_json::from_value(serde_json::json!({
        "op": "insert", "target": locator_of(src, FILE, "main"), "placement": "lastChild",
        "snippet": snippet, "imports": imports,
    }))
    .unwrap();
    match apply_op(src, FILE, &op) {
        Ok(out) => panic!("{op:?} should be refused but wrote:\n{}", out.code),
        Err(e) => (e.code(), e.to_string()),
    }
}

/// A requested import whose name the file already binds to something else would make the
/// new element render that other thing. bindQuery refuses the same situation.
#[test]
fn a_name_bound_to_another_module_or_a_local_is_refused() {
    let shadcn = serde_json::json!([{ "name": "Button", "source": "@/components/ui/button" }]);
    let snippet = "<Button variant=\"outline\">b</Button>";
    for (imports, what) in [
        ("import { Button } from \"@mui/material\"\n", "import { Button } from \"@mui/material\""),
        ("import { Button } from \"react-aria-components\"\n", "import { Button } from \"react-aria-components\""),
        ("import { MuiButton as Button } from \"@/components/ui/button\"\n", "import { MuiButton as Button }"),
        ("import Button from \"@/components/ui/button\"\n", "import Button from"),
        ("import * as Button from \"@/components/ui/button\"\n", "import * as Button from"),
    ] {
        let src = page(imports, &[]);
        let (code, message) = refusal(&src, snippet, shadcn.clone());
        assert_eq!(code, "unsupported", "{imports}: {message}");
        assert!(message.contains(what) && message.contains("@/components/ui/button"), "{imports}: {message}");
    }
    for local in ["const Button = (p: object) => <button {...p} />\n", "function Button() {\n  return null\n}\n"] {
        let src = page(local, &[]);
        let (code, message) = refusal(&src, snippet, shadcn.clone());
        assert_eq!(code, "unsupported", "{local}: {message}");
        assert!(message.contains("`Button` is already declared in this file"), "{local}: {message}");
    }
    // A default spec needs a default import of that module.
    let src = page("import { Logo } from \"@/logo\"\n", &[]);
    let (code, message) = refusal(&src, "<Logo />", serde_json::json!([{ "name": "Logo", "source": "@/logo", "default": true }]));
    assert_eq!(code, "unsupported", "{message}");
}

#[test]
fn a_name_bound_by_the_requested_import_is_reused() {
    let imports = "import Logo from \"@/logo\"\nimport { Button as Button } from \"@/ui/button\"\nimport { default as Mark } from \"@/mark\"\n";
    let used = ["<Logo />", "<Button />", "<Mark />"];
    for (snippet, spec) in [
        ("<Logo />", default_spec("Logo", "@/logo")),
        ("<Button />", spec("Button", "@/ui/button")),
        ("<Mark />", default_spec("Mark", "@/mark")),
    ] {
        check_insert(imports, &used, snippet, vec![spec], imports);
    }
}

/// The import exists, but the destination sits in a scope that declares its own `Button`,
/// so the new `<Button>` would render that local one.
#[test]
fn a_requested_name_shadowed_at_the_destination_is_refused() {
    let src = "import { Button } from \"@/ui/button\"\n\nexport function Page() {\n  const Button = () => null\n  return (\n    <main>\n    </main>\n  )\n}\n";
    let (code, message) = refusal(src, "<Button />", serde_json::json!([{ "name": "Button", "source": "@/ui/button" }]));
    assert_eq!(code, "unsupported", "{message}");
    assert!(message.contains("`Button`") && message.contains("shadow"), "{message}");
}

// --- block comments around the insertion point --------------------------------------------

#[test]
fn a_new_declaration_goes_after_a_block_comment_that_ends_on_a_later_line() {
    for semi in ["", ";"] {
        let imports = format!("import {{ A }} from \"./a\"{semi} /* the a\n   component */\n");
        check_insert(
            &imports,
            &["<A />"],
            "<Zeta />",
            vec![spec("Zeta", "@/z")],
            &format!("{imports}import {{ Zeta }} from \"@/z\"{semi}\n"),
        );
    }
    // Two comments, the second also running onto the next line.
    let imports = "import { A } from \"./a\" /* one */ /* two\n */ /* three\n */\n";
    check_insert(imports, &["<A />"], "<Zeta />", vec![spec("Zeta", "@/z")], &format!("{imports}import {{ Zeta }} from \"@/z\"\n"));
}

#[test]
fn a_merged_specifier_goes_after_a_block_comment_that_ends_on_a_later_line() {
    check_insert(
        "import {\n  Card, /* the card,\n  see docs */\n} from \"@/ui/card\"\n",
        &["<Card />"],
        "<CardTitle />",
        vec![spec("CardTitle", "@/ui/card")],
        "import {\n  Card, /* the card,\n  see docs */\n  CardTitle,\n} from \"@/ui/card\"\n",
    );
    // No trailing comma: one goes after `Card` and the new name has none. (Removing it again
    // keeps that comma, as for any specifier list with a comment after the comma: see
    // `pruning_an_import_never_removes_a_comment` in formatting.rs.)
    let src = page("import {\n  Card /* the card,\n  see docs */\n} from \"@/ui/card\"\n", &["<Card />"]);
    let expected = page("import {\n  Card, /* the card,\n  see docs */\n  CardTitle\n} from \"@/ui/card\"\n", &["<Card />", "<CardTitle />"]);
    for (src, expected) in [(src.clone(), expected.clone()), (to_crlf(&src), to_crlf(&expected))] {
        let out = apply(&src, FILE, &Op::Insert {
            target: locator_of(&src, FILE, "main"),
            expected_name: Some("main".into()),
            placement: Placement::LastChild,
            snippet: "<CardTitle />".into(),
            imports: vec![spec("CardTitle", "@/ui/card")],
        });
        assert_text_eq(&out.code, &expected, "no trailing comma");
        assert_consistent_line_endings(&src, &out.code, "no trailing comma");
    }
}

// --- one module, several spellings -----------------------------------------------------

/// Insert `snippet` into the first `<main>` of `src` (the file at `file`) with `imports`.
fn insert_at(
    file: &str,
    src: &str,
    snippet: &str,
    imports: Vec<ImportSpec>,
) -> trivia_oxc_engine::Result<trivia_oxc_engine::Outcome> {
    apply_op(src, file, &Op::Insert {
        target: locator_of(src, file, "main"),
        expected_name: Some("main".into()),
        placement: Placement::LastChild,
        snippet: snippet.into(),
        imports,
    })
}

/// The designer always sends the project's spelling (`@/components/ui/button`); the file may
/// already import that module through a relative path, with an extension or via `/index`.
/// That is the same module, so its binding is reused and nothing is added.
#[test]
fn the_same_module_spelled_another_way_is_reused() {
    let shadcn = vec![spec("Button", "@/components/ui/button")];
    let snippet = "<Button variant=\"outline\">b</Button>";
    for (file, existing) in [
        ("src/pages/Page.tsx", "../components/ui/button"),
        ("src/pages/Page.tsx", "@/components/ui/button.tsx"),
        ("src/pages/Page.tsx", "../components/ui/button/index"),
        ("src/pages/Page.tsx", "../components/ui/button/index.tsx"),
        ("src/pages/Page.tsx", "~/components/ui/button.jsx"),
        ("src/pages/Page.tsx", "./../components/ui/./button.js"),
        ("src/pages/Page.tsx", "../components/../components/ui/button.mjs"),
        ("src/App.tsx", "./components/ui/button/index"),
        ("src/App.tsx", "./components/ui/button.tsx"),
        ("src/components/ui/demo.tsx", "./button"),
        ("src/components/ui/button/demo.tsx", "."),
        ("src/components/ui/button/demo.tsx", "./index.ts"),
    ] {
        let imports = format!("import {{ Button }} from \"{existing}\"\n");
        let src = page(&imports, &["<Button />"]);
        let expected = page(&imports, &["<Button />", snippet]);
        for (src, expected) in [(src.clone(), expected.clone()), (to_crlf(&src), to_crlf(&expected))] {
            let what = format!("{file} importing from {existing:?}");
            let out = insert_at(file, &src, snippet, shadcn.clone()).unwrap_or_else(|e| panic!("{what}: {e}"));
            assert_text_eq(&out.code, &expected, &what);
            let remove = Op::Remove { target: out.locator.unwrap(), expected_name: Some("Button".into()) };
            assert_text_eq(&apply(&out.code, file, &remove).code, &src, &format!("{what} (removing it again)"));
        }
    }
    // A default import of the same module, spelled with its extension.
    let imports = "import Logo from \"../assets/logo.tsx\"\n";
    let logo = vec![default_spec("Logo", "@/assets/logo")];
    let out = insert_at("src/pages/Page.tsx", &page(imports, &[]), "<Logo />", logo).unwrap();
    assert_text_eq(&out.code, &page(imports, &["<Logo />"]), "default import");
}

/// Everything else is still another module: other paths, a path outside `src/` or outside
/// the project, other extensions, another case, and bare package names, which must match
/// exactly.
#[test]
fn different_modules_are_still_refused() {
    let snippet = "<Button variant=\"outline\">b</Button>";
    let file = "src/pages/Page.tsx";
    for (requested, existing) in [
        ("@/components/ui/button", "@mui/material"),
        ("@/components/ui/button", "react-aria-components"),
        ("@/components/ui/button", "./components/ui/button"),
        ("@/components/ui/button", "../../components/ui/button"),
        ("@/components/ui/button", "../../../../components/ui/button"),
        ("@/components/ui/button", "../components/ui/button-group"),
        ("@/components/ui/button", "../components/ui/button/button"),
        ("@/components/ui/button", "@/components/ui/Button"),
        ("@/components/ui/button", "@/components/button"),
        ("@/components/ui/button", "@/components/ui/button.css"),
        ("@/components/ui/button", "@/components/ui/button.d.ts"),
        ("@/components/ui/button", "components/ui/button"),
        ("@/components/ui/button", "src/components/ui/button"),
        ("@/components/ui/button", "@components/ui/button"),
        ("@/components/ui/button", "/src/components/ui/button"),
        ("@mui/material", "@mui/material/index"),
        ("@mui/material", "@mui/material/Button"),
        ("@mui/material", "@mui/material.js"),
        ("react-aria-components", "./react-aria-components"),
    ] {
        let src = page(&format!("import {{ Button }} from \"{existing}\"\n"), &[]);
        let what = format!("{requested:?} into a file importing from {existing:?}");
        let err = match insert_at(file, &src, snippet, vec![spec("Button", requested)]) {
            Ok(out) => panic!("{what}: should be refused but wrote\n{}", out.code),
            Err(e) => e,
        };
        assert_eq!(err.code(), "unsupported", "{what}: {err}");
        let message = err.to_string();
        assert!(message.contains(existing) && message.contains(requested), "{what}: {message}");
    }
    // The exact same bare name is the same package.
    let imports = "import { Button } from \"@mui/material\"\n";
    let out = insert_at(file, &page(imports, &[]), snippet, vec![spec("Button", "@mui/material")]).unwrap();
    assert_text_eq(&out.code, &page(imports, &[snippet]), "same package");
}

/// A specifier the file does not import yet joins the declaration of the same module, in
/// the file's own spelling, instead of a second declaration of that module.
#[test]
fn a_missing_specifier_joins_the_same_module_spelled_another_way() {
    let file = "src/pages/Page.tsx";
    let src = page("import { Card } from \"../components/ui/card\"\n", &["<Card />"]);
    let expected = page("import { Card, CardTitle } from \"../components/ui/card\"\n", &["<Card />", "<CardTitle />"]);
    for (src, expected) in [(src.clone(), expected.clone()), (to_crlf(&src), to_crlf(&expected))] {
        let out = insert_at(file, &src, "<CardTitle />", vec![spec("CardTitle", "@/components/ui/card")]).unwrap();
        assert_text_eq(&out.code, &expected, "merged");
        let remove = Op::Remove { target: out.locator.unwrap(), expected_name: Some("CardTitle".into()) };
        assert_text_eq(&apply(&out.code, file, &remove).code, &src, "merged (removing it again)");
    }
    // Two requested names from one module spelled two ways share one new declaration.
    let out = insert_at(
        file,
        &page("import { A } from \"./a\"\n", &["<A />"]),
        "<CardTitle><CardDescription /></CardTitle>",
        vec![spec("CardTitle", "@/components/ui/card"), spec("CardDescription", "../components/ui/card.tsx")],
    )
    .unwrap();
    let imports = "import { A } from \"./a\"\nimport { CardTitle, CardDescription } from \"@/components/ui/card\"\n";
    assert!(out.code.starts_with(imports), "{}", out.code);
}
