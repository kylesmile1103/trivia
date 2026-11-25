use oxc_ast::ast::{CallExpression, ChainElement, Expression, MemberExpression};
use oxc_span::Span;

const METHODS: &[&str] = &[
    "trim", "toLowerCase", "toUpperCase", "startsWith", "endsWith", "includes", "slice",
    "padStart", "padEnd", "split", "replaceAll", "map", "filter", "find", "some", "every",
    "join", "flatMap", "reduce", "at", "toSorted", "toFixed",
];
const MATH_METHODS: &[&str] = &[
    "abs", "acos", "acosh", "asin", "asinh", "atan", "atan2", "atanh", "cbrt", "ceil", "clz32",
    "cos", "cosh", "exp", "expm1", "f16round", "floor", "fround", "hypot", "imul", "log", "log10", "log1p",
    "log2", "max", "min", "pow", "round", "sign", "sin", "sinh", "sqrt", "tan", "tanh", "trunc",
];
const GLOBAL_FUNCTIONS: &[&str] = &["Number", "String", "Boolean"];
const GLOBAL_METHODS: &[(&str, &[&str])] = &[
    ("Math", MATH_METHODS),
    ("Object", &["keys", "values", "entries"]),
    ("JSON", &["stringify"]),
    ("Date", &["now"]),
    ("Intl", &[]),
];
const FORMAT_FACTORIES: &[&str] = &["NumberFormat", "DateTimeFormat"];

pub(crate) enum Call {
    Allowed,
    Format(Span),
    Refused,
}

pub(crate) fn classify(callee: &Expression<'_>, is_shadowed: impl Fn(&str) -> bool) -> Call {
    let callee = callee.without_parentheses();
    if let Expression::Identifier(id) = callee {
        return if GLOBAL_FUNCTIONS.contains(&id.name.as_str()) && !is_shadowed(id.name.as_str()) {
            Call::Allowed
        } else {
            Call::Refused
        };
    }
    let Some(member) = as_member(callee) else { return Call::Refused };
    let Some((_, name)) = member.static_property_info() else { return Call::Refused };
    if let Expression::Identifier(id) = member.object().without_parentheses()
        && !is_shadowed(id.name.as_str())
    {
        if let Some((_, methods)) = GLOBAL_METHODS.iter().find(|(global, _)| *global == id.name.as_str()) {
            return if methods.contains(&name) { Call::Allowed } else { Call::Refused };
        }
        if GLOBAL_FUNCTIONS.contains(&id.name.as_str()) {
            return Call::Refused;
        }
    }
    if name == "format"
        && let Some(call) = as_call(member.object())
        && let Some(factory) = as_member(&call.callee)
        && matches!(factory.object().without_parentheses(), Expression::Identifier(id)
            if id.name == "Intl" && !is_shadowed("Intl"))
        && factory.static_property_info().is_some_and(|(_, method)| FORMAT_FACTORIES.contains(&method))
    {
        return Call::Format(call.span);
    }
    if METHODS.contains(&name) { Call::Allowed } else { Call::Refused }
}

pub(crate) fn as_member<'n, 'a>(expr: &'n Expression<'a>) -> Option<&'n MemberExpression<'a>> {
    match expr.without_parentheses() {
        Expression::ChainExpression(chain) => chain.expression.as_member_expression(),
        expr => expr.as_member_expression(),
    }
}

fn as_call<'n, 'a>(expr: &'n Expression<'a>) -> Option<&'n CallExpression<'a>> {
    match expr.without_parentheses() {
        Expression::CallExpression(call) => Some(call),
        Expression::ChainExpression(chain) => match &chain.expression {
            ChainElement::CallExpression(call) => Some(call),
            _ => None,
        },
        _ => None,
    }
}

pub(crate) fn is_global(name: &str) -> bool {
    name == "undefined" || GLOBAL_FUNCTIONS.contains(&name) || GLOBAL_METHODS.iter().any(|(global, _)| *global == name)
}

pub(crate) fn is_global_member(global: &str, name: &str) -> bool {
    const MATH_CONSTANTS: &[&str] = &["E", "LN10", "LN2", "LOG10E", "LOG2E", "PI", "SQRT1_2", "SQRT2"];
    const NUMBER_CONSTANTS: &[&str] = &[
        "EPSILON", "MAX_SAFE_INTEGER", "MIN_SAFE_INTEGER", "MAX_VALUE", "MIN_VALUE", "NaN",
        "NEGATIVE_INFINITY", "POSITIVE_INFINITY",
    ];
    match global {
        "Math" if MATH_CONSTANTS.contains(&name) => true,
        "Number" => NUMBER_CONSTANTS.contains(&name),
        "Intl" => FORMAT_FACTORIES.contains(&name),
        _ => GLOBAL_METHODS.iter().any(|(root, methods)| *root == global && methods.contains(&name)),
    }
}
