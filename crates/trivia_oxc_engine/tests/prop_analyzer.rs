//! Prop-schema extraction against the playground's real shadcn components (`fixtures/ui`, copied
//! verbatim from `examples/playground/src/components/ui`), hand-written pre-v4 shadcn
//! (`fixtures/ui-legacy`: `*Props` interfaces + `forwardRef`), and inline edge cases.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use trivia_oxc_engine::prop_analyzer::analyze;
use trivia_oxc_engine::{ComponentSchema, EngineError, PropKind, PropSchema, PropSource, Workspace};

const UI_DIR: &str = "src/components/ui";

fn fixtures(dir: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(dir)
}

/// Analyze `fixtures/<dir>/<stem>.tsx` as the project file `src/components/ui/<stem>.tsx`.
fn analyze_fixture(dir: &str, stem: &str) -> Vec<ComponentSchema> {
    let src = fs::read_to_string(fixtures(dir).join(format!("{stem}.tsx"))).unwrap();
    analyze(&src, &format!("{UI_DIR}/{stem}.tsx"), &format!("@/components/ui/{stem}")).unwrap()
}

/// Analyze inline source as `src/components/ui/x.tsx`.
fn analyze_src(src: &str) -> Vec<ComponentSchema> {
    analyze(src, "src/components/ui/x.tsx", "@/components/ui/x").unwrap_or_else(|e| panic!("{e}"))
}

fn names(schemas: &[ComponentSchema]) -> Vec<&str> {
    schemas.iter().map(|c| c.name.as_str()).collect()
}

fn find<'s>(schemas: &'s [ComponentSchema], name: &str) -> &'s ComponentSchema {
    schemas.iter().find(|c| c.name == name).unwrap_or_else(|| panic!("no {name} in {:?}", names(schemas)))
}

/// Exact shape of one component (name/file/importSource are checked separately).
#[track_caller]
fn assert_schema(c: &ComponentSchema, base: Option<&str>, accepts_children: bool, props: Vec<PropSchema>) {
    assert_eq!(c.base_element.as_deref(), base, "{}: baseElement", c.name);
    assert_eq!(c.accepts_children, accepts_children, "{}: acceptsChildren", c.name);
    assert_eq!(c.props, props, "{}: props", c.name);
    assert!(c.unresolved_types.is_empty(), "{}: unresolved {:?}", c.name, c.unresolved_types);
}

fn options(values: &[&str]) -> PropKind {
    PropKind::Enum { options: values.iter().map(|v| (*v).to_string()).collect() }
}

fn unknown(type_text: &str) -> PropKind {
    PropKind::Unknown { type_text: type_text.to_string() }
}

fn prop(name: &str, kind: PropKind, source: PropSource) -> PropSchema {
    PropSchema { name: name.to_string(), kind, optional: true, default: None, source }
}

fn variant(name: &str, values: &[&str]) -> PropSchema {
    prop(name, options(values), PropSource::Variant)
}

fn declared(name: &str, kind: PropKind) -> PropSchema {
    prop(name, kind, PropSource::Declared)
}

fn intrinsic(name: &str, kind: PropKind) -> PropSchema {
    prop(name, kind, PropSource::Intrinsic)
}

fn class_name() -> PropSchema {
    intrinsic("className", PropKind::ClassName)
}

trait PropExt {
    fn with_default(self, value: impl Into<Value>) -> Self;
    fn required(self) -> Self;
}

impl PropExt for PropSchema {
    fn with_default(self, value: impl Into<Value>) -> Self {
        Self { default: Some(value.into()), ..self }
    }

    fn required(self) -> Self {
        Self { optional: false, ..self }
    }
}

const INPUT_TYPES: &[&str] = &[
    "text", "email", "password", "number", "search", "tel", "url", "date", "time", "datetime-local", "month", "week",
    "color", "file", "range", "checkbox", "radio", "hidden",
];

fn input_props() -> Vec<PropSchema> {
    use PropKind::{Boolean, String};
    vec![
        intrinsic("type", options(INPUT_TYPES)),
        intrinsic("placeholder", String),
        intrinsic("disabled", Boolean),
        intrinsic("id", String),
        intrinsic("name", String),
        class_name(),
    ]
}

fn radix_toggle_props() -> Vec<PropSchema> {
    vec![
        intrinsic("disabled", PropKind::Boolean),
        intrinsic("defaultChecked", PropKind::Boolean),
        intrinsic("id", PropKind::String),
    ]
}

// ── shadcn v4 (playground) ──────────────────────────────────────────────────────────────────

#[test]
fn button_reads_cva_variants_destructuring_defaults_and_button_attributes() {
    let schemas = analyze_fixture("ui", "button");
    assert_eq!(names(&schemas), ["Button"], "buttonVariants is not a component");
    let button = &schemas[0];
    assert_eq!(button.file, "src/components/ui/button.tsx");
    assert_eq!(button.import_source, "@/components/ui/button");
    assert_schema(button, Some("button"), true, vec![
        variant("variant", &["default", "outline", "secondary", "ghost", "destructive", "link"]).with_default("default"),
        variant("size", &["default", "xs", "sm", "lg", "icon", "icon-xs", "icon-sm", "icon-lg"]).with_default("default"),
        declared("asChild", PropKind::Boolean).with_default(false),
        intrinsic("type", options(&["button", "submit", "reset"])),
        intrinsic("disabled", PropKind::Boolean),
        class_name(),
    ]);
}

/// The wire format the designer's `bridge/types.ts` mirrors.
#[test]
fn schema_serializes_as_the_bridge_contract() {
    let badge = &analyze_fixture("ui", "badge")[0];
    assert_eq!(serde_json::to_value(badge).unwrap(), json!({
        "name": "Badge",
        "file": "src/components/ui/badge.tsx",
        "importSource": "@/components/ui/badge",
        "baseElement": "span",
        "acceptsChildren": true,
        "props": [
            { "name": "variant", "kind": "enum",
              "options": ["default", "secondary", "destructive", "outline", "ghost", "link"],
              "optional": true, "default": "default", "source": "variant" },
            { "name": "asChild", "kind": "boolean", "optional": true, "default": false, "source": "declared" },
            { "name": "className", "kind": "className", "optional": true, "source": "intrinsic" },
        ],
    }));
    let unresolved = &analyze_src(
        "import type { P } from './p'\nexport function X({ title }: P) { return <div>{title}</div> }\n",
    )[0];
    let json = serde_json::to_value(unresolved).unwrap();
    assert_eq!(json["unresolvedTypes"], json!(["P"]));
    assert_eq!(json["props"][0], json!({
        "name": "title", "kind": "unknown", "typeText": "P[\"title\"]", "optional": true, "source": "intrinsic",
    }));
}

#[test]
fn badge() {
    let schemas = analyze_fixture("ui", "badge");
    assert_eq!(names(&schemas), ["Badge"]);
    assert_schema(&schemas[0], Some("span"), true, vec![
        variant("variant", &["default", "secondary", "destructive", "outline", "ghost", "link"]).with_default("default"),
        declared("asChild", PropKind::Boolean).with_default(false),
        class_name(),
    ]);
}

#[test]
fn card_parts_in_source_order_not_export_order() {
    let schemas = analyze_fixture("ui", "card");
    // `export { Card, CardHeader, CardFooter, CardTitle, … }` lists them in another order.
    assert_eq!(names(&schemas), [
        "Card", "CardHeader", "CardTitle", "CardDescription", "CardAction", "CardContent", "CardFooter",
    ]);
    assert_schema(&schemas[0], Some("div"), true, vec![
        declared("size", options(&["default", "sm"])).with_default("default"),
        class_name(),
    ]);
    for part in &schemas[1..] {
        assert_eq!(part.import_source, "@/components/ui/card");
        assert_schema(part, Some("div"), true, vec![class_name()]);
    }
}

#[test]
fn input_is_void_with_curated_input_attributes() {
    let schemas = analyze_fixture("ui", "input");
    assert_eq!(names(&schemas), ["Input"]);
    assert_schema(&schemas[0], Some("input"), false, input_props());
}

#[test]
fn textarea() {
    use PropKind::{Boolean, Number, String};
    let schemas = analyze_fixture("ui", "textarea");
    assert_eq!(names(&schemas), ["Textarea"]);
    assert_schema(&schemas[0], Some("textarea"), false, vec![
        intrinsic("placeholder", String),
        intrinsic("disabled", Boolean),
        intrinsic("rows", Number),
        intrinsic("id", String),
        class_name(),
    ]);
}

#[test]
fn switch_resolves_the_radix_primitive_from_the_radix_ui_import() {
    let schemas = analyze_fixture("ui", "switch");
    assert_eq!(names(&schemas), ["Switch"]);
    let mut props = vec![declared("size", options(&["sm", "default"])).with_default("default")];
    props.extend(radix_toggle_props());
    props.push(class_name());
    assert_schema(&schemas[0], Some("SwitchPrimitive.Root"), false, props);
}

#[test]
fn checkbox() {
    let schemas = analyze_fixture("ui", "checkbox");
    assert_eq!(names(&schemas), ["Checkbox"]);
    let mut props = radix_toggle_props();
    props.push(class_name());
    assert_schema(&schemas[0], Some("CheckboxPrimitive.Root"), false, props);
}

#[test]
fn label() {
    let schemas = analyze_fixture("ui", "label");
    assert_eq!(names(&schemas), ["Label"]);
    assert_schema(&schemas[0], Some("LabelPrimitive.Root"), true, vec![
        intrinsic("htmlFor", PropKind::String),
        class_name(),
    ]);
}

#[test]
fn separator_takes_defaults_from_destructuring() {
    let schemas = analyze_fixture("ui", "separator");
    assert_eq!(names(&schemas), ["Separator"]);
    assert_schema(&schemas[0], Some("SeparatorPrimitive.Root"), false, vec![
        intrinsic("orientation", options(&["horizontal", "vertical"])).with_default("horizontal"),
        intrinsic("decorative", PropKind::Boolean).with_default(true),
        class_name(),
    ]);
}

#[test]
fn select_exports_every_part() {
    use PropKind::{Boolean, String};
    let schemas = analyze_fixture("ui", "select");
    assert_eq!(names(&schemas), [
        "Select",
        "SelectGroup",
        "SelectValue",
        "SelectTrigger",
        "SelectContent",
        "SelectLabel",
        "SelectItem",
        "SelectSeparator",
        "SelectScrollUpButton",
        "SelectScrollDownButton",
    ]);
    let part = |name| find(&schemas, name);
    // Root is a context provider: no DOM node, so no className.
    assert_schema(part("Select"), Some("SelectPrimitive.Root"), true, vec![
        intrinsic("defaultValue", String),
        intrinsic("disabled", Boolean),
    ]);
    assert_schema(part("SelectGroup"), Some("SelectPrimitive.Group"), true, vec![class_name()]);
    assert_schema(part("SelectValue"), Some("SelectPrimitive.Value"), true, vec![
        intrinsic("placeholder", String),
        class_name(),
    ]);
    assert_schema(part("SelectTrigger"), Some("SelectPrimitive.Trigger"), true, vec![
        declared("size", options(&["sm", "default"])).with_default("default"),
        class_name(),
    ]);
    assert_schema(part("SelectContent"), Some("SelectPrimitive.Content"), true, vec![
        intrinsic("position", options(&["item-aligned", "popper"])).with_default("item-aligned"),
        intrinsic("align", options(&["start", "center", "end"])).with_default("center"),
        class_name(),
    ]);
    assert_schema(part("SelectLabel"), Some("SelectPrimitive.Label"), true, vec![class_name()]);
    assert_schema(part("SelectItem"), Some("SelectPrimitive.Item"), true, vec![
        intrinsic("value", String).required(),
        intrinsic("disabled", Boolean),
        class_name(),
    ]);
    assert_schema(part("SelectSeparator"), Some("SelectPrimitive.Separator"), false, vec![class_name()]);
    assert_schema(part("SelectScrollUpButton"), Some("SelectPrimitive.ScrollUpButton"), true, vec![class_name()]);
    assert_schema(part("SelectScrollDownButton"), Some("SelectPrimitive.ScrollDownButton"), true, vec![class_name()]);
}

// ── pre-v4 shadcn: `*Props` interfaces + `forwardRef` ───────────────────────────────────────

#[test]
fn legacy_button_reads_the_props_interface_through_forward_ref() {
    let schemas = analyze_fixture("ui-legacy", "button");
    assert_eq!(names(&schemas), ["Button"], "the ButtonProps interface and buttonVariants are skipped");
    assert_schema(&schemas[0], Some("button"), true, vec![
        // `variant`/`size` are destructured without defaults: `defaultVariants` supplies them.
        variant("variant", &["default", "destructive", "outline", "secondary", "ghost", "link"]).with_default("default"),
        variant("size", &["default", "sm", "lg", "icon"]).with_default("default"),
        declared("asChild", PropKind::Boolean).with_default(false),
        intrinsic("type", options(&["button", "submit", "reset"])),
        intrinsic("disabled", PropKind::Boolean),
        class_name(),
    ]);
}

#[test]
fn legacy_input_extends_input_html_attributes() {
    let schemas = analyze_fixture("ui-legacy", "input");
    assert_eq!(names(&schemas), ["Input"]);
    assert_schema(&schemas[0], Some("input"), false, input_props());
}

#[test]
fn legacy_card_parts() {
    let schemas = analyze_fixture("ui-legacy", "card");
    assert_eq!(names(&schemas), ["Card", "CardHeader", "CardTitle", "CardDescription", "CardContent", "CardFooter"]);
    for part in &schemas {
        // `HTMLAttributes<HTMLHeadingElement>` is shared by h1–h6: the tag is unknown.
        let base = match part.name.as_str() {
            "CardTitle" => None,
            "CardDescription" => Some("p"),
            _ => Some("div"),
        };
        assert_schema(part, base, true, vec![class_name()]);
    }
}

#[test]
fn legacy_switch_resolves_a_namespace_radix_import() {
    let schemas = analyze_fixture("ui-legacy", "switch");
    assert_eq!(names(&schemas), ["Switch"]);
    let mut props = radix_toggle_props();
    props.push(class_name());
    assert_schema(&schemas[0], Some("SwitchPrimitives.Root"), false, props);
}

// ── what counts as a component ──────────────────────────────────────────────────────────────

#[test]
fn only_exported_capitalized_function_components() {
    use PropKind::{Boolean, Number, String};
    let schemas = analyze_src(
        r#"import * as React from "react"
import { forwardRef, memo } from "react"
import { cva } from "class-variance-authority"

export function A({ title }: { title?: string }) { return <h2>{title}</h2> }
export const B = ({ count = 1 }: { count?: number }) => <span>{count}</span>
export const C = function ({ open }: { open?: boolean }) { return open ? <i /> : null }
export const D = React.memo(React.forwardRef<HTMLDivElement, { label?: string }>((props, ref) => <div ref={ref} {...props} />))

interface RenderProps { tone?: "a" | "b" }
function Render(props: RenderProps, ref: React.Ref<HTMLDivElement>) { return <div ref={ref} {...props} /> }
export const E = forwardRef(Render)

interface FProps { heading: string }
const F: React.FC<FProps> = ({ heading }) => <h1>{heading}</h1>
const G = memo(function G({ size }: { size?: "s" | "m" }) { return <b>{size}</b> })

export function useThing() { return 1 }
export function lower() { return <div /> }
export const thingVariants = cva("", { variants: { tone: { a: "", b: "" } } })
export const SIZES = ["s", "m"]
export class Klass extends React.Component { render() { return <div /> } }
export default function Default() { return <div /> }
function NotExported() { return <div /> }
export function* Gen() {}
export type T = { a: string }

export { F as Renamed, G }
"#,
    );
    assert_eq!(names(&schemas), ["A", "B", "C", "D", "E", "Renamed", "G"]);
    assert_eq!(find(&schemas, "A").props, [declared("title", String)]);
    assert_eq!(find(&schemas, "B").props, [declared("count", Number).with_default(1)]);
    assert_eq!(find(&schemas, "C").props, [declared("open", Boolean)]);
    assert_eq!(find(&schemas, "D").props, [declared("label", String)]);
    assert_eq!(find(&schemas, "E").props, [declared("tone", options(&["a", "b"]))]);
    assert_eq!(find(&schemas, "Renamed").props, [declared("heading", String).required()]);
    assert_eq!(find(&schemas, "G").props, [declared("size", options(&["s", "m"]))]);
}

#[test]
fn untyped_destructuring_is_the_declaration() {
    use PropKind::{Boolean, Number, String};
    let schemas = analyze_src(
        "export function Plain({ className, label, count = 2, on = false, mode = 'a', ...rest }) {\n  return <div className={className} {...rest}>{label}</div>\n}\n",
    );
    assert_schema(&schemas[0], None, true, vec![
        declared("label", unknown("any")),
        declared("count", Number).with_default(2),
        declared("on", Boolean).with_default(false),
        declared("mode", String).with_default("a"),
        declared("className", PropKind::ClassName),
    ]);
}

#[test]
fn accepts_children_follows_the_base_and_the_props_parameter() {
    let schemas = analyze_src(
        r#"import * as React from "react"
export function Dot() { return <span /> }
export function Spinner({ className }: { className?: string }) { return <span className={className} /> }
export function Wrap({ className, children }: { className?: string; children?: React.ReactNode }) { return <div className={className}>{children}</div> }
export function Box(props: React.ComponentProps<"div">) { return <div {...props} /> }
export function Pic({ className, ...props }: React.ComponentProps<"img">) { return <img className={className} {...props} /> }
export function Rule(props: React.HTMLAttributes<HTMLHRElement>) { return <hr {...props} /> }
"#,
    );
    let accepts: Vec<(&str, bool)> = schemas.iter().map(|c| (c.name.as_str(), c.accepts_children)).collect();
    assert_eq!(accepts, [
        ("Dot", false),
        ("Spinner", false),
        ("Wrap", true),
        ("Box", true),
        ("Pic", false),
        ("Rule", false),
    ]);
    assert_eq!(find(&schemas, "Pic").props, [
        intrinsic("src", PropKind::String),
        intrinsic("alt", PropKind::String),
        class_name(),
    ]);
    assert_eq!(find(&schemas, "Wrap").props, [declared("className", PropKind::ClassName)]);
}

// ── type resolution ─────────────────────────────────────────────────────────────────────────

#[test]
fn classifies_declared_types() {
    use PropKind::{Boolean, Number, String};
    let schemas = analyze_src(
        r#"import * as React from "react"
type Tone = "info" | "warn"
type Size = ("s" | "m") | null
interface BaseProps { id?: string }
interface Props extends BaseProps {
  tone?: Tone | undefined
  size?: Size
  open: true | false
  checked?: boolean | "indeterminate"
  count?: number
  label: string
  onPick?(value: string): void
  render?: () => React.ReactNode
  untyped
  "aria-label"?: string
  children?: React.ReactNode
  ref?: React.Ref<HTMLDivElement>
  key?: string
  className: string
}
export function Panel({ tone = "warn", ...props }: Props) { return <div {...props} /> }
"#,
    );
    assert_schema(&schemas[0], None, true, vec![
        declared("id", String),
        declared("tone", options(&["info", "warn"])).with_default("warn"),
        declared("size", options(&["s", "m"])),
        declared("open", Boolean).required(),
        declared("checked", unknown("boolean | \"indeterminate\"")),
        declared("count", Number),
        declared("label", String).required(),
        declared("onPick", unknown("onPick?(value: string): void")),
        declared("render", unknown("() => React.ReactNode")),
        declared("untyped", unknown("any")).required(),
        declared("aria-label", String),
        // children/ref/key are structure, not inspector props.
        declared("className", PropKind::ClassName).required(),
    ]);
}

#[test]
fn utility_types_and_local_aliases() {
    use PropKind::String;
    let schemas = analyze_src(
        r#"import * as React from "react"
interface FieldProps { label: string; hint?: string; size?: "sm" | "lg"; tone?: "a" | "b" }
type Other = { x: string }
export function Field(props: Omit<FieldProps, "hint" | "tone"> & Partial<Pick<FieldProps, "label">>) { return <label {...props} /> }
export function Strict(props: Required<Pick<FieldProps, "size">>) { return <i {...props} /> }
export function Loose(props: Omit<FieldProps, keyof Other>) { return <i {...props} /> }
"#,
    );
    let field = find(&schemas, "Field");
    assert_eq!(field.props, [
        declared("label", String).required(),
        declared("size", options(&["sm", "lg"])),
        // `Partial<Pick<…, "label">>`: the duplicate keeps the first (required) one.
    ]);
    assert!(field.unresolved_types.is_empty());
    assert_eq!(find(&schemas, "Strict").props, [declared("size", options(&["sm", "lg"])).required()]);
    let loose = find(&schemas, "Loose");
    assert_eq!(loose.props.len(), 4, "unreadable keys keep every prop");
    assert_eq!(loose.unresolved_types, ["Omit<FieldProps, keyof Other>"]);
}

#[test]
fn pick_from_an_imported_component_types_each_key_honestly() {
    // shadcn's pagination: `Pick<React.ComponentProps<typeof Button>, "size"> & React.ComponentProps<"a">`
    let schemas = analyze_src(
        r#"import * as React from "react"
import { Button } from "@/components/ui/button"
type PaginationLinkProps = { isActive?: boolean } & Pick<React.ComponentProps<typeof Button>, "size"> & React.ComponentProps<"a">
function PaginationLink({ className, isActive, size = "icon", ...props }: PaginationLinkProps) {
  return <a data-active={isActive} className={className} {...props} />
}
export { PaginationLink }
"#,
    );
    assert_schema(&schemas[0], Some("a"), true, vec![
        declared("isActive", PropKind::Boolean),
        intrinsic("size", unknown("React.ComponentProps<typeof Button>[\"size\"]")).with_default("icon"),
        intrinsic("href", PropKind::String),
        intrinsic("target", PropKind::String),
        class_name(),
    ]);
}

#[test]
fn component_props_of_a_local_component_reuse_its_type() {
    let schemas = analyze_src(
        r#"import * as React from "react"
function Base({ tone, ...props }: React.ComponentProps<"button"> & { tone?: "a" | "b" }) { return <button {...props} /> }
export function Derived({ className, ...props }: React.ComponentProps<typeof Base>) { return <Base className={className} {...props} /> }
export function SelfRef(props: React.ComponentProps<typeof SelfRef>) { return <div {...props} /> }
"#,
    );
    assert_eq!(names(&schemas), ["Derived", "SelfRef"]);
    assert_schema(find(&schemas, "Derived"), Some("button"), true, vec![
        declared("tone", options(&["a", "b"])),
        intrinsic("type", options(&["button", "submit", "reset"])),
        intrinsic("disabled", PropKind::Boolean),
        class_name(),
    ]);
    // A component typed by its own props is a cycle: listed, not looped on.
    assert_eq!(find(&schemas, "SelfRef").unresolved_types, ["React.ComponentProps<typeof SelfRef>"]);
}

#[test]
fn cyclic_and_deep_types_terminate() {
    use PropKind::{Boolean, Number, String};
    let deep = format!("{}{{ deep?: string }}{}", "(".repeat(40), ")".repeat(40));
    let schemas = analyze_src(&format!(
        "type A = B & {{ a?: string }}
type B = A & {{ b?: boolean }}
interface I extends J {{ i?: number }}
interface J extends I {{ j?: string }}
type Deep = {deep}
export function Cyclic(props: A) {{ return <div {{...props}} /> }}
export function Inherit(props: I) {{ return <div {{...props}} /> }}
export function Nested(props: Deep) {{ return <div {{...props}} /> }}
"
    ));
    assert_eq!(find(&schemas, "Cyclic").props, [declared("b", Boolean), declared("a", String)]);
    assert_eq!(find(&schemas, "Inherit").props, [declared("j", String), declared("i", Number)]);
    let nested = find(&schemas, "Nested");
    assert!(nested.props.is_empty());
    assert_eq!(nested.unresolved_types.len(), 1, "too deep is reported, not dropped");
}

#[test]
fn fan_out_alias_graph_is_bounded() {
    // Seven levels of 16-way intersections (within MAX_DEPTH): 16^7 ≈ 2.7e8 leaf expansions
    // without a step budget.
    let mut src = std::string::String::new();
    for level in 0..7 {
        let next = vec![format!("T{}", level + 1); 16].join(" & ");
        src.push_str(&format!("type T{level} = {next}\n"));
    }
    src.push_str("type T7 = { leaf?: string }\nexport function Wide(props: T0) { return <div {...props} /> }\n");
    let started = Instant::now();
    let schemas = analyze_src(&src);
    assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
    let wide = &schemas[0];
    assert_eq!(wide.props, [declared("leaf", PropKind::String)]);
    assert!(!wide.unresolved_types.is_empty(), "a spent budget is reported");
}

// ── variants and precedence ─────────────────────────────────────────────────────────────────

#[test]
fn precedence_is_declared_then_variant_then_intrinsic() {
    let schemas = analyze_src(
        r#"import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
const config = {
  variants: {
    disabled: { true: "opacity-50", false: "" },
    size: { sm: "h-7", lg: "h-9" },
    tone: { quiet: "", loud: "" },
  },
  defaultVariants: { disabled: "false", size: "sm", tone: "loud" },
}
const toggleVariants = cva("base", config)
const fallbackTone = "quiet"
function Toggle({
  className,
  size = "lg",
  tone = fallbackTone,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof toggleVariants> & { size?: "sm" | "md" | "lg" }) {
  return <button className={className} {...props} />
}
export { Toggle }
"#,
    );
    assert_schema(&schemas[0], Some("button"), true, vec![
        // A boolean cva variant shadows the intrinsic `disabled`; `"false"` becomes `false`.
        prop("disabled", PropKind::Boolean, PropSource::Variant).with_default(false),
        // A non-literal destructuring default hides `defaultVariants`.
        variant("tone", &["quiet", "loud"]),
        // The declared `size` replaces the variant one; the destructuring default wins.
        declared("size", options(&["sm", "md", "lg"])).with_default("lg"),
        intrinsic("type", options(&["button", "submit", "reset"])),
        class_name(),
    ]);
}

#[test]
fn unexpanded_types_are_reported_and_destructured_props_still_listed() {
    let schemas = analyze_src(
        r#"import type { ButtonProps } from "./types"
import { buttonVariants } from "./variants"
import { type VariantProps } from "class-variance-authority"
export function Imported({ className, variant, tone = "info", ...props }: ButtonProps & VariantProps<typeof buttonVariants>) {
  return <button className={className} {...props} />
}
"#,
    );
    let c = &schemas[0];
    assert_eq!(c.unresolved_types, ["ButtonProps", "VariantProps<typeof buttonVariants>"]);
    assert_eq!(c.base_element, None);
    assert!(c.accepts_children);
    assert_eq!(c.props, [
        intrinsic("variant", unknown("(ButtonProps & VariantProps<typeof buttonVariants>)[\"variant\"]")),
        intrinsic("tone", PropKind::String).with_default("info"),
        class_name(),
    ]);
}

#[test]
fn radix_curated_parts_and_destructured_extras() {
    use PropKind::{Boolean, Number, String};
    let schemas = analyze_src(
        r#"import * as React from "react"
import { Slider as SliderPrimitive, Tabs as TabsPrimitive } from "radix-ui"
import * as AccordionPrimitive from "@radix-ui/react-accordion"
function Slider({ className, defaultValue, value, min = 0, max = 100, ...props }: React.ComponentProps<typeof SliderPrimitive.Root>) {
  return <SliderPrimitive.Root className={className} min={min} max={max} {...props} />
}
function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger className={className} {...props} />
}
function Accordion({ ...props }: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root {...props} />
}
export { Slider, TabsTrigger, Accordion }
"#,
    );
    let slider_props = "React.ComponentProps<typeof SliderPrimitive.Root>";
    assert_schema(find(&schemas, "Slider"), Some("SliderPrimitive.Root"), false, vec![
        intrinsic("min", Number).with_default(0),
        intrinsic("max", Number).with_default(100),
        intrinsic("step", Number),
        intrinsic("disabled", Boolean),
        intrinsic("orientation", options(&["horizontal", "vertical"])),
        intrinsic("defaultValue", unknown(&format!("{slider_props}[\"defaultValue\"]"))),
        intrinsic("value", unknown(&format!("{slider_props}[\"value\"]"))),
        class_name(),
    ]);
    assert_schema(find(&schemas, "TabsTrigger"), Some("TabsPrimitive.Trigger"), true, vec![
        intrinsic("value", String).required(),
        intrinsic("disabled", Boolean),
        class_name(),
    ]);
    assert_schema(find(&schemas, "Accordion"), Some("AccordionPrimitive.Root"), true, vec![
        intrinsic("type", options(&["single", "multiple"])).required(),
        intrinsic("collapsible", Boolean),
        intrinsic("disabled", Boolean),
        class_name(),
    ]);
}

// ── errors and determinism ──────────────────────────────────────────────────────────────────

#[test]
fn parse_errors_are_returned() {
    let err = analyze("export function Broken( {", "src/components/ui/broken.tsx", "@/components/ui/broken").unwrap_err();
    assert!(matches!(&err, EngineError::Parse { file, .. } if file == "src/components/ui/broken.tsx"), "{err}");
    assert_eq!(err.code(), "parse_error");
}

#[test]
fn output_is_deterministic() {
    let src = fs::read_to_string(fixtures("ui").join("select.tsx")).unwrap();
    let first = analyze(&src, "src/components/ui/select.tsx", "@/components/ui/select").unwrap();
    for _ in 0..5 {
        assert_eq!(analyze(&src, "src/components/ui/select.tsx", "@/components/ui/select").unwrap(), first);
    }
}

// ── Workspace::components ───────────────────────────────────────────────────────────────────

/// A scratch project under Cargo's per-test tmp dir, removed on drop (also on failure).
struct TempProject(PathBuf);

impl TempProject {
    fn new(name: &str) -> Self {
        let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn workspace_components_are_sorted_by_file_with_import_sources() {
    let project = TempProject::new("prop-analyzer-workspace");
    let ui = project.0.join(UI_DIR);
    fs::create_dir_all(&ui).unwrap();
    let mut stems = Vec::new();
    for entry in fs::read_dir(fixtures("ui")).unwrap() {
        let path = entry.unwrap().path();
        fs::copy(&path, ui.join(path.file_name().unwrap())).unwrap();
        stems.push(path.file_stem().unwrap().to_str().unwrap().to_string());
    }
    stems.sort();
    fs::write(ui.join("README.md"), "not a component").unwrap();

    let workspace = Workspace::new(&project.0).unwrap();
    let schemas = workspace.components(UI_DIR, "@/components/ui").unwrap();

    let mut expected = Vec::new();
    for stem in &stems {
        expected.extend(analyze_fixture("ui", stem));
    }
    assert_eq!(schemas, expected);

    let files: Vec<&str> = schemas.iter().map(|c| c.file.as_str()).collect();
    let mut sorted = files.clone();
    sorted.sort();
    assert_eq!(files, sorted, "grouped by file, in file-name order");
    assert_eq!(&names(&schemas)[..3], ["Badge", "Button", "Card"]);
    for c in &schemas {
        let stem = c.file.strip_prefix("src/components/ui/").and_then(|f| f.strip_suffix(".tsx")).unwrap();
        assert_eq!(c.import_source, format!("@/components/ui/{stem}"), "{}", c.name);
    }
    assert_eq!(find(&schemas, "SelectItem").import_source, "@/components/ui/select");

    // Trailing slashes on either argument change nothing.
    assert_eq!(workspace.components("src/components/ui/", "@/components/ui/").unwrap(), schemas);
}

#[test]
fn recognizes_base_ui_alias_and_control_parts() {
    let schemas = analyze_src(r#"
        import { Select as SelectPrimitive } from "@base-ui/react/select";
        import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
        export const Select = SelectPrimitive.Root;
        export function SelectItem({ ...props }: SelectPrimitive.Item.Props) {
          return <SelectPrimitive.Item {...props} />;
        }
        export function Checkbox({ ...props }: CheckboxPrimitive.Root.Props) {
          return <CheckboxPrimitive.Root {...props} />;
        }
    "#);
    let select = find(&schemas, "Select");
    assert!(select.accepts_children);
    assert_eq!(select.base_element.as_deref(), Some("SelectPrimitive.Root"));
    for (component, prop) in [("SelectItem", "value"), ("Checkbox", "id")] {
        assert!(find(&schemas, component).props.iter().any(|p| p.name == prop), "{component}.{prop}");
    }
}
