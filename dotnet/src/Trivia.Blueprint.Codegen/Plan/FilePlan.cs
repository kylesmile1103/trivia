using System.Text.Json.Serialization;
using Trivia.Blueprint.Codegen.Model;

namespace Trivia.Blueprint.Codegen.Plan;

public enum FileKind { Generated, Scaffold }
public enum FileAction { Create, Update, Unchanged, Delete }

public sealed record EmittedFile(string Path, FileKind Kind, string Content, string? Todo = null);
public sealed record PlanTodo(string Path, string Message);

public sealed record PlannedFile(string Path, FileKind Kind, FileAction Action, string Hash)
{
    [JsonIgnore] internal byte[]? Before { get; init; }
    [JsonIgnore] internal byte[]? After { get; init; }
}

public sealed record FilePlan(
    string Generator, string ModelRev, IReadOnlyList<PlannedFile> Files,
    IReadOnlyList<PlanTodo> Todo, IReadOnlyList<Diagnostic> Diagnostics)
{
    [JsonIgnore] internal string Root { get; init; } = "";
}

public sealed class WriteRefusedException(IReadOnlyList<Diagnostic> diagnostics)
    : Exception(string.Join("\n", diagnostics.Select(item => $"{item.Doc}: {item.Message}")))
{
    public int ExitCode => 2;
    public IReadOnlyList<Diagnostic> Diagnostics { get; } = diagnostics;
}
