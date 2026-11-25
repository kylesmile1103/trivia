use std::{borrow::Cow, collections::BTreeMap};

use oxc_ast::ast::*;
use oxc_ast_visit::{Visit, walk};
use oxc_span::{GetSpan, Span};

use crate::{
    Diagnostic, EmitRequest, EmitResponse, EmitResult, ExpressionInput, Locals, MAX_EXPRESSIONS, RenameRequest, Scope, Severity, Unit,
    allow, parse, scope::{ArrowBindings, ScopeCheck}, subset,
};

pub fn emit(request: EmitRequest) -> EmitResponse {
    let scope = Scope::default();
    batch(request.expressions, |input| {
        emit_one(&input.source, &request.rename, request.arrow_body, &scope, &input.locals)
    })
}

#[derive(Debug)]
pub struct InvalidNodeName(&'static str);

impl std::fmt::Display for InvalidNodeName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "`{}` must be a node name", self.0)
    }
}

impl std::error::Error for InvalidNodeName {}

pub fn rename_references(request: RenameRequest) -> Result<EmitResponse, InvalidNodeName> {
    for (field, name) in [("from", &request.from), ("to", &request.to)] {
        let mut bytes = name.bytes();
        if !bytes.next().is_some_and(|first| first.is_ascii_lowercase()) || !bytes.all(|b| b.is_ascii_alphanumeric()) {
            return Err(InvalidNodeName(field));
        }
    }
    Ok(batch(request.expressions, |input| {
        rename_one(&input.source, &input.locals, &request.from, &request.to)
    }))
}

fn batch(expressions: Vec<ExpressionInput>, apply: impl Fn(&ExpressionInput) -> Result<String, Vec<Diagnostic>>) -> EmitResponse {
    let results = expressions.into_iter().enumerate().map(|(index, input)| {
        let result = if index < MAX_EXPRESSIONS { apply(&input) } else { Err(vec![Diagnostic::batch_limit()]) };
        match result {
            Ok(ts) => EmitResult { id: input.id, ts: Some(ts), diagnostics: Vec::new() },
            Err(diagnostics) => EmitResult { id: input.id, ts: None, diagnostics },
        }
    }).collect();
    EmitResponse { unit: Unit::Utf16, results }
}

fn rename_one(source: &str, locals: &Locals, from: &str, to: &str) -> Result<String, Vec<Diagnostic>> {
    let parsed = parse::parse(source, |expression| {
        let mut rewriter = Rewriter::new(Rename::Node { from, to }, locals);
        rewriter.visit_expression(expression);
        if let Some(span) = rewriter.untracked_reference {
            return Err(vec![Diagnostic::at(source, "expr_unsupported_syntax", Severity::Error, span,
                "Cannot rename a reference inside a scope outside the binding subset")]);
        }
        Ok(rewriter.edits)
    });
    match parsed {
        Ok(edits) => finish(source, edits?),
        // A broken draft with no possible `ui` identifier needs no edit. Identifier escapes
        // may conceal the name, so leave those to the parser and refuse if it cannot recover.
        Err(error) if error.code == "expr_unsupported_syntax" && !source.contains('\\') && !source.contains("ui") => {
            Ok(source.to_owned())
        }
        Err(error) => Err(vec![Diagnostic::from_parse(source, error)]),
    }
}

fn emit_one(
    source: &str, rename: &BTreeMap<String, String>, arrow_body: bool, scope: &Scope, locals: &Locals,
) -> Result<String, Vec<Diagnostic>> {
    let edits = parse::parse(source, |expression| {
        let (diagnostics, _) = subset::check(source, expression, ScopeCheck { scope, locals }, false);
        if diagnostics.iter().any(|diagnostic| diagnostic.severity == Severity::Error) {
            return Err(diagnostics);
        }
        let mut rewriter = Rewriter::new(Rename::Emit(rename), locals);
        if !rename.is_empty() {
            rewriter.visit_expression(expression);
        }
        if arrow_body && starts_with_object(expression) {
            let span = expression.span();
            rewriter.edits.push(Edit { span: Span::new(span.start, span.start), text: "(".into() });
            rewriter.edits.push(Edit { span: Span::new(span.end, span.end), text: ")".into() });
        }
        Ok(rewriter.edits)
    }).map_err(|error| vec![Diagnostic::from_parse(source, error)])??;
    finish(source, edits)
}

fn starts_with_object(mut expression: &Expression<'_>) -> bool {
    loop {
        expression = match expression {
            Expression::TSAsExpression(assertion) => &assertion.expression,
            Expression::TSSatisfiesExpression(satisfies) => &satisfies.expression,
            Expression::ObjectExpression(_) => return true,
            _ => return false,
        };
    }
}

struct Edit<'r> {
    span: Span,
    text: Cow<'r, str>,
}

fn finish(source: &str, mut edits: Vec<Edit<'_>>) -> Result<String, Vec<Diagnostic>> {
    if edits.is_empty() { return Ok(source.to_owned()); }
    let internal = |message: String| vec![Diagnostic::at(source, "internal", Severity::Error,
        Span::new(0, source.len() as u32), message)];
    edits.sort_unstable_by_key(|edit| (edit.span.start, edit.span.end));
    let mut cursor = 0;
    let mut output = String::with_capacity(source.len());
    for edit in edits {
        let Some(before) = source.get(cursor..edit.span.start as usize) else {
            return Err(internal("Invalid expression edit span".into()));
        };
        output.push_str(before);
        output.push_str(&edit.text);
        cursor = edit.span.end as usize;
    }
    let Some(suffix) = source.get(cursor..) else {
        return Err(internal("Invalid expression edit span".into()));
    };
    output.push_str(suffix);
    parse::parse(&output, |_| ()).map_err(|error| internal(format!("Emitted expression does not parse: {}", error.message)))?;
    Ok(output)
}

#[derive(Clone, Copy)]
enum Rename<'r> {
    Emit(&'r BTreeMap<String, String>),
    Node { from: &'r str, to: &'r str },
}

struct Rewriter<'r, 'a> {
    rename: Rename<'r>,
    locals: &'r Locals,
    bindings: ArrowBindings<'a>,
    edits: Vec<Edit<'r>>,
    untracked_scope: bool,
    untracked_reference: Option<Span>,
}

impl<'r> Rewriter<'r, '_> {
    fn new(rename: Rename<'r>, locals: &'r Locals) -> Self {
        Self { rename, locals, bindings: ArrowBindings::default(), edits: Vec::new(),
            untracked_scope: false, untracked_reference: None }
    }

    fn is_local(&self, name: &str) -> bool {
        self.bindings.contains(name) || self.locals.tier(name).is_some()
    }

    fn replacement(&self, name: &str) -> Option<&'r str> {
        let Rename::Emit(rename) = self.rename else { return None };
        if self.is_local(name) { return None; }
        rename.get(name).map(String::as_str).filter(|&replacement| replacement != name)
    }

    fn emit_prefix(&mut self, member: &MemberExpression<'_>, rename: &'r BTreeMap<String, String>) -> bool {
        let mut path = Path::default();
        if !path.append(member) || self.is_local(&path.name[..path.prefixes[0].0]) { return false; }
        for &(length, span) in path.prefixes.iter().rev() {
            let name = &path.name[..length];
            if let Some(replacement) = rename.get(name) {
                if replacement != name {
                    self.edits.push(Edit { span, text: Cow::Borrowed(replacement) });
                }
                return true;
            }
        }
        false
    }

    fn rename_node_member(&mut self, member: &MemberExpression<'_>, from: &str, to: &'r str) -> bool {
        if from == to || self.is_local("ui") || !matches!(member.object().get_inner_expression(),
            Expression::Identifier(id) if id.name == "ui")
        {
            return false;
        }
        let Some((mut span, _)) = member.static_property_info().filter(|(_, name)| *name == from) else { return false };
        if matches!(member, MemberExpression::ComputedMemberExpression(_)) {
            // The literal's span includes its quote or backtick pair.
            span = Span::new(span.start + 1, span.end - 1);
        }
        if self.untracked_scope {
            self.untracked_reference.get_or_insert(span);
        } else {
            self.edits.push(Edit { span, text: Cow::Borrowed(to) });
        }
        true
    }
}

impl<'a> Visit<'a> for Rewriter<'_, 'a> {
    fn visit_expression(&mut self, expression: &Expression<'a>) {
        let outer = self.untracked_scope;
        self.untracked_scope |= matches!(self.rename, Rename::Node { .. })
            && matches!(expression, Expression::FunctionExpression(_) | Expression::ClassExpression(_));
        walk::walk_expression(self, expression);
        self.untracked_scope = outer;
    }

    fn visit_member_expression(&mut self, member: &MemberExpression<'a>) {
        let matched = match self.rename {
            Rename::Emit(rename) => self.emit_prefix(member, rename),
            Rename::Node { from, to } => self.rename_node_member(member, from, to),
        };
        if !matched { walk::walk_member_expression(self, member); }
    }

    fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
        if let Some(replacement) = self.replacement(id.name.as_str()) {
            self.edits.push(Edit { span: id.span, text: Cow::Borrowed(replacement) });
        }
    }

    fn visit_object_property(&mut self, property: &ObjectProperty<'a>) {
        if property.shorthand && let Expression::Identifier(id) = &property.value {
            if let Some(replacement) = self.replacement(id.name.as_str()) {
                self.edits.push(Edit { span: id.span, text: format!("{}: {replacement}", id.name).into() });
            }
        } else {
            walk::walk_object_property(self, property);
        }
    }

    fn visit_arrow_function_expression(&mut self, arrow: &ArrowFunctionExpression<'a>) {
        let outer = self.bindings.enter(arrow, |_| {});
        let tracked = self.untracked_scope;
        self.untracked_scope |= matches!(arrow.body, ArrowFunctionBody::FunctionBody(_));
        walk::walk_arrow_function_expression(self, arrow);
        self.untracked_scope = tracked;
        self.bindings.leave(outer);
    }

    fn visit_ts_type(&mut self, _: &TSType<'a>) {}
}

#[derive(Default)]
struct Path {
    name: String,
    prefixes: Vec<(usize, Span)>,
}

impl Path {
    fn append(&mut self, member: &MemberExpression<'_>) -> bool {
        let Some((_, key)) = member.static_property_info() else { return false };
        // Dots in a string key are part of the property name, not path separators.
        if key.contains('.') { return false; }
        let object = member.object().without_parentheses();
        if let Expression::Identifier(id) = object {
            self.name.push_str(id.name.as_str());
            self.prefixes.push((self.name.len(), id.span));
        } else if !allow::as_member(object).is_some_and(|object| self.append(object)) {
            return false;
        }
        self.name.push('.');
        self.name.push_str(key);
        self.prefixes.push((self.name.len(), member.span()));
        true
    }
}
