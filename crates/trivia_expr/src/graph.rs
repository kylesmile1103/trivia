use std::{collections::{BTreeMap, BTreeSet, VecDeque}, sync::Arc};

use oxc_span::Span;

use crate::{Analysis, AnalyzeRequest, Diagnostic, Severity};

pub(crate) fn report_cycles(request: &AnalyzeRequest, results: &mut [Analysis]) {
    let Some(graph) = Graph::new(request, results) else { return };
    let (groups, group_of) = graph.components();
    let mut from_start = vec![None; graph.names.len()];
    let mut to_start = vec![None; graph.names.len()];
    let mut covered = vec![false; graph.names.len()];
    for (group, nodes) in groups.into_iter().enumerate() {
        let start = nodes[0];
        if nodes.len() == 1 && !graph.edges[start].contains(&start) { continue; }
        let path = graph.closed_path(&nodes, group, &group_of, &mut from_start, &mut to_start, &mut covered);
        let message: Arc<str> = format!("Dependency cycle: {path}").into();
        for node in nodes {
            let mut reported = BTreeSet::new();
            for &(to, expression) in &graph.expression_edges[node] {
                if group_of[to] == group && reported.insert(expression) {
                    let source = &request.expressions[expression].source;
                    let result = &mut results[expression];
                    result.ok = false;
                    result.diagnostics.push(Diagnostic::at(source, "expr_cycle", Severity::Error,
                        Span::new(0, source.len() as u32), Arc::clone(&message)));
                }
            }
        }
    }
}

struct Graph {
    names: Vec<String>,
    edges: Vec<Vec<usize>>,
    reverse: Vec<Vec<usize>>,
    // Each edge retains its originating expression, including repeated definitions.
    expression_edges: Vec<Vec<(usize, usize)>>,
}

impl Graph {
    fn new(request: &AnalyzeRequest, results: &[Analysis]) -> Option<Self> {
        let definitions = request.expressions.iter().zip(results).enumerate().filter_map(|(i, (input, result))| {
            result.ok.then_some(input.defines.as_deref()).flatten().map(|entity| (i, entity))
        });
        let mut names: BTreeSet<_> = definitions.clone().map(|(_, entity)| entity.to_owned()).collect();
        if names.is_empty() { return None; }
        names.extend(definitions.clone().flat_map(|(i, _)| results[i].deps.iter())
            .filter(|dep| dep.ends_with(".*")).cloned());
        let names: Vec<_> = names.into_iter().collect();
        let index: BTreeMap<_, _> = names.iter().enumerate().map(|(i, name)| (name.as_str(), i)).collect();
        let mut edges = vec![Vec::new(); names.len()];
        let mut expression_edges = vec![Vec::new(); names.len()];
        for (expression, entity) in definitions {
            let from = index[entity];
            for dep in &results[expression].deps {
                if let Some(&to) = index.get(dep.as_str()) {
                    edges[from].push(to);
                    expression_edges[from].push((to, expression));
                }
            }
        }
        // A dynamic read depends on every entity under the root. One vertex for the whole
        // root avoids constructing an edge for every pair of expressions and entities.
        let wildcards: BTreeMap<_, _> = index.iter().filter_map(|(entity, &node)| {
            entity.strip_suffix(".*").map(|root| (root, node))
        }).collect();
        for (node, entity) in names.iter().enumerate() {
            if let Some((root, name)) = entity.split_once('.')
                && name != "*"
                && let Some(&wildcard) = wildcards.get(root)
            {
                edges[wildcard].push(node);
            }
        }
        let mut reverse = vec![Vec::new(); names.len()];
        for (from, targets) in edges.iter_mut().enumerate() {
            targets.sort_unstable();
            targets.dedup();
            for &to in targets.iter() {
                reverse[to].push(from);
            }
        }
        Some(Self { names, edges, reverse, expression_edges })
    }

    // Kosaraju's algorithm with explicit stacks, including for very long dependency chains.
    fn components(&self) -> (Vec<Vec<usize>>, Vec<usize>) {
        let mut visited = vec![false; self.names.len()];
        let mut order = Vec::with_capacity(self.names.len());
        let mut stack = Vec::new();
        for start in 0..self.names.len() {
            if std::mem::replace(&mut visited[start], true) { continue; }
            stack.push((start, self.edges[start].iter()));
            while let Some((node, targets)) = stack.last_mut() {
                if let Some(&next) = targets.next() {
                    if !std::mem::replace(&mut visited[next], true) {
                        stack.push((next, self.edges[next].iter()));
                    }
                } else {
                    order.push(*node);
                    stack.pop();
                }
            }
        }

        let mut group_of = vec![usize::MAX; self.names.len()];
        let mut groups = Vec::new();
        let mut pending = Vec::new();
        for start in order.into_iter().rev() {
            if group_of[start] != usize::MAX { continue; }
            let group = groups.len();
            let mut nodes = Vec::new();
            group_of[start] = group;
            pending.push(start);
            while let Some(node) = pending.pop() {
                nodes.push(node);
                for &next in &self.reverse[node] {
                    if group_of[next] == usize::MAX {
                        group_of[next] = group;
                        pending.push(next);
                    }
                }
            }
            nodes.sort_unstable();
            groups.push(nodes);
        }
        (groups, group_of)
    }

    fn closed_path(
        &self, nodes: &[usize], group: usize, group_of: &[usize],
        from_start: &mut [Option<usize>], to_start: &mut [Option<usize>], covered: &mut [bool],
    ) -> String {
        let start = nodes[0];
        if nodes.len() == 1 { return format!("{} -> {}", self.names[start], self.names[start]); }
        paths(&self.edges, start, group, group_of, from_start);
        paths(&self.reverse, start, group, group_of, to_start);

        let mut path = self.names[start].clone();
        let mut outbound = Vec::new();
        covered[start] = true;
        for &target in nodes {
            if covered[target] { continue; }
            let mut node = target;
            while node != start {
                outbound.push(node);
                node = from_start[node].expect("every group member is reachable");
            }
            let mut append = |node: usize| {
                path.push_str(" -> ");
                path.push_str(&self.names[node]);
                covered[node] = true;
            };
            for node in outbound.drain(..).rev() { append(node); }
            let mut node = target;
            while node != start {
                node = to_start[node].expect("every group member can return");
                append(node);
            }
        }
        path
    }
}

fn paths(edges: &[Vec<usize>], start: usize, group: usize, group_of: &[usize], parent: &mut [Option<usize>]) {
    parent[start] = Some(start);
    let mut pending = VecDeque::from([start]);
    while let Some(node) = pending.pop_front() {
        for &next in &edges[node] {
            if group_of[next] == group && parent[next].is_none() {
                parent[next] = Some(node);
                pending.push_back(next);
            }
        }
    }
}
