//! Values: object and array literals in the source, addressed by name and key rather than by
//! position, so that framework adapters (Refine's `useTable` columns, a zod schema, a form's
//! `defaultValues`) can read and edit them with the same byte-preserving splices as JSX.
//!
//! A value path is `<file>#<scope>#<head><step>*`:
//! * `scope` is a top-level function (component or hook) named as JSX locators name it, or
//!   `module` for the file's top level;
//! * `head` is a `const`/`let` binding at the top level of that scope's body (`columns`), the
//!   first call there to a function of that name (`useForm()`), or the first JSX element of that
//!   name in the scope (`<Refine>`), whose first step names an attribute
//!   (`<Refine>.resources`: the expression in `resources={…}`);
//! * a step is `.prop` (an object property), `[key=value]` (the array element that is an
//!   object whose `key` is the string `value`) or `[i]` (the `i`-th element).
//!
//! Before each step, and at the end when an edit needs an object or array, the value is
//! unwrapped to the literal it holds: parentheses and TS `as`/`satisfies`/`!` go, a function
//! becomes what it returns, a call becomes its first argument. So `columns` reaches the array
//! in `useMemo(() => [...], [])`, and `schema` the object in `z.object({...})`.
//!
//! Keyed steps are their own stale guard: when the element is gone or renamed, the path no
//! longer resolves and the edit fails instead of touching a neighbour.

use std::fmt;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    ArrayExpressionElement, BindingPattern, Declaration, Expression, ExportDefaultDeclarationKind, ObjectPropertyKind,
    Program, Statement,
};
use oxc_span::{GetSpan, Span};
use serde::Serialize;

use crate::error::{EngineError, Result};
use crate::parse;
use crate::text;

/// The scope name for a file's top level.
pub const MODULE_SCOPE: &str = "module";

/// Deepest a description goes into nested literals; deeper values are summarized.
const MAX_DESCRIBE_DEPTH: usize = 8;
/// Longest source excerpt a description carries.
const MAX_EXCERPT: usize = 600;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Head {
    Binding(String),
    Call(String),
    /// The first JSX element with this tag name in the scope; the next step is an attribute.
    Element(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    Prop(String),
    Key { key: String, value: String },
    Index(usize),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValuePath {
    pub file: String,
    pub scope: String,
    pub head: Head,
    pub steps: Vec<Step>,
}

impl ValuePath {
    pub fn parse(s: &str) -> Result<Self> {
        let invalid = || EngineError::InvalidValuePath(s.to_string());
        let mut parts = s.splitn(3, '#');
        let (Some(file), Some(scope), Some(rest)) = (parts.next(), parts.next(), parts.next()) else {
            return Err(invalid());
        };
        if file.is_empty() || !is_identifier(scope) {
            return Err(invalid());
        }
        let head_end = if rest.starts_with('<') {
            rest.find('>').map_or(rest.len(), |i| i + 1)
        } else {
            rest.find(['.', '[']).unwrap_or(rest.len())
        };
        let (head_text, mut steps_text) = rest.split_at(head_end);
        let head = if let Some(tag) = head_text.strip_prefix('<').and_then(|t| t.strip_suffix('>')) {
            if !tag.split('.').all(is_identifier) {
                return Err(invalid());
            }
            Head::Element(tag.to_string())
        } else {
            match head_text.strip_suffix("()") {
                Some(callee) if is_identifier(callee) => Head::Call(callee.to_string()),
                None if is_identifier(head_text) => Head::Binding(head_text.to_string()),
                _ => return Err(invalid()),
            }
        };
        let mut steps = Vec::new();
        while !steps_text.is_empty() {
            if let Some(after) = steps_text.strip_prefix('.') {
                let end = after.find(['.', '[']).unwrap_or(after.len());
                let prop = &after[..end];
                if !is_identifier(prop) {
                    return Err(invalid());
                }
                steps.push(Step::Prop(prop.to_string()));
                steps_text = &after[end..];
            } else if let Some(after) = steps_text.strip_prefix('[') {
                let end = after.find(']').ok_or_else(invalid)?;
                let inner = &after[..end];
                let step = match inner.split_once('=') {
                    Some((key, value)) if is_identifier(key) && !value.is_empty() => {
                        Step::Key { key: key.to_string(), value: value.to_string() }
                    }
                    None if !inner.is_empty() && inner.bytes().all(|b| b.is_ascii_digit()) => {
                        Step::Index(inner.parse().map_err(|_| invalid())?)
                    }
                    _ => return Err(invalid()),
                };
                steps.push(step);
                steps_text = &after[end + 1..];
            } else {
                return Err(invalid());
            }
        }
        Ok(Self { file: file.to_string(), scope: scope.to_string(), head, steps })
    }

    /// This path with one more step.
    pub fn child(&self, step: Step) -> Self {
        let mut out = self.clone();
        out.steps.push(step);
        out
    }
}

impl fmt::Display for ValuePath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}#{}#", self.file, self.scope)?;
        match &self.head {
            Head::Binding(name) => write!(f, "{name}")?,
            Head::Call(callee) => write!(f, "{callee}()")?,
            Head::Element(tag) => write!(f, "<{tag}>")?,
        }
        for step in &self.steps {
            match step {
                Step::Prop(p) => write!(f, ".{p}")?,
                Step::Key { key, value } => write!(f, "[{key}={value}]")?,
                Step::Index(i) => write!(f, "[{i}]")?,
            }
        }
        Ok(())
    }
}

pub(crate) fn is_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// Where a resolved value sits in its container, for edits that remove or move it.
#[derive(Clone, Copy)]
pub(crate) struct Slot<'p, 'a> {
    /// The object or array literal holding it.
    pub container: &'p Expression<'a>,
    /// Its index among the container's items (properties or elements).
    pub index: usize,
}

/// A path resolved in a parsed file.
pub(crate) struct Resolved<'p, 'a> {
    /// The value as written (not unwrapped).
    pub expr: &'p Expression<'a>,
    /// Its place in an enclosing literal, when the last step selected one.
    pub slot: Option<Slot<'p, 'a>>,
}

/// The statements to search for a scope's bindings and calls.
enum ScopeBody<'p, 'a> {
    Statements(&'p [Statement<'a>]),
    /// A concise arrow body: no bindings, but calls may still be in it.
    Expression(&'p Expression<'a>),
}

/// Resolve `path` in `program` (which must be the path's file).
pub(crate) fn resolve<'p, 'a>(program: &'p Program<'a>, path: &ValuePath) -> Result<Resolved<'p, 'a>> {
    let missing = |why: String| EngineError::ValueNotFound { path: path.to_string(), why };
    let body = scope_body(program, &path.scope).ok_or_else(|| {
        missing(format!("no top-level function `{}` in {} (scopes are named as JSX locators name them)", path.scope, path.file))
    })?;
    let mut steps = path.steps.as_slice();
    let mut expr = match &path.head {
        Head::Binding(name) => find_binding(&body, name)
            .ok_or_else(|| missing(format!("`{name}` is not a binding with a value at the top of `{}`", path.scope)))?,
        Head::Call(callee) => find_call(&body, callee)
            .ok_or_else(|| missing(format!("`{}` makes no call to `{callee}` at its top level", path.scope)))?,
        Head::Element(tag) => {
            let Some((Step::Prop(attr), rest)) = steps.split_first() else {
                return Err(EngineError::InvalidValuePath(format!("{path} (after <{tag}> comes the attribute: <{tag}>.name)")));
            };
            steps = rest;
            element_attribute(program, &path.file, &path.scope, tag, attr).map_err(missing)?
        }
    };
    let mut slot = None;
    for step in steps {
        let container = unwrap_literal(expr);
        match step {
            Step::Prop(prop) => {
                let Expression::ObjectExpression(obj) = container else {
                    return Err(missing(format!("`.{prop}` needs an object, but the value there is {}", kind_name(container))));
                };
                let (index, value) = obj
                    .properties
                    .iter()
                    .enumerate()
                    .find_map(|(i, p)| match p {
                        ObjectPropertyKind::ObjectProperty(p) if !p.computed && p.key.static_name().as_deref() == Some(prop) => {
                            Some((i, &p.value))
                        }
                        _ => None,
                    })
                    .ok_or_else(|| missing(format!("the object has no property `{prop}`")))?;
                expr = value;
                slot = Some(Slot { container, index });
            }
            Step::Key { key, value } => {
                let Expression::ArrayExpression(arr) = container else {
                    return Err(missing(format!("`[{key}=…]` needs an array, but the value there is {}", kind_name(container))));
                };
                let mut hits = arr.elements.iter().enumerate().filter_map(|(i, e)| {
                    let e = e.as_expression()?;
                    (string_property(e, key).as_deref() == Some(value.as_str())).then_some((i, e))
                });
                let (index, element) = hits.next().ok_or_else(|| missing(format!("no element has {key} \"{value}\"")))?;
                if hits.next().is_some() {
                    return Err(EngineError::Unsupported(format!(
                        "`{path}` is ambiguous: more than one element has {key} \"{value}\""
                    )));
                }
                expr = element;
                slot = Some(Slot { container, index });
            }
            Step::Index(i) => {
                let Expression::ArrayExpression(arr) = container else {
                    return Err(missing(format!("`[{i}]` needs an array, but the value there is {}", kind_name(container))));
                };
                let element = arr.elements.get(*i).ok_or_else(|| {
                    missing(format!("the array has {} elements", arr.elements.len()))
                })?;
                expr = element
                    .as_expression()
                    .ok_or_else(|| missing(format!("element {i} is a spread or a hole, not a value")))?;
                slot = Some(Slot { container, index: *i });
            }
        }
    }
    Ok(Resolved { expr, slot })
}

/// The expression of attribute `attr` (`attr={…}`) on the first `<tag>` element in `scope`.
fn element_attribute<'p, 'a>(
    program: &'p Program<'a>,
    file: &str,
    scope: &str,
    tag: &str,
    attr: &str,
) -> std::result::Result<&'p Expression<'a>, String> {
    let table = crate::locator::JsxTable::build(program, file).map_err(|e| e.to_string())?;
    let in_scope = |n: &crate::locator::JsxNode| scope == MODULE_SCOPE || n.scope == scope;
    let node = table
        .nodes
        .iter()
        .find(|n| in_scope(n) && n.name.as_deref() == Some(tag))
        .ok_or_else(|| format!("`{scope}` renders no <{tag}>"))?;
    let at = node
        .attributes
        .iter()
        .find(|a| a.name.as_deref() == Some(attr))
        .ok_or_else(|| format!("<{tag}> has no `{attr}` attribute"))?;
    if !matches!(at.value, Some(crate::locator::AttrValue::Expression { .. })) {
        return Err(format!("<{tag}>'s `{attr}` is not a `{{…}}` expression"));
    }
    descend::attribute(program, at.span)
        .and_then(|a| match &a.value {
            Some(oxc_ast::ast::JSXAttributeValue::ExpressionContainer(c)) => c.expression.as_expression(),
            _ => None,
        })
        .ok_or_else(|| format!("<{tag}>'s `{attr}` holds no expression Trivia can reach"))
}

/// Find a node by span, stepping at each level into the child that contains it. Covers where
/// JSX sits in components: statements and declarations, returns, function bodies, calls,
/// conditionals, logical and TS wrappers, literals, and JSX attributes and children.
mod descend {
    use oxc_ast::ast::{
        Declaration, ExportDefaultDeclarationKind, Expression, JSXAttribute, JSXAttributeItem, JSXAttributeValue, JSXChild,
        JSXElement, ObjectPropertyKind, Program, Statement,
    };
    use oxc_span::{GetSpan, Span};

    pub fn attribute<'p, 'a>(program: &'p Program<'a>, target: Span) -> Option<&'p JSXAttribute<'a>> {
        statements(&program.body, target)
    }

    fn holds(outer: Span, target: Span) -> bool {
        outer.start <= target.start && target.end <= outer.end
    }

    fn statements<'p, 'a>(stmts: &'p [Statement<'a>], target: Span) -> Option<&'p JSXAttribute<'a>> {
        stmts.iter().find(|s| holds(s.span(), target)).and_then(|s| statement(s, target))
    }

    fn statement<'p, 'a>(stmt: &'p Statement<'a>, target: Span) -> Option<&'p JSXAttribute<'a>> {
        match stmt {
            Statement::ExpressionStatement(s) => expression(&s.expression, target),
            Statement::ReturnStatement(r) => r.argument.as_ref().and_then(|e| expression(e, target)),
            Statement::BlockStatement(b) => statements(&b.body, target),
            Statement::IfStatement(i) => {
                if holds(i.consequent.span(), target) {
                    statement(&i.consequent, target)
                } else {
                    i.alternate.as_ref().and_then(|a| statement(a, target))
                }
            }
            Statement::VariableDeclaration(d) => declarators(&d.declarations, target),
            Statement::FunctionDeclaration(f) => f.body.as_ref().and_then(|b| statements(&b.statements, target)),
            Statement::ExportDeclaration(e) => match &e.declaration {
                Declaration::FunctionDeclaration(f) => f.body.as_ref().and_then(|b| statements(&b.statements, target)),
                Declaration::VariableDeclaration(d) => declarators(&d.declarations, target),
                _ => None,
            },
            Statement::ExportDefaultDeclaration(e) => match &e.declaration {
                ExportDefaultDeclarationKind::FunctionDeclaration(f) => f.body.as_ref().and_then(|b| statements(&b.statements, target)),
                kind => kind.as_expression().and_then(|x| expression(x, target)),
            },
            _ => None,
        }
    }

    fn declarators<'p, 'a>(decls: &'p [oxc_ast::ast::VariableDeclarator<'a>], target: Span) -> Option<&'p JSXAttribute<'a>> {
        decls.iter().find(|d| holds(d.span, target)).and_then(|d| d.init.as_ref()).and_then(|e| expression(e, target))
    }

    fn expression<'p, 'a>(e: &'p Expression<'a>, target: Span) -> Option<&'p JSXAttribute<'a>> {
        if !holds(e.span(), target) {
            return None;
        }
        match e {
            Expression::ParenthesizedExpression(p) => expression(&p.expression, target),
            Expression::TSAsExpression(x) => expression(&x.expression, target),
            Expression::TSSatisfiesExpression(x) => expression(&x.expression, target),
            Expression::TSNonNullExpression(x) => expression(&x.expression, target),
            Expression::JSXElement(el) => element(el, target),
            Expression::JSXFragment(f) => children(&f.children, target),
            Expression::ArrowFunctionExpression(a) => match (a.get_expression(), a.get_function_body()) {
                (Some(x), _) => expression(x, target),
                (None, Some(b)) => statements(&b.statements, target),
                _ => None,
            },
            Expression::FunctionExpression(f) => f.body.as_ref().and_then(|b| statements(&b.statements, target)),
            Expression::CallExpression(c) => std::iter::once(&c.callee)
                .chain(c.arguments.iter().filter_map(|a| a.as_expression()))
                .find(|x| holds(x.span(), target))
                .and_then(|x| expression(x, target)),
            Expression::ConditionalExpression(c) => [&c.test, &c.consequent, &c.alternate]
                .into_iter()
                .find(|x| holds(x.span(), target))
                .and_then(|x| expression(x, target)),
            Expression::LogicalExpression(l) => {
                if holds(l.left.span(), target) { expression(&l.left, target) } else { expression(&l.right, target) }
            }
            Expression::ArrayExpression(a) => a
                .elements
                .iter()
                .filter_map(|el| el.as_expression())
                .find(|x| holds(x.span(), target))
                .and_then(|x| expression(x, target)),
            Expression::ObjectExpression(o) => o
                .properties
                .iter()
                .find_map(|p| match p {
                    ObjectPropertyKind::ObjectProperty(p) if holds(p.value.span(), target) => Some(&p.value),
                    _ => None,
                })
                .and_then(|x| expression(x, target)),
            _ => None,
        }
    }

    fn element<'p, 'a>(el: &'p JSXElement<'a>, target: Span) -> Option<&'p JSXAttribute<'a>> {
        for item in &el.opening_element.attributes {
            if let JSXAttributeItem::Attribute(a) = item {
                if a.span == target {
                    return Some(a);
                }
                if holds(a.span, target) {
                    return match &a.value {
                        Some(JSXAttributeValue::ExpressionContainer(c)) => c.expression.as_expression().and_then(|x| expression(x, target)),
                        Some(JSXAttributeValue::Element(inner)) => element(inner, target),
                        _ => None,
                    };
                }
            }
        }
        children(&el.children, target)
    }

    fn children<'p, 'a>(kids: &'p [JSXChild<'a>], target: Span) -> Option<&'p JSXAttribute<'a>> {
        kids.iter().find(|c| holds(c.span(), target)).and_then(|c| match c {
            JSXChild::Element(el) => element(el, target),
            JSXChild::Fragment(f) => children(&f.children, target),
            JSXChild::ExpressionContainer(x) => x.expression.as_expression().and_then(|x| expression(x, target)),
            _ => None,
        })
    }
}

/// The string value of `obj.key` when `e` is an object literal with that property.
fn string_property(e: &Expression<'_>, key: &str) -> Option<String> {
    let Expression::ObjectExpression(obj) = e.without_parentheses() else { return None };
    obj.properties.iter().find_map(|p| match p {
        ObjectPropertyKind::ObjectProperty(p) if !p.computed && p.key.static_name().as_deref() == Some(key) => {
            static_string(&p.value)
        }
        _ => None,
    })
}

fn static_string(e: &Expression<'_>) -> Option<String> {
    match e.without_parentheses() {
        Expression::StringLiteral(s) => Some(s.value.to_string()),
        Expression::TemplateLiteral(t) => t.single_quasi().map(|q| q.to_string()),
        _ => None,
    }
}

/// Follow wrappers down to the literal a value holds (see the module docs), or the value
/// itself when it holds none.
pub(crate) fn unwrap_literal<'p, 'a>(mut e: &'p Expression<'a>) -> &'p Expression<'a> {
    loop {
        e = match e {
            Expression::ParenthesizedExpression(p) => &p.expression,
            Expression::TSAsExpression(x) => &x.expression,
            Expression::TSSatisfiesExpression(x) => &x.expression,
            Expression::TSNonNullExpression(x) => &x.expression,
            Expression::TSTypeAssertion(x) => &x.expression,
            Expression::ArrowFunctionExpression(arrow) => match (arrow.get_expression(), arrow.get_function_body()) {
                (Some(expr), _) => expr,
                (None, Some(body)) => match returned(&body.statements) {
                    Some(expr) => expr,
                    None => return e,
                },
                (None, None) => return e,
            },
            Expression::FunctionExpression(f) => match f.body.as_deref().and_then(|b| returned(&b.statements)) {
                Some(expr) => expr,
                None => return e,
            },
            Expression::CallExpression(call) => match call.arguments.first().and_then(|a| a.as_expression()) {
                Some(arg) => arg,
                None => return e,
            },
            _ => return e,
        };
    }
}

/// The callees a value goes through on the way to its literal (`useMemo`, `z.object`).
fn via(mut e: &Expression<'_>) -> Vec<String> {
    let mut out = Vec::new();
    loop {
        e = match e {
            Expression::ParenthesizedExpression(p) => &p.expression,
            Expression::TSAsExpression(x) => &x.expression,
            Expression::TSSatisfiesExpression(x) => &x.expression,
            Expression::TSNonNullExpression(x) => &x.expression,
            Expression::TSTypeAssertion(x) => &x.expression,
            Expression::ArrowFunctionExpression(arrow) => match (arrow.get_expression(), arrow.get_function_body()) {
                (Some(expr), _) => expr,
                (None, Some(body)) => match returned(&body.statements) {
                    Some(expr) => expr,
                    None => return out,
                },
                (None, None) => return out,
            },
            Expression::CallExpression(call) => match call.arguments.first().and_then(|a| a.as_expression()) {
                Some(arg) => {
                    out.push(callee_text(&call.callee));
                    arg
                }
                None => return out,
            },
            _ => return out,
        };
    }
}

/// What a function body returns: its last top-level `return`'s argument.
fn returned<'p, 'a>(statements: &'p [Statement<'a>]) -> Option<&'p Expression<'a>> {
    statements.iter().rev().find_map(|s| match s {
        Statement::ReturnStatement(r) => r.argument.as_ref(),
        _ => None,
    })
}

fn callee_text(callee: &Expression<'_>) -> String {
    match callee.without_parentheses() {
        Expression::Identifier(id) => id.name.to_string(),
        Expression::StaticMemberExpression(m) => format!("{}.{}", callee_text(&m.object), m.property.name),
        _ => "…".into(),
    }
}

fn scope_body<'p, 'a>(program: &'p Program<'a>, scope: &str) -> Option<ScopeBody<'p, 'a>> {
    if scope == MODULE_SCOPE {
        return Some(ScopeBody::Statements(&program.body));
    }
    program.body.iter().find_map(|stmt| scope_of(stmt).filter(|(name, _)| name == scope).map(|(_, body)| body))
}

/// The scope a top-level statement defines, with its body: function declarations (exported or
/// default), and `const X = () => …` / `function` expressions, possibly wrapped in a call
/// (`memo`, `forwardRef`).
fn scope_of<'p, 'a>(stmt: &'p Statement<'a>) -> Option<(String, ScopeBody<'p, 'a>)> {
    let function = |f: &'p oxc_ast::ast::Function<'a>, fallback: &str| {
        let name = f.id.as_ref().map_or_else(|| fallback.to_string(), |id| id.name.to_string());
        f.body.as_deref().map(|b| (name, ScopeBody::Statements(&b.statements)))
    };
    let declarators = |decl: &'p oxc_ast::ast::VariableDeclaration<'a>| {
        decl.declarations.iter().find_map(|d| {
            let BindingPattern::BindingIdentifier(id) = &d.id else { return None };
            callable_body(d.init.as_ref()?).map(|body| (id.name.to_string(), body))
        })
    };
    match stmt {
        Statement::FunctionDeclaration(f) => function(f, "default"),
        Statement::VariableDeclaration(decl) => declarators(decl),
        Statement::ExportDeclaration(e) => match &e.declaration {
            Declaration::FunctionDeclaration(f) => function(f, "module"),
            Declaration::VariableDeclaration(decl) => declarators(decl),
            _ => None,
        },
        Statement::ExportDefaultDeclaration(e) => match &e.declaration {
            ExportDefaultDeclarationKind::FunctionDeclaration(f) => function(f, "default"),
            kind => kind.as_expression().and_then(callable_body).map(|body| ("default".to_string(), body)),
        },
        _ => None,
    }
}

fn callable_body<'p, 'a>(e: &'p Expression<'a>) -> Option<ScopeBody<'p, 'a>> {
    match e.without_parentheses() {
        Expression::ArrowFunctionExpression(arrow) => match (arrow.get_function_body(), arrow.get_expression()) {
            (Some(body), _) => Some(ScopeBody::Statements(&body.statements)),
            (None, Some(expr)) => Some(ScopeBody::Expression(expr)),
            (None, None) => None,
        },
        Expression::FunctionExpression(f) => f.body.as_deref().map(|b| ScopeBody::Statements(&b.statements)),
        Expression::CallExpression(call) => call.arguments.first().and_then(|a| a.as_expression()).and_then(callable_body),
        _ => None,
    }
}

/// The variable declarations at the top of a scope's body (the module's include exported ones).
fn declarations<'p, 'a>(
    body: &ScopeBody<'p, 'a>,
) -> impl Iterator<Item = &'p oxc_ast::ast::VariableDeclarator<'a>> + use<'p, 'a> {
    let statements: &'p [Statement<'a>] = match body {
        ScopeBody::Statements(s) => s,
        ScopeBody::Expression(_) => &[],
    };
    statements
        .iter()
        .filter_map(|s| match s {
            Statement::VariableDeclaration(d) => Some(&**d),
            Statement::ExportDeclaration(e) => match &e.declaration {
                Declaration::VariableDeclaration(d) => Some(&**d),
                _ => None,
            },
            _ => None,
        })
        .flat_map(|d| d.declarations.iter())
}

fn find_binding<'p, 'a>(body: &ScopeBody<'p, 'a>, name: &str) -> Option<&'p Expression<'a>> {
    declarations(body).find_map(|d| match &d.id {
        BindingPattern::BindingIdentifier(id) if id.name == name => d.init.as_ref(),
        _ => None,
    })
}

/// The top-level calls of a scope: declarator values and expression statements that are calls.
fn top_calls<'p, 'a>(body: &ScopeBody<'p, 'a>) -> Vec<(&'p Expression<'a>, Option<&'p BindingPattern<'a>>)> {
    let mut out: Vec<(&'p Expression<'a>, Option<&'p BindingPattern<'a>>)> = Vec::new();
    let mut push = |e: &'p Expression<'a>, binding: Option<&'p BindingPattern<'a>>| {
        let inner = match e.without_parentheses() {
            Expression::AwaitExpression(a) => &a.argument,
            other => other,
        };
        if matches!(inner.get_inner_expression(), Expression::CallExpression(_)) {
            out.push((inner.get_inner_expression(), binding));
        }
    };
    match body {
        ScopeBody::Expression(e) => push(e, None),
        ScopeBody::Statements(statements) => {
            for stmt in statements.iter() {
                match stmt {
                    Statement::ExpressionStatement(s) => push(&s.expression, None),
                    Statement::VariableDeclaration(d) => {
                        for d in &d.declarations {
                            if let Some(init) = &d.init {
                                push(init, Some(&d.id));
                            }
                        }
                    }
                    Statement::ExportDeclaration(e) => {
                        if let Declaration::VariableDeclaration(d) = &e.declaration {
                            for d in &d.declarations {
                                if let Some(init) = &d.init {
                                    push(init, Some(&d.id));
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    out
}

fn find_call<'p, 'a>(body: &ScopeBody<'p, 'a>, callee: &str) -> Option<&'p Expression<'a>> {
    top_calls(body).into_iter().map(|(e, _)| e).find(|e| match e {
        Expression::CallExpression(call) => callee_text(&call.callee) == callee,
        _ => false,
    })
}

fn kind_name(e: &Expression<'_>) -> &'static str {
    match e {
        Expression::ObjectExpression(_) => "an object",
        Expression::ArrayExpression(_) => "an array",
        Expression::StringLiteral(_) | Expression::TemplateLiteral(_) => "a string",
        Expression::NumericLiteral(_) => "a number",
        Expression::BooleanLiteral(_) => "a boolean",
        Expression::NullLiteral(_) => "null",
        Expression::Identifier(_) => "an identifier",
        Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => "a function",
        Expression::CallExpression(_) => "a call",
        Expression::JSXElement(_) | Expression::JSXFragment(_) => "JSX",
        _ => "an expression",
    }
}

// ---------------------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------------------

/// A value, described for adapters: literals exactly, everything else as a kind and an
/// excerpt of its source.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ValueDesc {
    String { value: String },
    Number { value: f64 },
    Boolean { value: bool },
    Null,
    Identifier { name: String },
    Object { properties: Vec<PropertyDesc> },
    Array { elements: Vec<Value> },
    Function { source: String },
    Call { callee: String, source: String },
    Jsx { source: String },
    Other { source: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Value {
    /// 1-based line where the value starts.
    pub line: u32,
    #[serde(flatten)]
    pub desc: ValueDesc,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyDesc {
    /// The property name; `...` for a spread.
    pub key: String,
    pub line: u32,
    pub value: Value,
}

/// A top-level binding of a scope, unwrapped to its literal.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingValue {
    pub name: String,
    /// Its value path.
    pub path: String,
    pub line: u32,
    /// Callees the value goes through to reach its literal, outermost first.
    pub via: Vec<String>,
    pub value: Value,
}

/// A top-level hook call of a scope (`useTable(...)`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallValue {
    pub callee: String,
    /// Its value path (`…#useTable()`): steps from it go into the first argument.
    pub path: String,
    pub line: u32,
    /// The type arguments as written (`<CustomerDto>` → `CustomerDto`).
    pub type_args: Vec<String>,
    /// The name its result is bound to, when it is a plain binding.
    pub binding: Option<String>,
    pub args: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeValues {
    pub scope: String,
    pub bindings: Vec<BindingValue>,
    /// Calls to hooks (`use…`), in source order.
    pub calls: Vec<CallValue>,
}

/// Every scope of `file` with its top-level bindings and hook calls: what an adapter needs
/// to find the values it edits. Scopes with neither are left out.
pub fn describe_values(source: &str, file: &str) -> Result<Vec<ScopeValues>> {
    let alloc = Allocator::default();
    let program = parse(&alloc, source, file)?;
    let mut scopes: Vec<(String, ScopeBody<'_, '_>)> = vec![(MODULE_SCOPE.to_string(), ScopeBody::Statements(&program.body))];
    scopes.extend(program.body.iter().filter_map(scope_of));
    let mut out = Vec::new();
    for (scope, body) in scopes {
        let mut bindings = Vec::new();
        for d in declarations(&body) {
            let (BindingPattern::BindingIdentifier(id), Some(init)) = (&d.id, &d.init) else { continue };
            // A function is a scope of its own, not a value (at module level).
            if scope == MODULE_SCOPE && callable_body(init).is_some() && !matches!(init.without_parentheses(), Expression::CallExpression(_)) {
                continue;
            }
            let path = ValuePath { file: file.to_string(), scope: scope.clone(), head: Head::Binding(id.name.to_string()), steps: vec![] };
            bindings.push(BindingValue {
                name: id.name.to_string(),
                path: path.to_string(),
                line: line(source, d.span),
                via: via(init),
                value: describe(source, unwrap_literal(init), 0),
            });
        }
        let mut calls = Vec::new();
        for (e, binding) in top_calls(&body) {
            let Expression::CallExpression(call) = e else { continue };
            let callee = callee_text(&call.callee);
            if !callee.rsplit('.').next().is_some_and(|last| last.starts_with("use")) {
                continue;
            }
            let path = ValuePath { file: file.to_string(), scope: scope.clone(), head: Head::Call(callee.clone()), steps: vec![] };
            calls.push(CallValue {
                callee,
                path: path.to_string(),
                line: line(source, call.span),
                type_args: call
                    .type_arguments
                    .as_ref()
                    .map(|t| t.params.iter().map(|p| source[p.span().start as usize..p.span().end as usize].to_string()).collect())
                    .unwrap_or_default(),
                binding: match binding {
                    Some(BindingPattern::BindingIdentifier(id)) => Some(id.name.to_string()),
                    _ => None,
                },
                args: call.arguments.iter().filter_map(|a| a.as_expression()).map(|a| describe(source, a, 0)).collect(),
            });
        }
        if !bindings.is_empty() || !calls.is_empty() {
            out.push(ScopeValues { scope, bindings, calls });
        }
    }
    Ok(out)
}

/// Describe the value at `path` (unwrapped to its literal) in `source`.
pub fn describe_value(source: &str, path: &str) -> Result<Value> {
    let path = ValuePath::parse(path)?;
    let alloc = Allocator::default();
    let program = parse(&alloc, source, &path.file)?;
    let resolved = resolve(&program, &path)?;
    Ok(describe(source, unwrap_literal(resolved.expr), 0))
}

fn line(source: &str, span: Span) -> u32 {
    text::line_col(source, span.start).0
}

fn excerpt(source: &str, span: Span) -> String {
    let text = &source[span.start as usize..span.end as usize];
    if text.len() <= MAX_EXCERPT {
        return text.to_string();
    }
    let mut end = MAX_EXCERPT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

fn describe(source: &str, e: &Expression<'_>, depth: usize) -> Value {
    let at = |desc| Value { line: line(source, e.span()), desc };
    let other = || ValueDesc::Other { source: excerpt(source, e.span()) };
    if depth > MAX_DESCRIBE_DEPTH {
        return at(other());
    }
    at(match e {
        Expression::ParenthesizedExpression(p) => return describe(source, &p.expression, depth),
        Expression::TSAsExpression(x) => return describe(source, &x.expression, depth),
        Expression::TSSatisfiesExpression(x) => return describe(source, &x.expression, depth),
        Expression::TSNonNullExpression(x) => return describe(source, &x.expression, depth),
        Expression::StringLiteral(s) => ValueDesc::String { value: s.value.to_string() },
        Expression::TemplateLiteral(t) => match t.single_quasi() {
            Some(q) => ValueDesc::String { value: q.to_string() },
            None => other(),
        },
        Expression::NumericLiteral(n) => ValueDesc::Number { value: n.value },
        Expression::UnaryExpression(u)
            if u.operator == oxc_syntax::operator::UnaryOperator::UnaryNegation
                && matches!(u.argument, Expression::NumericLiteral(_)) =>
        {
            match &u.argument {
                Expression::NumericLiteral(n) => ValueDesc::Number { value: -n.value },
                _ => other(),
            }
        }
        Expression::BooleanLiteral(b) => ValueDesc::Boolean { value: b.value },
        Expression::NullLiteral(_) => ValueDesc::Null,
        Expression::Identifier(id) => ValueDesc::Identifier { name: id.name.to_string() },
        Expression::ObjectExpression(obj) => ValueDesc::Object {
            properties: obj
                .properties
                .iter()
                .map(|p| match p {
                    ObjectPropertyKind::ObjectProperty(p) => PropertyDesc {
                        key: if p.computed { excerpt(source, p.key.span()) } else { p.key.static_name().map_or_else(|| excerpt(source, p.key.span()), |n| n.to_string()) },
                        line: line(source, p.span),
                        value: describe(source, &p.value, depth + 1),
                    },
                    ObjectPropertyKind::SpreadProperty(s) => PropertyDesc {
                        key: "...".into(),
                        line: line(source, s.span),
                        value: describe(source, &s.argument, depth + 1),
                    },
                })
                .collect(),
        },
        Expression::ArrayExpression(arr) => ValueDesc::Array {
            elements: arr
                .elements
                .iter()
                .map(|el| match el {
                    ArrayExpressionElement::SpreadElement(s) => {
                        Value { line: line(source, s.span), desc: ValueDesc::Other { source: excerpt(source, s.span) } }
                    }
                    ArrayExpressionElement::Elision(h) => Value { line: line(source, h.span), desc: ValueDesc::Other { source: String::new() } },
                    el => match el.as_expression() {
                        Some(x) => describe(source, x, depth + 1),
                        None => Value { line: line(source, el.span()), desc: ValueDesc::Other { source: excerpt(source, el.span()) } },
                    },
                })
                .collect(),
        },
        Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => {
            ValueDesc::Function { source: excerpt(source, e.span()) }
        }
        Expression::CallExpression(call) => ValueDesc::Call { callee: callee_text(&call.callee), source: excerpt(source, e.span()) },
        Expression::JSXElement(_) | Expression::JSXFragment(_) => ValueDesc::Jsx { source: excerpt(source, e.span()) },
        _ => other(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"import { useMemo } from "react";
import { z } from "zod";

const schema = z.object({
  title: z.string().min(2),
  status: z.enum(["draft", "published"]),
});

export function PostList() {
  const columns = useMemo<ColumnDef<Post>[]>(
    () => [
      {
        id: "id",
        accessorKey: "id",
        header: "ID",
      },
      {
        id: "title",
        accessorKey: "title",
        header: ({ column }) => <span>Title</span>,
      },
    ],
    [],
  );

  const table = useTable<Post>({
    columns,
    refineCoreProps: { resource: "posts" },
  });

  return <DataTable table={table} />;
}

export const PostEdit = () => {
  const form = useForm({ defaultValues: { title: "" } });
  return null;
};
"#;

    /// The source of the value at `path`: as written, or unwrapped to its literal.
    fn resolve_text(path: &str, unwrapped: bool) -> String {
        let alloc = Allocator::default();
        let program = parse(&alloc, PAGE, "src/posts.tsx").unwrap();
        let r = resolve(&program, &ValuePath::parse(path).unwrap()).unwrap();
        let span = if unwrapped { unwrap_literal(r.expr).span() } else { r.expr.span() };
        PAGE[span.start as usize..span.end as usize].to_string()
    }

    #[test]
    fn parses_and_prints_paths() {
        for s in [
            "src/a.tsx#PostList#columns",
            "src/a.tsx#PostList#columns[id=title].header",
            "src/a.tsx#module#schema.status",
            "src/a.tsx#PostEdit#useForm().defaultValues.title",
            "src/a.tsx#PostList#columns[0]",
            "src/a.tsx#PostList#columns[accessorKey=category.id]",
            "src/a.tsx#App#<Refine>.resources[name=posts]",
            "src/a.tsx#App#<Foo.Bar>.items",
        ] {
            assert_eq!(ValuePath::parse(s).unwrap().to_string(), s);
        }
        for bad in ["a.tsx#X", "a.tsx#X#", "a.tsx#X#1a", "a.tsx#X#a..b", "a.tsx#X#a[", "a.tsx#X#a[=v]", "a.tsx#X#a[x=]", "a.tsx#1#a", "a.tsx#X#f(x)", "a.tsx#X#<1x>.a", "a.tsx#X#<A"] {
            assert!(ValuePath::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn resolves_through_use_memo_calls_and_keys() {
        assert!(resolve_text("src/posts.tsx#PostList#columns", false).starts_with("useMemo<ColumnDef<Post>[]>("));
        assert!(resolve_text("src/posts.tsx#PostList#columns", true).starts_with("[\n      {\n        id: \"id\""));
        assert_eq!(resolve_text("src/posts.tsx#PostList#columns[id=title].accessorKey", false), "\"title\"");
        assert_eq!(resolve_text("src/posts.tsx#PostList#columns[1].header", false), "({ column }) => <span>Title</span>");
        assert_eq!(resolve_text("src/posts.tsx#PostList#useTable().refineCoreProps.resource", false), "\"posts\"");
        assert_eq!(resolve_text("src/posts.tsx#module#schema.title", false), "z.string().min(2)");
        assert_eq!(resolve_text("src/posts.tsx#module#schema", true).lines().next(), Some("{"));
        assert_eq!(resolve_text("src/posts.tsx#PostEdit#useForm().defaultValues", false), "{ title: \"\" }");
    }

    #[test]
    fn resolves_jsx_attributes() {
        const APP: &str = r#"export default function App() {
  return (
    <BrowserRouter>
      {ready && (
        <Refine
          dataProvider={dataProvider}
          resources={[
            { name: "posts", list: "/posts" },
            { name: "users", list: "/users", meta: { icon: <UserIcon /> } },
          ]}
        >
          <Routes />
        </Refine>
      )}
    </BrowserRouter>
  );
}
"#;
        let alloc = Allocator::default();
        let program = parse(&alloc, APP, "src/App.tsx").unwrap();
        let text = |p: &str| {
            let r = resolve(&program, &ValuePath::parse(p).unwrap()).unwrap();
            APP[r.expr.span().start as usize..r.expr.span().end as usize].to_string()
        };
        assert!(text("src/App.tsx#App#<Refine>.resources").starts_with("[\n            { name: \"posts\""));
        assert_eq!(text("src/App.tsx#App#<Refine>.resources[name=users].list"), "\"/users\"");
        assert_eq!(text("src/App.tsx#App#<Refine>.dataProvider"), "dataProvider");
        let err = |p: &str| resolve(&program, &ValuePath::parse(p).unwrap()).err().unwrap().to_string();
        assert!(err("src/App.tsx#App#<Refine>.nope").contains("<Refine> has no `nope` attribute"));
        assert!(err("src/App.tsx#App#<Admin>.resources").contains("renders no <Admin>"));
        assert!(err("src/App.tsx#App#<Refine>").contains("after <Refine> comes the attribute"));
    }

    #[test]
    fn says_why_a_path_does_not_resolve() {
        let alloc = Allocator::default();
        let program = parse(&alloc, PAGE, "src/posts.tsx").unwrap();
        let err = |p: &str| match resolve(&program, &ValuePath::parse(p).unwrap()) {
            Err(e) => e.to_string(),
            Ok(_) => panic!("{p} resolved"),
        };
        assert!(err("src/posts.tsx#Nope#columns").contains("no top-level function `Nope`"));
        assert!(err("src/posts.tsx#PostList#rows").contains("`rows` is not a binding"));
        assert!(err("src/posts.tsx#PostList#columns[id=status]").contains("no element has id \"status\""));
        assert!(err("src/posts.tsx#PostList#columns[5]").contains("the array has 2 elements"));
        assert!(err("src/posts.tsx#PostList#columns.id").contains("`.id` needs an object, but the value there is an array"));
        assert!(err("src/posts.tsx#PostList#useList()").contains("makes no call to `useList`"));
    }

    #[test]
    fn describes_scopes_bindings_and_hook_calls() {
        let scopes = describe_values(PAGE, "src/posts.tsx").unwrap();
        let names: Vec<&str> = scopes.iter().map(|s| s.scope.as_str()).collect();
        assert_eq!(names, ["module", "PostList", "PostEdit"]);
        let module = &scopes[0];
        assert_eq!(module.bindings.len(), 1, "functions at module level are scopes, not values");
        assert_eq!(module.bindings[0].via, ["z.object"]);
        let list = &scopes[1];
        let columns = list.bindings.iter().find(|b| b.name == "columns").unwrap();
        assert_eq!(columns.path, "src/posts.tsx#PostList#columns");
        assert_eq!(columns.via, ["useMemo"]);
        let json = serde_json::to_value(&columns.value).unwrap();
        assert_eq!(json["kind"], "array");
        assert_eq!(json["elements"][1]["properties"][0], serde_json::json!({ "key": "id", "line": 18, "value": { "kind": "string", "line": 18, "value": "title" } }));
        assert_eq!(json["elements"][1]["properties"][2]["value"]["kind"], "function");
        let table = list.calls.iter().find(|c| c.callee == "useTable").unwrap();
        assert_eq!(table.type_args, ["Post"]);
        assert_eq!(table.binding.as_deref(), Some("table"));
        assert_eq!(table.path, "src/posts.tsx#PostList#useTable()");
        let args = serde_json::to_value(&table.args).unwrap();
        assert_eq!(args[0]["properties"][0]["value"], serde_json::json!({ "kind": "identifier", "line": 27, "name": "columns" }));
        let memo = list.calls.iter().find(|c| c.callee == "useMemo").unwrap();
        assert_eq!(memo.type_args, ["ColumnDef<Post>[]"]);
        assert_eq!(scopes[2].calls[0].callee, "useForm");
    }
}
