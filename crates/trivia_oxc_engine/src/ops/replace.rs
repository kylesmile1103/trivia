//! `replaceElement`: swap a JSX element for another where it stands, such as
//! `<OpenApiListInferencer />` → `<CustomerList />`. One element's span becomes another's, so
//! it also works where siblings can't be added: in a `{…}` expression or an attribute
//! (`element={<X />}`). The snippet's imports are added, and the imports only the old element
//! used are dropped (CLAUDE.md rule 9).

use super::insert::parse_snippet;
use super::{Doc, Outcome, finish};
use crate::error::Result;
use crate::import_manager::{self, ImportSpec};
use crate::text::{self, Edit};

impl Doc<'_, '_> {
    pub(super) fn replace_element(&self, target: usize, snippet: &str, imports: &[ImportSpec]) -> Result<Outcome> {
        let snippet = snippet.trim();
        let parsed = parse_snippet(snippet)?;
        import_manager::validate_specs(imports)?;
        let span = self.table.nodes[target].span;
        let nl = text::newline(self.src);
        let indent = text::line_indent(self.src, span.start);
        let body = text::reindent_snippet(snippet, indent, nl, &parsed.frozen, &text::indent_unit(snippet), &text::indent_unit(self.src));
        // Only the imports the snippet actually references: the op touches nothing else.
        let used: Vec<ImportSpec> = imports.iter().filter(|s| parsed.free.contains(&s.name)).cloned().collect();
        if !used.is_empty() {
            self.check_not_shadowed(target, &used)?;
        }
        let before = import_manager::import_reference_counts(self.program);
        let mut edits = vec![Edit::replace(span.start, span.end, body)];
        edits.extend(import_manager::ensure_imports(self.src, self.file, self.program, &used, &parsed.components)?);
        let (code, _) = text::apply_edits(self.src, &edits)?;
        let code = import_manager::prune_dropped(&code, self.file, &before)?;
        let imported: Vec<&str> = used.iter().map(|s| s.name.as_str()).collect();
        let mut outcome = finish(self.file, self.src, code, None, &imported)?;
        // One element for one: it keeps the old one's place, and so its locator (imports are not JSX).
        outcome.locator = Some(self.table.locator(target, self.file).to_string());
        Ok(outcome)
    }
}

#[cfg(test)]
mod tests {
    use crate::inspect::{OutlineNode, outline};
    use crate::ops::{Op, apply_op};
    use crate::ImportSpec;

    const FILE: &str = "src/App.tsx";
    const APP: &str = r#"import { Route, Routes } from "react-router";
import { OpenApiListInferencer, OpenApiShowInferencer } from "@trivia/openapi-inferencer";

import { CustomerList } from "@/pages/customers/list";

export default function App() {
  return (
    <Routes>
      <Route path="/customers" element={<CustomerList />} />
      <Route path="/transactions" element={<OpenApiListInferencer resource="transactions" />} />
      <Route path="/transactions/show/:id" element={<OpenApiShowInferencer />} />
      {false && <OpenApiShowInferencer />}
    </Routes>
  );
}
"#;

    fn replace(src: &str, target: &str, name: &str, snippet: &str, imports: Vec<ImportSpec>) -> crate::Result<crate::Outcome> {
        let op = Op::ReplaceElement { target: target.into(), expected_name: Some(name.into()), snippet: snippet.into(), imports };
        apply_op(src, FILE, &op)
    }

    /// The locator of the `nth` `<tag>` in source order.
    fn locator_of(src: &str, tag: &str, nth: usize) -> String {
        fn walk(nodes: &[OutlineNode], tag: &str, out: &mut Vec<(u32, String)>) {
            for n in nodes {
                if n.name == tag {
                    out.push((n.line, n.locator.clone()));
                }
                walk(&n.children, tag, out);
            }
        }
        let mut found = Vec::new();
        walk(&outline(src, FILE).unwrap(), tag, &mut found);
        found.sort();
        found[nth].1.clone()
    }

    fn spec(name: &str, source: &str) -> ImportSpec {
        ImportSpec { name: name.into(), source: source.into(), default: false }
    }

    #[test]
    fn swaps_an_element_inside_an_attribute_with_its_imports() {
        let target = locator_of(APP, "OpenApiListInferencer", 0);
        let out = replace(APP, &target, "OpenApiListInferencer", "<TransactionList />", vec![spec("TransactionList", "@/pages/transactions/list")]).unwrap();
        assert!(out.code.contains(r#"<Route path="/transactions" element={<TransactionList />} />"#), "{}", out.code);
        assert!(out.code.contains("import { TransactionList } from \"@/pages/transactions/list\";"), "{}", out.code);
        // The inferencer import keeps the name still used; the replaced one goes.
        assert!(out.code.contains("import { OpenApiShowInferencer } from \"@trivia/openapi-inferencer\";"), "{}", out.code);
        assert_eq!(out.locator.as_deref(), Some(target.as_str()));
        // Everything else is as it was.
        let back = out.code.replace("<TransactionList />", "<OpenApiListInferencer resource=\"transactions\" />");
        assert!(back.contains(r#"<Route path="/customers" element={<CustomerList />} />"#));
    }

    #[test]
    fn drops_the_import_when_its_last_use_goes() {
        let mut src = APP.to_string();
        for nth in [1, 0] {
            let target = locator_of(&src, "OpenApiShowInferencer", nth);
            src = replace(&src, &target, "OpenApiShowInferencer", "<TransactionShow />", vec![spec("TransactionShow", "@/pages/transactions/show")]).unwrap().code;
        }
        let target = locator_of(&src, "OpenApiListInferencer", 0);
        src = replace(&src, &target, "OpenApiListInferencer", "<TransactionList />", vec![spec("TransactionList", "@/pages/transactions/list")]).unwrap().code;
        assert!(!src.contains("@trivia/openapi-inferencer"), "{src}");
        assert!(src.contains("{false && <TransactionShow />}"), "{src}");
    }

    #[test]
    fn keeps_the_layout_of_a_multi_line_replacement_and_checks_its_guard() {
        let target = locator_of(APP, "OpenApiShowInferencer", 0);
        let out = replace(APP, &target, "OpenApiShowInferencer", "<Section\n  title=\"Show\"\n/>", vec![]);
        assert_eq!(out.unwrap_err().code(), "unresolved_component");
        let out = replace(APP, &target, "Route", "<b />", vec![]);
        assert_eq!(out.unwrap_err().code(), "stale_locator");
        let out = replace(APP, &target, "OpenApiShowInferencer", "<b>one</b><i>two</i>", vec![]);
        assert_eq!(out.unwrap_err().code(), "invalid_snippet");
        let routes = locator_of(APP, "Routes", 0);
        let out = replace(APP, &routes, "Routes", "<div>\n  <p>Gone</p>\n</div>", vec![]).unwrap();
        assert!(out.code.contains("  return (\n    <div>\n      <p>Gone</p>\n    </div>\n  );"), "{}", out.code);
        // Route and CustomerList lost their last use with it.
        assert!(!out.code.contains("react-router"), "{}", out.code);
        assert!(!out.code.contains("CustomerList"), "{}", out.code);
    }
}
