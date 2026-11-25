using System.Text.Json.Serialization;

namespace Trivia.Blueprint.Codegen.Model;

public sealed record AppDocument(
    [property: JsonPropertyName("$schema")] string Schema,
    int BlueprintVersion,
    string Name,
    AppTargets Targets,
    AppAuth? Auth,
    AppTheme? Theme,
    AppNavEntry[]? Nav);

public sealed record AppTargets(string Web, string? Api);
public sealed record AppAuth(string Mode);
public sealed record AppTheme(Dictionary<string, string> Tokens);
public sealed record AppNavEntry(string Page, string Label, string? Icon);
