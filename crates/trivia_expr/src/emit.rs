use std::{borrow::Cow, collections::BTreeMap};

use oxc_ast::ast::*;
use oxc_ast_visit::{Visit, walk};
use oxc_span::{GetSpan, Span};

use crate::{
    Diagnostic, EmitRequest, EmitResponse, EmitResult, Locals, MAX_EXPRESSIONS, Scope, Severity, Unit,
    allow, parse, scope::{ArrowBindings, ScopeCheck}, subset,
};

pub fn emit(request: EmitRequest) -> EmitResponse {
    let scope = Scope::default();
    let results = request.expressions.into_iter().enumerate().map(|(index, input)| {
        let result = if index < MAX_EXPRESSIONS {
            emit_one(&input.source, &request.rename, request.arrow_body, &scope, &input.locals)
        } else {
            Err(vec![Diagnostic::batch_limit()])
        };
        match result {
            Ok(ts) => EmitResult { id: input.id, ts: Some(ts), diagnostics: Vec::new() },
            Err(diagnostics) => EmitResult { id: input.id, ts: None, diagnostics },
        }
    }).collect();
    EmitResponse { unit: Unit::Utf16, results }
}

fn emit_one(
    source: &str, rename: &BTreeMap<String, String>, arrow_body: bool, scope: &Scope, locals: &Locals,
) -> Result<String, Vec<Diagnostic>> {
    let edits = parse::parse(source, |expression| {
        let (diagnostics, _) = subset::check(source, expression, ScopeCheck { scope, locals }, false);
        if diagnostics.iter().any(|diagnostic| diagnostic.severity == Severity::Error) {
            return Err(diagnostics);
        }
        let mut rewriter = Rewriter { rename, locals, bindings: ArrowBindings::default(), edits: Vec::new() };
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

struct Rewriter<'r, 'a> {
    rename: &'r BTreeMap<String, String>,
    locals: &'r Locals,
    bindings: ArrowBindings<'a>,
    edits: Vec<Edit<'r>>,
}

impl<'r> Rewriter<'r, '_> {
    fn is_local(&self, name: &str) -> bool {
        self.bindings.contains(name) || self.locals.tier(name).is_some()
    }

    fn replacement(&self, name: &str) -> Option<&'r str> {
        if self.is_local(name) { return None; }
        self.rename.get(name).map(String::as_str).filter(|&replacement| replacement != name)
    }
}

impl<'a> Visit<'a> for Rewriter<'_, 'a> {
    fn visit_member_expression(&mut self, member: &MemberExpression<'a>) {
        let mut path = Path::default();
        if path.append(member) && !self.is_local(&path.name[..path.prefixes[0].0]) {
            for &(length, span) in path.prefixes.iter().rev() {
                let name = &path.name[..length];
                if let Some(replacement) = self.rename.get(name) {
                    if replacement != name {
                        self.edits.push(Edit { span, text: Cow::Borrowed(replacement) });
                    }
                    return;
                }
            }
        }
        walk::walk_member_expression(self, member);
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
        walk::walk_arrow_function_expression(self, arrow);
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
