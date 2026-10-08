//! `remove`: delete a node (its whole lines when it sits alone on them), and the imports
//! whose last reference it held.

use super::{Doc, Outcome, finish, removal_range};
use crate::error::{EngineError, Result};
use crate::import_manager;
use crate::text::{self, Edit};

impl Doc<'_, '_> {
    pub(super) fn removable(&self, idx: usize, verb: &str) -> Result<()> {
        let node = &self.table.nodes[idx];
        if node.parent.is_none() {
            return Err(EngineError::Unsupported(format!(
                "cannot {verb} {}: it is the root element of `{}`",
                self.name(idx),
                node.scope
            )));
        }
        if !node.direct {
            return Err(EngineError::Unsupported(format!(
                "cannot {verb} {}: it is rendered from a {{…}} expression; edit that code by hand",
                self.name(idx)
            )));
        }
        Ok(())
    }

    pub(super) fn remove(&self, target: usize) -> Result<Outcome> {
        self.removable(target, "remove")?;
        let (start, end) = removal_range(self.src, self.table.nodes[target].span);
        let before = import_manager::import_reference_counts(self.program);
        let (code, _) = text::apply_edits(self.src, &[Edit::delete(start, end)])?;
        let code = import_manager::prune_dropped(&code, self.file, &before)?;
        finish(self.file, self.src, code, None, &[])
    }
}
