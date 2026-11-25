//! Static prop-schema extraction for shadcn components in `src/components/ui/*.tsx`.
//!
//! Current shadcn has no `ButtonProps` interface: props are typed inline on the function
//! parameter (`React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & {…}`),
//! variant unions live in the `cva(…)` config, and defaults in parameter destructuring and
//! `defaultVariants`. OXC has no type checker, so this resolves those shapes syntactically.
//!
//! Rules:
//! * A *component* is a named export with a capitalized name bound to a function declaration,
//!   a `const` arrow/function expression, or a `forwardRef`/`memo` call around one (props from
//!   the call's type arguments, else from the inner parameter's annotation). Hooks, `cva`
//!   configs, types, classes and default exports are skipped. Output is in source order.
//! * The props type is expanded through parentheses, intersections, type literals, local
//!   interfaces (with `extends`) and local type aliases — depth-limited, cycle-safe and with a
//!   total step budget — plus `Omit`/`Pick`/`Partial`/`Required` around any of those.
//! * `VariantProps<typeof x>` reads the `variants` and `defaultVariants` of a local
//!   `const x = cva(…)`.
//! * `React.ComponentProps<"tag">` (`…WithoutRef`, `…WithRef`, `XHTMLAttributes<…>`) and
//!   `React.ComponentProps<typeof XPrimitive.Root>` for Radix are *not* expanded (rule 8 in
//!   `CLAUDE.md`): they give the base element and a small curated set of commonly edited props
//!   ([`dom_props`], [`radix_props`]).
//! * Anything else (an imported `ButtonProps`, a `cva` config from another file) is listed in
//!   [`ComponentSchema::unresolved_types`] instead of being dropped silently.
//! * A destructured prop the type doesn't spell out is still listed, since the component
//!   reads it: typed by its literal default, else `unknown` as `Props["name"]`.
//! * Prop types map to controls: unions of string literals → enum, `boolean`/`true | false` →
//!   boolean, `string`, `number`, and `className` → the class manager (`undefined`/`null`
//!   members are ignored). Everything else is `unknown` with its source text.
//! * Precedence when names collide: Declared > Variant > Intrinsic. A literal destructuring
//!   default overrides `defaultVariants`; a non-literal one clears it.
//! * `children`, `ref` and `key` are structural, not inspector props, and are never listed.
//!   `accepts_children` is false for void bases (`input`, Radix `Switch`, …) and for
//!   components whose props parameter can't pass children on (none, or `{ a, b }` without a
//!   rest element or `children`).

use std::collections::{HashMap, HashSet};

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_span::{GetSpan, Span};
use serde::Serialize;
use serde_json::Value;

use crate::error::Result;

/// One exported component and the props the inspector can edit.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentSchema {
    /// Exported component name, e.g. `Button`.
    pub name: String,
    /// Source file relative to the project root, e.g. `src/components/ui/button.tsx`.
    pub file: String,
    /// Module specifier to import it from, e.g. `@/components/ui/button`.
    pub import_source: String,
    /// The intrinsic tag or primitive it renders (`button`, `SwitchPrimitive.Root`), if known.
    pub base_element: Option<String>,
    /// False for void-like components (Input, Switch, Separator, …) and for components that
    /// never render `children`.
    pub accepts_children: bool,
    pub props: Vec<PropSchema>,
    /// Parts of the props type the analyzer could not expand, as source text (an imported
    /// `ButtonProps`, `VariantProps<typeof x>` for a `cva` defined elsewhere). Props that come
    /// only from these are missing from `props` unless the component destructures them.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unresolved_types: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropSchema {
    pub name: String,
    #[serde(flatten)]
    pub kind: PropKind,
    pub optional: bool,
    /// Literal default from parameter destructuring or `defaultVariants`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,
    pub source: PropSource,
}

/// How the inspector renders the prop: Enum → Select, Boolean → Switch, String/Number →
/// Input, ClassName → Tailwind class manager.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PropKind {
    Enum { options: Vec<String> },
    Boolean,
    String,
    Number,
    ClassName,
    /// A type the analyzer cannot map to a control; `type_text` is the source text.
    #[serde(rename_all = "camelCase")]
    Unknown { type_text: String },
}

/// Where a prop came from. Precedence when names collide: Declared > Variant > Intrinsic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PropSource {
    /// Written in the component's own type (type literal, interface, alias), or in the
    /// destructuring of an untyped props parameter.
    Declared,
    /// From `VariantProps<typeof xVariants>` resolved through the `cva(…)` config.
    Variant,
    /// A curated, commonly edited attribute of the base element (`disabled`, `placeholder`),
    /// or a destructured prop from a part of the type the analyzer doesn't expand.
    Intrinsic,
}

/// Analyze one component file. `file` is its project-relative path and `import_source` the
/// module specifier it is imported from.
pub fn analyze(source: &str, file: &str, import_source: &str) -> Result<Vec<ComponentSchema>> {
    let alloc = Allocator::default();
    let program = crate::parse(&alloc, source, file)?;
    let index = FileIndex::build(&program);
    let mut exported = HashSet::new();
    let mut found = Vec::new();
    for &(name, local) in &index.exports {
        if !is_component_name(name) || !exported.insert(name) {
            continue;
        }
        if let Some(def) = index.component(local, 1, 0) {
            found.push((def.start, index.schema(name, &def, file, import_source)));
        } else if let Some(alias) = index.base_select_alias(local, name, file, import_source) {
            found.push(alias);
        }
    }
    // Stable sort: aliases of one definition keep their export order.
    found.sort_by_key(|(start, _)| *start);
    Ok(found.into_iter().map(|(_, schema)| schema).collect())
}

/// Nesting limit for type expansion (aliases of aliases, interface chains, …).
const MAX_DEPTH: u32 = 16;

/// Total expansion steps per component. The cycle guard only covers the current path, so an
/// alias graph that fans out (`type A = B & B; type B = C & C; …`) would otherwise take
/// exponential time; real props types need a few dozen steps.
const MAX_STEPS: u32 = 4096;

/// React props that are structure, not inspector controls.
const STRUCTURAL: &[&str] = &["children", "ref", "key"];

/// Elements that take no children (HTML void elements, plus `textarea`, whose children are
/// its default value).
const VOID_TAGS: &[&str] =
    &["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "textarea"];

/// Radix families whose `Root` renders no children of the user's (they draw their own parts).
const VOID_PRIMITIVES: &[&str] = &["Switch", "Checkbox", "Separator", "Slider", "Progress"];

/// Radix parts that are void in every family (`DropdownMenu.Separator`, `Avatar.Image`, …).
const VOID_PARTS: &[&str] = &["Separator", "Image", "Thumb"];

/// Radix `Root`s that are context providers and render no DOM node, so take no `className`.
const NON_DOM_ROOTS: &[&str] =
    &["Select", "Dialog", "AlertDialog", "Popover", "DropdownMenu", "ContextMenu", "Tooltip", "HoverCard"];

const INPUT_TYPES: &[&str] = &[
    "text", "email", "password", "number", "search", "tel", "url", "date", "time", "datetime-local", "month", "week",
    "color", "file", "range", "checkbox", "radio", "hidden",
];

/// Curated props of an intrinsic element (`React.ComponentProps<"button">`). Deliberately
/// small: these are the attributes worth a control in the inspector, not the full DOM type.
fn dom_props(tag: &str) -> Vec<PropSchema> {
    use PropKind::{Boolean, Number, String};
    match tag {
        "button" => vec![intrinsic("type", options(&["button", "submit", "reset"])), intrinsic("disabled", Boolean)],
        "input" => vec![
            intrinsic("type", options(INPUT_TYPES)),
            intrinsic("placeholder", String),
            intrinsic("disabled", Boolean),
            intrinsic("id", String),
            intrinsic("name", String),
        ],
        "textarea" => vec![
            intrinsic("placeholder", String),
            intrinsic("disabled", Boolean),
            intrinsic("rows", Number),
            intrinsic("id", String),
        ],
        "a" => vec![intrinsic("href", String), intrinsic("target", String)],
        "img" => vec![intrinsic("src", String), intrinsic("alt", String)],
        "label" => vec![intrinsic("htmlFor", String)],
        _ => Vec::new(),
    }
}

/// Curated props of a Radix primitive part (`family` from the import, e.g. `Switch`; `part`
/// from the member, e.g. `Root`), for the families shadcn wraps. Same rule as [`dom_props`]:
/// the props worth a control, typed as Radix declares them.
fn radix_props(family: &str, part: &str) -> Vec<PropSchema> {
    use PropKind::{Boolean, Number, String};
    let orientation = || intrinsic("orientation", options(&["horizontal", "vertical"]));
    match (family, part) {
        ("Switch" | "Checkbox", "Root") => {
            vec![intrinsic("disabled", Boolean), intrinsic("defaultChecked", Boolean), intrinsic("id", String)]
        }
        ("Label", "Root") => vec![intrinsic("htmlFor", String)],
        ("Separator", "Root") => vec![orientation(), intrinsic("decorative", Boolean)],
        ("Select", "Root") => vec![intrinsic("defaultValue", String), intrinsic("disabled", Boolean)],
        ("Select", "Value") => vec![intrinsic("placeholder", String)],
        ("Select", "Content") => vec![
            intrinsic("position", options(&["item-aligned", "popper"])),
            intrinsic("align", options(&["start", "center", "end"])),
        ],
        ("Select" | "RadioGroup" | "Accordion", "Item") | ("Tabs", "Trigger") => {
            vec![required(intrinsic("value", String)), intrinsic("disabled", Boolean)]
        }
        ("Tabs", "Root") => vec![intrinsic("defaultValue", String), orientation()],
        ("Tabs", "Content") => vec![required(intrinsic("value", String))],
        ("RadioGroup", "Root") => vec![intrinsic("defaultValue", String), intrinsic("disabled", Boolean), orientation()],
        ("Accordion", "Root") => vec![
            required(intrinsic("type", options(&["single", "multiple"]))),
            intrinsic("collapsible", Boolean),
            intrinsic("disabled", Boolean),
        ],
        ("Progress", "Root") => vec![intrinsic("value", Number), intrinsic("max", Number)],
        ("Slider", "Root") => vec![
            intrinsic("min", Number),
            intrinsic("max", Number),
            intrinsic("step", Number),
            intrinsic("disabled", Boolean),
            orientation(),
        ],
        ("Toggle", "Root") => vec![intrinsic("defaultPressed", Boolean), intrinsic("disabled", Boolean)],
        ("Collapsible", "Root") => vec![intrinsic("defaultOpen", Boolean), intrinsic("disabled", Boolean)],
        ("Dialog" | "AlertDialog" | "Popover" | "HoverCard" | "Tooltip" | "DropdownMenu", "Root") => {
            vec![intrinsic("defaultOpen", Boolean)]
        }
        ("Avatar", "Image") => vec![intrinsic("src", String), intrinsic("alt", String)],
        _ => Vec::new(),
    }
}

fn intrinsic(name: &str, kind: PropKind) -> PropSchema {
    PropSchema { name: name.to_string(), kind, optional: true, default: None, source: PropSource::Intrinsic }
}

fn required(prop: PropSchema) -> PropSchema {
    PropSchema { optional: false, ..prop }
}

fn options(values: &[&str]) -> PropKind {
    PropKind::Enum { options: values.iter().map(|v| (*v).to_string()).collect() }
}

fn unknown(type_text: impl Into<std::string::String>) -> PropKind {
    PropKind::Unknown { type_text: type_text.into() }
}

fn is_component_name(name: &str) -> bool {
    name.chars().next().is_some_and(|c| c.is_ascii_uppercase())
}

#[derive(Clone, Copy)]
enum Binding<'b, 'a> {
    Function(&'b Function<'a>),
    Var(&'b VariableDeclarator<'a>),
}

#[derive(Clone, Copy)]
enum Import<'b> {
    /// `import { imported as local } from "source"`
    Named { source: &'b str, imported: &'b str },
    /// `import * as local from "source"`
    Namespace { source: &'b str },
    /// `import local from "source"`
    Default,
}

/// A component's props parameter: its type annotation and binding pattern.
struct ComponentDef<'b, 'a> {
    /// Start of the definition, for source order.
    start: u32,
    props_type: Option<&'b TSType<'a>>,
    pattern: Option<&'b BindingPattern<'a>>,
}

/// Top-level bindings of one file, by local name.
struct FileIndex<'b, 'a> {
    src: &'b str,
    values: HashMap<&'b str, Binding<'b, 'a>>,
    interfaces: HashMap<&'b str, Vec<&'b TSInterfaceDeclaration<'a>>>,
    aliases: HashMap<&'b str, &'b TSTypeAliasDeclaration<'a>>,
    imports: HashMap<&'b str, Import<'b>>,
    /// `(exported, local)` value exports, in source order.
    exports: Vec<(&'b str, &'b str)>,
}

impl<'b, 'a> FileIndex<'b, 'a> {
    fn build(program: &'b Program<'a>) -> Self {
        let mut index = Self {
            src: program.source_text,
            values: HashMap::new(),
            interfaces: HashMap::new(),
            aliases: HashMap::new(),
            imports: HashMap::new(),
            exports: Vec::new(),
        };
        for stmt in &program.body {
            match stmt {
                Statement::ImportDeclaration(import) => index.add_import(import),
                Statement::ExportDeclaration(export) => {
                    for name in index.add_declaration(&export.declaration) {
                        index.exports.push((name, name));
                    }
                }
                Statement::ExportNamedDeclaration(export) if export.export_kind.is_value() => {
                    for spec in export.specifiers.iter().filter(|s| s.export_kind.is_value()) {
                        index.exports.push((spec.exported.name().as_str(), spec.local.name().as_str()));
                    }
                }
                _ => {
                    if let Some(decl) = stmt.as_declaration() {
                        index.add_declaration(decl);
                    }
                }
            }
        }
        index
    }

    /// Index a declaration; returns the value names it binds (for `export <declaration>`).
    fn add_declaration(&mut self, decl: &'b Declaration<'a>) -> Vec<&'b str> {
        match decl {
            Declaration::FunctionDeclaration(f) => {
                let Some(id) = &f.id else { return Vec::new() };
                // Overload signatures have no body; the implementation that follows wins.
                if f.body.is_some() {
                    self.values.insert(id.name.as_str(), Binding::Function(f));
                }
                vec![id.name.as_str()]
            }
            Declaration::VariableDeclaration(v) => v
                .declarations
                .iter()
                .filter_map(|d| {
                    let BindingPattern::BindingIdentifier(id) = &d.id else { return None };
                    self.values.insert(id.name.as_str(), Binding::Var(d));
                    Some(id.name.as_str())
                })
                .collect(),
            Declaration::TSInterfaceDeclaration(i) => {
                self.interfaces.entry(i.id.name.as_str()).or_default().push(i);
                Vec::new()
            }
            Declaration::TSTypeAliasDeclaration(t) => {
                self.aliases.insert(t.id.name.as_str(), t);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn add_import(&mut self, import: &'b ImportDeclaration<'a>) {
        let source = import.source.value.as_str();
        for spec in import.specifiers.iter().flatten() {
            let (local, import) = match spec {
                ImportDeclarationSpecifier::ImportSpecifier(s) => {
                    (s.local.name.as_str(), Import::Named { source, imported: s.imported.name().as_str() })
                }
                ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => {
                    (s.local.name.as_str(), Import::Namespace { source })
                }
                ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => (s.local.name.as_str(), Import::Default),
            };
            self.imports.insert(local, import);
        }
    }

    fn text(&self, span: Span) -> &'b str {
        self.src.get(span.start as usize..span.end as usize).unwrap_or_default()
    }

    /// shadcn's Base UI Select exports the primitive Root directly, without a wrapper function.
    fn base_select_alias(&self, local: &str, name: &str, file: &str, import_source: &str) -> Option<(u32, ComponentSchema)> {
        let Binding::Var(declaration) = self.values.get(local)? else { return None };
        let Expression::StaticMemberExpression(member) = declaration.init.as_ref()?.get_inner_expression() else { return None };
        let Expression::Identifier(root) = member.object.get_inner_expression() else { return None };
        if member.optional || member.property.name.as_str() != "Root" || !matches!(
            self.imports.get(root.name.as_str()), Some(Import::Named { source: "@base-ui/react/select", imported: "Select" })
        ) {
            return None;
        }
        let mut props = Collected::default();
        let element = self.text(member.span);
        props.base_ui_control(element, "@base-ui/react/select", "Root");
        Some((declaration.span.start, ComponentSchema {
            name: name.to_string(),
            file: file.to_string(),
            import_source: import_source.to_string(),
            base_element: Some(element.to_string()),
            accepts_children: true,
            props: props.finish(&[]),
            unresolved_types: Vec::new(),
        }))
    }

    /// The component bound to `local`, if it is one.
    /// `max_params` is 2 for the render function of a `forwardRef`, else 1.
    fn component(&self, local: &str, max_params: usize, depth: u32) -> Option<ComponentDef<'b, 'a>> {
        if depth > MAX_DEPTH {
            return None;
        }
        match *self.values.get(local)? {
            Binding::Function(f) if !f.generator => {
                let (props_type, pattern) = props_param(&f.params, max_params)?;
                Some(ComponentDef { start: f.span.start, props_type, pattern })
            }
            Binding::Function(_) => None,
            Binding::Var(d) => {
                let (props_type, pattern) = self.component_expr(d.init.as_ref()?, max_params, depth)?;
                // `const X: React.FC<Props> = (…) => …`
                let props_type =
                    props_type.or_else(|| d.type_annotation.as_ref().and_then(|a| fc_props(&a.type_annotation)));
                Some(ComponentDef { start: d.span.start, props_type, pattern })
            }
        }
    }

    /// A function expression with at most `max_params` parameters (2 for a `forwardRef` render
    /// function), or a `forwardRef`/`memo` call around one.
    fn component_expr(&self, expr: &'b Expression<'a>, max_params: usize, depth: u32) -> Option<PropsParam<'b, 'a>> {
        match expr.get_inner_expression() {
            Expression::ArrowFunctionExpression(f) => props_param(&f.params, max_params),
            Expression::FunctionExpression(f) if !f.generator => props_param(&f.params, max_params),
            Expression::CallExpression(call) if depth < MAX_DEPTH => {
                // forwardRef<Ref, Props>(render) / memo<Props>(component)
                let (type_arg, inner_max) = match callee_name(&call.callee)? {
                    "forwardRef" => (1, 2),
                    "memo" => (0, 1),
                    _ => return None,
                };
                let inner = call.arguments.first()?.as_expression()?;
                let (props_type, pattern) = match inner.get_inner_expression() {
                    // `forwardRef(ButtonRender)` with `function ButtonRender(props, ref)`
                    Expression::Identifier(id) => {
                        let def = self.component(id.name.as_str(), inner_max, depth + 1)?;
                        (def.props_type, def.pattern)
                    }
                    inner => self.component_expr(inner, inner_max, depth + 1)?,
                };
                let explicit = call.type_arguments.as_ref().and_then(|t| t.params.get(type_arg));
                Some((explicit.or(props_type), pattern))
            }
            _ => None,
        }
    }

    /// The object literal `expr` is, or that the local `const` it names is initialized with.
    fn object(&self, expr: &'b Expression<'a>) -> Option<&'b ObjectExpression<'a>> {
        match expr.get_inner_expression() {
            Expression::ObjectExpression(o) => Some(o),
            Expression::Identifier(id) => match *self.values.get(id.name.as_str())? {
                Binding::Var(d) => match d.init.as_ref()?.get_inner_expression() {
                    Expression::ObjectExpression(o) => Some(o),
                    _ => None,
                },
                Binding::Function(_) => None,
            },
            _ => None,
        }
    }

    /// The config object (`{ variants, defaultVariants }`) of `const name = cva(base, config)`.
    fn variants_config(&self, name: &str) -> Option<&'b ObjectExpression<'a>> {
        let Binding::Var(d) = *self.values.get(name)? else { return None };
        let Expression::CallExpression(call) = d.init.as_ref()?.get_inner_expression() else { return None };
        call.arguments
            .iter()
            .filter_map(Argument::as_expression)
            .filter_map(|e| self.object(e))
            .find(|o| property(o, "variants").is_some())
    }

    fn schema(&self, name: &str, def: &ComponentDef<'b, 'a>, file: &str, import_source: &str) -> ComponentSchema {
        let destructured = def.pattern.map(destructured).unwrap_or_default();
        let mut c = Collected::default();
        match def.props_type {
            Some(ty) => {
                Resolver { index: self, visiting: Vec::new(), steps: 0 }.collect(ty, &mut c, 0);
                // Destructured names the type doesn't spell out come from a base type that isn't
                // expanded (`React.ComponentProps<…>`, an unresolved import). The component reads
                // them, so they are listed: typed by their literal default, else as unknown.
                let indexed = indexable(ty, self.text(ty.span()));
                for d in &destructured {
                    if d.name == "className" {
                        c.accept_class_name(PropSource::Intrinsic, true);
                    } else if !STRUCTURAL.contains(&d.name.as_str()) && !c.has(&d.name) {
                        let kind = match &d.default {
                            DefaultValue::Literal(v) => literal_kind(v),
                            _ => None,
                        };
                        let kind = kind.unwrap_or_else(|| unknown(format!("{indexed}[\"{}\"]", d.name)));
                        c.intrinsic.push(intrinsic(&d.name, kind));
                    }
                }
            }
            // Untyped parameter: the destructuring is the declaration.
            None => {
                for d in &destructured {
                    if d.name == "className" {
                        c.accept_class_name(PropSource::Declared, true);
                    } else if !STRUCTURAL.contains(&d.name.as_str()) {
                        let kind = match &d.default {
                            DefaultValue::Literal(v) => literal_kind(v),
                            _ => None,
                        };
                        c.declared.push(PropSchema {
                            name: d.name.clone(),
                            kind: kind.unwrap_or_else(|| unknown("any")),
                            optional: true,
                            default: None,
                            source: PropSource::Declared,
                        });
                    }
                }
            }
        }
        let accepts_children =
            def.pattern.is_some_and(passes_children) && c.base.as_ref().is_none_or(|b| b.accepts_children);
        let base_element = c.base.as_ref().and_then(|b| b.element.clone());
        let mut unresolved_types = Vec::new();
        for t in std::mem::take(&mut c.unresolved) {
            if !unresolved_types.contains(&t) {
                unresolved_types.push(t);
            }
        }
        ComponentSchema {
            name: name.to_string(),
            file: file.to_string(),
            import_source: import_source.to_string(),
            base_element,
            accepts_children,
            props: c.finish(&destructured),
            unresolved_types,
        }
    }
}

/// `(props type, props pattern)` of a component's first parameter.
type PropsParam<'b, 'a> = (Option<&'b TSType<'a>>, Option<&'b BindingPattern<'a>>);

fn props_param<'b, 'a>(params: &'b FormalParameters<'a>, max: usize) -> Option<PropsParam<'b, 'a>> {
    if params.rest.is_some() || params.items.len() > max {
        return None;
    }
    Some(match params.items.first() {
        Some(p) => (p.type_annotation.as_ref().map(|a| &a.type_annotation), Some(&p.pattern)),
        None => (None, None),
    })
}

/// `P` of `React.FC<P>` / `FunctionComponent<P>`.
fn fc_props<'b, 'a>(ty: &'b TSType<'a>) -> Option<&'b TSType<'a>> {
    let TSType::TSTypeReference(r) = ty else { return None };
    if !matches!(last_segment(&r.type_name), "FC" | "FunctionComponent" | "VFC" | "VoidFunctionComponent") {
        return None;
    }
    r.type_arguments.as_ref()?.params.first()
}

/// `forwardRef` for both `forwardRef(…)` and `React.forwardRef(…)`.
fn callee_name<'b>(callee: &'b Expression<'_>) -> Option<&'b str> {
    match callee.get_inner_expression() {
        Expression::Identifier(id) => Some(id.name.as_str()),
        Expression::StaticMemberExpression(m) => Some(m.property.name.as_str()),
        _ => None,
    }
}

/// `ComponentProps` for both `ComponentProps` and `React.ComponentProps`.
fn last_segment<'b>(name: &'b TSTypeName<'_>) -> &'b str {
    match name {
        TSTypeName::IdentifierReference(id) => id.name.as_str(),
        TSTypeName::QualifiedName(q) => q.right.name.as_str(),
        TSTypeName::ThisExpression(_) => "this",
    }
}

/// The value of the non-computed property `key` of an object literal.
fn property<'b, 'a>(object: &'b ObjectExpression<'a>, key: &str) -> Option<&'b Expression<'a>> {
    object.properties.iter().find_map(|p| match p {
        ObjectPropertyKind::ObjectProperty(p) if !p.computed && p.key.static_name().is_some_and(|k| k == key) => {
            Some(&p.value)
        }
        _ => None,
    })
}

/// The element of `HTMLAttributes<T>`: `HTMLDivElement` → `div`. `None` for interfaces shared
/// by several tags (`HTMLHeadingElement`, `HTMLTableCellElement`, `HTMLElement`, …).
fn element_tag(interface: &str) -> Option<&'static str> {
    Some(match interface {
        "HTMLDivElement" => "div",
        "HTMLSpanElement" => "span",
        "HTMLParagraphElement" => "p",
        "HTMLButtonElement" => "button",
        "HTMLInputElement" => "input",
        "HTMLTextAreaElement" => "textarea",
        "HTMLAnchorElement" => "a",
        "HTMLImageElement" => "img",
        "HTMLLabelElement" => "label",
        "HTMLFormElement" => "form",
        "HTMLSelectElement" => "select",
        "HTMLOptionElement" => "option",
        "HTMLUListElement" => "ul",
        "HTMLOListElement" => "ol",
        "HTMLLIElement" => "li",
        "HTMLTableElement" => "table",
        "HTMLTableRowElement" => "tr",
        "HTMLTableCaptionElement" => "caption",
        "HTMLHRElement" => "hr",
        "HTMLBRElement" => "br",
        "HTMLPreElement" => "pre",
        "HTMLIFrameElement" => "iframe",
        "HTMLVideoElement" => "video",
        "HTMLAudioElement" => "audio",
        "HTMLCanvasElement" => "canvas",
        "HTMLDialogElement" => "dialog",
        "HTMLFieldSetElement" => "fieldset",
        "HTMLLegendElement" => "legend",
        "HTMLProgressElement" => "progress",
        "HTMLDetailsElement" => "details",
        _ => return None,
    })
}

/// The element of a tag-specific attributes interface: `ButtonHTMLAttributes` → `button`.
/// `None` for `MediaHTMLAttributes`, shared by `audio` and `video`.
fn attributes_tag(prefix: &str) -> Option<std::string::String> {
    match prefix {
        "Anchor" => Some("a".into()),
        "Quote" => Some("q".into()),
        "Media" => None,
        _ => Some(prefix.to_ascii_lowercase()),
    }
}

/// `dropdown-menu` (from `@radix-ui/react-dropdown-menu`) → `DropdownMenu`.
fn pascal_case(kebab: &str) -> std::string::String {
    kebab
        .split('-')
        .map(|w| {
            let mut chars = w.chars();
            chars.next().map(|c| c.to_ascii_uppercase().to_string() + chars.as_str()).unwrap_or_default()
        })
        .collect()
}

/// `(family, part)` of a Radix primitive reference, from how its root identifier is imported:
/// `import { Switch as SwitchPrimitive } from "radix-ui"` + `SwitchPrimitive.Root` →
/// `(Switch, Root)`; `import * as SwitchPrimitives from "@radix-ui/react-switch"` likewise.
fn radix_primitive(import: Option<&Import<'_>>, name: &TSTypeName<'_>) -> Option<(std::string::String, std::string::String)> {
    let member = match name {
        TSTypeName::QualifiedName(q) => Some(q.right.name.as_str()),
        _ => None,
    };
    let package = |source: &str| source.strip_prefix("@radix-ui/react-").map(pascal_case);
    match *import? {
        Import::Named { source: "radix-ui", imported } => Some((imported.to_string(), member.unwrap_or("Root").to_string())),
        // `import { Root as SwitchRoot } from "@radix-ui/react-switch"`
        Import::Named { source, imported } => Some((package(source)?, member.unwrap_or(imported).to_string())),
        Import::Namespace { source } => Some((package(source)?, member.unwrap_or("Root").to_string())),
        Import::Default => None,
    }
}

/// A destructuring default: none, a literal (JSON), or an expression the analyzer can't read.
enum DefaultValue {
    None,
    Literal(Value),
    Opaque,
}

struct Destructured {
    name: std::string::String,
    default: DefaultValue,
}

/// Names and defaults of `{ a, b = "x", ...rest }` (the rest element is ignored).
fn destructured(pattern: &BindingPattern<'_>) -> Vec<Destructured> {
    match pattern {
        BindingPattern::ObjectPattern(o) => o
            .properties
            .iter()
            .filter_map(|p| {
                let name = p.key.static_name()?.into_owned();
                let default = match &p.value {
                    BindingPattern::AssignmentPattern(a) => literal(&a.right).map_or(DefaultValue::Opaque, DefaultValue::Literal),
                    _ => DefaultValue::None,
                };
                Some(Destructured { name, default })
            })
            .collect(),
        BindingPattern::AssignmentPattern(a) => destructured(&a.left),
        _ => Vec::new(),
    }
}

/// JSON value of a literal expression (`"x"`, `3`, `-1`, `true`, `null`, `` `x` ``).
fn literal(expr: &Expression<'_>) -> Option<Value> {
    match expr.get_inner_expression() {
        Expression::StringLiteral(s) => Some(Value::String(s.value.as_str().to_string())),
        Expression::BooleanLiteral(b) => Some(Value::Bool(b.value)),
        Expression::NullLiteral(_) => Some(Value::Null),
        Expression::NumericLiteral(n) => number(n.value),
        Expression::UnaryExpression(u) if u.operator == UnaryOperator::UnaryNegation => {
            match u.argument.get_inner_expression() {
                Expression::NumericLiteral(n) => number(-n.value),
                _ => None,
            }
        }
        Expression::TemplateLiteral(t) => t.single_quasi().map(|q| Value::String(q.as_str().to_string())),
        _ => None,
    }
}

/// Integral values serialize as JSON integers (`3`, not `3.0`).
fn number(v: f64) -> Option<Value> {
    const EXACT: f64 = 9_007_199_254_740_992.0; // 2^53
    if v.fract() == 0.0 && v.abs() < EXACT {
        #[expect(clippy::cast_possible_truncation, reason = "integral and below 2^53")]
        return Some(Value::from(v as i64));
    }
    serde_json::Number::from_f64(v).map(Value::Number)
}

/// The control for a prop whose type isn't known, from its literal default (what TypeScript
/// would infer). `None` for `null`.
fn literal_kind(v: &Value) -> Option<PropKind> {
    match v {
        Value::Bool(_) => Some(PropKind::Boolean),
        Value::Number(_) => Some(PropKind::Number),
        Value::String(_) => Some(PropKind::String),
        _ => None,
    }
}

/// Whether a props pattern can pass `children` on: a plain `props` binding, a rest element,
/// or a `children` key. `{ title }` alone never renders them, and neither does a component
/// without a props parameter.
fn passes_children(pattern: &BindingPattern<'_>) -> bool {
    match pattern {
        BindingPattern::ObjectPattern(o) => {
            o.rest.is_some() || o.properties.iter().any(|p| p.key.static_name().is_none_or(|k| k == "children"))
        }
        BindingPattern::AssignmentPattern(a) => passes_children(&a.left),
        _ => true,
    }
}

/// `text` of a props type, on one line and parenthesized where `T["key"]` needs it.
fn indexable(ty: &TSType<'_>, text: &str) -> std::string::String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match ty {
        TSType::TSTypeReference(_) | TSType::TSParenthesizedType(_) | TSType::TSTypeLiteral(_) => text,
        _ => format!("({text})"),
    }
}

struct Base {
    /// `button`, `SwitchPrimitive.Root`; `None` when only the element family is known.
    element: Option<std::string::String>,
    accepts_children: bool,
}

/// Props gathered from one props type, grouped by source.
#[derive(Default)]
struct Collected {
    base: Option<Base>,
    variants: Vec<PropSchema>,
    declared: Vec<PropSchema>,
    intrinsic: Vec<PropSchema>,
    class_name: Option<PropSchema>,
    unresolved: Vec<std::string::String>,
}

impl Collected {
    /// The first base wins (`ComponentProps<"div"> & …`).
    fn set_base(&mut self, element: Option<std::string::String>, accepts_children: bool) {
        if self.base.is_none() {
            self.base = Some(Base { element, accepts_children });
        }
    }

    fn accept_class_name(&mut self, source: PropSource, optional: bool) {
        let keep = self.class_name.as_ref().is_some_and(|c| c.source == PropSource::Declared || source != PropSource::Declared);
        if !keep {
            self.class_name =
                Some(PropSchema { name: "className".into(), kind: PropKind::ClassName, optional, default: None, source });
        }
    }

    /// An intrinsic element: its tag (if known), `className` and the curated props.
    fn dom(&mut self, tag: Option<&str>) {
        self.set_base(tag.map(str::to_string), !tag.is_some_and(|t| VOID_TAGS.contains(&t)));
        self.accept_class_name(PropSource::Intrinsic, true);
        if let Some(tag) = tag {
            self.intrinsic.extend(dom_props(tag));
        }
    }

    /// A Radix primitive part, e.g. `SwitchPrimitive.Root` of family `Switch`.
    fn primitive(&mut self, element: &str, family: &str, part: &str) {
        let void = (part == "Root" && VOID_PRIMITIVES.contains(&family)) || VOID_PARTS.contains(&part);
        self.set_base(Some(element.to_string()), !void);
        let no_dom =
            matches!(part, "Portal" | "Provider" | "Sub") || (part == "Root" && NON_DOM_ROOTS.contains(&family));
        if !no_dom {
            self.accept_class_name(PropSource::Intrinsic, true);
        }
        self.intrinsic.extend(radix_props(family, part));
    }

    /// Curated native props forwarded by the Base UI kit controls.
    fn base_ui_control(&mut self, element: &str, source: &str, part: &str) -> bool {
        let (accepts_children, names): (bool, &[&str]) = match (source, part) {
            ("@base-ui/react/select", "Root") => (true, &["disabled", "id", "name"]),
            ("@base-ui/react/select", "Item") => (true, &["value", "disabled"]),
            ("@base-ui/react/radio", "Root") => (false, &["value", "disabled", "id"]),
            ("@base-ui/react/checkbox" | "@base-ui/react/switch", "Root") => (false, &["disabled", "id", "defaultChecked"]),
            _ => return false,
        };
        self.set_base(Some(element.to_string()), accepts_children);
        self.intrinsic.extend(names.iter().map(|name| intrinsic(name, match *name {
            "disabled" | "defaultChecked" => PropKind::Boolean,
            "value" => unknown("unknown"),
            _ => PropKind::String,
        })));
        true
    }

    fn has(&self, name: &str) -> bool {
        self.variants.iter().chain(&self.declared).chain(&self.intrinsic).chain(&self.class_name).any(|p| p.name == name)
    }

    fn props_mut(&mut self) -> impl Iterator<Item = &mut PropSchema> {
        self.variants.iter_mut().chain(&mut self.declared).chain(&mut self.intrinsic).chain(&mut self.class_name)
    }

    fn retain(&mut self, keep: impl Fn(&str) -> bool) {
        self.variants.retain(|p| keep(&p.name));
        self.declared.retain(|p| keep(&p.name));
        self.intrinsic.retain(|p| keep(&p.name));
        self.class_name = self.class_name.take().filter(|p| keep(&p.name));
    }

    fn merge(&mut self, other: Collected) {
        if let Some(base) = other.base {
            self.set_base(base.element, base.accepts_children);
        }
        self.variants.extend(other.variants);
        self.declared.extend(other.declared);
        self.intrinsic.extend(other.intrinsic);
        if let Some(c) = other.class_name {
            self.accept_class_name(c.source, c.optional);
        }
        self.unresolved.extend(other.unresolved);
    }

    /// Final order: variants, declared, intrinsic, `className`; first of a name wins after
    /// Declared > Variant > Intrinsic. Literal destructuring defaults override.
    fn finish(self, destructured: &[Destructured]) -> Vec<PropSchema> {
        let Collected { variants, declared, intrinsic, class_name, .. } = self;
        let declared_names: HashSet<std::string::String> = declared.iter().map(|p| p.name.clone()).collect();
        let mut seen = HashSet::new();
        let mut props: Vec<PropSchema> = variants
            .into_iter()
            .filter(|p| !declared_names.contains(&p.name))
            .chain(declared)
            .chain(intrinsic)
            .chain(class_name)
            .filter(|p| seen.insert(p.name.clone()))
            .collect();
        for p in &mut props {
            match destructured.iter().find(|d| d.name == p.name).map(|d| &d.default) {
                Some(DefaultValue::Literal(v)) => p.default = Some(v.clone()),
                Some(DefaultValue::Opaque) => p.default = None,
                Some(DefaultValue::None) | None => {}
            }
        }
        props
    }
}

/// Expands a props type into a [`Collected`].
struct Resolver<'i, 'b, 'a> {
    index: &'i FileIndex<'b, 'a>,
    /// Named types on the current expansion path (cycle guard).
    visiting: Vec<std::string::String>,
    /// Expansion steps taken, bounded by [`MAX_STEPS`].
    steps: u32,
}

impl<'b, 'a> Resolver<'_, 'b, 'a> {
    /// Count one expansion step; false once the budget is spent.
    fn step(&mut self) -> bool {
        self.steps = self.steps.saturating_add(1);
        self.steps <= MAX_STEPS
    }

    fn unresolved(&self, out: &mut Collected, span: Span) {
        out.unresolved.push(self.index.text(span).to_string());
    }

    fn collect(&mut self, ty: &'b TSType<'a>, out: &mut Collected, depth: u32) {
        if depth > MAX_DEPTH || !self.step() {
            return self.unresolved(out, ty.span());
        }
        match ty {
            TSType::TSParenthesizedType(p) => self.collect(&p.type_annotation, out, depth + 1),
            TSType::TSIntersectionType(i) => {
                for t in &i.types {
                    self.collect(t, out, depth + 1);
                }
            }
            TSType::TSTypeLiteral(l) => self.members(&l.members, out, depth),
            TSType::TSTypeReference(r) => {
                self.reference(&r.type_name, r.type_arguments.as_deref(), r.span, out, depth);
            }
            _ => self.unresolved(out, ty.span()),
        }
    }

    /// `Name<Args>`, from a type reference or an interface's `extends` clause.
    fn reference(
        &mut self,
        name: &'b TSTypeName<'a>,
        args: Option<&'b TSTypeParameterInstantiation<'a>>,
        span: Span,
        out: &mut Collected,
        depth: u32,
    ) {
        let arg = |i: usize| args.and_then(|a| a.params.get(i));
        if let TSTypeName::IdentifierReference(id) = name {
            let local = id.name.as_str();
            if self.index.interfaces.contains_key(local) || self.index.aliases.contains_key(local) {
                return self.local_type(local, out, depth);
            }
        }
        if let TSTypeName::QualifiedName(qualified) = name
            && qualified.right.name.as_str() == "Props"
            && let Some(id) = qualified.left.get_identifier_reference()
            && let Some(Import::Named { source, .. }) = self.index.imports.get(id.name.as_str())
            && out.base_ui_control(self.index.text(qualified.left.span()), source, last_segment(&qualified.left))
        {
            return;
        }
        match last_segment(name) {
            "VariantProps" => match arg(0) {
                Some(TSType::TSTypeQuery(q)) => self.variants(q, span, out),
                _ => self.unresolved(out, span),
            },
            "ComponentProps" | "ComponentPropsWithoutRef" | "ComponentPropsWithRef" => match arg(0) {
                Some(TSType::TSLiteralType(l)) => match &l.literal {
                    TSLiteral::StringLiteral(tag) => out.dom(Some(tag.value.as_str())),
                    _ => self.unresolved(out, span),
                },
                Some(TSType::TSTypeQuery(q)) => match q.expr_name.as_ts_type_name() {
                    Some(target) => self.component_props_of(target, span, out, depth),
                    None => self.unresolved(out, span),
                },
                _ => self.unresolved(out, span),
            },
            "PropsWithChildren" | "PropsWithoutRef" | "PropsWithRef" | "DetailedHTMLProps" => match arg(0) {
                Some(inner) => self.collect(inner, out, depth + 1),
                None => self.unresolved(out, span),
            },
            "HTMLAttributes" | "HTMLProps" | "AllHTMLAttributes" => out.dom(arg(0).and_then(|t| match t {
                TSType::TSTypeReference(r) => element_tag(last_segment(&r.type_name)),
                _ => None,
            })),
            "SVGProps" | "SVGAttributes" => out.dom(None),
            utility @ ("Omit" | "Pick" | "Partial" | "Required") => self.utility(utility, arg(0), arg(1), span, out, depth),
            other => match other.strip_suffix("HTMLAttributes") {
                Some(prefix) => out.dom(attributes_tag(prefix).as_deref()),
                None => self.unresolved(out, span),
            },
        }
    }

    /// A local interface (every merged declaration, `extends` first) or type alias.
    fn local_type(&mut self, name: &'b str, out: &mut Collected, depth: u32) {
        // A cycle (`type A = B; type B = A`) is a type error; it adds nothing.
        if self.visiting.iter().any(|v| v == name) {
            return;
        }
        if depth > MAX_DEPTH || !self.step() {
            return out.unresolved.push(name.to_string());
        }
        self.visiting.push(name.to_string());
        let index = self.index;
        if let Some(decls) = index.interfaces.get(name) {
            for decl in decls {
                for heritage in &decl.extends {
                    let args = heritage.type_arguments.as_deref();
                    self.reference(&heritage.type_name, args, heritage.span, out, depth + 1);
                }
                self.members(&decl.body.body, out, depth + 1);
            }
        } else if let Some(alias) = index.aliases.get(name) {
            self.collect(&alias.type_annotation, out, depth + 1);
        }
        self.visiting.pop();
    }

    fn members(&mut self, members: &'b [TSSignature<'a>], out: &mut Collected, depth: u32) {
        for member in members {
            let (name, optional, kind) = match member {
                TSSignature::TSPropertySignature(p) => {
                    let Some(name) = p.key.static_name() else { continue };
                    let kind = match &p.type_annotation {
                        Some(a) => self.classify(&a.type_annotation, depth + 1),
                        None => unknown("any"),
                    };
                    (name, p.optional, kind)
                }
                TSSignature::TSMethodSignature(m) => {
                    let Some(name) = m.key.static_name() else { continue };
                    (name, m.optional, unknown(self.index.text(m.span)))
                }
                // Index, call and construct signatures name no prop.
                _ => continue,
            };
            if name == "className" {
                out.accept_class_name(PropSource::Declared, optional);
            } else if !STRUCTURAL.contains(&&*name) {
                let name = name.into_owned();
                out.declared.push(PropSchema { name, kind, optional, default: None, source: PropSource::Declared });
            }
        }
    }

    /// The control for a declared prop's type.
    fn classify(&mut self, ty: &'b TSType<'a>, depth: u32) -> PropKind {
        let mut members = Vec::new();
        self.flatten(ty, &mut members, depth);
        members.retain(|t| !matches!(t, TSType::TSUndefinedKeyword(_) | TSType::TSNullKeyword(_)));
        if let Some(options) = string_literals(&members) {
            return PropKind::Enum { options };
        }
        let boolean = |t: &&TSType<'_>| match t {
            TSType::TSBooleanKeyword(_) => true,
            TSType::TSLiteralType(l) => matches!(l.literal, TSLiteral::BooleanLiteral(_)),
            _ => false,
        };
        if !members.is_empty() && members.iter().all(boolean) {
            return PropKind::Boolean;
        }
        match members.as_slice() {
            [TSType::TSStringKeyword(_)] => PropKind::String,
            [TSType::TSNumberKeyword(_)] => PropKind::Number,
            _ => unknown(self.index.text(ty.span())),
        }
    }

    /// Union members of `ty`, through parentheses and local non-generic aliases.
    fn flatten(&mut self, ty: &'b TSType<'a>, out: &mut Vec<&'b TSType<'a>>, depth: u32) {
        if depth > MAX_DEPTH || !self.step() {
            return out.push(ty);
        }
        match ty {
            TSType::TSParenthesizedType(p) => self.flatten(&p.type_annotation, out, depth + 1),
            TSType::TSUnionType(u) => {
                for t in &u.types {
                    self.flatten(t, out, depth + 1);
                }
            }
            TSType::TSTypeReference(r) => {
                let index = self.index;
                if let TSTypeName::IdentifierReference(id) = &r.type_name
                    && r.type_arguments.is_none()
                    && let Some(alias) = index.aliases.get(id.name.as_str())
                    && alias.type_parameters.is_none()
                    && !self.visiting.iter().any(|v| v == id.name.as_str())
                {
                    self.visiting.push(id.name.as_str().to_string());
                    self.flatten(&alias.type_annotation, out, depth + 1);
                    self.visiting.pop();
                } else {
                    out.push(ty);
                }
            }
            _ => out.push(ty),
        }
    }

    /// `React.ComponentProps<typeof target>`: a local component's props type, or a Radix
    /// primitive. Anything else (a sibling file's component, a third-party one) only names
    /// the base element.
    fn component_props_of(&mut self, target: &'b TSTypeName<'a>, span: Span, out: &mut Collected, depth: u32) {
        let index = self.index;
        let element = index.text(target.span());
        let Some(root) = target.get_identifier_reference().map(|id| id.name.as_str()) else {
            return self.unresolved(out, span);
        };
        if matches!(target, TSTypeName::IdentifierReference(_))
            && let Some(def) = index.component(root, 1, 0)
        {
            let key = format!("typeof {root}");
            match def.props_type {
                Some(ty) if !self.visiting.contains(&key) => {
                    self.visiting.push(key);
                    self.collect(ty, out, depth + 1);
                    self.visiting.pop();
                }
                _ => self.unresolved(out, span),
            }
            return;
        }
        match radix_primitive(index.imports.get(root), target) {
            Some((family, part)) => out.primitive(element, &family, &part),
            None => {
                out.set_base(Some(element.to_string()), true);
                self.unresolved(out, span);
            }
        }
    }

    /// `VariantProps<typeof x>` → one optional prop per key of `x`'s cva `variants`.
    fn variants(&mut self, query: &'b TSTypeQuery<'a>, span: Span, out: &mut Collected) {
        let index = self.index;
        let Some(TSTypeName::IdentifierReference(id)) = query.expr_name.as_ts_type_name() else {
            return self.unresolved(out, span);
        };
        let config_name = id.name.as_str();
        let Some(config) = index.variants_config(config_name) else { return self.unresolved(out, span) };
        let Some(variants) = property(config, "variants").and_then(|v| index.object(v)) else {
            return self.unresolved(out, span);
        };
        let defaults = property(config, "defaultVariants").and_then(|d| index.object(d));
        for prop in &variants.properties {
            let ObjectPropertyKind::ObjectProperty(p) = prop else {
                self.unresolved(out, prop.span());
                continue;
            };
            let Some(name) = p.key.static_name().filter(|_| !p.computed) else {
                self.unresolved(out, prop.span());
                continue;
            };
            let kind = index
                .object(&p.value)
                .and_then(variant_kind)
                .unwrap_or_else(|| unknown(format!("VariantProps<typeof {config_name}>[\"{name}\"]")));
            let mut default = defaults.and_then(|d| property(d, &name)).and_then(literal);
            if kind == PropKind::Boolean
                && let Some(Value::String(s)) = &default
            {
                default = Some(Value::Bool(s == "true"));
            }
            let name = name.into_owned();
            out.variants.push(PropSchema { name, kind, optional: true, default, source: PropSource::Variant });
        }
    }

    /// `Omit<T, K>`, `Pick<T, K>`, `Partial<T>`, `Required<T>`.
    fn utility(
        &mut self,
        utility: &str,
        inner: Option<&'b TSType<'a>>,
        keys: Option<&'b TSType<'a>>,
        span: Span,
        out: &mut Collected,
        depth: u32,
    ) {
        let Some(inner_ty) = inner else { return self.unresolved(out, span) };
        let mut inner = Collected::default();
        self.collect(inner_ty, &mut inner, depth + 1);
        match utility {
            "Partial" => inner.props_mut().for_each(|p| p.optional = true),
            "Required" => inner.props_mut().for_each(|p| p.optional = false),
            _ => {
                let mut members = Vec::new();
                if let Some(keys) = keys {
                    self.flatten(keys, &mut members, depth + 1);
                }
                let Some(keys) = string_literals(&members) else {
                    // Keys we can't read (`keyof X`): keep everything, but say so.
                    self.unresolved(out, span);
                    return out.merge(inner);
                };
                if utility == "Omit" {
                    inner.retain(|name| !keys.iter().any(|k| k == name));
                } else {
                    inner.retain(|name| keys.iter().any(|k| k == name));
                    // Only the picked keys survive, so this is no longer "renders <tag>".
                    inner.base = None;
                    // Picked keys of a type that isn't expanded: name them, typed honestly.
                    let inner_text = self.index.text(inner_ty.span());
                    for key in &keys {
                        if key == "className" {
                            inner.accept_class_name(PropSource::Intrinsic, true);
                        } else if !inner.has(key) && !STRUCTURAL.contains(&key.as_str()) {
                            inner.intrinsic.push(intrinsic(key, unknown(format!("{inner_text}[\"{key}\"]"))));
                        }
                    }
                    inner.unresolved.clear();
                }
            }
        }
        out.merge(inner);
    }
}

/// `Some(options)` when every member is a string literal (deduplicated, in order).
fn string_literals(members: &[&TSType<'_>]) -> Option<Vec<std::string::String>> {
    if members.is_empty() {
        return None;
    }
    let mut options: Vec<std::string::String> = Vec::new();
    for t in members {
        let TSType::TSLiteralType(l) = t else { return None };
        let TSLiteral::StringLiteral(s) = &l.literal else { return None };
        if !options.iter().any(|o| o == s.value.as_str()) {
            options.push(s.value.as_str().to_string());
        }
    }
    Some(options)
}

/// The kind of one cva variant from its options object: `true`/`false` keys → boolean (as
/// cva's `VariantProps` types them), identifier or string keys → enum. `None` for numeric,
/// computed or spread keys.
fn variant_kind(options: &ObjectExpression<'_>) -> Option<PropKind> {
    let mut keys: Vec<std::string::String> = Vec::new();
    for p in &options.properties {
        let ObjectPropertyKind::ObjectProperty(p) = p else { return None };
        let key = match &p.key {
            PropertyKey::StaticIdentifier(id) if !p.computed => id.name.as_str(),
            PropertyKey::StringLiteral(s) => s.value.as_str(),
            _ => return None,
        };
        if !keys.iter().any(|k| k == key) {
            keys.push(key.to_string());
        }
    }
    if !keys.is_empty() && keys.iter().all(|k| k == "true" || k == "false") {
        return Some(PropKind::Boolean);
    }
    Some(PropKind::Enum { options: keys })
}
