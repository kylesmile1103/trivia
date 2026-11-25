using System.Text;
using Trivia.Blueprint.Codegen.Model;

namespace Trivia.Blueprint.Codegen.Plan;

public static class PlanWriter
{
    public static FilePlan Plan(string root, string modelRev, string apiDirectory,
        IEnumerable<EmittedFile> output, bool force = false)
    {
        root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        List<PlannedFile> files = [];
        List<Diagnostic> diagnostics = [];
        List<PlanTodo> todo = [];
        HashSet<string> paths = new(StringComparer.OrdinalIgnoreCase);

        foreach (EmittedFile emitted in output)
        {
            if (!paths.Add(emitted.Path))
            {
                diagnostics.Add(new("duplicate_output", emitted.Path, "", "More than one output claims this path."));
                continue;
            }
            string? path = Resolve(root, emitted.Path, diagnostics);
            if (path is null)
                continue;

            bool generated = emitted.Kind == FileKind.Generated;
            if (generated != emitted.Path.EndsWith(".g.cs", StringComparison.Ordinal))
            {
                diagnostics.Add(new("invalid_output", emitted.Path, "", "Only generated files may use .g.cs."));
                continue;
            }
            try
            {
                bool exists = Ownership.Attributes(path) is not null;
                byte[]? before = generated && exists ? File.ReadAllBytes(path) : null;
                byte[] after = generated ? Hashing.Generated(emitted.Content) : Encoding.UTF8.GetBytes(emitted.Content);
                if (before is not null)
                    RequireOwned(emitted.Path, before, force, diagnostics);
                FileAction action = !exists ? FileAction.Create
                    : !generated || after.AsSpan().SequenceEqual(before) ? FileAction.Unchanged : FileAction.Update;
                files.Add(new(emitted.Path, emitted.Kind, action, Hashing.Of(after)) { Before = before, After = after });
                if (!exists && emitted.Todo is string message)
                    todo.Add(new(emitted.Path, message));
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                diagnostics.Add(new("write_refused", emitted.Path, "", exception.Message));
            }
        }

        try
        {
            foreach (string leftover in Ownership.GeneratedPaths(root, apiDirectory).Order(StringComparer.Ordinal))
            {
                if (paths.Contains(leftover))
                    continue;
                byte[] before = File.ReadAllBytes(Ownership.Resolve(root, leftover));
                if (!Hashing.IsOwned(before))
                    continue;
                RequireOwned(leftover, before, force, diagnostics);
                files.Add(new(leftover, FileKind.Generated, FileAction.Delete, Hashing.Of(before)) { Before = before });
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            diagnostics.Add(new("path_escape", apiDirectory, "", exception.Message));
        }

        return new(Hashing.Generator, modelRev, files, todo, diagnostics) { Root = root };
    }

    public static void Write(string root, FilePlan plan)
    {
        Diagnostic[] errors = plan.Diagnostics.Where(diagnostic => diagnostic.IsError).ToArray();
        if (errors.Length > 0)
            throw new WriteRefusedException(errors);

        root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        if (!StringComparer.Ordinal.Equals(root, plan.Root))
            throw Refused("path_escape", root, "The plan was made for a different root.");

        PlannedFile[] changes = plan.Files.Where(file => file.Action != FileAction.Unchanged).ToArray();
        using Mutex mutex = new(false, "trivia-dotnet-" + Hashing.Of(Encoding.UTF8.GetBytes(root))[7..]);
        try
        {
            try { mutex.WaitOne(); }
            catch (AbandonedMutexException) { /* An abandoned mutex has now been acquired. */ }
            Apply(root, changes);
        }
        finally
        {
            mutex.ReleaseMutex();
        }
    }

    private static void Apply(string root, PlannedFile[] changes)
    {
        List<StagedFile> staged = [];
        List<StagedFile> applied = [];
        List<string> directories = [];
        bool committed = false;
        try
        {
            foreach (PlannedFile change in changes)
                _ = Verify(root, change);

            foreach (PlannedFile change in changes)
            {
                string path = Ownership.Resolve(root, change.Path);
                MakeDirectory(Path.GetDirectoryName(path)!, directories);
                StagedFile stage = new(change, path, TemporaryPath(path), TemporaryPath(path));
                staged.Add(stage);
                if (change.Before is not null)
                    File.WriteAllBytes(stage.Backup, change.Before);
                if (change.After is not null)
                    File.WriteAllBytes(stage.Replacement, change.After);
            }

            foreach (StagedFile stage in staged)
            {
                _ = Verify(root, stage.File);
                if (stage.File.Action == FileAction.Delete)
                    File.Delete(stage.Path);
                else
                    File.Move(stage.Replacement, stage.Path, overwrite: stage.File.Action == FileAction.Update);
                applied.Add(stage);
            }
            committed = true;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or WriteRefusedException)
        {
            foreach (StagedFile stage in applied.AsEnumerable().Reverse())
            {
                if (stage.File.Before is null)
                    File.Delete(stage.Path);
                else
                    File.Move(stage.Backup, stage.Path, overwrite: true);
            }
            if (exception is WriteRefusedException)
                throw;
            throw Refused("write_refused", root, exception.Message);
        }
        finally
        {
            foreach (StagedFile stage in staged)
            {
                File.Delete(stage.Replacement);
                File.Delete(stage.Backup);
            }

            if (!committed)
            {
                foreach (string directory in directories.AsEnumerable().Reverse())
                    if (!Directory.EnumerateFileSystemEntries(directory).Any())
                        Directory.Delete(directory);
            }
        }
    }

    private static string Verify(string root, PlannedFile change)
    {
        string path = Ownership.Resolve(root, change.Path);
        bool exists = Ownership.Attributes(path) is not null;
        bool matches = change.Before is null ? !exists : exists && File.ReadAllBytes(path).AsSpan().SequenceEqual(change.Before);
        if (!matches)
            throw Refused("stale_plan", change.Path, "The file changed after planning.");
        return path;
    }

    private static void MakeDirectory(string path, List<string> created)
    {
        if (Directory.Exists(path))
            return;
        string? parent = Path.GetDirectoryName(path);
        if (parent is not null)
            MakeDirectory(parent, created);
        Directory.CreateDirectory(path);
        created.Add(path);
    }

    private static string TemporaryPath(string path) =>
        Path.Combine(Path.GetDirectoryName(path)!, $".trivia-dotnet-{Guid.NewGuid():N}.tmp");

    private static string? Resolve(string root, string relative, List<Diagnostic> diagnostics)
    {
        try
        {
            return Ownership.Resolve(root, relative);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            diagnostics.Add(new("path_escape", relative, "", exception.Message));
            return null;
        }
    }

    private static void RequireOwned(string path, byte[] before, bool force, List<Diagnostic> diagnostics)
    {
        if (!force && !Hashing.HasValidBody(before))
            diagnostics.Add(new("modified_generated_file", path, "", "The generated file was edited. Use --force to replace or remove it."));
    }

    private static WriteRefusedException Refused(string code, string path, string message) =>
        new([new(code, path, "", message)]);

    private sealed record StagedFile(PlannedFile File, string Path, string Backup, string Replacement);
}
