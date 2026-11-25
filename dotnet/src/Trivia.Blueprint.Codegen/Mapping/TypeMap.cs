using System.Collections.ObjectModel;
using System.Globalization;
using Trivia.Blueprint.Codegen.Model;

namespace Trivia.Blueprint.Codegen.Mapping;

public sealed record MappedType(string CSharp, string Postgres, string? PostgresWithoutMaxLength = null);

public static class TypeMap
{
    public static IReadOnlyDictionary<string, MappedType> Types { get; } =
        new ReadOnlyDictionary<string, MappedType>(new Dictionary<string, MappedType>(StringComparer.Ordinal)
        {
            ["string"] = new("string", "varchar({maxLength})", "text"),
            ["text"] = new("string", "text"),
            ["int"] = new("int", "integer"),
            ["long"] = new("long", "bigint"),
            ["decimal"] = new("decimal", "numeric({precision},{scale})"),
            ["bool"] = new("bool", "boolean"),
            ["date"] = new("DateOnly", "date"),
            ["datetime"] = new("DateTimeOffset", "timestamptz"),
            ["uuid"] = new("Guid", "uuid"),
            ["enum"] = new("{enum}", "text CHECK ({column} IN ({values}))"),
            ["json"] = new("JsonDocument", "jsonb")
        });

    public static string CSharp(ModelField field) => field.Enum ?? Types[field.Type].CSharp;

    public static string Postgres(ModelField field) => field.Type switch
    {
        "string" => field.MaxLength is int length
            ? Types["string"].Postgres.Replace("{maxLength}", length.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal)
            : Types["string"].PostgresWithoutMaxLength!,
        "decimal" => Types["decimal"].Postgres
            .Replace("{precision}", field.Precision!.Value.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal)
            .Replace("{scale}", field.Scale!.Value.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal),
        // EF configures the column and its check constraint separately.
        "enum" => "text",
        _ => Types[field.Type].Postgres
    };
}
