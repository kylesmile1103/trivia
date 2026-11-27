//! Where a JSX node is after an op (`applyOps`' `follow`, docs/api.md).
//!
//! A locator is a position (CLAUDE.md rule 4), so an op that adds, drops or moves JSX before a
//! node renumbers it, and a same-tag neighbour can slide into its old locator. The engine knows
//! the byte ranges it spliced, so it can say where the node went:
//! * a splice before the node shifts it, one after it leaves it alone, and one inside it (an
//!   attribute, a child, or its whole span: a replacement) keeps it, a little longer or shorter;
//! * a splice that cuts across the node, or covers more than it, removes it (`None`).
//!
//! The answer is then checked against the result's own JSX table: a node must be there with
//! exactly the mapped span, the same kind and the same tag, and a node no splice touched must
//! have the same bytes. A wrong map therefore gives `None`, never another node.
//!
//! The splices come from `text::apply_edits` itself, which reports each call while
//! [`recording`] runs an op, so every op (and every op to come) is covered. A file's chain is
//! the run of recorded calls whose texts lead from the file's text before the op to its text
//! after it, so a splice of some other text (the other file of a move, a trial) never enters it.
//! Moves say where their block went: a JSX move (`move`, `moveNode`, within a file or across
//! two) through the op's own result, and `moveElement` through [`moved`].

use std::cell::RefCell;
use std::hash::{DefaultHasher, Hash, Hasher};

use oxc_allocator::Allocator;

use crate::locator::{JsxNode, JsxTable, Locator};
use crate::ops::Op;
use crate::parse;
use crate::text::Edit;

/// One replacement, in the offsets of the text it was applied to: `start..end` became `len` bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Splice {
    start: u32,
    end: u32,
    len: u32,
}

/// A block one call moved verbatim: `from` in its input, `to` in its output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Moved {
    from: (u32, u32),
    to: (u32, u32),
}

/// One `text::apply_edits` call made while an op was recorded.
#[derive(Debug, Clone)]
pub struct Stage {
    input: u64,
    output: u64,
    /// Sorted by start, as `apply_edits` applies them.
    splices: Vec<Splice>,
    moved: Option<Moved>,
}

thread_local! {
    static RECORDER: RefCell<Option<Vec<Stage>>> = const { RefCell::new(None) };
}

fn digest(text: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

/// `text::apply_edits` turned `source` into `output` with `edits`: note it if an op is being recorded.
pub(crate) fn record(source: &str, edits: &[Edit], output: &str) {
    RECORDER.with(|recorder| {
        if let Some(stages) = recorder.borrow_mut().as_mut() {
            let mut splices: Vec<Splice> =
                edits.iter().map(|e| Splice { start: e.start, end: e.end, len: e.text.len() as u32 }).collect();
            splices.sort_by_key(|s| (s.start, s.end));
            stages.push(Stage { input: digest(source), output: digest(output), splices, moved: None });
        }
    });
}

/// The `apply_edits` call just made moved `from` (offsets in its input) verbatim to `to` (in its output).
pub(crate) fn moved(from: (u32, u32), to: (u32, u32)) {
    RECORDER.with(|recorder| {
        if let Some(stage) = recorder.borrow_mut().as_mut().and_then(|stages| stages.last_mut()) {
            stage.moved = Some(Moved { from, to });
        }
    });
}

/// Run `op` (one op's work), recording the splices it makes. Nested calls each get their own.
pub fn recording<T>(op: impl FnOnce() -> T) -> (T, Vec<Stage>) {
    struct Restore(Option<Option<Vec<Stage>>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            if let Some(outer) = self.0.take() {
                RECORDER.with(|recorder| recorder.replace(outer));
            }
        }
    }
    let mut restore = Restore(Some(RECORDER.with(|recorder| recorder.replace(Some(Vec::new())))));
    let out = op();
    let stages = RECORDER.with(|recorder| recorder.replace(restore.0.take().flatten())).unwrap_or_default();
    (out, stages)
}

/// One file's text before and after an op (`None`: the file does not exist).
#[derive(Debug, Clone, Copy)]
pub struct FileTexts<'t> {
    pub file: &'t str,
    pub before: Option<&'t str>,
    pub after: Option<&'t str>,
}

/// Where `loc` is after `op`, which `stages` record and which turned `files` from their `before`
/// to their `after` texts. `landed` is the op's result locator (where a moved element went).
/// `None` when the node is gone or its place can't be known; `loc` itself when the op left its
/// file as it was.
pub fn through(op: &Op, stages: &[Stage], files: &[FileTexts<'_>], landed: Option<&str>, loc: &Locator) -> Option<Locator> {
    let Some(texts) = files.iter().find(|t| t.file == loc.file) else { return Some(loc.clone()) };
    if texts.before == texts.after {
        return Some(loc.clone());
    }
    let (before, after) = (texts.before?, texts.after?);
    let alloc = Allocator::default();
    let program = parse(&alloc, before, &loc.file).ok()?;
    let table = JsxTable::build(&program, &loc.file).ok()?;
    let node = &table.nodes[table.find(&loc.scope, &loc.path)?];

    // A JSX move takes its element's subtree along, byte for byte but for indentation.
    if let Some(source) = moved_element(op)
        && source.file == loc.file
        && (source == *loc || source.is_ancestor_of(loc))
    {
        let landed = Locator::parse(landed?).ok()?;
        let path = landed.path.iter().chain(&loc.path[source.path.len()..]).copied().collect();
        let candidate = Locator { file: landed.file.clone(), scope: landed.scope, path };
        let target = files.iter().find(|t| t.file == candidate.file)?.after?;
        return check(target, &candidate, node, None);
    }

    let chain = chain(stages, before, after)?;
    let mut span = (node.span.start, node.span.end);
    let mut touched = false;
    for (i, stage) in chain.iter().enumerate() {
        if let Some(moved) = stage.moved
            && moved.from.0 <= span.0
            && span.1 <= moved.from.1
        {
            // Only the first call's input is the text the table was built from.
            return if i == 0 { follow_moved_block(&table, node, &moved, &chain[1..], &loc.file, after, before) } else { None };
        }
        let (next, cut) = through_stage(span, &stage.splices)?;
        span = next;
        touched |= cut;
    }
    let after_alloc = Allocator::default();
    let after_program = parse(&after_alloc, after, &loc.file).ok()?;
    let after_table = JsxTable::build(&after_program, &loc.file).ok()?;
    let found = after_table.nodes.iter().position(|n| n.span.start == span.0 && n.span.end == span.1)?;
    let candidate = after_table.locator(found, &loc.file);
    let bytes = (!touched).then(|| &before[node.span.start as usize..node.span.end as usize]);
    same_node(&after_table.nodes[found], node, after, bytes).then_some(candidate)
}

/// The element a JSX move takes along (`move` and `moveNode`), by its locator before the op.
fn moved_element(op: &Op) -> Option<Locator> {
    match op {
        Op::Move { source, .. } | Op::MoveNode { source, .. } => Locator::parse(source).ok(),
        _ => None,
    }
}

/// `candidate` in `after` is `node`'s counterpart: same kind and tag (and, given, the same bytes).
fn check(after: &str, candidate: &Locator, node: &JsxNode, bytes: Option<&str>) -> Option<Locator> {
    let alloc = Allocator::default();
    let program = parse(&alloc, after, &candidate.file).ok()?;
    let table = JsxTable::build(&program, &candidate.file).ok()?;
    let found = table.find(&candidate.scope, &candidate.path)?;
    same_node(&table.nodes[found], node, after, bytes).then(|| candidate.clone())
}

fn same_node(found: &JsxNode, node: &JsxNode, after: &str, bytes: Option<&str>) -> bool {
    found.kind == node.kind
        && found.name == node.name
        && bytes.is_none_or(|bytes| &after[found.span.start as usize..found.span.end as usize] == bytes)
}

/// The recorded calls that turn `before` into `after`, in order.
fn chain<'s>(stages: &'s [Stage], before: &str, after: &str) -> Option<Vec<&'s Stage>> {
    fn walk<'s>(stages: &'s [Stage], at: u64, to: u64, used: &mut [bool], path: &mut Vec<&'s Stage>) -> bool {
        if at == to && !path.is_empty() {
            return true;
        }
        for (i, stage) in stages.iter().enumerate() {
            if used[i] || stage.input != at || stage.input == stage.output {
                continue;
            }
            used[i] = true;
            path.push(stage);
            if walk(stages, stage.output, to, used, path) {
                return true;
            }
            path.pop();
            used[i] = false;
        }
        false
    }
    let mut used = vec![false; stages.len()];
    let mut path = Vec::new();
    walk(stages, digest(before), digest(after), &mut used, &mut path).then_some(path)
}

/// `span` through one call's splices: its new span, and whether a splice fell inside it (its
/// whole span included). `None` when a splice cuts across it or covers more than it.
fn through_stage(span: (u32, u32), splices: &[Splice]) -> Option<((u32, u32), bool)> {
    let (start, end) = span;
    let (mut new_start, mut new_end) = (i64::from(start), i64::from(end));
    let mut touched = false;
    for s in splices {
        let delta = i64::from(s.len) - i64::from(s.end - s.start);
        if s.end <= start {
            // Before it; an insertion at its start lands before it too.
            new_start += delta;
            new_end += delta;
        } else if s.start >= end {
            // After it; an insertion at its end lands after it.
        } else if start <= s.start && s.end <= end {
            // Inside it, or the node itself replaced: whatever is in its place now.
            new_end += delta;
            touched = true;
        } else {
            return None;
        }
    }
    Some(((u32::try_from(new_start).ok()?, u32::try_from(new_end).ok()?), touched))
}

/// A node inside a block the first call moved verbatim (`moveElement`): the block's JSX nodes
/// keep their order, so the node is the one in the same place among the landed block's, once
/// the block's place is carried through the remaining calls. The landed block must hold as many
/// nodes, with the same tags, and the node the same bytes.
fn follow_moved_block(
    table: &JsxTable,
    node: &JsxNode,
    moved: &Moved,
    rest: &[&Stage],
    file: &str,
    after: &str,
    before: &str,
) -> Option<Locator> {
    let inside = |n: &&JsxNode, (from, to): (u32, u32)| from <= n.span.start && n.span.end <= to;
    let mut was: Vec<&JsxNode> = table.nodes.iter().filter(|n| inside(n, moved.from)).collect();
    was.sort_by_key(|n| n.span.start);
    let k = was.iter().position(|n| std::ptr::eq(*n, node))?;
    let mut block = moved.to;
    for stage in rest {
        block = through_stage(block, &stage.splices)?.0;
    }
    let alloc = Allocator::default();
    let program = parse(&alloc, after, file).ok()?;
    let after_table = JsxTable::build(&program, file).ok()?;
    let mut now: Vec<usize> = (0..after_table.nodes.len()).filter(|&i| inside(&&after_table.nodes[i], block)).collect();
    now.sort_by_key(|&i| after_table.nodes[i].span.start);
    if now.len() != was.len() || now.iter().zip(&was).any(|(&i, w)| after_table.nodes[i].name != w.name) {
        return None;
    }
    let found = now[k];
    let bytes = &before[node.span.start as usize..node.span.end as usize];
    same_node(&after_table.nodes[found], node, after, Some(bytes)).then(|| after_table.locator(found, file))
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn splice(start: u32, end: u32, len: u32) -> Splice {
        Splice { start, end, len }
    }

    #[test]
    fn a_splice_before_shifts_one_after_leaves_and_one_inside_stretches() {
        let node = (10, 20);
        assert_eq!(through_stage(node, &[splice(2, 4, 5)]), Some(((13, 23), false)));
        assert_eq!(through_stage(node, &[splice(4, 10, 0)]), Some(((4, 14), false)));
        assert_eq!(through_stage(node, &[splice(10, 10, 3)]), Some(((13, 23), false)), "an insertion at its start lands before it");
        assert_eq!(through_stage(node, &[splice(20, 20, 3)]), Some(((10, 20), false)), "an insertion at its end lands after it");
        assert_eq!(through_stage(node, &[splice(25, 30, 0)]), Some(((10, 20), false)));
        assert_eq!(through_stage(node, &[splice(12, 14, 6)]), Some(((10, 24), true)));
        assert_eq!(through_stage(node, &[splice(10, 12, 0)]), Some(((10, 18), true)), "a splice from its start, inside it");
        assert_eq!(through_stage(node, &[splice(1, 2, 0), splice(12, 13, 2), splice(30, 31, 9)]), Some(((9, 20), true)));
    }

    #[test]
    fn a_splice_of_the_whole_node_keeps_its_place_and_one_across_it_removes_it() {
        assert_eq!(through_stage((10, 20), &[splice(10, 20, 4)]), Some(((10, 14), true)));
        assert_eq!(through_stage((10, 20), &[splice(2, 4, 1), splice(10, 20, 4)]), Some(((9, 13), true)));
        assert_eq!(through_stage((10, 20), &[splice(5, 12, 0)]), None, "across its start");
        assert_eq!(through_stage((10, 20), &[splice(18, 25, 0)]), None, "across its end");
        assert_eq!(through_stage((10, 20), &[splice(5, 25, 3)]), None, "around it");
    }

    #[test]
    fn records_only_while_recording_and_restores_the_outer_recorder() {
        let edits = [Edit::insert(0, "x")];
        record("a", &edits, "xa");
        let ((), outer) = recording(|| {
            record("a", &edits, "xa");
            let ((), inner) = recording(|| record("b", &edits, "xb"));
            assert_eq!(inner.len(), 1);
            record("xa", &edits, "xxa");
        });
        assert_eq!(outer.len(), 2);
        assert_eq!(outer[0].input, digest("a"));
        assert_eq!(outer[1].output, digest("xxa"));
    }

    #[test]
    fn a_chain_runs_from_the_file_before_to_after_and_skips_other_texts() {
        let ((), stages) = recording(|| {
            record("other", &[Edit::insert(0, "!")], "!other");
            record("ab", &[Edit::insert(1, "x")], "axb");
            record("ab", &[Edit::insert(0, "trial")], "trialab");
            record("axb", &[Edit::delete(0, 1)], "xb");
        });
        let chain = chain(&stages, "ab", "xb").expect("a chain");
        assert_eq!(chain.iter().map(|s| s.output).collect::<Vec<_>>(), vec![digest("axb"), digest("xb")]);
        assert!(super::chain(&stages, "ab", "zz").is_none());
    }
}
