//! Filesystem layer: safe path resolution under the project root and atomic writes.

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::error::{EngineError, Result};
use crate::inspect::{self, NodeDetails};
use crate::mutator::{self, Op, Outcome};
use crate::prop_analyzer::{self, ComponentSchema};

/// A user project on disk. All paths are project-relative with forward slashes.
#[derive(Debug, Clone)]
pub struct Workspace {
    root: PathBuf,
}

/// Result of applying an op to disk, with the before/after text for undo history.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    #[serde(flatten)]
    pub outcome: Outcome,
    #[serde(skip)]
    pub before: String,
}

impl Workspace {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        let root = root.canonicalize().map_err(|source| EngineError::Io { path: root.display().to_string(), source })?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolve a project-relative `.tsx`/`.jsx` path, refusing anything outside the root.
    pub fn resolve(&self, rel: &str) -> Result<PathBuf> {
        let outside = || EngineError::PathOutsideRoot(rel.to_string());
        let path = Path::new(rel);
        if rel.is_empty() || !path.components().all(|c| matches!(c, Component::Normal(_))) {
            return Err(outside());
        }
        if !matches!(path.extension().and_then(|e| e.to_str()), Some("tsx" | "jsx")) {
            return Err(outside());
        }
        let full = self.root.join(path);
        // Follow symlinks: the real file must still live under the root.
        let real = full.canonicalize().map_err(|source| EngineError::Io { path: rel.to_string(), source })?;
        if !real.starts_with(&self.root) {
            return Err(outside());
        }
        Ok(real)
    }

    pub fn read(&self, rel: &str) -> Result<String> {
        let path = self.resolve(rel)?;
        fs::read_to_string(&path).map_err(|source| EngineError::Io { path: rel.to_string(), source })
    }

    /// Read the target file fresh, apply `op`, and write atomically if anything changed.
    pub fn apply(&self, op: &Op) -> Result<Applied> {
        let file = op.file()?;
        let before = self.read(&file)?;
        let outcome = mutator::apply_op(&before, &file, op)?;
        if outcome.changed {
            self.write_atomic(&file, &outcome.code)?;
        }
        Ok(Applied { outcome, before })
    }

    /// Replace a file's content only if it still equals `expected` (guarded undo/redo).
    pub fn restore(&self, rel: &str, expected: &str, content: &str) -> Result<()> {
        let current = self.read(rel)?;
        if current != expected {
            return Err(EngineError::Unsupported(format!(
                "{rel} changed outside the designer since this edit; undo/redo refused to overwrite it"
            )));
        }
        // Never write code that doesn't parse.
        let alloc = oxc_allocator::Allocator::default();
        crate::parse(&alloc, content, rel).map_err(|e| EngineError::InvalidResult(e.to_string()))?;
        self.write_atomic(rel, content)
    }

    pub fn inspect(&self, locator: &str) -> Result<NodeDetails> {
        let file = crate::locator::Locator::parse(locator)?.file;
        inspect::inspect(&self.read(&file)?, locator)
    }

    /// Analyze every `*.tsx` in `ui_dir` (project-relative). `import_base` is the module
    /// prefix (shadcn `components.json` → `aliases.ui`, e.g. `@/components/ui`).
    pub fn components(&self, ui_dir: &str, import_base: &str) -> Result<Vec<ComponentSchema>> {
        let dir = self.root.join(ui_dir);
        let entries = fs::read_dir(&dir).map_err(|source| EngineError::Io { path: ui_dir.to_string(), source })?;
        let mut files: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.ends_with(".tsx"))
            .collect();
        files.sort();
        let mut out = Vec::new();
        for name in files {
            let rel = format!("{}/{name}", ui_dir.trim_end_matches('/'));
            let stem = name.trim_end_matches(".tsx");
            let source = self.read(&rel)?;
            let import_source = format!("{}/{stem}", import_base.trim_end_matches('/'));
            out.extend(prop_analyzer::analyze(&source, &rel, &import_source)?);
        }
        Ok(out)
    }

    /// Write via a temp file in the same directory + rename, so watchers (Vite) see one
    /// change event and never a half-written file. Keeps the original permissions.
    pub fn write_atomic(&self, rel: &str, content: &str) -> Result<()> {
        let path = self.resolve(rel)?;
        let io = |source| EngineError::Io { path: rel.to_string(), source };
        let dir = path.parent().ok_or_else(|| EngineError::PathOutsideRoot(rel.to_string()))?;
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        let tmp = dir.join(format!(".{name}.trivia-{}-{nanos}.tmp", std::process::id()));
        let result = (|| {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(content.as_bytes())?;
            f.sync_all()?;
            if let Ok(meta) = fs::metadata(&path) {
                fs::set_permissions(&tmp, meta.permissions())?;
            }
            fs::rename(&tmp, &path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result.map_err(io)
    }
}
