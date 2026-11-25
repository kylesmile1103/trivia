use std::collections::{BTreeMap, VecDeque};

use oxc_ast::ast::{Expression, MemberExpression};
use oxc_span::Span;

use crate::{Analysis, AnalyzeRequest, LocalTier, RootTier, Scope, Tier, scope::{ArrowBindings, ScopeCheck}};

#[derive(Default)]
pub(crate) struct Reads {
    pub(crate) deps: Vec<String>,
    pub(crate) tier: Tier,
    pub(crate) local_sources: Vec<String>,
}

impl Reads {
    pub(crate) fn identifier(&mut self, scope: &ScopeCheck<'_>, bindings: &ArrowBindings<'_>, name: &str) {
        if bindings.contains(name) { return; }
        match scope.local(name) {
            Some(LocalTier::Fixed(tier)) => self.tier = self.tier.max(*tier),
            Some(LocalTier::FromExpression { from }) => {
                if !self.local_sources.contains(from) { self.local_sources.push(from.clone()); }
            }
            None => {
                if let Some(root) = scope.scope.roots.get(name) {
                    self.record(name, "*", root.tier);
                }
            }
        }
    }

    pub(crate) fn member(
        &mut self, scope: &ScopeCheck<'_>, bindings: &ArrowBindings<'_>, member: &MemberExpression<'_>,
    ) -> Option<Span> {
        let Expression::Identifier(id) = member.object().get_inner_expression() else { return None };
        let name = id.name.as_str();
        if bindings.contains(name) || scope.local(name).is_some() { return None; }
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

pub(crate) fn propagate_tiers(request: &AnalyzeRequest, results: &mut [Analysis], local_reads: &[Vec<String>]) {
    let mut local_consumers: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (index, reads) in local_reads.iter().enumerate() {
        for from in reads { local_consumers.entry(from).or_default().push(index); }
    }
    let can_supply_tier = |index: usize| {
        let input = &request.expressions[index];
        local_consumers.contains_key(input.id.as_str())
            || input.defines.as_deref().and_then(|entity| query_root(&request.scope, entity)).is_some()
    };
    let mut pending: VecDeque<_> = results.iter().enumerate()
        .filter(|(index, result)| result.ok && result.tier != Tier::Static && can_supply_tier(*index))
        .map(|(index, _)| index).collect();
    if pending.is_empty() { return; }

    let mut query_consumers: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    let mut wildcard_consumers: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    for (index, result) in results.iter().enumerate() {
        for dep in &result.deps {
            let Some(root) = query_root(&request.scope, dep) else { continue };
            if dep.strip_suffix(".*") == Some(root) {
                wildcard_consumers.entry(root).or_default().push(index);
            } else {
                query_consumers.entry(dep).or_default().push(index);
            }
        }
    }

    // A tier can rise only from static to server to client. Propagate increases through
    // reverse edges so forward references and long chains need no recursion or repeated scans.
    let mut query_tiers: BTreeMap<&str, Tier> = BTreeMap::new();
    let mut root_tiers: BTreeMap<&str, Tier> = BTreeMap::new();
    let mut expression_tiers: Vec<_> = results.iter().map(|result| result.tier).collect();
    let mut propagated = vec![Tier::Static; results.len()];
    while let Some(index) = pending.pop_front() {
        let input = &request.expressions[index];
        let current = expression_tiers[index];
        if current <= propagated[index] { continue; }
        propagated[index] = current;
        let mut direct = None;
        let mut wildcard = None;
        if let Some(entity) = input.defines.as_deref()
            && let Some(root) = query_root(&request.scope, entity)
        {
            let tier = query_tiers.entry(entity).or_default();
            if current > *tier {
                *tier = current;
                direct = query_consumers.get(entity);
                let root_tier = root_tiers.entry(root).or_default();
                if current > *root_tier {
                    *root_tier = current;
                    wildcard = wildcard_consumers.get(root);
                }
            }
        }
        let locals = local_consumers.get(input.id.as_str());
        for &consumer in [direct, wildcard, locals].into_iter().flatten().flatten() {
            if expression_tiers[consumer] < current {
                expression_tiers[consumer] = current;
                if results[consumer].ok && can_supply_tier(consumer) {
                    pending.push_back(consumer);
                }
            }
        }
    }
    for (result, tier) in results.iter_mut().zip(expression_tiers) {
        result.tier = tier;
    }
}
