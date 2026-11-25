//! Filesystem layer: safe path resolution under the project root and atomic writes.

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

use crate::error::{EngineError, Result};
use crate::inspect::{self, NodeDetails, OutlineNode};
use crate::ops::{self, Op, Outcome};
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

/// Distinguishes temp files written in the same nanosecond by one process.
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

impl Workspace {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        let root = root.canonicalize().map_err(|source| EngineError::Io { path: root.display().to_string(), source })?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolve a project-relative `.tsx`/`.jsx` path, refusing anything outside the root:
    /// `..`, absolute paths, and symlinks whose target lies outside. The path must also be
    /// spelled canonically (`src/App.tsx`: no `./`, empty segments, trailing `/` or `\`),
    /// because it is the file part of every locator the engine returns.
    pub fn resolve(&self, rel: &str) -> Result<PathBuf> {
        self.resolve_file(rel, false)
    }

    fn resolve_file(&self, rel: &str, edit: bool) -> Result<PathBuf> {
        let outside = || EngineError::PathOutsideRoot(rel.to_string());
        let path = Path::new(rel);
        if !is_canonical_relative(rel) || !path.components().all(|c| matches!(c, Component::Normal(_))) {
            return Err(outside());
        }
        if !supported_file(path, edit) {
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

    /// Whether the project-relative `.tsx`/`.jsx` file exists (path rules as [`Self::resolve`]).
    pub fn exists(&self, rel: &str) -> Result<bool> {
        self.exists_file(rel, false)
    }

    pub fn exists_for_edit(&self, rel: &str) -> Result<bool> {
        self.exists_file(rel, true)
    }

    fn exists_file(&self, rel: &str, edit: bool) -> Result<bool> {
        match self.resolve_file(rel, edit) {
            Ok(_) => Ok(true),
            Err(EngineError::Io { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
                self.resolve_new(rel, edit)?; // still refuse a path outside the root
                Ok(false)
            }
            Err(e) => Err(e),
        }
    }

    /// Write a new file, creating its directories (inside the root). Refused with `conflict`
    /// when it exists, `invalid_result` when `content` does not parse, and `path_outside_root`
    /// for any path [`Self::resolve`] refuses.
    pub fn create(&self, rel: &str, content: &str) -> Result<()> {
        let path = self.resolve_new(rel, true)?;
        ops::created(rel, content)?;
        let dir = path.parent().ok_or_else(|| EngineError::PathOutsideRoot(rel.to_string()))?;
        let io = |source| EngineError::Io { path: rel.to_string(), source };
        fs::create_dir_all(dir).map_err(io)?;
        // The directories may have been made by someone else meanwhile: check again.
        if !dir.canonicalize().map_err(io)?.starts_with(&self.root) {
            return Err(EngineError::PathOutsideRoot(rel.to_string()));
        }
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        let unique = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
        let tmp = dir.join(format!(".{name}.trivia-{}-{nanos}-{unique}.tmp", std::process::id()));
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(io)?;
        let result = (|| {
            f.write_all(content.as_bytes()).map_err(io)?;
            f.sync_all().map_err(io)?;
            drop(f);
            // `hard_link` fails when the name exists, so a file created meanwhile is never replaced.
            fs::hard_link(&tmp, &path).map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { exists(rel) } else { io(e) })
        })();
        let _ = fs::remove_file(&tmp);
        result
    }

    /// Delete a file only if it still holds `expected` (undoing a `createFile`), else `conflict`.
    pub fn remove_file(&self, rel: &str, expected: &str) -> Result<()> {
        if self.read_for_edit(rel)? != expected {
            return Err(conflict(rel));
        }
        let path = self.resolve_file(rel, true)?;
        fs::remove_file(&path).map_err(|source| EngineError::Io { path: rel.to_string(), source })
    }

    /// [`Self::resolve`] for a file that doesn't exist yet: the same path rules, and its
    /// nearest existing directory must lie inside the root (symlinks followed).
    fn resolve_new(&self, rel: &str, edit: bool) -> Result<PathBuf> {
        let outside = || EngineError::PathOutsideRoot(rel.to_string());
        let path = Path::new(rel);
        if !is_canonical_relative(rel) || !path.components().all(|c| matches!(c, Component::Normal(_))) {
            return Err(outside());
        }
        if !supported_file(path, edit) {
            return Err(outside());
        }
        let full = self.root.join(path);
        let mut existing = full.parent().ok_or_else(outside)?.to_path_buf();
        while !existing.exists() {
            existing = existing.parent().ok_or_else(outside)?.to_path_buf();
        }
        let real = existing.canonicalize().map_err(|source| EngineError::Io { path: rel.to_string(), source })?;
        if !real.starts_with(&self.root) {
            return Err(outside());
        }
        if full.exists() {
            return Err(exists(rel));
        }
        Ok(full)
    }

    pub fn read(&self, rel: &str) -> Result<String> {
        self.read_file(rel, false)
    }

    pub fn read_for_edit(&self, rel: &str) -> Result<String> {
        self.read_file(rel, true)
    }

    fn read_file(&self, rel: &str, edit: bool) -> Result<String> {
        let path = self.resolve_file(rel, edit)?;
        fs::read_to_string(&path).map_err(|source| EngineError::Io { path: rel.to_string(), source })
    }

    /// Read an op's input; the whole-file replace contract distinguishes a missing target.
    pub fn read_for_op(&self, rel: &str, op: &Op) -> Result<String> {
        self.read_file(rel, matches!(op, Op::ReplaceFile { .. })).map_err(|error| match error {
            EngineError::Io { path, source }
                if matches!(op, Op::ReplaceFile { .. }) && source.kind() == std::io::ErrorKind::NotFound =>
                    EngineError::FileNotFound(path),
            other => other,
        })
    }

    /// Read the target file fresh, apply `op`, and write atomically if anything changed.
    /// The write is refused (`conflict`) if the file changed while the edit was computed.
    /// `createFile` writes its new file (`before` is then empty).
    pub fn apply(&self, op: &Op) -> Result<Applied> {
        if let Op::CreateFile { file, content, if_missing } = op {
            if *if_missing && self.exists_for_edit(file)? {
                let before = self.read_for_edit(file)?;
                let outcome = ops::Outcome { file: file.clone(), changed: false, locator: None, code: before.clone() };
                return Ok(Applied { outcome, before });
            }
            self.create(file, content)?;
            return Ok(Applied { outcome: ops::created(file, content)?, before: String::new() });
        }
        let file = op.file()?;
        let before = self.read_for_op(&file, op)?;
        let outcome = ops::apply_op(&before, &file, op)?;
        if outcome.changed {
            self.write(&file, &outcome.code, Some(&before), matches!(op, Op::ReplaceFile { .. }))?;
        }
        Ok(Applied { outcome, before })
    }

    /// Replace a file's content only if it still equals `expected` (guarded undo/redo).
    /// Refuses with `conflict` when it does not, and with `invalid_result` when `content`
    /// does not parse.
    pub fn restore(&self, rel: &str, expected: &str, content: &str) -> Result<()> {
        self.restore_file(rel, expected, content, false)
    }

    pub fn restore_for_edit(&self, rel: &str, expected: &str, content: &str) -> Result<()> {
        self.restore_file(rel, expected, content, true)
    }

    fn restore_file(&self, rel: &str, expected: &str, content: &str, edit: bool) -> Result<()> {
        if self.read_file(rel, edit)? != expected {
            return Err(conflict(rel));
        }
        // Never write code that doesn't parse.
        ops::validate_file(rel, content).map_err(|e| EngineError::InvalidResult(e.to_string()))?;
        self.write(rel, content, Some(expected), edit)
    }

    pub fn inspect(&self, locator: &str) -> Result<NodeDetails> {
        let file = crate::locator::Locator::parse(locator)?.file;
        inspect::inspect(&self.read(&file)?, locator)
    }

    /// Every JSX tree of the project-relative `file`.
    pub fn outline(&self, file: &str) -> Result<Vec<OutlineNode>> {
        inspect::outline(&self.read(file)?, file)
    }

    /// The scopes of `file` with their top-level bindings and hook calls (`crate::values`).
    pub fn describe_values(&self, file: &str) -> Result<Vec<crate::values::ScopeValues>> {
        crate::values::describe_values(&self.read(file)?, file)
    }

    /// Where `file` still names `name` (`crate::mentions`).
    pub fn mentions(&self, file: &str, name: &str) -> Result<Vec<crate::mentions::Mention>> {
        crate::mentions::mentions(&self.read(file)?, file, name)
    }

    /// The value at a value path, unwrapped to its literal.
    pub fn describe_value(&self, path: &str) -> Result<crate::values::Value> {
        let file = crate::values::ValuePath::parse(path)?.file;
        crate::values::describe_value(&self.read(&file)?, path)
    }

    /// Analyze every `*.tsx` in `ui_dir` (project-relative; a leading `./` and trailing `/`
    /// are accepted). `import_base` is the module prefix (shadcn `components.json` →
    /// `aliases.ui`, e.g. `@/components/ui`).
    pub fn components(&self, ui_dir: &str, import_base: &str) -> Result<Vec<ComponentSchema>> {
        let mut normalized = ui_dir.trim_end_matches('/');
        while let Some(rest) = normalized.strip_prefix("./") {
            normalized = rest;
        }
        if !is_canonical_relative(normalized) {
            return Err(EngineError::PathOutsideRoot(ui_dir.to_string()));
        }
        let ui_dir = normalized;
        let dir = self.resolve_dir(ui_dir)?;
        let entries = fs::read_dir(&dir).map_err(|source| EngineError::Io { path: ui_dir.to_string(), source })?;
        let mut files: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|n| n.ends_with(".tsx"))
            .collect();
        files.sort();
        let mut out = Vec::new();
        for name in files {
            let rel = format!("{ui_dir}/{name}");
            let stem = name.trim_end_matches(".tsx");
            let source = self.read(&rel)?;
            let import_source = format!("{}/{stem}", import_base.trim_end_matches('/'));
            out.extend(prop_analyzer::analyze(&source, &rel, &import_source)?);
        }
        Ok(out)
    }

    /// A canonical project-relative directory, refusing anything outside the root.
    fn resolve_dir(&self, rel: &str) -> Result<PathBuf> {
        let outside = || EngineError::PathOutsideRoot(rel.to_string());
        let path = Path::new(rel);
        if !is_canonical_relative(rel) || !path.components().all(|c| matches!(c, Component::Normal(_))) {
            return Err(outside());
        }
        let real = self.root.join(path).canonicalize().map_err(|source| EngineError::Io { path: rel.to_string(), source })?;
        if !real.starts_with(&self.root) {
            return Err(outside());
        }
        Ok(real)
    }

    /// Write via a temp file in the same directory + rename, so watchers (Vite) see one
    /// change event and never a half-written file. Keeps the original permissions (applied
    /// before any content is written, so a private file never has a readable copy) and
    /// refuses read-only files. No temp file is left behind, whether the write succeeds or not.
    pub fn write_atomic(&self, rel: &str, content: &str) -> Result<()> {
        self.write(rel, content, None, false)
    }

    /// [`Self::write_atomic`], refusing with `conflict` when `expected` is given and the file
    /// no longer has that content just before the rename.
    fn write(&self, rel: &str, content: &str, expected: Option<&str>, edit: bool) -> Result<()> {
        let path = self.resolve_file(rel, edit)?;
        let io = |source| EngineError::Io { path: rel.to_string(), source };
        let meta = fs::metadata(&path).map_err(io)?;
        if meta.permissions().readonly() {
            return Err(io(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "the file is read-only")));
        }
        let dir = path.parent().ok_or_else(|| EngineError::PathOutsideRoot(rel.to_string()))?;
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        let unique = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let tmp = dir.join(format!(".{name}.trivia-{}-{nanos}-{unique}.tmp", std::process::id()));

        // `create_new`: never truncate a file we did not create (and never delete one, below).
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp).map_err(io)?;
        let result = (|| {
            fs::set_permissions(&tmp, meta.permissions()).map_err(io)?;
            f.write_all(content.as_bytes()).map_err(io)?;
            f.sync_all().map_err(io)?;
            drop(f);
            if let Some(expected) = expected
                && fs::read_to_string(&path).map_err(io)? != expected
            {
                return Err(conflict(rel));
            }
            fs::rename(&tmp, &path).map_err(io)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result
    }
}

/// `seg/seg/…` with no empty, `.` or `..` segment and no backslash.
fn is_canonical_relative(rel: &str) -> bool {
    !rel.is_empty() && rel.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != ".." && !seg.contains('\\'))
}

fn exists(rel: &str) -> EngineError {
    EngineError::Conflict(format!("{rel} already exists; createFile never overwrites a file"))
}

fn conflict(rel: &str) -> EngineError {
    EngineError::Conflict(format!(
        "{rel} changed on disk (outside the designer) since this edit was computed; nothing was written"
    ))
}

fn supported_file(path: &Path, edit: bool) -> bool {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("tsx" | "jsx") => true,
        Some("ts") => edit,
        Some("json") => edit && path.file_name().and_then(|name| name.to_str()) == Some("blueprint.lock.json"),
        _ => false,
    }
}
