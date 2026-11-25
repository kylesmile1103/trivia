use oxc_allocator::ArenaVec;
use oxc_ast::ast::*;
use oxc_ast_visit::{Visit, walk};
use oxc_span::{GetSpan, Span};

use crate::{Diagnostic, Severity, allow, deps::Reads, scope::{ArrowBindings, ScopeCheck}};

pub(crate) fn check<'a>(source: &str, expression: &Expression<'a>, scope: ScopeCheck<'_>) -> (Vec<Diagnostic>, Reads) {
    let mut subset = Subset {
        source, scope, diagnostics: Vec::new(), arrow_argument: None, format_factory: None,
        bindings: ArrowBindings::default(), reads: Reads::default(), member_root: None,
    };
    subset.visit_expression(expression);
    (subset.diagnostics, subset.reads)
}

struct Subset<'s, 'a> {
    source: &'s str,
    scope: ScopeCheck<'s>,
    diagnostics: Vec<Diagnostic>,
    arrow_argument: Option<Span>,
    format_factory: Option<Span>,
    bindings: ArrowBindings<'a>,
    reads: Reads,
    member_root: Option<Span>,
}

impl Subset<'_, '_> {
    fn unsupported(&mut self, span: Span, message: &'static str) {
        self.diagnostics.push(Diagnostic::at(self.source, "expr_unsupported_syntax", Severity::Error, span, message));
    }
}

impl<'a> Visit<'a> for Subset<'_, 'a> {
    fn visit_expression(&mut self, node: &Expression<'a>) {
        use Expression::*;
        let message = match node {
            BooleanLiteral(_) | NullLiteral(_) | NumericLiteral(_) | StringLiteral(_) | TemplateLiteral(_)
            | Identifier(_) | ArrayExpression(_) | ObjectExpression(_) | StaticMemberExpression(_)
            | ComputedMemberExpression(_) | ChainExpression(_) | CallExpression(_) | LogicalExpression(_)
            | ConditionalExpression(_) | ParenthesizedExpression(_) | TSAsExpression(_) | TSSatisfiesExpression(_)
            | ArrowFunctionExpression(_) => {
                walk::walk_expression(self, node);
                return;
            }
            BinaryExpression(bin) if bin.operator.is_arithmetic() || bin.operator.is_compare()
                || bin.operator.is_equality() => {
                walk::walk_expression(self, node);
                return;
            }
            UnaryExpression(unary) if unary.operator.is_arithmetic() || unary.operator.is_not()
                || unary.operator.is_typeof() => {
                walk::walk_expression(self, node);
                return;
            }
            AssignmentExpression(_) => "Assignment is unsupported in a binding",
            UpdateExpression(_) => "Increment and decrement are unsupported in a binding",
            NewExpression(_) => "Construction with new is unsupported in a binding",
            AwaitExpression(_) => "Await is unsupported in a binding",
            YieldExpression(_) => "Yield is unsupported in a binding",
            ThisExpression(_) | Super(_) => "this and super are unsupported in a binding",
            BinaryExpression(_) | UnaryExpression(_) => "Operator is unsupported in a binding",
            SequenceExpression(_) => "The comma operator is unsupported in a binding",
            FunctionExpression(_) => "Functions are unsupported in a binding",
            TaggedTemplateExpression(_) => "Tagged templates are unsupported in a binding",
            ImportExpression(_) | ImportMeta(_) => "Imports are unsupported in a binding",
            JSXElement(_) | JSXFragment(_) => "JSX is unsupported in a binding",
            RegExpLiteral(_) => "Regular expression literals are unsupported in a binding",
            ClassExpression(_) => "Classes are unsupported in a binding",
            _ => "Syntax is unsupported in a binding",
        };
        self.unsupported(node.span(), message);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        let factory = if self.format_factory == Some(call.span) {
            None
        } else {
            match allow::classify(&call.callee, |name| self.scope.shadowed(&self.bindings, name)) {
                allow::Call::Allowed => None,
                allow::Call::Format(factory) => Some(factory),
                allow::Call::Refused => {
                    self.diagnostics.push(Diagnostic::at(self.source, "expr_impure_call", Severity::Error,
                        call.callee.span(), "Call target is outside the pure call allowlist"));
                    self.visit_arguments(&call.arguments);
                    return;
                }
            }
        };
        let previous = std::mem::replace(&mut self.format_factory, factory);
        walk::walk_call_expression(self, call);
        self.format_factory = previous;
    }

    fn visit_arguments(&mut self, args: &ArenaVec<'a, Argument<'a>>) {
        for arg in args {
            let arrow = arg.as_expression().map(Expression::without_parentheses)
                .filter(|expr| matches!(expr, Expression::ArrowFunctionExpression(_))).map(GetSpan::span);
            let previous = std::mem::replace(&mut self.arrow_argument, arrow);
            walk::walk_argument(self, arg);
            self.arrow_argument = previous;
        }
    }

    fn visit_arrow_function_expression(&mut self, arrow: &ArrowFunctionExpression<'a>) {
        let outer = self.bindings.enter(arrow, |binding| {
            if self.scope.scope.roots.contains_key(binding.name.as_str()) {
                self.diagnostics.push(Diagnostic::at(self.source, "expr_shadowed_root", Severity::Warning,
                    binding.span, format!("Arrow parameter shadows the root `{}`", binding.name)));
            }
        });
        if self.arrow_argument != Some(arrow.span) {
            self.unsupported(arrow.span, "Arrow functions are allowed only as call arguments");
        } else if arrow.r#async {
            self.unsupported(arrow.span, "Async arrow functions are unsupported in a binding");
        } else if let ArrowFunctionBody::FunctionBody(body) = &arrow.body {
            self.unsupported(body.span, "Arrow functions in bindings must have an expression body");
        } else {
            walk::walk_arrow_function_expression(self, arrow);
        }
        self.bindings.leave(outer);
    }

    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'a>) {
        let name = identifier.name.as_str();
        if self.member_root != Some(identifier.span) {
            self.reads.identifier(&self.scope, &self.bindings, name);
        }
        if !self.scope.known(&self.bindings, name) {
            self.diagnostics.push(Diagnostic::at(self.source, "expr_unknown_root", Severity::Error,
                identifier.span, format!("Unknown root `{name}`")));
        }
    }

    fn visit_member_expression(&mut self, member: &MemberExpression<'a>) {
        if let Some((span, name)) = member.static_property_info()
            && self.scope.has_unknown_member(&self.bindings, member)
        {
            self.diagnostics.push(Diagnostic::at(self.source, "expr_unknown_member", Severity::Error,
                span, format!("Unknown member `{name}`")));
        }
        let root = self.reads.member(&self.scope, &self.bindings, member);
        let previous = std::mem::replace(&mut self.member_root, root);
        walk::walk_member_expression(self, member);
        self.member_root = previous;
    }

    fn visit_object_property(&mut self, property: &ObjectProperty<'a>) {
        if property.method || property.kind != PropertyKind::Init {
            self.unsupported(property.span, "Object methods and accessors are unsupported in a binding");
        } else {
            walk::walk_object_property(self, property);
        }
    }

    fn visit_private_field_expression(&mut self, field: &PrivateFieldExpression<'a>) {
        self.unsupported(field.span, "Private fields are unsupported in a binding");
    }

    fn visit_ts_non_null_expression(&mut self, node: &TSNonNullExpression<'a>) {
        self.unsupported(node.span, "Non-null assertions are unsupported in a binding");
    }

    // Type syntax is preserved for tsc. Its identifiers and literals are not value reads.
    fn visit_ts_type(&mut self, _: &TSType<'a>) {}
}
