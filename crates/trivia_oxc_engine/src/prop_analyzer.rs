//! Static prop-schema extraction for shadcn components in `src/components/ui/*.tsx`.
//!
//! Current shadcn has no `ButtonProps` interface: props are typed inline on the function
//! parameter (`React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & {…}`),
//! variant unions live in the `cva(…)` config, and defaults in parameter destructuring and
//! `defaultVariants`. OXC has no type checker, so this resolves those shapes syntactically.

use serde::Serialize;

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
    /// False for void-like components (Input, Switch, Separator, …).
    pub accepts_children: bool,
    pub props: Vec<PropSchema>,
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
    /// Written in the component's own type (type literal, interface, alias).
    Declared,
    /// From `VariantProps<typeof xVariants>` resolved through the `cva(…)` config.
    Variant,
    /// A curated, commonly edited attribute of the base element (`disabled`, `placeholder`).
    Intrinsic,
}

/// Analyze one component file. `file` is its project-relative path and `import_source` the
/// module specifier it is imported from.
pub fn analyze(source: &str, file: &str, import_source: &str) -> Result<Vec<ComponentSchema>> {
    let _ = (source, file, import_source);
    Ok(Vec::new())
}
