//! Deterministic JSX locators: `<relative_path>#<component>#<i.j.k>`.
//!
//! This module is the single definition of the locator algorithm. The Vite plugin
//! (via [`annotate`]) and the mutation engine (via [`JsxTable`]) both use it, so the
//! locators written into the DOM always resolve to the same node at edit time.
//!
//! Rules:
//! * The *component* is the top-level statement that contains the JSX: the declared name
//!   of a function, class or variable (`export default function X` → `X`); `default` for an
//!   anonymous default export; `module` for any other top-level code (e.g. `main.tsx`).
//! * A node's *parent* is its nearest enclosing JSX element or fragment. JSX reached through
//!   `{…}` expressions or attribute values still belongs to that parent, but is marked
//!   non-[`direct`](JsxNode::direct) because it cannot be moved by text splicing alone.
//! * Indices count only JSX elements and fragments, in source order. Text, whitespace and
//!   `{…}` containers never take an index, so reformatting never shifts a locator.
//! * Roots (JSX with no JSX ancestor) are numbered in source order within their component.

use std::collections::HashMap;
use std::fmt;

use oxc_ast::ast::*;
use oxc_ast_visit::Visit;
use oxc_span::{GetSpan, Span};

use crate::error::{EngineError, Result};
use crate::text::{self, Edit};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Locator {
    pub file: String,
    pub scope: String,
    pub path: Vec<u32>,
}

impl Locator {
    pub fn parse(s: &str) -> Result<Self> {
        let invalid = || EngineError::InvalidLocator(s.to_string());
        // Split from the right: file paths may contain `#`, components and paths cannot.
        let mut parts = s.rsplitn(3, '#');
        let path = parts.next().ok_or_else(invalid)?;
        let scope = parts.next().ok_or_else(invalid)?;
        let file = parts.next().ok_or_else(invalid)?;
        if file.is_empty() || scope.is_empty() || path.is_empty() {
            return Err(invalid());
        }
        let path = path
            .split('.')
            .map(|seg| seg.parse::<u32>().map_err(|_| invalid()))
            .collect::<Result<Vec<_>>>()?;
        Ok(Self { file: file.to_string(), scope: scope.to_string(), path })
    }

    /// True when `self` is a strict ancestor of `other`.
    pub fn is_ancestor_of(&self, other: &Locator) -> bool {
        self.file == other.file
            && self.scope == other.scope
            && other.path.len() > self.path.len()
            && other.path.starts_with(&self.path)
    }
}

impl fmt::Display for Locator {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}#{}#", self.file, self.scope)?;
        for (i, seg) in self.path.iter().enumerate() {
            if i > 0 {
                f.write_str(".")?;
            }
            write!(f, "{seg}")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    Element,
    Fragment,
}

/// A literal attribute value the inspector can show and edit.
#[derive(Debug, Clone, PartialEq)]
pub enum AttrValue {
    /// `name="text"`
    String { span: Span, value: String },
    /// `name={expr}`; `literal` is set when `expr` is a plain literal.
    Expression { span: Span, source: String, literal: Option<serde_json::Value> },
    /// `name=<El />`
    Element { span: Span },
}

#[derive(Debug, Clone)]
pub struct Attr {
    /// `None` for `{...spread}`.
    pub name: Option<String>,
    pub span: Span,
    /// End of the attribute name (where `=value` would go for a shorthand attribute).
    pub name_end: u32,
    pub value: Option<AttrValue>,
}

/// A non-whitespace child of an element: a JSX node or other content (text, `{…}`).
#[derive(Debug, Clone, Copy)]
pub struct Content {
    pub span: Span,
    pub node: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct JsxNode {
    pub scope: String,
    pub path: Vec<u32>,
    pub kind: NodeKind,
    /// Tag name as written (`Button`, `div`, `React.Fragment`); `None` for `<>`.
    pub name: Option<String>,
    pub span: Span,
    /// Span of the opening element/fragment.
    pub opening: Span,
    /// Span of the closing element; `None` when self-closing.
    pub closing: Option<Span>,
    /// Offset right after the tag name (and type arguments): where attributes start.
    pub attr_insert: u32,
    pub attributes: Vec<Attr>,
    pub parent: Option<usize>,
    /// True when the node sits directly in its parent's children (not inside `{…}`).
    pub direct: bool,
    /// All child JSX nodes, in index order.
    pub children: Vec<usize>,
    /// Non-whitespace children in source order.
    pub content: Vec<Content>,
}

impl JsxNode {
    pub fn display_name(&self) -> &str {
        self.name.as_deref().unwrap_or("<>")
    }

    /// Root identifier of the tag when it refers to a binding (`Button`, `Card` in
    /// `Card.Header`); `None` for intrinsic elements and fragments.
    pub fn component_ref(&self) -> Option<&str> {
        let name = self.name.as_deref()?;
        let root = name.split(['.', ':']).next()?;
        let first = root.chars().next()?;
        (first.is_ascii_uppercase() || name.contains('.') || first == '_' || first == '$')
            .then_some(root)
            .filter(|r| *r != "this")
    }
}

/// Flat table of every JSX node in a file.
#[derive(Debug, Default)]
pub struct JsxTable {
    pub nodes: Vec<JsxNode>,
    index: HashMap<(String, Vec<u32>), usize>,
}

impl JsxTable {
    pub fn build(program: &Program<'_>) -> Self {
        let mut c = Collector { src: program.source_text, ..Collector::default() };
        for stmt in &program.body {
            match stmt {
                Statement::VariableDeclaration(decl) => c.visit_declarators(decl),
                Statement::ExportDeclaration(export) => match &export.declaration {
                    Declaration::VariableDeclaration(decl) => c.visit_declarators(decl),
                    _ => {
                        c.scope = statement_scope(stmt);
                        c.visit_statement(stmt);
                    }
                },
                _ => {
                    c.scope = statement_scope(stmt);
                    c.visit_statement(stmt);
                }
            }
        }
        let index = c
            .nodes
            .iter()
            .enumerate()
            .map(|(i, n)| ((n.scope.clone(), n.path.clone()), i))
            .collect();
        Self { nodes: c.nodes, index }
    }

    pub fn find(&self, scope: &str, path: &[u32]) -> Option<usize> {
        self.index.get(&(scope.to_string(), path.to_vec())).copied()
    }

    pub fn resolve(&self, loc: &Locator) -> Result<usize> {
        self.find(&loc.scope, &loc.path).ok_or_else(|| EngineError::NodeNotFound(loc.to_string()))
    }

    /// Resolve and, when `expected` is given, check the tag name still matches.
    pub fn resolve_expected(&self, loc: &Locator, expected: Option<&str>) -> Result<usize> {
        let idx = self.resolve(loc)?;
        if let Some(expected) = expected {
            let found = self.nodes[idx].display_name();
            if found != expected {
                return Err(EngineError::StaleLocator {
                    locator: loc.to_string(),
                    expected: expected.to_string(),
                    found: found.to_string(),
                });
            }
        }
        Ok(idx)
    }

    pub fn locator(&self, idx: usize, file: &str) -> Locator {
        let n = &self.nodes[idx];
        Locator { file: file.to_string(), scope: n.scope.clone(), path: n.path.clone() }
    }

    /// Outermost node starting exactly at `start`.
    pub fn node_starting_at(&self, start: u32) -> Option<usize> {
        self.nodes.iter().position(|n| n.span.start == start)
    }

    /// Every node in the subtree rooted at `idx` (including `idx`).
    pub fn subtree(&self, idx: usize) -> Vec<usize> {
        let mut out = vec![idx];
        let mut i = 0;
        while i < out.len() {
            out.extend(self.nodes[out[i]].children.iter().copied());
            i += 1;
        }
        out
    }
}

fn statement_scope(stmt: &Statement<'_>) -> String {
    fn named(id: Option<&BindingIdentifier<'_>>, fallback: &str) -> String {
        id.map_or_else(|| fallback.to_string(), |id| id.name.as_str().to_string())
    }
    match stmt {
        Statement::FunctionDeclaration(f) => named(f.id.as_ref(), "default"),
        Statement::ClassDeclaration(c) => named(c.id.as_ref(), "default"),
        Statement::ExportDeclaration(e) => match &e.declaration {
            Declaration::FunctionDeclaration(f) => named(f.id.as_ref(), "module"),
            Declaration::ClassDeclaration(c) => named(c.id.as_ref(), "module"),
            _ => "module".into(),
        },
        Statement::ExportDefaultDeclaration(e) => match &e.declaration {
            ExportDefaultDeclarationKind::FunctionDeclaration(f) => named(f.id.as_ref(), "default"),
            ExportDefaultDeclarationKind::ClassDeclaration(c) => named(c.id.as_ref(), "default"),
            _ => "default".into(),
        },
        _ => "module".into(),
    }
}

#[derive(Default)]
struct Collector<'s> {
    src: &'s str,
    nodes: Vec<JsxNode>,
    stack: Vec<usize>,
    scope: String,
    root_counters: HashMap<String, u32>,
    next_is_direct: bool,
}

impl Collector<'_> {
    fn visit_declarators(&mut self, decl: &VariableDeclaration<'_>) {
        for d in &decl.declarations {
            self.scope = match &d.id {
                BindingPattern::BindingIdentifier(id) => id.name.as_str().to_string(),
                _ => "module".into(),
            };
            self.visit_variable_declarator(d);
        }
    }

    fn push(&mut self, mut node: JsxNode) -> usize {
        let direct = std::mem::take(&mut self.next_is_direct);
        let idx = self.nodes.len();
        match self.stack.last().copied() {
            Some(parent) => {
                let i = self.nodes[parent].children.len() as u32;
                node.path = self.nodes[parent].path.clone();
                node.path.push(i);
                node.parent = Some(parent);
                node.direct = direct;
                self.nodes[parent].children.push(idx);
            }
            None => {
                let counter = self.root_counters.entry(self.scope.clone()).or_insert(0);
                node.path = vec![*counter];
                *counter += 1;
                node.direct = false;
            }
        }
        node.scope = self.scope.clone();
        self.nodes.push(node);
        idx
    }

    fn visit_children<'a>(&mut self, idx: usize, children: &[JSXChild<'a>]) {
        for child in children {
            let content = match child {
                JSXChild::Text(t) if t.value.trim().is_empty() => None,
                JSXChild::Element(_) | JSXChild::Fragment(_) => {
                    self.next_is_direct = true;
                    Some(Content { span: child.span(), node: Some(self.nodes.len()) })
                }
                _ => Some(Content { span: child.span(), node: None }),
            };
            self.visit_jsx_child(child);
            self.next_is_direct = false;
            if let Some(content) = content {
                self.nodes[idx].content.push(content);
            }
        }
    }

    fn attributes(&self, opening: &JSXOpeningElement<'_>) -> Vec<Attr> {
        opening
            .attributes
            .iter()
            .map(|item| match item {
                JSXAttributeItem::SpreadAttribute(s) => {
                    Attr { name: None, span: s.span, name_end: s.span.end, value: None }
                }
                JSXAttributeItem::Attribute(a) => {
                    let name_span = a.name.span();
                    let value = a.value.as_ref().map(|v| match v {
                        JSXAttributeValue::StringLiteral(s) => {
                            AttrValue::String { span: s.span, value: s.value.as_str().to_string() }
                        }
                        JSXAttributeValue::ExpressionContainer(c) => {
                            let expr_span = c.expression.span();
                            AttrValue::Expression {
                                span: c.span,
                                source: self.src[expr_span.start as usize..expr_span.end as usize]
                                    .to_string(),
                                literal: literal_value(&c.expression),
                            }
                        }
                        JSXAttributeValue::Element(e) => AttrValue::Element { span: e.span },
                        JSXAttributeValue::Fragment(f) => AttrValue::Element { span: f.span },
                    });
                    Attr {
                        name: Some(self.src[name_span.start as usize..name_span.end as usize].to_string()),
                        span: a.span,
                        name_end: name_span.end,
                        value,
                    }
                }
            })
            .collect()
    }
}

impl<'a> Visit<'a> for Collector<'_> {
    fn visit_jsx_element(&mut self, it: &JSXElement<'a>) {
        let opening = &it.opening_element;
        let name_span = opening.name.span();
        let attr_insert = opening.type_arguments.as_ref().map_or(name_span.end, |t| t.span.end);
        let node = JsxNode {
            scope: String::new(),
            path: Vec::new(),
            kind: NodeKind::Element,
            name: Some(self.src[name_span.start as usize..name_span.end as usize].to_string()),
            span: it.span,
            opening: opening.span,
            closing: it.closing_element.as_ref().map(|c| c.span),
            attr_insert,
            attributes: self.attributes(opening),
            parent: None,
            direct: false,
            children: Vec::new(),
            content: Vec::new(),
        };
        let idx = self.push(node);
        self.stack.push(idx);
        // Attribute values may hold JSX: it belongs to this element but is not direct.
        self.visit_jsx_opening_element(opening);
        self.visit_children(idx, &it.children);
        self.stack.pop();
    }

    fn visit_jsx_fragment(&mut self, it: &JSXFragment<'a>) {
        let node = JsxNode {
            scope: String::new(),
            path: Vec::new(),
            kind: NodeKind::Fragment,
            name: None,
            span: it.span,
            opening: it.opening_fragment.span,
            closing: Some(it.closing_fragment.span),
            attr_insert: it.opening_fragment.span.end - 1,
            attributes: Vec::new(),
            parent: None,
            direct: false,
            children: Vec::new(),
            content: Vec::new(),
        };
        let idx = self.push(node);
        self.stack.push(idx);
        self.visit_children(idx, &it.children);
        self.stack.pop();
    }
}

fn literal_value(expr: &JSXExpression<'_>) -> Option<serde_json::Value> {
    use serde_json::Value;
    match expr {
        JSXExpression::BooleanLiteral(b) => Some(Value::Bool(b.value)),
        JSXExpression::NullLiteral(_) => Some(Value::Null),
        JSXExpression::NumericLiteral(n) => serde_json::Number::from_f64(n.value).map(Value::Number),
        JSXExpression::StringLiteral(s) => Some(Value::String(s.value.as_str().to_string())),
        JSXExpression::TemplateLiteral(t) if t.expressions.is_empty() => {
            t.quasis.first().and_then(|q| q.value.cooked.as_ref()).map(|c| Value::String(c.as_str().to_string()))
        }
        JSXExpression::UnaryExpression(u) if u.operator == oxc_ast::ast::UnaryOperator::UnaryNegation => {
            match &u.argument {
                Expression::NumericLiteral(n) => serde_json::Number::from_f64(-n.value).map(Value::Number),
                _ => None,
            }
        }
        _ => None,
    }
}

/// Attribute name the Vite plugin injects.
pub const ATTR: &str = "data-ast-node";

/// An insertion the Vite plugin applies to stamp a locator onto an opening tag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Insertion {
    /// UTF-8 byte offset into the original source.
    pub offset: u32,
    pub text: String,
}

/// Compute the `data-ast-node` insertions for a file. The attribute goes first (right after
/// the tag name) so that a usage-site value passed down through `{...props}` overrides the
/// definition-site one inside wrapper components such as shadcn's `<Button>`.
///
/// Fragments are skipped (they cannot carry attributes) but still take their index.
pub fn annotate(program: &Program<'_>, file: &str) -> Vec<Insertion> {
    let table = JsxTable::build(program);
    table
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, n)| {
            n.kind == NodeKind::Element
                && !matches!(n.name.as_deref(), Some("Fragment" | "React.Fragment"))
                && !n.attributes.iter().any(|a| a.name.as_deref() == Some(ATTR))
        })
        .map(|(i, _)| {
            let loc = table.locator(i, file).to_string();
            Insertion {
                offset: table.nodes[i].attr_insert,
                text: format!(" {ATTR}=\"{}\"", escape_attr(&loc)),
            }
        })
        .collect()
}

/// Apply [`annotate`] insertions, for tests and non-Vite consumers.
pub fn annotate_source(program: &Program<'_>, file: &str) -> Result<String> {
    let edits: Vec<Edit> = annotate(program, file).into_iter().map(|i| Edit::insert(i.offset, i.text)).collect();
    Ok(text::apply_edits(program.source_text, &edits)?.0)
}

fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('"', "&quot;")
}
