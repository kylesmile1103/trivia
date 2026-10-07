//! Bind a JSX element to a TanStack Query v5 `useQuery` hook, by span splicing.
//!
//! Like every engine op, OXC is only used to *find* things; the result is the original text
//! plus a few byte-range edits (CLAUDE.md rule 1). Binding `<DataTable … />` to the
//! hey-api factory `listCustomersOptions` writes:
//!
//! * `const { data: customerData, isLoading: isCustomerLoading } = useQuery({ ...listCustomersOptions(…) })`
//!   as the first statement of the enclosing component. When `optionsArgs` reads the
//!   component's own locals (`{ path: { id } }` after `const { id } = useParams()`), the hook
//!   goes right after the last statement declaring one of them instead, so it never reads a
//!   binding before its declaration. Rules of hooks: always the component's own top-level
//!   body, never a nested callback, never module scope and never after an early `return`.
//! * `import { useQuery } from "@tanstack/react-query"` and the factory's import, through
//!   [`import_manager::ensure_imports`] (merged into existing declarations when possible).
//! * `data={customerData?.items ?? []}` and `isLoading={isCustomerLoading}` on the element.
//!
//! The only runtime the bound code needs is `@tanstack/react-query`. Binding is idempotent:
//! a `useQuery` in the component that already spreads the same factory is reused (its
//! destructured names are read, and only a missing `isLoading` is added), so binding the
//! same element twice leaves the file unchanged.
//!
//! Refused with `unsupported` rather than written: `optionsArgs` reading a local that is
//! declared after an early `return`, at or after the statement rendering the element, or only
//! inside a nested function or block (the hook could not see it).

use std::borrow::Cow;
use std::cell::Cell;
use std::collections::BTreeSet;

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::Visit;
use oxc_semantic::{Scoping, SemanticBuilder};
use oxc_span::{GetSpan, Span};
use oxc_syntax::scope::{ScopeFlags, ScopeId};
use serde::{Deserialize, Serialize};

use crate::error::{EngineError, Result};
use crate::import_manager::{self, ImportSpec};
use crate::locator::{self, AttrValue, JsxNode, JsxTable, Locator, NodeKind};
use crate::mutator::Outcome;
use crate::parse;
use crate::text::{self, Edit};

/// The package every generated hook comes from: the only data runtime bound code may use.
pub const TANSTACK_QUERY: &str = "@tanstack/react-query";

const USE_QUERY: &str = "useQuery";

/// `optionsArgs` limits, checked before it is parsed. The parser recurses once per nesting
/// level (about 1.5 KB of stack per bracket level in a release build), so unbounded input
/// could overflow the stack and kill the host process (the dev server) instead of being
/// refused. Real arguments are small object literals such as `{ query: { page: 1 } }`.
const MAX_ARGS_DEPTH: usize = 256;
/// Also bounds the nesting brackets don't show (`a = b = …`, `x => y => …`, JSX, `!!…`):
/// at most one level per byte.
const MAX_ARGS_LEN: usize = 4096;

/// Bind `target` to `useQuery({ ...<options_fn>(<options_args>) })`.
///
/// Serializes like the rest of the engine's ops (camelCase), so it can back an
/// `Op::BindQuery` variant without changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryBinding {
    /// Locator of the element to bind, e.g. the `<DataTable>`.
    pub target: String,
    /// Stale-locator guard: the tag name the designer saw at `target`.
    #[serde(default)]
    pub expected_name: Option<String>,
    /// The generated TanStack options factory, e.g. `listCustomersOptions`.
    pub options_fn: String,
    /// The module exporting it, e.g. `@/api/generated/@tanstack/react-query.gen`.
    pub options_import: String,
    /// The factory's argument as JS expression text, e.g. `{ query: { page: 1, pageSize: 20 } }`.
    #[serde(default)]
    pub options_args: Option<String>,
    /// Resource name used for the variables: `Customer` → `customerData` / `isCustomerLoading`.
    pub resource: String,
    /// Property path to the rows in the response (`items` → `customerData?.items ?? []`;
    /// `data.items` → `customerData?.data?.items ?? []`). `None` when the response is the array.
    #[serde(default)]
    pub items_path: Option<String>,
    /// Prop that receives the rows, usually `data`.
    pub data_prop: String,
    /// Prop that receives the loading flag, usually `isLoading`; `None` binds no loading flag.
    #[serde(default)]
    pub loading_prop: Option<String>,
}

/// Apply `binding` to `source` (the content of `file`). Pure: no I/O.
pub fn bind_query(source: &str, file: &str, binding: &QueryBinding) -> Result<Outcome> {
    let request = Request::validate(binding, file)?;

    let alloc = Allocator::default();
    let program = parse(&alloc, source, file)?;
    let table = JsxTable::build(&program);
    let loc = Locator::parse(&binding.target)?;
    if loc.file != file {
        return Err(EngineError::Unsupported(format!(
            "`{}` is in {} but this edit targets {file}; cross-file edits are not supported",
            binding.target, loc.file
        )));
    }
    let target = table.resolve_expected(&loc, binding.expected_name.as_deref())?;
    let node = &table.nodes[target];
    if node.kind == NodeKind::Fragment {
        return Err(EngineError::Unsupported("fragments (<>) cannot have props; bind an element instead".into()));
    }

    let component = find_component(&program, node)?;
    let semantic = SemanticBuilder::new().build(&program).semantic;
    let scope =
        ComponentScope { program: &program, scoping: semantic.scoping(), span: component.span, reads: &request.reads };
    scope.check_import(USE_QUERY, TANSTACK_QUERY)?;
    scope.check_import(&binding.options_fn, &binding.options_import)?;

    let style = Style::of(source, &program, &component);
    let (refs, mut edits) = match &component.body {
        Body::Block(body) => match find_existing_hook(body, &binding.options_fn)? {
            Some(hook) => reuse_hook(source, &hook, &request, &scope, &style)?,
            None => {
                let after = hook_anchor(source, &component, &scope, node)?;
                let names = scope.fresh_names(&request);
                let edit = insert_hook(source, body, after, &request, &names, &style);
                (names.refs(), vec![edit])
            }
        },
        Body::Expression { arrow, expr } => {
            // No statements to wait for: this only refuses names the hook cannot see.
            hook_anchor(source, &component, &scope, node)?;
            let names = scope.fresh_names(&request);
            let edits = convert_expression_body(source, arrow, expr, &request, &names, &style)?;
            (names.refs(), edits)
        }
    };

    let data_value = match &request.items_path {
        Some(path) => format!("{}?.{} ?? []", refs.data, path.join("?.")),
        None => format!("{} ?? []", refs.data),
    };
    let mut props = vec![(binding.data_prop.as_str(), data_value)];
    if let (Some(prop), Some(loading)) = (&binding.loading_prop, &refs.loading) {
        props.push((prop.as_str(), loading.clone()));
    }
    edits.extend(prop_edits(source, node, &props));

    let specs = [
        ImportSpec { name: USE_QUERY.into(), source: TANSTACK_QUERY.into(), default: false },
        ImportSpec { name: binding.options_fn.clone(), source: binding.options_import.clone(), default: false },
    ];
    let imports = import_manager::ensure_imports(source, &program, &specs, &[])?;
    edits.extend(imports.into_iter().map(|e| keep_crlf_intact(source, e)));

    let (code, _) = text::apply_edits(source, &edits)?;
    finish(file, source, code, shifted(&edits, node.span.start))
}

// ---------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------

/// A validated [`QueryBinding`].
struct Request<'b> {
    options_fn: &'b str,
    /// Trimmed factory argument.
    args: Option<&'b str>,
    /// Names `args` reads from its surroundings (sorted): the hook must go where each one is
    /// already declared, and its own variables must not take any of them.
    reads: Vec<String>,
    /// `customer` / `Customer`, derived from the resource name.
    camel: String,
    pascal: String,
    items_path: Option<Vec<&'b str>>,
    wants_loading: bool,
}

impl<'b> Request<'b> {
    fn validate(b: &'b QueryBinding, file: &str) -> Result<Self> {
        let invalid = |msg: String| Err(EngineError::InvalidOp(msg));
        if !is_identifier(&b.options_fn) {
            return invalid(format!("optionsFn `{}` is not an identifier", b.options_fn));
        }
        if b.options_import.trim().is_empty()
            || b.options_import.contains(['"', '\'', '`', '\\', '\n', '\r'])
            || b.options_import.contains(locator::ATTR)
        {
            return invalid(format!("optionsImport `{}` is not a valid module specifier", b.options_import));
        }
        for prop in std::iter::once(&b.data_prop).chain(&b.loading_prop) {
            if !is_attr_name(prop) || prop == locator::ATTR {
                return invalid(format!("`{prop}` is not a bindable prop name"));
            }
        }
        if b.loading_prop.as_deref() == Some(b.data_prop.as_str()) {
            return invalid(format!("dataProp and loadingProp are both `{}`", b.data_prop));
        }
        let items_path = match &b.items_path {
            None => None,
            Some(path) => {
                let segments: Vec<&str> = path.split('.').collect();
                if !segments.iter().all(|s| is_identifier(s)) {
                    return invalid(format!(
                        "itemsPath `{path}` must be a dotted property path such as `items` \
                         (use null when the response is the array)"
                    ));
                }
                Some(segments)
            }
        };
        let (args, reads) = match &b.options_args {
            None => (None, Vec::new()),
            Some(args) => {
                let args = args.trim();
                (Some(args), validate_args(args, file)?)
            }
        };
        let (camel, pascal) = resource_names(&b.resource)?;
        Ok(Self {
            options_fn: &b.options_fn,
            args,
            reads,
            camel,
            pascal,
            items_path,
            wants_loading: b.loading_prop.is_some(),
        })
    }

    fn data_base(&self) -> String {
        format!("{}Data", self.camel)
    }

    fn loading_base(&self) -> String {
        format!("is{}Loading", self.pascal)
    }
}

/// `optionsArgs` must be exactly one argument expression: it is spliced into
/// `<optionsFn>(<args>)`, so `a, b`, `a) || (b` or a trailing `// comment` are refused, and
/// so is anything over [`MAX_ARGS_LEN`] bytes or [`MAX_ARGS_DEPTH`] levels deep.
///
/// Returns the names the expression reads without declaring them (value references only:
/// types are erased and have no temporal dead zone), sorted.
fn validate_args(args: &str, file: &str) -> Result<Vec<String>> {
    let shown = abbreviate(args);
    let invalid = |why: &str| EngineError::InvalidOp(format!("optionsArgs `{shown}` {why}"));
    if args.is_empty() {
        return Err(invalid("is empty (use null for no argument)"));
    }
    if args.len() > MAX_ARGS_LEN {
        return Err(invalid(&format!("is {} bytes long; at most {MAX_ARGS_LEN} are accepted", args.len())));
    }
    let depth = nesting_depth(args);
    if depth > MAX_ARGS_DEPTH {
        return Err(invalid(&format!("nests {depth} levels deep; at most {MAX_ARGS_DEPTH} are accepted")));
    }
    if args.contains(locator::ATTR) {
        return Err(invalid("must not mention the dev-only locator attribute"));
    }
    const PROBE: &str = "__triviaOptionsProbe";
    let wrapped = format!("{PROBE}({args});");
    let alloc = Allocator::default();
    let program = parse(&alloc, &wrapped, file).map_err(|_| invalid("is not a valid expression"))?;
    let single_argument = match program.body.as_slice() {
        [Statement::ExpressionStatement(stmt)] => match &stmt.expression {
            Expression::CallExpression(call) => {
                call.callee.is_specific_id(PROBE)
                    && call.arguments.len() == 1
                    && call.arguments[0].as_expression().is_some()
                    && call.span.end as usize == wrapped.len() - 1
            }
            _ => false,
        },
        _ => false,
    };
    if !single_argument {
        return Err(invalid("must be exactly one expression"));
    }
    let semantic = SemanticBuilder::new().build(&program).semantic;
    let s = semantic.scoping();
    let reads: BTreeSet<String> = s
        .root_unresolved_references()
        .iter()
        .filter(|(name, refs)| name.as_str() != PROBE && refs.iter().any(|&r| s.get_reference(r).is_value()))
        .map(|(name, _)| name.to_string())
        .collect();
    Ok(reads.into_iter().collect())
}

/// Deepest nesting of `(`, `[`, `{`, template literals and their `${…}` in `src`, outside
/// string literals and comments. A cheap guard run before parsing, not a tokenizer: brackets
/// in a regex literal count too, which can only overestimate.
fn nesting_depth(src: &str) -> usize {
    let b = src.as_bytes();
    let mut open: Vec<u8> = Vec::new();
    let mut deepest = 0;
    let mut i = 0;
    while i < b.len() {
        if open.last() == Some(&b'`') {
            match b[i] {
                b'\\' => i += 1,
                b'`' => drop(open.pop()),
                b'$' if b.get(i + 1) == Some(&b'{') => {
                    open.push(b'{');
                    i += 1;
                }
                _ => {}
            }
        } else {
            match b[i] {
                quote @ (b'"' | b'\'') => {
                    i += 1;
                    while i < b.len() && b[i] != quote && b[i] != b'\n' {
                        i += if b[i] == b'\\' { 2 } else { 1 };
                    }
                }
                b'/' if b.get(i + 1) == Some(&b'/') => {
                    while i < b.len() && b[i] != b'\n' {
                        i += 1;
                    }
                }
                // Lands on the comment's closing `/` (or past the end when it is unclosed).
                b'/' if b.get(i + 1) == Some(&b'*') => i = src[i + 2..].find("*/").map_or(b.len(), |n| i + 3 + n),
                c @ (b'(' | b'[' | b'{' | b'`') => open.push(c),
                b')' | b']' | b'}' => drop(open.pop()),
                _ => {}
            }
        }
        deepest = deepest.max(open.len());
        i += 1;
    }
    deepest
}

/// `s` for an error message: its first 60 characters and `…` when it is longer than 80.
fn abbreviate(s: &str) -> Cow<'_, str> {
    if s.chars().nth(80).is_none() {
        Cow::Borrowed(s)
    } else {
        Cow::Owned(format!("{}…", s.chars().take(60).collect::<String>()))
    }
}

/// `Customer` → (`customer`, `Customer`); `customer-orders` → (`customerOrders`, `CustomerOrders`).
fn resource_names(resource: &str) -> Result<(String, String)> {
    let pascal: String = resource
        .split(|c: char| !c.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            chars.next().map(|first| first.to_uppercase().chain(chars).collect::<String>()).unwrap_or_default()
        })
        .collect();
    if !pascal.chars().next().is_some_and(char::is_alphabetic) {
        return Err(EngineError::InvalidOp(format!(
            "resource `{resource}` must start with a letter (it names the hook's variables)"
        )));
    }
    let mut chars = pascal.chars();
    let camel = chars.next().map(|first| first.to_lowercase().chain(chars).collect::<String>()).unwrap_or_default();
    Ok((camel, pascal))
}

// ---------------------------------------------------------------------------------------
// The enclosing component
// ---------------------------------------------------------------------------------------

struct Component<'p, 'a> {
    /// Span of the whole function (parameters included): the scope that must stay clash-free.
    span: Span,
    /// The parameter list: everything bound there is in scope at the first statement.
    params: Span,
    /// The function's scope (parameters and top-level declarations), set by `SemanticBuilder`.
    scope_id: &'p Cell<Option<ScopeId>>,
    body: Body<'p, 'a>,
}

enum Body<'p, 'a> {
    Block(&'p FunctionBody<'a>),
    /// A concise arrow body, `() => (<div />)`.
    Expression { arrow: &'p ArrowFunctionExpression<'a>, expr: &'p Expression<'a> },
}

#[derive(Clone, Copy)]
enum Callable<'p, 'a> {
    Function(&'p Function<'a>),
    Arrow(&'p ArrowFunctionExpression<'a>),
}

/// The top-level component whose body renders `node`: a function declaration (exported or
/// not), or a `const` arrow/function expression, possibly wrapped in `forwardRef`/`memo`.
fn find_component<'p, 'a>(program: &'p Program<'a>, node: &JsxNode) -> Result<Component<'p, 'a>> {
    let target = node.span;
    let contains = |outer: Span| outer.start <= target.start && target.end <= outer.end;
    let tag = node.display_name();
    let outside = || {
        EngineError::Unsupported(format!(
            "<{tag}> is not rendered inside a function component, so there is no component body for useQuery \
             (hooks cannot run at module scope)"
        ))
    };
    let class = |name: Option<&BindingIdentifier<'_>>| {
        let name = name.map_or("this class", |id| id.name.as_str());
        EngineError::Unsupported(format!(
            "<{tag}> is rendered by class component `{name}`; hooks need a function component"
        ))
    };

    let stmt = program.body.iter().find(|s| contains(s.span())).ok_or_else(outside)?;
    let (name, callable) = match stmt {
        Statement::FunctionDeclaration(f) => function_component(f),
        Statement::ClassDeclaration(c) => return Err(class(c.id.as_ref())),
        Statement::VariableDeclaration(decl) => declarator_component(decl, target),
        Statement::ExportDeclaration(export) => match &export.declaration {
            Declaration::FunctionDeclaration(f) => function_component(f),
            Declaration::ClassDeclaration(c) => return Err(class(c.id.as_ref())),
            Declaration::VariableDeclaration(decl) => declarator_component(decl, target),
            _ => (None, None),
        },
        Statement::ExportDefaultDeclaration(export) => match &export.declaration {
            ExportDefaultDeclarationKind::FunctionDeclaration(f) => function_component(f),
            ExportDefaultDeclarationKind::ClassDeclaration(c) => return Err(class(c.id.as_ref())),
            kind => (None, kind.as_expression().and_then(unwrap_component)),
        },
        _ => (None, None),
    };
    let callable = callable.ok_or_else(outside)?;

    if let Some(name) = name.filter(|n| !is_component_or_hook_name(n)) {
        return Err(EngineError::Unsupported(format!(
            "<{tag}> is rendered by `{name}`, which is not a React component (components start with an \
             uppercase letter, hooks with `use`); useQuery can only be called from one of those"
        )));
    }
    let (span, params, scope_id, is_async, is_generator) = match callable {
        Callable::Function(f) => (f.span, f.params.span, &f.scope_id, f.r#async, f.generator),
        Callable::Arrow(a) => (a.span, a.params.span, &a.scope_id, a.r#async, false),
    };
    if is_async || is_generator {
        let what = if is_async { "async" } else { "a generator" };
        return Err(EngineError::Unsupported(format!(
            "<{tag}> is rendered by {what} function; hooks cannot be called there"
        )));
    }
    let body = match callable {
        Callable::Function(f) => f.body.as_deref().map(Body::Block),
        Callable::Arrow(a) => match (a.get_function_body(), a.get_expression()) {
            (Some(body), _) => Some(Body::Block(body)),
            (None, Some(expr)) => Some(Body::Expression { arrow: a, expr }),
            (None, None) => None,
        },
    }
    .ok_or_else(outside)?;
    let body_span = match &body {
        Body::Block(b) => b.span,
        Body::Expression { expr, .. } => expr.span(),
    };
    // E.g. JSX in a default parameter value is inside the function but not its body.
    if !contains(body_span) {
        return Err(outside());
    }
    Ok(Component { span, params, scope_id, body })
}

fn function_component<'p, 'a>(f: &'p Function<'a>) -> (Option<&'p str>, Option<Callable<'p, 'a>>) {
    (f.id.as_ref().map(|id| id.name.as_str()), Some(Callable::Function(f)))
}

fn declarator_component<'p, 'a>(
    decl: &'p VariableDeclaration<'a>,
    target: Span,
) -> (Option<&'p str>, Option<Callable<'p, 'a>>) {
    let Some(d) = decl.declarations.iter().find(|d| d.span.start <= target.start && target.end <= d.span.end) else {
        return (None, None);
    };
    let name = match &d.id {
        BindingPattern::BindingIdentifier(id) => Some(id.name.as_str()),
        _ => None,
    };
    (name, d.init.as_ref().and_then(unwrap_component))
}

/// `() => …`, `function () {…}`, and either wrapped in `forwardRef(…)` / `memo(…)`
/// (also as `React.forwardRef` / `React.memo`, and nested).
fn unwrap_component<'p, 'a>(expr: &'p Expression<'a>) -> Option<Callable<'p, 'a>> {
    match expr.get_inner_expression() {
        Expression::ArrowFunctionExpression(a) => Some(Callable::Arrow(a)),
        Expression::FunctionExpression(f) => Some(Callable::Function(f)),
        Expression::CallExpression(call)
            if ["forwardRef", "memo"]
                .into_iter()
                .any(|w| call.callee.is_specific_id(w) || call.callee.is_specific_member_access("React", w)) =>
        {
            call.arguments.first().and_then(Argument::as_expression).and_then(unwrap_component)
        }
        _ => None,
    }
}

fn is_component_or_hook_name(name: &str) -> bool {
    name.chars().next().is_some_and(char::is_uppercase)
        || name.strip_prefix("use").is_some_and(|rest| rest.chars().next().is_none_or(|c| !c.is_lowercase()))
}

// ---------------------------------------------------------------------------------------
// Names and scope
// ---------------------------------------------------------------------------------------

struct ComponentScope<'s, 'p, 'a> {
    program: &'p Program<'a>,
    scoping: &'s Scoping,
    span: Span,
    /// [`Request::reads`]: names the new hook's own arguments refer to.
    reads: &'s [String],
}

/// The variables a fresh hook declares.
struct Names {
    data: String,
    loading: Option<String>,
}

impl Names {
    fn refs(&self) -> Refs {
        Refs { data: self.data.clone(), loading: self.loading.clone() }
    }
}

/// Expressions the props read (`customerData`, or `query.data` for `const query = useQuery(…)`).
struct Refs {
    data: String,
    loading: Option<String>,
}

impl ComponentScope<'_, '_, '_> {
    fn inside(&self, span: Span) -> bool {
        self.span.start <= span.start && span.end <= self.span.end
    }

    /// True when declaring `name` at the top of the component would clash with, or shadow,
    /// an existing binding or global the component (or the module) can see, or a name the
    /// hook's own arguments read (`const { data: x } = useQuery(…(x))` reads itself).
    fn taken(&self, name: &str) -> bool {
        let s = self.scoping;
        s.get_root_binding(name.into()).is_some()
            || s.root_unresolved_references().keys().any(|k| k.as_str() == name)
            || s.symbol_ids().any(|id| s.symbol_name(id) == name && self.inside(s.symbol_span(id)))
            || self.reads.iter().any(|r| r == name)
    }

    /// The element will read a name the existing hook declares. Refuse when the component
    /// declares that name again (e.g. a `.map((rows) => …)` parameter), because the element
    /// could then see the other declaration.
    fn ensure_single_declaration(&self, bound: &Bound) -> Result<()> {
        let s = self.scoping;
        let redeclared = s.symbol_ids().any(|id| {
            let span = s.symbol_span(id);
            s.symbol_name(id) == bound.name && self.inside(span) && span != bound.span
        });
        if redeclared {
            return Err(EngineError::Unsupported(format!(
                "`{}` comes from the existing useQuery but is declared again inside the component, so the bound \
                 element might read the other one; rename one of them",
                bound.name
            )));
        }
        Ok(())
    }

    /// `base`, else `base2`, `base3`, … : the first free one.
    fn unique(&self, base: &str) -> String {
        (1..).map(|n| numbered(base, n)).find(|name| !self.taken(name)).expect("an unbounded range has a free name")
    }

    /// Fresh names for a new hook, sharing one suffix so the pair stays recognisable.
    fn fresh_names(&self, req: &Request<'_>) -> Names {
        let (data, loading) = (req.data_base(), req.loading_base());
        let n = (1..)
            .find(|&n| !self.taken(&numbered(&data, n)) && !(req.wants_loading && self.taken(&numbered(&loading, n))))
            .expect("an unbounded range has a free name");
        Names { data: numbered(&data, n), loading: req.wants_loading.then(|| numbered(&loading, n)) }
    }

    /// `name` must be free or already be `import { name } from "source"` (value import);
    /// anything else would make the bound code call some other function.
    fn check_import(&self, name: &str, source: &str) -> Result<()> {
        let s = self.scoping;
        if s.symbol_ids().any(|id| s.symbol_name(id) == name && self.inside(s.symbol_span(id))) {
            return Err(EngineError::Unsupported(format!(
                "`{name}` is declared inside the component and would shadow `import {{ {name} }} from \"{source}\"`; \
                 rename it first"
            )));
        }
        if s.get_root_binding(name.into()).is_none() {
            return Ok(());
        }
        let imported = self.program.body.iter().any(|stmt| {
            let Statement::ImportDeclaration(decl) = stmt else { return false };
            decl.source.value.as_str() == source
                && decl.import_kind.is_value()
                && decl.specifiers.iter().flatten().any(|spec| match spec {
                    ImportDeclarationSpecifier::ImportSpecifier(spec) => {
                        spec.local.name.as_str() == name
                            && spec.imported.name().as_str() == name
                            && spec.import_kind.is_value()
                    }
                    _ => false,
                })
        });
        if imported {
            Ok(())
        } else {
            Err(EngineError::Unsupported(format!(
                "`{name}` is already bound in this file, but not as `import {{ {name} }} from \"{source}\"`; \
                 rename or remove that binding first"
            )))
        }
    }
}

fn numbered(base: &str, n: u32) -> String {
    if n == 1 { base.to_string() } else { format!("{base}{n}") }
}

// ---------------------------------------------------------------------------------------
// Formatting style
// ---------------------------------------------------------------------------------------

struct Style {
    nl: &'static str,
    unit: String,
    semi: bool,
}

impl Style {
    /// Semicolons follow the nearest evidence: the component's own statements, then the
    /// module's top-level statements. No evidence means no semicolons.
    fn of(src: &str, program: &Program<'_>, component: &Component<'_, '_>) -> Self {
        let local: &[Statement<'_>] = match &component.body {
            Body::Block(body) => &body.statements,
            Body::Expression { .. } => &[],
        };
        let semi = local
            .iter()
            .chain(&program.body)
            .find(|s| is_asi_terminated(s))
            .is_some_and(|s| src[..s.span().end as usize].ends_with(';'));
        Self { nl: text::newline(src), unit: text::indent_unit(src), semi }
    }
}

/// Statements that end with an optional `;` (as opposed to a `}`).
fn is_asi_terminated(stmt: &Statement<'_>) -> bool {
    match stmt {
        Statement::VariableDeclaration(_)
        | Statement::ExpressionStatement(_)
        | Statement::ReturnStatement(_)
        | Statement::ThrowStatement(_)
        | Statement::BreakStatement(_)
        | Statement::ContinueStatement(_)
        | Statement::ImportDeclaration(_)
        | Statement::ExportNamedDeclaration(_)
        | Statement::ExportFromDeclaration(_)
        | Statement::ExportAllDeclaration(_)
        | Statement::TSTypeAliasDeclaration(_) => true,
        Statement::ExportDeclaration(e) => {
            matches!(e.declaration, Declaration::VariableDeclaration(_) | Declaration::TSTypeAliasDeclaration(_))
        }
        Statement::ExportDefaultDeclaration(e) => e.declaration.as_expression().is_some(),
        _ => false,
    }
}

// ---------------------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------------------

/// `const { data: x, isLoading: y } = useQuery({ ...fn(args) })`, with lines after the
/// first indented from `indent`. No leading indent, no trailing newline.
fn hook_statement(req: &Request<'_>, names: &Names, indent: &str, style: &Style, semi: bool) -> String {
    let destructure = match &names.loading {
        Some(loading) => format!("{{ data: {}, isLoading: {loading} }}", names.data),
        None => format!("{{ data: {} }}", names.data),
    };
    let semi = if semi { ";" } else { "" };
    let f = req.options_fn;
    match req.args {
        Some(args) if args.contains('\n') => {
            let (nl, unit) = (style.nl, style.unit.as_str());
            let args = reindent_expression(args, &format!("{indent}{unit}"), unit, nl);
            format!("const {destructure} = {USE_QUERY}({{{nl}{indent}{unit}...{f}({args}),{nl}{indent}}}){semi}")
        }
        args => format!("const {destructure} = {USE_QUERY}({{ ...{f}({}) }}){semi}", args.unwrap_or_default()),
    }
}

/// Re-indent multi-line expression text for splicing: the first line stays put; later lines
/// lose the text's own base indentation, keep their relative depth (converted to the file's
/// indent unit) and are prefixed with `to`.
fn reindent_expression(expr: &str, to: &str, unit: &str, nl: &str) -> String {
    let lines: Vec<&str> = expr.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let lead = |l: &str| l.len() - l.trim_start_matches([' ', '\t']).len();
    let rest: Vec<&str> = lines[1..].iter().copied().filter(|l| !l.trim().is_empty()).collect();
    let base = rest.iter().map(|l| lead(l)).min().unwrap_or(0);
    let own_unit = text::indent_unit(&rest.iter().map(|l| &l[base..]).collect::<Vec<_>>().join("\n"));

    let mut out = String::from(lines[0]);
    for line in &lines[1..] {
        out.push_str(nl);
        if line.trim().is_empty() {
            continue;
        }
        let relative = &line[base.min(lead(line))..];
        let depth_ws = &relative[..lead(relative)];
        let (depth, remainder) = if own_unit == "\t" {
            let tabs = depth_ws.len() - depth_ws.trim_start_matches('\t').len();
            (tabs, &relative[tabs..])
        } else if depth_ws.bytes().all(|b| b == b' ') {
            let n = depth_ws.len() / own_unit.len();
            (n, &relative[n * own_unit.len()..])
        } else {
            (0, relative)
        };
        out.push_str(to);
        out.push_str(&unit.repeat(depth));
        out.push_str(remainder);
    }
    out
}

/// True when the statement starting at `pos` would continue the previous line without a
/// `;` (`(…)`, `[…]`, template literals, unary `+`/`-`, regex literals, bare JSX).
fn continues_previous_line(src: &str, pos: u32) -> bool {
    matches!(src.as_bytes().get(pos as usize), Some(b'(' | b'[' | b'`' | b'+' | b'-' | b'/' | b'<'))
}

/// Where a new hook can go so that every component local its arguments read is declared
/// before it: `None` for the first statement, `Some(i)` for right after `statements[i]`, the
/// last top-level statement declaring one of them. Parameters, hoisted function declarations
/// and module-level names are in scope from the first statement on.
///
/// Refuses (`unsupported`) a name the hook could not see from the component's top level, and
/// a placement after an early `return` (rules of hooks) or after the element it feeds.
fn hook_anchor(
    src: &str,
    component: &Component<'_, '_>,
    scope: &ComponentScope<'_, '_, '_>,
    node: &JsxNode,
) -> Result<Option<usize>> {
    let s = scope.scoping;
    let function_scope = component
        .scope_id
        .get()
        .ok_or_else(|| EngineError::Internal("the component function has no scope after semantic analysis".into()))?;
    let statements: &[Statement<'_>] = match &component.body {
        Body::Block(body) => &body.statements,
        Body::Expression { .. } => &[],
    };
    let within = |outer: Span, inner: Span| outer.start <= inner.start && inner.end <= outer.end;

    let mut anchor: Option<(usize, &str)> = None;
    for name in scope.reads.iter().map(String::as_str) {
        let Some(symbol) = s.get_binding(function_scope, name.into()) else {
            let nested = s.symbol_ids().any(|id| s.symbol_name(id) == name && scope.inside(s.symbol_span(id)));
            if nested && s.find_binding(function_scope, name.into()).is_none() {
                return Err(EngineError::Unsupported(format!(
                    "optionsArgs reads `{name}`, which this component declares only inside a nested function or \
                     block; useQuery goes at the component's top level, where `{name}` is not in scope. Declare it \
                     at the top level of the component first"
                )));
            }
            continue;
        };
        let declared = s.symbol_span(symbol);
        if within(component.params, declared) || s.symbol_flags(symbol).is_function() {
            continue;
        }
        if let Some(i) = statements.iter().position(|st| within(st.span(), declared))
            && anchor.is_none_or(|(j, _)| i > j)
        {
            anchor = Some((i, name));
        }
    }
    let Some((i, name)) = anchor else { return Ok(None) };

    if let Some(ret) = statements[..=i].iter().find_map(component_return) {
        let (line, _) = text::line_col(src, ret.start);
        return Err(EngineError::Unsupported(format!(
            "optionsArgs reads `{name}`, which is declared after the early `return` on line {line}; a useQuery placed \
             after `{name}` would not run on every render, which breaks the rules of hooks. Declare `{name}` before \
             that return"
        )));
    }
    let tag = node.display_name();
    if statements.iter().position(|st| within(st.span(), node.span)).is_none_or(|r| r <= i) {
        return Err(EngineError::Unsupported(format!(
            "optionsArgs reads `{name}`, which is declared at or after the statement that renders <{tag}>; the hook \
             has to follow `{name}` and precede <{tag}>, which reads its result. Declare `{name}` above that statement"
        )));
    }
    Ok(Some(i))
}

/// The first `return` in `stmt` that returns from the component itself rather than from a
/// function nested in it.
fn component_return(stmt: &Statement<'_>) -> Option<Span> {
    struct FirstReturn(Option<Span>);
    impl<'a> Visit<'a> for FirstReturn {
        fn visit_return_statement(&mut self, it: &ReturnStatement<'a>) {
            if self.0.is_none() {
                self.0 = Some(it.span);
            }
        }
        fn visit_function(&mut self, _: &Function<'a>, _: ScopeFlags) {}
        fn visit_arrow_function_expression(&mut self, _: &ArrowFunctionExpression<'a>) {}
    }
    let mut first = FirstReturn(None);
    first.visit_statement(stmt);
    first.0
}

/// The edit that inserts a new hook into a block body: as its first statement, or right after
/// `statements[i]` for `after: Some(i)` (see [`hook_anchor`]).
fn insert_hook(
    src: &str,
    body: &FunctionBody<'_>,
    after: Option<usize>,
    req: &Request<'_>,
    names: &Names,
    style: &Style,
) -> Edit {
    let nl = style.nl;
    if let Some(i) = after {
        let anchor = body.statements[i].span();
        let indent = if text::starts_line(src, anchor.start) {
            text::line_indent(src, anchor.start).to_string()
        } else {
            format!("{}{}", text::line_indent(src, body.span.start), style.unit)
        };
        let next = body.statements.get(i + 1).map(|s| s.span().start);
        let semi = style.semi || next.is_some_and(|start| continues_previous_line(src, start));
        let hook = hook_statement(req, names, &indent, style, semi);
        return match trivia_to_line_break(src, anchor.end) {
            // The statement (plus any trailing comment) ends its line: the hook gets the next.
            Some(eol) => Edit::insert(eol, format!("{nl}{indent}{hook}")),
            // Code follows on the same line (`const id = f(); return …`): break before it.
            None => {
                let rest = &src[anchor.end as usize..];
                let code = anchor.end + (rest.len() - rest.trim_start().len()) as u32;
                Edit::replace(anchor.end, code, format!("{nl}{indent}{hook}{nl}{indent}"))
            }
        };
    }

    let first = body.statements.first().map(|s| s.span().start);
    let indent = match first {
        Some(start) if text::starts_line(src, start) => text::line_indent(src, start).to_string(),
        _ => format!("{}{}", text::line_indent(src, body.span.start), style.unit),
    };
    let semi = style.semi || first.is_some_and(|start| continues_previous_line(src, start));
    let hook = hook_statement(req, names, &indent, style, semi);
    // A blank line separates the hook from the statements that were already there.
    let gap = if first.is_some() { nl } else { "" };

    // Directives (`"use no memo"`) must stay first.
    let after = body.directives.last().map_or(body.span.start + 1, |d| d.span.end);
    match trivia_to_line_break(src, after) {
        // `{` (plus any trailing comment) ends its line: the hook gets the next line.
        Some(eol) => Edit::insert(eol, format!("{nl}{indent}{hook}{gap}")),
        // Code follows on the same line (`{ return <A /> }`): break the line before it.
        None => {
            let next = after + (src[after as usize..].len() - src[after as usize..].trim_start().len()) as u32;
            Edit::replace(after, next, format!("{nl}{indent}{hook}{nl}{gap}{indent}"))
        }
    }
}

/// From `pos`, skip spaces, tabs and comments. If a line break comes before any code,
/// return its offset (before a `\r\n`'s `\r`); `None` if code comes first.
fn trivia_to_line_break(src: &str, pos: u32) -> Option<u32> {
    let b = src.as_bytes();
    let mut i = pos as usize;
    loop {
        while matches!(b.get(i), Some(b' ' | b'\t')) {
            i += 1;
        }
        match (b.get(i), b.get(i + 1)) {
            (None, _) | (Some(b'\r' | b'\n'), _) => return Some(i as u32),
            (Some(b'/'), Some(b'/')) => {
                let end = src[i..].find('\n').map_or(b.len(), |n| i + n);
                return Some(if end > i && b[end - 1] == b'\r' { end - 1 } else { end } as u32);
            }
            (Some(b'/'), Some(b'*')) => i = i + 2 + src[i + 2..].find("*/")? + 2,
            _ => return None,
        }
    }
}

/// From `pos`, skip whitespace (line breaks included) and comments.
fn skip_trivia(src: &str, pos: u32) -> u32 {
    let b = src.as_bytes();
    let mut i = pos as usize;
    loop {
        while b.get(i).is_some_and(u8::is_ascii_whitespace) {
            i += 1;
        }
        match (b.get(i), b.get(i + 1)) {
            (Some(b'/'), Some(b'/')) => i = src[i..].find('\n').map_or(b.len(), |n| i + n),
            (Some(b'/'), Some(b'*')) => match src[i + 2..].find("*/") {
                Some(n) => i = i + 2 + n + 2,
                None => return i as u32,
            },
            _ => return i as u32,
        }
    }
}

/// `() => (<div />)` → `() => {⏎  const … = useQuery(…)⏎⏎  return (<div />)⏎}`: splices
/// only around the expression, whose bytes stay untouched.
fn convert_expression_body(
    src: &str,
    arrow: &ArrowFunctionExpression<'_>,
    expr: &Expression<'_>,
    req: &Request<'_>,
    names: &Names,
    style: &Style,
) -> Result<Vec<Edit>> {
    let nl = style.nl;
    let after_params = arrow.return_type.as_ref().map_or(arrow.params.span.end, |t| t.span.end);
    let token = skip_trivia(src, after_params);
    if !src[token as usize..].starts_with("=>") {
        return Err(EngineError::Internal(format!("no `=>` after the arrow parameters at byte {after_params}")));
    }
    let arrow_end = token + 2;
    let span = expr.span();
    let outer = text::line_indent(src, token);
    let indent = format!("{outer}{}", style.unit);
    let hook = hook_statement(req, names, &indent, style, style.semi);
    let head = format!(" {{{nl}{indent}{hook}{nl}{nl}{indent}return ");

    let gap = &src[arrow_end as usize..span.start as usize];
    let parenthesized = matches!(expr, Expression::ParenthesizedExpression(_));
    let edits = if gap.trim().is_empty() {
        // The whitespace gap is replaced, so the expression starts on the `return` line (a
        // kept line break would make it `return⏎…`, i.e. return undefined). A multi-line
        // expression that is not parenthesized yet gets the idiomatic `return (…)`.
        let wrap = !parenthesized && src[span.start as usize..span.end as usize].contains('\n');
        let (open, close) = if wrap { ("(", ")") } else { ("", "") };
        vec![
            Edit::replace(arrow_end, span.start, format!("{head}{open}")),
            Edit::insert(span.end, format!("{close}{nl}{outer}}}")),
        ]
    } else {
        // Comments between `=>` and the expression stay where they are, inside `return (…)`.
        vec![Edit::insert(arrow_end, format!("{head}(")), Edit::insert(span.end, format!("){nl}{outer}}}"))]
    };
    Ok(edits)
}

// ---------------------------------------------------------------------------------------
// Reusing an existing hook
// ---------------------------------------------------------------------------------------

/// A `useQuery(…)` at the top of the component that already uses the requested factory.
enum ExistingHook {
    /// `const query = useQuery(…)`
    Identifier(Bound),
    /// `const { data: x, isLoading } = useQuery(…)`
    Object { pattern: Span, data: Option<Bound>, loading: Option<Bound>, properties: Vec<Span>, has_rest: bool },
}

/// A name the existing hook declares, with the span of its binding identifier.
struct Bound {
    name: String,
    span: Span,
}

impl Bound {
    fn of(id: &BindingIdentifier<'_>) -> Self {
        Self { name: id.name.as_str().to_string(), span: id.span }
    }
}

fn find_existing_hook(body: &FunctionBody<'_>, options_fn: &str) -> Result<Option<ExistingHook>> {
    for stmt in &body.statements {
        let Statement::VariableDeclaration(decl) = stmt else { continue };
        for d in &decl.declarations {
            let Some(Expression::CallExpression(call)) = d.init.as_ref().map(Expression::get_inner_expression) else {
                continue;
            };
            let factory = call.arguments.first().is_some_and(|a| uses_factory(a, options_fn));
            if !call.callee.is_specific_id(USE_QUERY) || !factory {
                continue;
            }
            return describe_hook(&d.id, options_fn).map(Some);
        }
    }
    Ok(None)
}

/// `{ ...fn(…) }` (the idiomatic form) or `fn(…)` passed straight to `useQuery`.
fn uses_factory(arg: &Argument<'_>, options_fn: &str) -> bool {
    let is_factory_call = |e: &Expression<'_>| {
        matches!(e.get_inner_expression(), Expression::CallExpression(c) if c.callee.is_specific_id(options_fn))
    };
    match arg.as_expression().map(Expression::get_inner_expression) {
        Some(Expression::ObjectExpression(obj)) => obj.properties.iter().any(|p| match p {
            ObjectPropertyKind::SpreadProperty(spread) => is_factory_call(&spread.argument),
            ObjectPropertyKind::ObjectProperty(_) => false,
        }),
        Some(e) => is_factory_call(e),
        None => false,
    }
}

fn describe_hook(id: &BindingPattern<'_>, options_fn: &str) -> Result<ExistingHook> {
    let unsupported = |what: &str| {
        EngineError::Unsupported(format!(
            "the component already calls useQuery with {options_fn}(…), but {what}; bind its result to a name \
             (or destructure `data` into a name) and retry"
        ))
    };
    match id {
        BindingPattern::BindingIdentifier(id) => Ok(ExistingHook::Identifier(Bound::of(id))),
        BindingPattern::ObjectPattern(obj) => {
            let mut found = [None, None];
            for prop in &obj.properties {
                let Some(key) = prop.key.static_name().filter(|_| !prop.computed) else { continue };
                let Some(slot) = ["data", "isLoading"].iter().position(|k| *k == key) else { continue };
                let id = match &prop.value {
                    BindingPattern::BindingIdentifier(id) => id,
                    BindingPattern::AssignmentPattern(p) => match &p.left {
                        BindingPattern::BindingIdentifier(id) => id,
                        _ => return Err(unsupported(&format!("its `{key}` is destructured into a nested pattern"))),
                    },
                    _ => return Err(unsupported(&format!("its `{key}` is destructured into a nested pattern"))),
                };
                found[slot] = Some(Bound::of(id));
            }
            let [data, loading] = found;
            Ok(ExistingHook::Object {
                pattern: obj.span,
                data,
                loading,
                properties: obj.properties.iter().map(|p| p.span).collect(),
                has_rest: obj.rest.is_some(),
            })
        }
        _ => Err(unsupported("its result is destructured as an array")),
    }
}

/// Read the existing hook's names; add only what the binding needs and the hook lacks.
fn reuse_hook(
    src: &str,
    hook: &ExistingHook,
    req: &Request<'_>,
    scope: &ComponentScope<'_, '_, '_>,
    style: &Style,
) -> Result<(Refs, Vec<Edit>)> {
    let (pattern, data, loading, properties, has_rest) = match hook {
        ExistingHook::Identifier(query) => {
            scope.ensure_single_declaration(query)?;
            let name = &query.name;
            let refs =
                Refs { data: format!("{name}.data"), loading: req.wants_loading.then(|| format!("{name}.isLoading")) };
            return Ok((refs, Vec::new()));
        }
        ExistingHook::Object { pattern, data, loading, properties, has_rest } => {
            (*pattern, data, loading, properties, *has_rest)
        }
    };
    let mut added = Vec::new();
    let data = match data {
        Some(bound) => {
            scope.ensure_single_declaration(bound)?;
            bound.name.clone()
        }
        None => {
            let name = scope.unique(&req.data_base());
            added.push(format!("data: {name}"));
            name
        }
    };
    let loading = match (req.wants_loading, loading) {
        (false, _) => None,
        (true, Some(bound)) => {
            scope.ensure_single_declaration(bound)?;
            Some(bound.name.clone())
        }
        (true, None) => {
            let name = scope.unique(&req.loading_base());
            added.push(format!("isLoading: {name}"));
            Some(name)
        }
    };
    let refs = Refs { data, loading };
    if added.is_empty() {
        return Ok((refs, Vec::new()));
    }
    if has_rest {
        return Err(EngineError::Unsupported(format!(
            "the existing useQuery with {}(…) destructures `...rest`; adding `{}` before it would change `rest`. \
             Add it by hand",
            req.options_fn,
            added.join(", ")
        )));
    }
    let edit = match properties.last() {
        None => Edit::replace(pattern.start, pattern.end, format!("{{ {} }}", added.join(", "))),
        Some(last) if text::starts_line(src, last.start) => {
            let sep = format!(",{}{}", style.nl, text::line_indent(src, last.start));
            Edit::insert(last.end, added.iter().map(|a| format!("{sep}{a}")).collect::<String>())
        }
        Some(last) => Edit::insert(last.end, added.iter().map(|a| format!(", {a}")).collect::<String>()),
    };
    Ok((refs, vec![edit]))
}

// ---------------------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------------------

/// Set `name={expr}` for each prop: replace an existing value (string, expression,
/// element or bare shorthand) or add the attribute, placed like `mutator`'s `UpdateProp`
/// (own line with the same indent when attributes are one per line).
///
/// Kept private on purpose: `UpdateProp` only takes JSON literals today. Once it can take raw
/// expression values this can fold into `mutator.rs`.
fn prop_edits(src: &str, node: &JsxNode, props: &[(&str, String)]) -> Vec<Edit> {
    let mut edits = Vec::new();
    let mut added = Vec::new();
    for (name, expr) in props {
        let value = format!("{{{expr}}}");
        // JSX lets a later duplicate win, so edit the last occurrence.
        match node.attributes.iter().rev().find(|a| a.name.as_deref() == Some(*name)) {
            Some(attr) => match &attr.value {
                None => edits.push(Edit::insert(attr.name_end, format!("={value}"))),
                Some(AttrValue::String { span, .. } | AttrValue::Expression { span, .. } | AttrValue::Element { span }) => {
                    if src[span.start as usize..span.end as usize] != value {
                        edits.push(Edit::replace(span.start, span.end, value));
                    }
                }
            },
            None => added.push(format!("{name}={value}")),
        }
    }
    if !added.is_empty() {
        edits.push(match node.attributes.last() {
            Some(last) if text::starts_line(src, last.span.start) => {
                let sep = format!("{}{}", text::newline(src), text::line_indent(src, last.span.start));
                Edit::insert(last.span.end, added.iter().map(|a| format!("{sep}{a}")).collect::<String>())
            }
            Some(last) => Edit::insert(last.span.end, added.iter().map(|a| format!(" {a}")).collect::<String>()),
            None => Edit::insert(node.attr_insert, added.iter().map(|a| format!(" {a}")).collect::<String>()),
        });
    }
    edits
}

// ---------------------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------------------

/// `import_manager` appends new import lines at the `\n` that ends the last import, which
/// in a CRLF file is between its `\r` and `\n` and would leave a stray `\r`. Insert before
/// the `\r` instead (the inserted text starts with the file's own `\r\n`).
fn keep_crlf_intact(src: &str, edit: Edit) -> Edit {
    let at = edit.start as usize;
    if edit.start == edit.end && at > 0 && src.as_bytes()[at - 1] == b'\r' && src.as_bytes().get(at) == Some(&b'\n') {
        Edit::insert(edit.start - 1, edit.text)
    } else {
        edit
    }
}

/// Where the byte at `pos` lands after `edits` (none of which may overlap `pos`).
fn shifted(edits: &[Edit], pos: u32) -> u32 {
    let delta: i64 =
        edits.iter().filter(|e| e.end <= pos).map(|e| e.text.len() as i64 - i64::from(e.end - e.start)).sum();
    (i64::from(pos) + delta) as u32
}

/// Re-parse the result (refusing invalid code) and locate the bound element in it.
fn finish(file: &str, original: &str, code: String, node_start: u32) -> Result<Outcome> {
    let alloc = Allocator::default();
    let program = parse(&alloc, &code, file).map_err(|e| EngineError::InvalidResult(e.to_string()))?;
    let table = JsxTable::build(&program);
    let node = table.node_starting_at(node_start).ok_or_else(|| {
        EngineError::Internal(format!("the bound element is missing at byte {node_start} after the edit"))
    })?;
    let locator = table.locator(node, file).to_string();
    Ok(Outcome { file: file.to_string(), changed: code != original, locator: Some(locator), code })
}

fn is_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

fn is_attr_name(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$' | '-' | ':'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_names_are_camel_and_pascal() {
        assert_eq!(resource_names("Customer").unwrap(), ("customer".into(), "Customer".into()));
        assert_eq!(resource_names("customer-orders").unwrap(), ("customerOrders".into(), "CustomerOrders".into()));
        assert_eq!(resource_names("line_item").unwrap(), ("lineItem".into(), "LineItem".into()));
        assert!(resource_names("2fa").is_err());
        assert!(resource_names("").is_err());
    }

    #[test]
    fn component_and_hook_names() {
        assert!(is_component_or_hook_name("CustomerList"));
        assert!(is_component_or_hook_name("useCustomers"));
        assert!(is_component_or_hook_name("use"));
        assert!(!is_component_or_hook_name("user"));
        assert!(!is_component_or_hook_name("renderTable"));
    }

    #[test]
    fn args_must_be_one_expression() {
        assert!(validate_args("{ query: { page: 1 } }", "a.tsx").is_ok());
        assert!(validate_args("/* first page */ { query: { page: 1 } }", "a.tsx").is_ok());
        assert!(validate_args("{\n  query: { page: 1 },\n}", "a.tsx").is_ok());
        for bad in ["a, b", "a) || (b", "{ page: 1 } // first", "...rest", "a)(b", "", "{", "a; b"] {
            let err = validate_args(bad, "a.tsx").unwrap_err();
            assert_eq!(err.code(), "invalid_op", "{bad:?} → {err}");
        }
    }

    #[test]
    fn args_report_the_names_they_read() {
        let reads = validate_args("{ path: { id }, query: { tags: tags.map((t) => t.trim()) } }", "a.tsx").unwrap();
        assert_eq!(reads, ["id", "tags"]);
        // Type positions are erased: no temporal dead zone to respect.
        assert_eq!(validate_args("{ query: q as Query, n: 1 as typeof limit }", "a.tsx").unwrap(), ["q"]);
        assert!(validate_args("{ page: 1 }", "a.tsx").unwrap().is_empty());
    }

    #[test]
    fn nesting_depth_skips_strings_comments_and_template_text() {
        assert_eq!(nesting_depth("{ query: { page: 1 } }"), 2);
        assert_eq!(nesting_depth("f([{ a: (1) }])"), 4);
        assert_eq!(nesting_depth(r#"{ a: "((((", b: '[[\'[[', c: /* {{{{ */ 1 } // ((("#), 1);
        // A template counts, and so does each `${…}` inside it; its text does not.
        assert_eq!(nesting_depth("`(((${ `${ x }` }`"), 4);
        assert_eq!(nesting_depth("`\\${ not a substitution`"), 1);
        assert_eq!(nesting_depth(")))]]]"), 0);
        assert_eq!(nesting_depth("/* unclosed {{{"), 0);
    }

    #[test]
    fn long_args_are_abbreviated_in_messages() {
        assert_eq!(abbreviate("{ page: 1 }"), "{ page: 1 }");
        let long = "x".repeat(81);
        assert_eq!(abbreviate(&long), format!("{}…", "x".repeat(60)));
        let err = validate_args(&"[".repeat(300), "a.tsx").unwrap_err().to_string();
        assert!(err.contains("300 levels deep") && err.len() < 200, "{err}");
    }

    #[test]
    fn reindents_multiline_expressions() {
        let args = "{\n    query: {\n        page: 1,\n    },\n}";
        assert_eq!(
            reindent_expression(args, "\t\t", "\t", "\n"),
            "{\n\t\t\tquery: {\n\t\t\t\tpage: 1,\n\t\t\t},\n\t\t}"
        );
        let args = "{\r\n  query: 1,\r\n}";
        assert_eq!(reindent_expression(args, "    ", "  ", "\r\n"), "{\r\n      query: 1,\r\n    }");
    }

    #[test]
    fn trivia_scanning() {
        let src = "{ // note\r\n  return x\n}";
        assert_eq!(trivia_to_line_break(src, 1), Some(9));
        assert_eq!(trivia_to_line_break("{ /* a\nb */\n  x }", 1), Some(11));
        assert_eq!(trivia_to_line_break("{ return x }", 1), None);
        assert_eq!(skip_trivia("()  /* c */\n // d\n => x", 2), 19);
    }

    #[test]
    fn offsets_shift_past_earlier_edits() {
        let edits = [Edit::insert(0, "ab"), Edit::replace(2, 4, "x"), Edit::insert(9, "zz")];
        assert_eq!(shifted(&edits, 5), 6);
        assert_eq!(shifted(&edits, 9), 12);
    }
}
