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
    // `Button` is bound; `Unused` is not referenced by the snippet: neither is imported.
    check_insert_src(&src, "<Button />", vec![spec("Button", "@/ui/other"), spec("Unused", "@/ui/unused")], &expected);
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
        let edits = ensure_imports(src, &program, &[spec("B", "b")], &["B".to_string()]).unwrap();
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
