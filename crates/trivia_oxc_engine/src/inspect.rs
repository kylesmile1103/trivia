//! Read-only node details for the inspector.

use oxc_allocator::Allocator;
use serde::Serialize;

use crate::error::Result;
use crate::locator::{AttrValue, JsxTable, Locator, NodeKind};
use crate::{parse, text};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDetails {
    pub locator: String,
    pub file: String,
    /// Tag name as written (`Button`, `div`); `<>` for fragments.
    pub name: String,
    pub is_fragment: bool,
    /// 1-based position of the opening tag.
    pub line: u32,
    pub column: u32,
    pub is_root: bool,
    /// False when rendered from a `{…}` expression (cannot be moved/removed by the engine).
    pub is_direct: bool,
    pub parent: Option<String>,
    pub children: Vec<String>,
    pub attributes: Vec<AttrDetails>,
    /// The element's text when its only content is plain text (e.g. a Button label).
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttrDetails {
    /// `None` for `{...spread}`.
    pub name: Option<String>,
    pub kind: AttrKind,
    /// The literal value when the inspector can edit it (strings, `{true}`, `{3}`, shorthand).
    pub value: Option<serde_json::Value>,
    /// Source text of the value (or of the spread), for read-only display.
    pub source: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AttrKind {
    String,
    /// `{expr}`: editable only when `value` is set (a literal).
    Expression,
    /// Bare `disabled` (= true).
    Shorthand,
    Element,
    Spread,
}

pub fn inspect(source: &str, locator: &str) -> Result<NodeDetails> {
    let loc = Locator::parse(locator)?;
    let alloc = Allocator::default();
    let program = parse(&alloc, source, &loc.file)?;
    let table = JsxTable::build(&program);
    let idx = table.resolve(&loc)?;
    let node = &table.nodes[idx];
    let (line, column) = text::line_col(source, node.span.start);
    let slice = |s: oxc_span::Span| source[s.start as usize..s.end as usize].to_string();

    let attributes = node
        .attributes
        .iter()
        .map(|a| match (&a.name, &a.value) {
            (None, _) => AttrDetails { name: None, kind: AttrKind::Spread, value: None, source: slice(a.span) },
            (Some(name), None) => AttrDetails {
                name: Some(name.clone()),
                kind: AttrKind::Shorthand,
                value: Some(serde_json::Value::Bool(true)),
                source: name.clone(),
            },
            (Some(name), Some(AttrValue::String { span, value })) => AttrDetails {
                name: Some(name.clone()),
                kind: AttrKind::String,
                value: Some(serde_json::Value::String(value.clone())),
                source: slice(*span),
            },
            (Some(name), Some(AttrValue::Expression { source, literal, .. })) => AttrDetails {
                name: Some(name.clone()),
                kind: AttrKind::Expression,
                value: literal.clone(),
                source: source.clone(),
            },
            (Some(name), Some(AttrValue::Element { span })) => {
                AttrDetails { name: Some(name.clone()), kind: AttrKind::Element, value: None, source: slice(*span) }
            }
        })
        .collect();

    // Plain-text content only: one non-whitespace child that is JSX text. Reported as it
    // renders (JSX whitespace rules, character references decoded).
    let text = match node.content.as_slice() {
        [only] if only.node.is_none() => {
            let raw = slice(only.span);
            if raw.trim_start().starts_with('{') { None } else { text::jsx_text_value(&raw) }
        }
        _ => None,
    };

    Ok(NodeDetails {
        locator: loc.to_string(),
        file: loc.file.clone(),
        name: node.display_name().to_string(),
        is_fragment: node.kind == NodeKind::Fragment,
        line,
        column,
        is_root: node.parent.is_none(),
        is_direct: node.direct,
        parent: node.parent.map(|p| table.locator(p, &loc.file).to_string()),
        children: node.children.iter().map(|&c| table.locator(c, &loc.file).to_string()).collect(),
        attributes,
        text,
    })
}
