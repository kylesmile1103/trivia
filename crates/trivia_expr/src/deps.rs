use std::collections::{BTreeMap, VecDeque};

use oxc_ast::ast::{Expression, MemberExpression};
use oxc_span::Span;

use crate::{Analysis, AnalyzeRequest, RootTier, Scope, Tier, scope::{ArrowBindings, ScopeCheck}};

#[derive(Default)]
pub(crate) struct Reads {
    pub(crate) deps: Vec<String>,
    pub(crate) tier: Tier,
}

impl Reads {
    pub(crate) fn identifier(&mut self, scope: &ScopeCheck<'_>, bindings: &ArrowBindings<'_>, name: &str) {
        if bindings.contains(name) { return; }
        if let Some(tier) = scope.local_tier(name) {
            self.tier = self.tier.max(tier);
        } else if let Some(root) = scope.scope.roots.get(name) {
            self.record(name, "*", root.tier);
        }
    }

    pub(crate) fn member(
        &mut self, scope: &ScopeCheck<'_>, bindings: &ArrowBindings<'_>, member: &MemberExpression<'_>,
    ) -> Option<Span> {
        let Expression::Identifier(id) = member.object().get_inner_expression() else { return None };
        let name = id.name.as_str();
        if bindings.contains(name) || scope.local_tier(name).is_some() { return None; }
        let key = member.static_property_info().map_or("*", |(_, key)| key);
        if let Some(root) = scope.scope.roots.get(name) {
            self.record(name, key, root.tier);
            return Some(id.span);
        }
        if name == "Date" && key == "now" {
            self.tier = Tier::Client;
        }
        None
    }

    fn record(&mut self, name: &str, member: &str, tier: RootTier) {
        self.tier = self.tier.max(match tier {
            RootTier::Static | RootTier::Query => Tier::Static,
            RootTier::Server => Tier::Server,
            RootTier::Client => Tier::Client,
        });
        let dependency = format!("{name}.{member}");
        if !self.deps.contains(&dependency) {
            self.deps.push(dependency);
        }
    }
}

fn query_root<'s>(scope: &Scope, entity: &'s str) -> Option<&'s str> {
    let (root, _) = entity.split_once('.')?;
    scope.roots.get(root).is_some_and(|root| root.tier == RootTier::Query).then_some(root)
}

pub(crate) fn propagate_query_tiers(request: &AnalyzeRequest, results: &mut [Analysis]) {
    let mut pending: VecDeque<_> = results.iter().zip(&request.expressions).enumerate()
        .filter(|(_, (result, input))| result.ok && result.tier != Tier::Static
            && input.defines.as_deref().and_then(|entity| query_root(&request.scope, entity)).is_some())
        .map(|(index, _)| index).collect();
    if pending.is_empty() { return; }

    let mut consumers: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    let mut wildcard_consumers: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (index, result) in results.iter().enumerate() {
        for dep in &result.deps {
            let Some(root) = query_root(&request.scope, dep) else { continue };
            if dep.strip_suffix(".*") == Some(root) {
                wildcard_consumers.entry(root).or_default().push(index);
            } else {
                consumers.entry(dep).or_default().push(index);
            }
        }
    }

    // An entity can rise only from static to server to client. Propagate increases through
    // reverse edges so forward references and long chains need no recursion or repeated scans.
    let mut tiers: BTreeMap<&str, Tier> = BTreeMap::new();
    let mut root_tiers: BTreeMap<&str, Tier> = BTreeMap::new();
    let mut expression_tiers: Vec<_> = results.iter().map(|result| result.tier).collect();
    while let Some(index) = pending.pop_front() {
        let Some(entity) = request.expressions[index].defines.as_deref() else { continue };
        let Some(root) = query_root(&request.scope, entity) else { continue };
        let current = expression_tiers[index];
        let tier = tiers.entry(entity).or_default();
        if current <= *tier { continue; }
        *tier = current;
        let root_tier = root_tiers.entry(root).or_default();
        let wildcard = if current > *root_tier {
            *root_tier = current;
            wildcard_consumers.get(root)
        } else {
            None
        };
        let direct = consumers.get(entity).into_iter().flatten();
        for &consumer in direct.chain(wildcard.into_iter().flatten()) {
            if expression_tiers[consumer] < current {
                expression_tiers[consumer] = current;
                if results[consumer].ok && request.expressions[consumer].defines.is_some() {
                    pending.push_back(consumer);
                }
            }
        }
    }
    for (result, tier) in results.iter_mut().zip(expression_tiers) {
        result.tier = tier;
    }
}
