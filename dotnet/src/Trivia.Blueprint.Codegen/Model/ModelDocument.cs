using System.Text.Json;
using System.Text.Json.Serialization;

namespace Trivia.Blueprint.Codegen.Model;

public sealed record ModelDocument(
    [property: JsonPropertyName("$schema")] string Schema,
    int BlueprintVersion,
    string Namespace,
    ModelEnum[] Enums,
    ModelEntity[] Entities);

public sealed record ModelEnum(string Name, string[] Values);

public sealed record ModelEntity(
    string Name,
    string Plural,
    ModelKey Key,
    ModelField[] Fields,
    ModelRelation[] Relations,
    ModelIndex[] Indexes,
    EntityApi Api,
    bool? Concurrency,
    string? RenamedFrom);

public sealed record ModelKey(string Name, string Type, string? Generated);

public sealed record ModelField(
    string Name,
    string Type,
    bool? Required,
    bool? Unique,
    bool? ReadOnly,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] JsonElement Default,
    string? Description,
    int? MinLength,
    int? MaxLength,
    string? Pattern,
    string? Format,
    decimal? Minimum,
    decimal? Maximum,
    int? Precision,
    int? Scale,
    string? Generated,
    string? Enum,
    string? RenamedFrom);

public sealed record ModelRelation(
    string Name,
    string Kind,
    string To,
    string ForeignKey,
    bool? Required,
    string? OnDelete);

public sealed record ModelIndex(string[] Fields, bool? Unique);

public sealed record EntityApi(
    string[] Operations,
    string[]? Filterable,
    string[]? Sortable,
    string[]? Searchable,
    CustomOperation[]? Custom);

public sealed record CustomOperation(string Name, string Method, string Path, ModelField[]? Input, string? Returns);
