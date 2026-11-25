//! Pinned OXC 0.153.0 API (verified in the reference source):
//! `Parser::parse_expression` parses one expression through EOF and returns diagnostics on
//! failure. `Visit::visit_expression` and `walk::walk_expression` traverse the AST.
//! `GetSpan::span` returns a `Span` with zero-based UTF-8 byte offsets.

use oxc_allocator::Allocator;
use oxc_ast::ast::*;
use oxc_ast_visit::{Visit, walk};
use oxc_parser::Parser;
use oxc_span::{SourceType, Span};

pub const MAX_BYTES: usize = 4096;
pub const MAX_DEPTH: usize = 64;

#[derive(Debug)]
pub struct ParseError {
    pub code: &'static str,
    pub message: String,
    pub span: Span,
}

pub fn parse<T: Send>(source: &str, use_expression: impl FnOnce(&Expression<'_>) -> T + Send) -> Result<T, ParseError> {
    if source.len() > MAX_BYTES {
        return Err(too_large(source, "Expression exceeds 4096 bytes"));
    }
    let run = || parse_expression(&Allocator::default(), source).map(|expression| use_expression(&expression));
    if source.len() <= 128 {
        return run();
    }
    // OXC's recursive parser runs before the depth walk. Give inputs long enough to exhaust
    // an ordinary test or Node stack room to reach the limit check, even in a debug build.
    std::thread::scope(|scope| {
        let worker = std::thread::Builder::new().stack_size(32 * 1024 * 1024)
            .spawn_scoped(scope, run)
            .map_err(|_| ParseError {
                code: "internal",
                message: "Could not start expression parser".to_owned(),
                span: Span::new(0, 0),
            })?;
        worker.join().unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    })
}

fn too_large(source: &str, message: &str) -> ParseError {
    ParseError {
        code: "expr_too_large",
        message: message.to_owned(),
        span: Span::new(0, source.len().try_into().unwrap_or(u32::MAX)),
    }
}

fn parse_expression<'a>(allocator: &'a Allocator, source: &'a str) -> Result<Expression<'a>, ParseError> {
    let source_end = source.len() as u32;
    let expression = Parser::new(allocator, source, SourceType::tsx().with_module(true))
        .parse_expression()
        .map_err(|diagnostics| {
            let first = diagnostics.first();
            let span = first.and_then(|d| d.labels.first()).map_or(Span::new(source_end, source_end), |label| {
                let start = label.offset().min(source_end);
                let end = label.offset().saturating_add(label.len()).min(source_end);
                Span::new(start, end)
            });
            ParseError {
                code: "expr_unsupported_syntax",
                message: first.map_or_else(|| "Expected an expression".to_owned(), ToString::to_string),
                span,
            }
        })?;

    let mut depth = Depth::default();
    depth.visit_expression(&expression);
    if depth.exceeded {
        return Err(too_large(source, "Expression exceeds 64 levels"));
    }
    Ok(expression)
}

#[derive(Default)]
struct Depth {
    level: usize,
    exceeded: bool,
}

// Prune recursive grammar branches after the first excess. In particular, an iterative
// parser can produce a very deep left-associated AST from a short expression.
macro_rules! measure_depth {
    ($visit:ident, $node:ident, $walk:ident) => {
        fn $visit(&mut self, node: &$node<'a>) {
            if self.level == MAX_DEPTH { self.exceeded = true; }
            if self.exceeded { return; }
            self.level += 1;
            walk::$walk(self, node);
            self.level -= 1;
        }
    };
}

impl<'a> Visit<'a> for Depth {
    measure_depth!(visit_expression, Expression, walk_expression);
    measure_depth!(visit_ts_type, TSType, walk_ts_type);
    measure_depth!(visit_statement, Statement, walk_statement);
    measure_depth!(visit_binding_pattern, BindingPattern, walk_binding_pattern);
    measure_depth!(visit_assignment_target, AssignmentTarget, walk_assignment_target);
    measure_depth!(visit_jsx_element, JSXElement, walk_jsx_element);
    measure_depth!(visit_jsx_fragment, JSXFragment, walk_jsx_fragment);
}
