use oxc_ast::ast::{ArrowFunctionExpression, BindingIdentifier, Expression, MemberExpression};

use crate::{Locals, Members, Scope, Tier, allow};

#[derive(Default)]
pub(crate) struct ArrowBindings<'a> {
    names: Vec<&'a str>,
}

impl<'a> ArrowBindings<'a> {
    pub(crate) fn enter(
        &mut self, arrow: &ArrowFunctionExpression<'a>, mut on_binding: impl FnMut(&BindingIdentifier<'a>),
    ) -> usize {
        let outer = self.names.len();
        for binding in arrow.params.iter_bindings().flat_map(|pattern| pattern.get_binding_identifiers()) {
            self.names.push(binding.name.as_str());
            on_binding(binding);
        }
        outer
    }

    pub(crate) fn leave(&mut self, outer: usize) {
        self.names.truncate(outer);
    }

    pub(crate) fn contains(&self, name: &str) -> bool {
        self.names.contains(&name)
    }
}

pub(crate) struct ScopeCheck<'s> {
    pub(crate) scope: &'s Scope,
    pub(crate) locals: &'s Locals,
}

impl ScopeCheck<'_> {
    pub(crate) fn local_tier(&self, name: &str) -> Option<Tier> {
        self.locals.tier(name).or_else(|| self.scope.locals.tier(name))
    }

    pub(crate) fn shadowed(&self, bindings: &ArrowBindings<'_>, name: &str) -> bool {
        bindings.contains(name) || self.local_tier(name).is_some() || self.scope.roots.contains_key(name)
    }

    pub(crate) fn known(&self, bindings: &ArrowBindings<'_>, name: &str) -> bool {
        self.shadowed(bindings, name) || allow::is_global(name)
    }

    pub(crate) fn has_unknown_member(&self, bindings: &ArrowBindings<'_>, member: &MemberExpression<'_>) -> bool {
        let Some((_, name)) = member.static_property_info() else { return false };
        let object = self.shape(bindings, member.object());
        !matches!(object, Shape::Missing) && matches!(object.member(name), Shape::Missing)
    }

    fn shape<'n>(&'n self, bindings: &ArrowBindings<'_>, expr: &'n Expression<'_>) -> Shape<'n> {
        let expr = expr.get_inner_expression();
        if let Expression::Identifier(id) = expr {
            let name = id.name.as_str();
            if bindings.contains(name) || self.local_tier(name).is_some() {
                return Shape::Open;
            }
            if let Some(root) = self.scope.roots.get(name) {
                return Shape::of(root.members.as_ref());
            }
            return if allow::is_global(name) { Shape::Global(name) } else { Shape::Missing };
        }
        if let Some(member) = allow::as_member(expr) {
            if let Some((_, name)) = member.static_property_info() {
                return self.shape(bindings, member.object()).member(name);
            }
        }
        Shape::Open
    }
}

#[derive(Clone, Copy)]
enum Shape<'s> {
    Open,
    Known(&'s Members),
    Global(&'s str),
    Missing,
}

impl<'s> Shape<'s> {
    fn of(members: Option<&'s Members>) -> Self {
        members.map_or(Shape::Open, Shape::Known)
    }

    fn member(self, name: &str) -> Self {
        match self {
            Shape::Known(Members::Names(names)) => {
                if names.iter().any(|member| member == name) { Shape::Open } else { Shape::Missing }
            }
            Shape::Known(Members::Shaped(shapes)) => shapes.get(name)
                .map_or(Shape::Missing, |shape| Self::of(shape.as_ref())),
            Shape::Global(global) if allow::is_global_member(global, name) => Shape::Open,
            Shape::Global(_) => Shape::Missing,
            shape => shape,
        }
    }
}
