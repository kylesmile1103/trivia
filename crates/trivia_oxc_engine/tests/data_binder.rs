//! `bind_query`: binding a JSX element to a TanStack Query by span splicing.

use oxc_allocator::Allocator;
use trivia_oxc_engine::{Outcome, QueryBinding, annotate, bind_query, parse};

const LIST_FILE: &str = "src/pages/CustomerList.tsx";
const LIST: &str = include_str!("fixtures/data/CustomerList.tsx");
const LIST_EXPECTED: &str = include_str!("fixtures/data/CustomerList.expected.tsx");
const CARDS: &str = include_str!("fixtures/data/CustomerCards.tsx");
const CARDS_EXPECTED: &str = include_str!("fixtures/data/CustomerCards.expected.tsx");
const BOARD: &str = include_str!("fixtures/data/OrderBoard.tsx");
const BOARD_EXPECTED: &str = include_str!("fixtures/data/OrderBoard.expected.tsx");

const FILE: &str = "src/pages/Customers.tsx";
const OPTIONS_IMPORT: &str = "@/api/generated/@tanstack/react-query.gen";
const HOOK: &str =
    "const { data: customerData, isLoading: isCustomerLoading } = useQuery({ ...listCustomersOptions() })";
const IMPORTS: &str = "import { useQuery } from \"@tanstack/react-query\"\nimport { listCustomersOptions } from \"@/api/generated/@tanstack/react-query.gen\"\n";
const PROPS: &str = "data={customerData?.items ?? []} isLoading={isCustomerLoading}";

/// Locator of the first element named `name` (via the same annotation the Vite plugin uses).
fn locator_of(src: &str, file: &str, name: &str) -> String {
    let ins = annotate(src, file).unwrap();
    ins.iter()
        .find(|i| src[..i.offset as usize].ends_with(&format!("<{name}")))
        .map(|i| i.text.trim().trim_start_matches("data-ast-node=\"").trim_end_matches('"').to_string())
        .unwrap_or_else(|| panic!("no <{name}> in source"))
}

/// The designer's default binding: `<DataTable>` ← `Customer.operations.list`.
fn customers(src: &str, file: &str) -> QueryBinding {
    QueryBinding {
        target: locator_of(src, file, "DataTable"),
        expected_name: Some("DataTable".into()),
        options_fn: "listCustomersOptions".into(),
        options_import: OPTIONS_IMPORT.into(),
        options_args: None,
        resource: "Customer".into(),
        items_path: Some("items".into()),
        data_prop: "data".into(),
        loading_prop: Some("isLoading".into()),
    }
}

/// Bind and check the invariants every result must hold.
fn bind(src: &str, file: &str, binding: &QueryBinding) -> Outcome {
    let out = bind_query(src, file, binding).unwrap_or_else(|e| panic!("bind failed: {e}\n--- source ---\n{src}"));
    let alloc = Allocator::default();
    if let Err(e) = parse(&alloc, &out.code, file) {
        panic!("result does not parse: {e}\n{}", out.code);
    }
    assert!(!out.code.contains("data-ast-node"), "dev-only locator leaked into source:\n{}", out.code);
    assert_eq!(out.changed, out.code != src);
    out
}

/// Bind, then bind the result again: the second pass must be a byte-identical no-op.
fn bind_idempotent(src: &str, file: &str, binding: &QueryBinding) -> Outcome {
    let out = bind(src, file, binding);
    let mut again = binding.clone();
    again.target = out.locator.clone().expect("bound element has a locator");
    let second = bind(&out.code, file, &again);
    assert!(!second.changed, "re-binding changed the file:\n{}", second.code);
    assert_eq!(second.code, out.code);
    out
}

fn err_code(src: &str, file: &str, binding: &QueryBinding) -> &'static str {
    match bind_query(src, file, binding) {
        Ok(out) => panic!("expected an error, got:\n{}", out.code),
        Err(e) => e.code(),
    }
}

#[test]
fn customer_list_matches_the_hand_written_expected_file() {
    let mut binding = customers(LIST, LIST_FILE);
    assert_eq!(binding.target, "src/pages/CustomerList.tsx#CustomerList#0.1");
    binding.options_args = Some("{ query: { page: 1, pageSize: 20 } }".into());
    let out = bind_idempotent(LIST, LIST_FILE, &binding);
    assert!(out.changed);
    assert_eq!(out.code, LIST_EXPECTED);
    assert_eq!(out.locator.as_deref(), Some("src/pages/CustomerList.tsx#CustomerList#0.1"));

    // Byte preservation: stripping exactly the known insertions restores the input.
    let restored = out
        .code
        .replacen(IMPORTS, "", 1)
        .replacen(
            "  const { data: customerData, isLoading: isCustomerLoading } = useQuery({ ...listCustomersOptions({ query: { page: 1, pageSize: 20 } }) })\n\n",
            "",
            1,
        )
        .replacen(PROPS, "data={[]}", 1);
    assert_eq!(restored, LIST);
}

#[test]
fn expression_body_arrow_becomes_a_block_body_around_untouched_jsx() {
    let file = "src/pages/CustomerCards.tsx";
    let out = bind_idempotent(CARDS, file, &customers(CARDS, file));
    assert_eq!(out.code, CARDS_EXPECTED);
    // The JSX bytes between `(` and `)` are untouched apart from the two props.
    let jsx = |s: &str| s[s.find("(\n  <section").unwrap()..s.rfind(")\n").unwrap() + 1].to_string();
    assert_eq!(jsx(&out.code).replacen(&format!(" {PROPS}"), "", 1), jsx(CARDS));
}

#[test]
fn tab_indented_file_with_semicolons_multiline_args_and_one_prop_per_line() {
    let file = "src/pages/OrderBoard.tsx";
    let binding = QueryBinding {
        target: locator_of(BOARD, file, "DataTable"),
        expected_name: Some("DataTable".into()),
        options_fn: "listOrdersOptions".into(),
        options_import: OPTIONS_IMPORT.into(),
        // Two-space indented, as the designer writes it: converted to the file's tabs.
        options_args: Some("{\n  query: {\n    status,\n    page: 1,\n  },\n}".into()),
        resource: "Order".into(),
        items_path: Some("data".into()),
        data_prop: "data".into(),
        loading_prop: Some("isLoading".into()),
    };
    let out = bind_idempotent(BOARD, file, &binding);
    assert_eq!(out.code, BOARD_EXPECTED);
}

#[test]
fn crlf_file_keeps_crlf_line_endings() {
    let src = LIST.replace('\n', "\r\n");
    let mut binding = customers(&src, LIST_FILE);
    binding.options_args = Some("{ query: { page: 1, pageSize: 20 } }".into());
    let out = bind_idempotent(&src, LIST_FILE, &binding);
    assert_eq!(out.code, LIST_EXPECTED.replace('\n', "\r\n"));
    assert_eq!(out.code.matches('\n').count(), out.code.matches("\r\n").count(), "no bare LF");
    assert_eq!(out.code.matches('\r').count(), out.code.matches("\r\n").count(), "no bare CR");
}

#[test]
fn crlf_multiline_args_use_the_file_line_ending() {
    let src = "import { DataTable } from \"@/components/data-table\"\r\n\r\nexport function Customers() {\r\n  return <DataTable />\r\n}\r\n";
    let mut binding = customers(src, FILE);
    binding.options_args = Some("{\n  query: { page: 1 },\n}".into());
    let out = bind_idempotent(src, FILE, &binding);
    assert!(out.code.contains(
        "  const { data: customerData, isLoading: isCustomerLoading } = useQuery({\r\n    ...listCustomersOptions({\r\n      query: { page: 1 },\r\n    }),\r\n  })\r\n\r\n  return <DataTable "
    ), "{}", out.code);
    assert_eq!(out.code.matches('\n').count(), out.code.matches("\r\n").count(), "no bare LF");
}

#[test]
fn merges_use_query_into_an_existing_tanstack_import() {
    let src = r#"import { useQueryClient } from "@tanstack/react-query"
import { DataTable } from "@/components/data-table"

export function Customers() {
  const client = useQueryClient()
  return <DataTable data={[]} onRefresh={() => client.invalidateQueries()} />
}
"#;
    let out = bind_idempotent(src, FILE, &customers(src, FILE));
    let expected = src
        .replacen("import { useQueryClient }", "import { useQuery, useQueryClient }", 1)
        .replacen(
            "import { DataTable } from \"@/components/data-table\"\n",
            &format!("import {{ DataTable }} from \"@/components/data-table\"\nimport {{ listCustomersOptions }} from \"{OPTIONS_IMPORT}\"\n"),
            1,
        )
        .replacen("  const client", &format!("  {HOOK}\n\n  const client"), 1)
        .replacen("data={[]}", "data={customerData?.items ?? []}", 1)
        .replacen("client.invalidateQueries()} />", "client.invalidateQueries()} isLoading={isCustomerLoading} />", 1);
    assert_eq!(out.code, expected);
    assert_eq!(out.code.matches("@tanstack/react-query\"").count(), 1, "no second tanstack import");
}

#[test]
fn existing_hook_is_reused_and_only_is_loading_is_added() {
    let src = r#"import { useQuery } from "@tanstack/react-query"
import { listCustomersOptions } from "@/api/generated/@tanstack/react-query.gen"
import { DataTable } from "@/components/data-table"

export function Customers() {
  const { data: customers } = useQuery({ ...listCustomersOptions({ query: { page: 2 } }) })
  return <DataTable data={customers ?? []} />
}
"#;
    let out = bind_idempotent(src, FILE, &customers(src, FILE));
    let expected = src
        .replacen("{ data: customers }", "{ data: customers, isLoading: isCustomerLoading }", 1)
        .replacen("data={customers ?? []} />", "data={customers?.items ?? []} isLoading={isCustomerLoading} />", 1);
    assert_eq!(out.code, expected);
    assert_eq!(out.code.matches("useQuery(").count(), 1, "no second hook");
}

#[test]
fn existing_multiline_pattern_gets_the_new_property_on_its_own_line() {
    let src = r#"import { useQuery } from "@tanstack/react-query"
import { listCustomersOptions } from "@/api/generated/@tanstack/react-query.gen"
import { DataTable } from "@/components/data-table"

export function Customers() {
  const {
    data: rows,
    error,
  } = useQuery({
    ...listCustomersOptions(),
    staleTime: 60_000,
  })
  if (error) return null
  return <DataTable data={rows?.items ?? []} />
}
"#;
    let out = bind_idempotent(src, FILE, &customers(src, FILE));
    let expected = src
        .replacen("    error,\n", "    error,\n    isLoading: isCustomerLoading,\n", 1)
        .replacen("data={rows?.items ?? []} />", "data={rows?.items ?? []} isLoading={isCustomerLoading} />", 1);
    assert_eq!(out.code, expected);
}

#[test]
fn existing_hook_bound_to_a_name_is_read_through_it() {
    let src = r#"import { useQuery } from "@tanstack/react-query"
import { listCustomersOptions } from "@/api/generated/@tanstack/react-query.gen"
import { DataTable } from "@/components/data-table"

export function Customers() {
  const customers = useQuery(listCustomersOptions())
  return <DataTable data={[]} />
}
"#;
    let out = bind_idempotent(src, FILE, &customers(src, FILE));
    let expected = src.replacen(
        "data={[]} />",
        "data={customers.data?.items ?? []} isLoading={customers.isLoading} />",
        1,
    );
    assert_eq!(out.code, expected);
}

#[test]
fn existing_hook_with_an_array_pattern_is_refused() {
    let src = r#"import { useQuery } from "@tanstack/react-query"
import { listCustomersOptions } from "@/api/generated/@tanstack/react-query.gen"
import { DataTable } from "@/components/data-table"

export function Customers() {
  const [first] = useQuery({ ...listCustomersOptions() }) as never
  return <DataTable data={first} />
}
"#;
    assert_eq!(err_code(src, FILE, &customers(src, FILE)), "unsupported");
}

#[test]
fn reused_names_shadowed_at_the_element_are_refused() {
    // `rows` inside the callback is the parameter, not the query result.
    let src = r#"import { useQuery } from "@tanstack/react-query"
import { listCustomersOptions } from "@/api/generated/@tanstack/react-query.gen"
import { DataTable } from "@/components/data-table"

export function Customers({ pages }: { pages: string[][] }) {
  const { data: rows } = useQuery({ ...listCustomersOptions() })
  return <div>{pages.map((rows) => <DataTable key={rows.join()} />)}</div>
}
"#;
    let err = bind_query(src, FILE, &customers(src, FILE)).unwrap_err();
    assert_eq!(err.code(), "unsupported");
    assert!(err.to_string().contains("`rows`"), "{err}");
}

#[test]
fn a_different_factory_gets_its_own_hook_first() {
    let src = r#"import { useQuery } from "@tanstack/react-query"
import { listOrdersOptions } from "@/api/generated/@tanstack/react-query.gen"
import { DataTable } from "@/components/data-table"

export function Customers() {
  const { data: orderData } = useQuery({ ...listOrdersOptions() })
  return <DataTable data={[]} footer={orderData?.total} />
}
"#;
    let out = bind_idempotent(src, FILE, &customers(src, FILE));
    let expected = src
        .replacen("import { listOrdersOptions }", "import { listCustomersOptions, listOrdersOptions }", 1)
        .replacen("  const { data: orderData }", &format!("  {HOOK}\n\n  const {{ data: orderData }}"), 1)
        .replacen(
            "data={[]} footer={orderData?.total} />",
            "data={customerData?.items ?? []} footer={orderData?.total} isLoading={isCustomerLoading} />",
            1,
        );
    assert_eq!(out.code, expected);
}

#[test]
fn name_collisions_get_numbered_names_with_a_shared_suffix() {
    let src = r#"import { DataTable } from "@/components/data-table"

const customerData = [] as const

export function Customers({ isCustomerLoading }: { isCustomerLoading: boolean }) {
  return <DataTable data={customerData} isLoading={isCustomerLoading} />
}
"#;
    let out = bind_idempotent(src, FILE, &customers(src, FILE));
    let expected = src
        .replacen(
            "import { DataTable } from \"@/components/data-table\"\n",
            &format!("import {{ DataTable }} from \"@/components/data-table\"\n{IMPORTS}"),
            1,
        )
        .replacen(
            "  return <DataTable",
            "  const { data: customerData2, isLoading: isCustomerLoading2 } = useQuery({ ...listCustomersOptions() })\n\n  return <DataTable",
            1,
        )
        .replacen(
            "data={customerData} isLoading={isCustomerLoading}",
            "data={customerData2?.items ?? []} isLoading={isCustomerLoading2}",
            1,
        );
    assert_eq!(out.code, expected);
}

#[test]
fn collisions_in_nested_scopes_and_globals_are_avoided_too() {
    let src = r#"import { DataTable } from "@/components/data-table"

export function Customers({ groups }: { groups: string[][] }) {
  const customerData2 = customerData3
  return (
    <div title={String(customerData2)}>
      {groups.map((customerData) => (
        <DataTable key={customerData.join()} />
      ))}
    </div>
  )
}
"#;
    let out = bind_idempotent(src, FILE, &customers(src, FILE));
    assert!(
        out.code.contains("const { data: customerData4, isLoading: isCustomerLoading4 } = useQuery("),
        "{}",
        out.code
    );
    assert!(out.code.contains("data={customerData4?.items ?? []} isLoading={isCustomerLoading4}"));
}

#[test]
fn target_inside_a_map_callback_gets_the_hook_at_the_component_top_level() {
    let src = r#"import { DataTable } from "@/components/data-table"

export function Regions({ regions }: { regions: string[] }) {
  return (
    <div>
      {regions.map((region) => {
        const title = region.toUpperCase()
        return <DataTable key={region} caption={title} data={[]} />
      })}
    </div>
  )
}
"#;
    let binding = customers(src, FILE);
    assert_eq!(binding.target, "src/pages/Customers.tsx#Regions#0.0");
    let out = bind_idempotent(src, FILE, &binding);
    let expected = src
        .replacen(
            "import { DataTable } from \"@/components/data-table\"\n",
            &format!("import {{ DataTable }} from \"@/components/data-table\"\n{IMPORTS}"),
            1,
        )
        .replacen("{ regions: string[] }) {\n", &format!("{{ regions: string[] }}) {{\n  {HOOK}\n\n"), 1)
        .replacen("data={[]} />", &format!("{PROPS} />"), 1);
    assert_eq!(out.code, expected);
    assert_eq!(out.locator.as_deref(), Some("src/pages/Customers.tsx#Regions#0.0"));
}

#[test]
fn module_scope_jsx_is_refused() {
    let src = r#"import { DataTable } from "@/components/data-table"

export const table = <DataTable data={[]} />
"#;
    assert_eq!(err_code(src, FILE, &customers(src, FILE)), "unsupported");

    let src = r#"import { createRoot } from "react-dom/client"
import { DataTable } from "@/components/data-table"

createRoot(document.getElementById("root")!).render(<DataTable data={[]} />)
"#;
    assert_eq!(err_code(src, FILE, &customers(src, FILE)), "unsupported");

    // A module-level callback is not a component either.
    let src = r#"import { DataTable } from "@/components/data-table"

export const columns = [{ cell: () => <DataTable data={[]} /> }]
"#;
    assert_eq!(err_code(src, FILE, &customers(src, FILE)), "unsupported");
}

#[test]
fn non_component_functions_and_class_components_are_refused() {
    let src = r#"import { DataTable } from "@/components/data-table"

export function renderTable() {
  return <DataTable data={[]} />
}
"#;
    let err = bind_query(src, FILE, &customers(src, FILE)).unwrap_err();
    assert_eq!(err.code(), "unsupported");
    assert!(err.to_string().contains("`renderTable`"), "{err}");

    let src = r#"import { Component } from "react"
import { DataTable } from "@/components/data-table"

export class Customers extends Component {
  render() {
    return <DataTable data={[]} />
  }
}
"#;
    let err = bind_query(src, FILE, &customers(src, FILE)).unwrap_err();
    assert_eq!(err.code(), "unsupported");
    assert!(err.to_string().contains("class component"), "{err}");

    let src = r#"import { DataTable } from "@/components/data-table"

export async function Customers() {
  return <DataTable data={[]} />
}
"#;
    assert_eq!(err_code(src, FILE, &customers(src, FILE)), "unsupported");
}

#[test]
fn custom_hooks_may_receive_the_hook() {
    let src = r#"import { DataTable } from "@/components/data-table"

export function useCustomerTable() {
  return <DataTable data={[]} />
}
"#;
    let out = bind_idempotent(src, FILE, &customers(src, FILE));
    assert!(out.code.contains(&format!("export function useCustomerTable() {{\n  {HOOK}\n\n  return <DataTable {PROPS} />")));
}

#[test]
fn stale_expected_name_is_refused() {
    let mut binding = customers(LIST, LIST_FILE);
    binding.expected_name = Some("Button".into());
    assert_eq!(err_code(LIST, LIST_FILE, &binding), "stale_locator");

    let mut binding = customers(LIST, LIST_FILE);
    binding.target = "src/pages/CustomerList.tsx#CustomerList#0.9".into();
    assert_eq!(err_code(LIST, LIST_FILE, &binding), "node_not_found");

    let mut binding = customers(LIST, LIST_FILE);
    binding.target = "src/pages/Other.tsx#CustomerList#0.1".into();
    assert_eq!(err_code(LIST, LIST_FILE, &binding), "unsupported");
}

#[test]
fn items_path_none_binds_the_response_itself() {
    let mut binding = customers(LIST, LIST_FILE);
    binding.items_path = None;
    let out = bind_idempotent(LIST, LIST_FILE, &binding);
    assert!(out.code.contains("<DataTable columns={columns} data={customerData ?? []} isLoading={isCustomerLoading} />"));
}

#[test]
fn nested_items_path_chains_optionally() {
    let mut binding = customers(LIST, LIST_FILE);
    binding.items_path = Some("page.items".into());
    let out = bind_idempotent(LIST, LIST_FILE, &binding);
    assert!(out.code.contains("data={customerData?.page?.items ?? []}"));
}

#[test]
fn loading_prop_none_destructures_and_binds_only_data() {
    let mut binding = customers(LIST, LIST_FILE);
    binding.loading_prop = None;
    let out = bind_idempotent(LIST, LIST_FILE, &binding);
    assert!(out.code.contains("  const { data: customerData } = useQuery({ ...listCustomersOptions() })\n\n"));
    assert!(out.code.contains("<DataTable columns={columns} data={customerData?.items ?? []} />"));
    assert!(!out.code.contains("isLoading") && !out.code.contains("isCustomerLoading"));
}

#[test]
fn replaces_string_shorthand_and_expression_values_in_place() {
    let src = r#"import { DataTable } from "@/components/data-table"

export function Customers() {
  return <DataTable data="none" isLoading columns={columns} />
}
"#;
    let out = bind_idempotent(src, FILE, &customers(src, FILE));
    assert!(out.code.contains(&format!("return <DataTable {PROPS} columns={{columns}} />")), "{}", out.code);

    // Custom prop names, and a later duplicate (which JSX lets win) is the one edited.
    let src = r#"import { DataTable } from "@/components/data-table"

export function Customers() {
  return <DataTable rows={[]} busy={false} rows={undefined} />
}
"#;
    let mut binding = customers(src, FILE);
    binding.data_prop = "rows".into();
    binding.loading_prop = Some("busy".into());
    let out = bind_idempotent(src, FILE, &binding);
    assert!(
        out.code.contains("<DataTable rows={[]} busy={isCustomerLoading} rows={customerData?.items ?? []} />"),
        "{}",
        out.code
    );
}

#[test]
fn element_without_attributes_gets_both_props_after_its_name() {
    let src = r#"import { DataTable } from "@/components/data-table"

export function Customers() {
  return (
    <div>
      <DataTable></DataTable>
    </div>
  )
}
"#;
    let out = bind_idempotent(src, FILE, &customers(src, FILE));
    assert!(out.code.contains(&format!("      <DataTable {PROPS}></DataTable>\n")), "{}", out.code);
}

#[test]
fn forward_ref_and_memo_wrapped_components() {
    let src = r#"import * as React from "react"
import { DataTable } from "@/components/data-table"

export const CustomerPanel = React.memo(
  React.forwardRef<HTMLDivElement, { title: string }>(function CustomerPanel({ title }, ref) {
    return (
      <div ref={ref}>
        <h2>{title}</h2>
        <DataTable data={[]} />
      </div>
    )
  }),
)
"#;
    let out = bind_idempotent(src, FILE, &customers(src, FILE));
    assert!(
        out.code.contains(&format!("function CustomerPanel({{ title }}, ref) {{\n    {HOOK}\n\n    return (\n")),
        "{}",
        out.code
    );

    let src = r#"import { forwardRef } from "react"
import { DataTable } from "@/components/data-table"

export const CustomerPanel = forwardRef<HTMLDivElement>((props, ref) => (
  <div ref={ref} {...props}>
    <DataTable data={[]} />
  </div>
))
"#;
    let out = bind_idempotent(src, FILE, &customers(src, FILE));
    let expected = src
        .replacen(
            "import { DataTable } from \"@/components/data-table\"\n",
            &format!("import {{ DataTable }} from \"@/components/data-table\"\n{IMPORTS}"),
            1,
        )
        .replacen("(props, ref) => (\n", &format!("(props, ref) => {{\n  {HOOK}\n\n  return (\n"), 1)
        .replacen("data={[]} />", &format!("{PROPS} />"), 1)
        .replacen("  </div>\n))\n", "  </div>\n)\n})\n", 1);
    assert_eq!(out.code, expected);
}

#[test]
fn anonymous_default_export_arrow_without_parentheses() {
    let src = "import { DataTable } from \"@/components/data-table\"\n\nexport default () => <DataTable data={[]} />\n";
    let out = bind_idempotent(src, FILE, &customers(src, FILE));
    let expected = format!(
        "import {{ DataTable }} from \"@/components/data-table\"\n{IMPORTS}\nexport default () => {{\n  {HOOK}\n\n  return <DataTable {PROPS} />\n}}\n"
    );
    assert_eq!(out.code, expected);

    // Multi-line JSX without parentheses: the line break between `=>` and `<div>` is the only
    // original text replaced (a kept `return⏎` would return undefined), and the expression
    // gets the idiomatic `return (…)` parentheses.
    let src = "import { DataTable } from \"@/components/data-table\"\n\nexport default () =>\n  <div>\n    <DataTable />\n  </div>\n";
    let out = bind_idempotent(src, FILE, &customers(src, FILE));
    let expected = format!(
        "import {{ DataTable }} from \"@/components/data-table\"\n{IMPORTS}\nexport default () => {{\n  {HOOK}\n\n  return (<div>\n    <DataTable {PROPS} />\n  </div>)\n}}\n"
    );
    assert_eq!(out.code, expected);
}

#[test]
fn directives_stay_first_and_single_line_bodies_are_split() {
    let src = r#"import { DataTable } from "@/components/data-table"

export function Customers() {
  "use no memo"
  return <DataTable />
}
"#;
    let out = bind_idempotent(src, FILE, &customers(src, FILE));
    assert!(out.code.contains(&format!("  \"use no memo\"\n  {HOOK}\n\n  return <DataTable {PROPS} />")), "{}", out.code);

    let src = "import { DataTable } from \"@/components/data-table\"\n\nexport function Customers() { return <DataTable /> }\n";
    let out = bind_idempotent(src, FILE, &customers(src, FILE));
    assert!(
        out.code.contains(&format!("export function Customers() {{\n  {HOOK}\n\n  return <DataTable {PROPS} /> }}\n")),
        "{}",
        out.code
    );

    // A trailing comment on the `{` line stays on that line.
    let src = "import { DataTable } from \"@/components/data-table\"\n\nexport function Customers() { // eslint-disable-line\n  return <DataTable />\n}\n";
    let out = bind_idempotent(src, FILE, &customers(src, FILE));
    assert!(
        out.code.contains(&format!("export function Customers() {{ // eslint-disable-line\n  {HOOK}\n\n  return <DataTable")),
        "{}",
        out.code
    );
}

#[test]
fn semicolon_free_files_still_guard_against_asi_hazards() {
    let src = r#"import { DataTable } from "@/components/data-table"

export function Customers() {
  ;[1, 2].forEach(() => {})
  return <DataTable />
}
"#;
    // `;[` is already guarded by the user: no extra semicolon needed.
    let out = bind_idempotent(src, FILE, &customers(src, FILE));
    assert!(out.code.contains(&format!("  {HOOK}\n\n  ;[1, 2]")), "{}", out.code);

    let src = r#"import { DataTable } from "@/components/data-table"

export function Customers() {
  ;(window as any).ready = true
  return <DataTable />
}
"#;
    let out = bind_idempotent(src, FILE, &customers(src, FILE));
    assert!(out.code.contains(&format!("  {HOOK}\n\n  ;(window")), "{}", out.code);

    // First statement starting with `(` (legal right after `{`) would otherwise continue our line.
    let src = r#"import { DataTable } from "@/components/data-table"

export function Customers() {
  (globalThis as any).seen = true
  return <DataTable />
}
"#;
    let out = bind_idempotent(src, FILE, &customers(src, FILE));
    assert!(out.code.contains(&format!("  {HOOK};\n\n  (globalThis")), "{}", out.code);
}

#[test]
fn invalid_bindings_are_refused_before_any_edit() {
    type Tweak = fn(&mut QueryBinding);
    let cases: Vec<(&str, Tweak)> = vec![
        ("two arguments", |b| b.options_args = Some("{ page: 1 }, { page: 2 }".into())),
        ("closing paren", |b| b.options_args = Some("{}) || (null".into())),
        ("trailing line comment", |b| b.options_args = Some("{ page: 1 } // first".into())),
        ("not an expression", |b| b.options_args = Some("{ page: ".into())),
        ("empty args", |b| b.options_args = Some("  ".into())),
        ("optionsFn", |b| b.options_fn = "list-customers".into()),
        ("optionsImport quote", |b| b.options_import = "x\"; alert(1); \"".into()),
        ("resource", |b| b.resource = "42".into()),
        ("itemsPath", |b| b.items_path = Some("items[0]".into())),
        ("empty itemsPath", |b| b.items_path = Some(String::new())),
        ("dataProp", |b| b.data_prop = "data-ast-node".into()),
        ("loadingProp", |b| b.loading_prop = Some("{bad}".into())),
        ("same props", |b| b.loading_prop = Some("data".into())),
    ];
    for (what, edit) in cases {
        let mut binding = customers(LIST, LIST_FILE);
        edit(&mut binding);
        assert_eq!(err_code(LIST, LIST_FILE, &binding), "invalid_op", "{what}");
    }
}

#[test]
fn conflicting_bindings_for_the_imported_names_are_refused() {
    // `useQuery` from somewhere else.
    let src = r#"import { useQuery } from "@/lib/query"
import { DataTable } from "@/components/data-table"

export function Customers() {
  return <DataTable />
}
"#;
    let err = bind_query(src, FILE, &customers(src, FILE)).unwrap_err();
    assert_eq!(err.code(), "unsupported");
    assert!(err.to_string().contains("`useQuery`"), "{err}");

    // A local function with the factory's name.
    let src = r#"import { DataTable } from "@/components/data-table"

function listCustomersOptions() {
  return {}
}

export function Customers() {
  return <DataTable />
}
"#;
    assert_eq!(err_code(src, FILE, &customers(src, FILE)), "unsupported");

    // A type-only import cannot be called.
    let src = r#"import type { useQuery } from "@tanstack/react-query"
import { DataTable } from "@/components/data-table"

export function Customers() {
  return <DataTable />
}
"#;
    assert_eq!(err_code(src, FILE, &customers(src, FILE)), "unsupported");

    // Shadowed inside the component.
    let src = r#"import { DataTable } from "@/components/data-table"

export function Customers() {
  const useQuery = () => null
  return <DataTable />
}
"#;
    assert_eq!(err_code(src, FILE, &customers(src, FILE)), "unsupported");
}

#[test]
fn fragments_cannot_be_bound() {
    let src = "export function Customers() {\n  return <></>\n}\n";
    let binding = QueryBinding {
        target: "src/pages/Customers.tsx#Customers#0".into(),
        expected_name: None,
        ..customers(LIST, LIST_FILE)
    };
    assert_eq!(err_code(src, FILE, &binding), "unsupported");
}

#[test]
fn query_binding_deserializes_from_camel_case_json() {
    let json = serde_json::json!({
        "target": "src/pages/CustomerList.tsx#CustomerList#0.1",
        "optionsFn": "listCustomersOptions",
        "optionsImport": OPTIONS_IMPORT,
        "resource": "Customer",
        "itemsPath": "items",
        "dataProp": "data",
        "loadingProp": "isLoading",
    });
    let binding: QueryBinding = serde_json::from_value(json).unwrap();
    assert_eq!(binding.expected_name, None);
    assert_eq!(binding.options_args, None);
    let back = serde_json::to_value(&binding).unwrap();
    assert_eq!(back["optionsFn"], "listCustomersOptions");
    assert_eq!(back["itemsPath"], "items");
    let out = bind(LIST, LIST_FILE, &binding);
    assert!(out.code.contains(PROPS));
}

// ---------------------------------------------------------------------------------------
// optionsArgs that read the component's locals: the hook must come after their declarations
// ---------------------------------------------------------------------------------------

/// `<DataTable rows>` bound to a single-row query whose args are `args`.
fn orders(src: &str, args: &str) -> QueryBinding {
    QueryBinding {
        target: locator_of(src, FILE, "DataTable"),
        expected_name: Some("DataTable".into()),
        options_fn: "getCustomerOrdersOptions".into(),
        options_import: OPTIONS_IMPORT.into(),
        options_args: Some(args.into()),
        resource: "Order".into(),
        items_path: None,
        data_prop: "rows".into(),
        loading_prop: Some("isLoading".into()),
    }
}

const ORDER_IMPORTS: &str = "import { useQuery } from \"@tanstack/react-query\"\nimport { getCustomerOrdersOptions } from \"@/api/generated/@tanstack/react-query.gen\"\n";

/// The documented single-row shape `getXOptions({ path: { id } })`, with `id` from a hook:
/// a hook written first would read `id` in its temporal dead zone (ReferenceError on render).
#[test]
fn hook_goes_after_the_local_its_args_read() {
    let src = r#"import { useParams } from "react-router"
import { DataTable } from "@/components/data-table"

export function CustomerPage() {
  const { id } = useParams()
  return <DataTable rows={[]} />
}
"#;
    let out = bind_idempotent(src, FILE, &orders(src, "{ path: { id } }"));
    let expected = format!(
        r#"import {{ useParams }} from "react-router"
import {{ DataTable }} from "@/components/data-table"
{ORDER_IMPORTS}
export function CustomerPage() {{
  const {{ id }} = useParams()
  const {{ data: orderData, isLoading: isOrderLoading }} = useQuery({{ ...getCustomerOrdersOptions({{ path: {{ id }} }}) }})
  return <DataTable rows={{orderData ?? []}} isLoading={{isOrderLoading}} />
}}
"#
    );
    assert_eq!(out.code, expected);

    // CRLF: the hook's line break goes before the declaration's `\r\n`, not between them.
    let src = src.replace('\n', "\r\n");
    let out = bind_idempotent(&src, FILE, &orders(&src, "{ path: { id } }"));
    assert_eq!(out.code, expected.replace('\n', "\r\n"));
}

#[test]
fn hook_goes_after_the_last_declaration_its_args_read_keeping_comments_and_blank_lines() {
    let src = r#"import { useState } from "react"
import { useParams } from "react-router"
import { DataTable } from "@/components/data-table"

export function CustomerOrders() {
  const { id } = useParams()
  const [page, setPage] = useState(1) // 1-based

  const title = `Orders of ${id}`
  return <DataTable rows={[]} caption={title} onPage={setPage} />
}
"#;
    let out = bind_idempotent(src, FILE, &orders(src, "{ path: { id }, query: { page } }"));
    let expected = src
        .replacen(
            "import { DataTable } from \"@/components/data-table\"\n",
            &format!("import {{ DataTable }} from \"@/components/data-table\"\n{ORDER_IMPORTS}"),
            1,
        )
        .replacen(
            "  const [page, setPage] = useState(1) // 1-based\n",
            "  const [page, setPage] = useState(1) // 1-based\n  const { data: orderData, isLoading: isOrderLoading } = useQuery({ ...getCustomerOrdersOptions({ path: { id }, query: { page } }) })\n",
            1,
        )
        .replacen("rows={[]}", "rows={orderData ?? []}", 1)
        .replacen("onPage={setPage} />", "onPage={setPage} isLoading={isOrderLoading} />", 1);
    assert_eq!(out.code, expected);
}

#[test]
fn semicolon_files_and_same_line_statements_after_the_declaration() {
    // `;` style follows the file; code on the declaration's line moves to the next line.
    let src = "import { DataTable } from \"@/components/data-table\";\n\nexport function CustomerPage() {\n  const id = useId(); return <DataTable rows={[]} />;\n}\n";
    let out = bind_idempotent(src, FILE, &orders(src, "{ path: { id } }"));
    assert!(
        out.code.contains(
            "  const id = useId();\n  const { data: orderData, isLoading: isOrderLoading } = useQuery({ ...getCustomerOrdersOptions({ path: { id } }) });\n  return <DataTable rows={orderData ?? []} isLoading={isOrderLoading} />;\n"
        ),
        "{}",
        out.code
    );
}

#[test]
fn props_module_values_hoisted_functions_and_the_args_own_bindings_keep_the_hook_first() {
    // `tag` is declared only in a nested callback of the component, but the args bind their
    // own `tag`; `firstPage` is a hoisted function declaration; `tags` is a prop.
    let src = r#"import { DataTable } from "@/components/data-table"

const PAGE_SIZE = 20

export function Customers({ tags }: { tags: string[] }) {
  return (
    <div>
      {tags.map((tag) => <span key={tag}>{tag}</span>)}
      <DataTable data={[]} />
    </div>
  )

  function firstPage() {
    return 1
  }
}
"#;
    let mut binding = customers(src, FILE);
    binding.options_args =
        Some("{ query: { page: firstPage(), pageSize: PAGE_SIZE, tags: tags.map((tag) => tag.trim()) } }".into());
    let out = bind_idempotent(src, FILE, &binding);
    assert!(
        out.code.contains(
            "export function Customers({ tags }: { tags: string[] }) {\n  const { data: customerData, isLoading: isCustomerLoading } = useQuery({ ...listCustomersOptions({ query: { page: firstPage(), pageSize: PAGE_SIZE, tags: tags.map((tag) => tag.trim()) } }) })\n\n  return (\n"
        ),
        "{}",
        out.code
    );
}

#[test]
fn generated_names_never_shadow_a_name_the_args_read() {
    // `customerData` here is a global the args read; declaring it would read itself (TDZ).
    let src = "import { DataTable } from \"@/components/data-table\"\n\nexport function Customers() {\n  return <DataTable />\n}\n";
    let mut binding = customers(src, FILE);
    binding.options_args = Some("{ query: { cursor: customerData } }".into());
    let out = bind_idempotent(src, FILE, &binding);
    assert!(
        out.code.contains("const { data: customerData2, isLoading: isCustomerLoading2 } = useQuery({ ...listCustomersOptions({ query: { cursor: customerData } }) })"),
        "{}",
        out.code
    );
}

/// The error for `binding`, which must be `unsupported` and mention every `needles`.
fn refused(src: &str, binding: &QueryBinding, needles: &[&str]) {
    let err = match bind_query(src, FILE, binding) {
        Ok(out) => panic!("expected a refusal, got:\n{}", out.code),
        Err(e) => e,
    };
    assert_eq!(err.code(), "unsupported", "{err}");
    for needle in needles {
        assert!(err.to_string().contains(needle), "{needle:?} missing from: {err}");
    }
}

#[test]
fn args_reading_a_local_declared_after_an_early_return_are_refused() {
    // After the declaration, the hook would only run when `ready` is true: rules of hooks.
    let src = r#"import { useParams } from "react-router"
import { DataTable } from "@/components/data-table"

export function CustomerPage({ ready }: { ready: boolean }) {
  if (!ready) {
    return null
  }
  const { id } = useParams()
  return <DataTable rows={[]} />
}
"#;
    refused(src, &orders(src, "{ path: { id } }"), &["`id`", "return", "rules of hooks"]);

    // A `return` nested in a callback is not an early return of the component.
    let src = r#"import { useParams } from "react-router"
import { DataTable } from "@/components/data-table"

export function CustomerPage() {
  const onRow = (row: { id: string }) => {
    return row.id
  }
  const { id } = useParams()
  return <DataTable rows={[]} onRow={onRow} />
}
"#;
    let out = bind_idempotent(src, FILE, &orders(src, "{ path: { id } }"));
    assert!(out.code.contains("  const { id } = useParams()\n  const { data: orderData"), "{}", out.code);
}

#[test]
fn args_reading_a_name_only_declared_in_a_nested_scope_are_refused() {
    let src = r#"import { DataTable } from "@/components/data-table"

export function Regions({ regions }: { regions: string[] }) {
  return (
    <div>
      {regions.map((region) => {
        return <DataTable key={region} rows={[]} />
      })}
    </div>
  )
}
"#;
    refused(src, &orders(src, "{ path: { region } }"), &["`region`", "nested"]);

    // Same through a concise arrow body.
    let src = r#"import { DataTable } from "@/components/data-table"

export const Regions = ({ regions }: { regions: string[] }) => (
  <div>{regions.map((region) => <DataTable key={region} rows={[]} />)}</div>
)
"#;
    refused(src, &orders(src, "{ path: { region } }"), &["`region`", "nested"]);
}

#[test]
fn args_reading_a_local_declared_after_the_element_are_refused() {
    // The element (and so its props reading the hook's names) is evaluated before `id` exists.
    let src = r#"import { useParams } from "react-router"
import { DataTable } from "@/components/data-table"

export function CustomerPage() {
  const table = <DataTable rows={[]} />
  const { id } = useParams()
  return <section data-id={id}>{table}</section>
}
"#;
    refused(src, &orders(src, "{ path: { id } }"), &["`id`", "<DataTable>"]);
}

#[test]
fn deeply_nested_or_huge_options_args_are_refused_before_parsing() {
    // Each of these used to recurse once per level in the parser: at this size, the
    // process dies of a stack overflow instead of answering.
    let deep_brackets = format!("{}{}", "[".repeat(200_000), "]".repeat(200_000));
    let deep_objects = format!("{}1{}", "{ a: ".repeat(300), " }".repeat(300));
    let deep_templates = format!("{}1{}", "`${".repeat(300), "}`".repeat(300));
    let long_chain = format!("{}1", "x = ".repeat(100_000));
    for (what, args) in [
        ("brackets", deep_brackets),
        ("objects", deep_objects),
        ("templates", deep_templates),
        ("assignment chain", long_chain),
    ] {
        let mut binding = customers(LIST, LIST_FILE);
        binding.options_args = Some(args);
        let err = bind_query(LIST, LIST_FILE, &binding).unwrap_err();
        assert_eq!(err.code(), "invalid_op", "{what}: {err}");
        assert!(err.to_string().len() < 400, "{what}: the message must not echo the whole input: {err}");
    }

    // Brackets inside strings and comments are text, not nesting.
    let mut binding = customers(LIST, LIST_FILE);
    let parens = "(".repeat(300);
    binding.options_args = Some(format!("{{ query: {{ q: \"{parens}\", r: '{parens}' /* {parens} */ }} }}"));
    assert!(bind(LIST, LIST_FILE, &binding).changed);
}

/// `bindQuery` is part of the `Op` vocabulary, so it shares the HTTP API, batches and undo.
#[test]
fn bind_query_round_trips_through_the_op_json_wire_format() {
    let src = include_str!("fixtures/data/CustomerList.tsx");
    let file = "src/pages/CustomerList.tsx";
    let target = trivia_oxc_engine::annotate(src, file)
        .unwrap()
        .into_iter()
        .find(|i| src[..i.offset as usize].ends_with("<DataTable"))
        .map(|i| i.text.trim().trim_start_matches("data-ast-node=\"").trim_end_matches('"').to_string())
        .expect("fixture has a <DataTable>");
    let json = serde_json::json!({
        "op": "bindQuery",
        "target": target,
        "expectedName": "DataTable",
        "optionsFn": "listCustomersOptions",
        "optionsImport": "@/api/generated/@tanstack/react-query.gen",
        "optionsArgs": "{ query: { page: 1, pageSize: 20 } }",
        "resource": "Customer",
        "itemsPath": "items",
        "dataProp": "data",
        "loadingProp": "isLoading"
    });
    let op: trivia_oxc_engine::Op = serde_json::from_value(json.clone()).expect("bindQuery deserializes as an Op");
    assert_eq!(op.file().unwrap(), file);
    assert_eq!(serde_json::to_value(&op).unwrap(), json, "serializes back to the same wire shape");
    let via_op = trivia_oxc_engine::apply_op(src, file, &op).unwrap();
    let trivia_oxc_engine::Op::BindQuery(binding) = &op else { unreachable!() };
    let direct = trivia_oxc_engine::bind_query(src, file, binding).unwrap();
    assert!(via_op.changed);
    assert_eq!(via_op.code, direct.code);
}
