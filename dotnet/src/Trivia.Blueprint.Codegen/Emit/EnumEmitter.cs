using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Trivia.Blueprint.Codegen.Model;
using static Trivia.Blueprint.Codegen.Emit.CSharp;

namespace Trivia.Blueprint.Codegen.Emit;

public static partial class EnumEmitter
{
    public static CompilationUnitSyntax Emit(ModelDocument model, ModelEnum values)
    {
        string name = values.Name;
        HashSet<string> used = new(StringComparer.Ordinal) { name };
        (string Member, string Literal)[] members = values.Values.Select(value =>
        {
            string basis = string.Concat(Words().Matches(value).Select(match => Pascal(match.Value)));
            if (basis.Length == 0 || char.IsAsciiDigit(basis[0]))
                basis = "Value" + basis;
            string member = basis;
            for (int suffix = 2; !used.Add(member); suffix++)
                member = basis + suffix.ToString(System.Globalization.CultureInfo.InvariantCulture);
            return (member, Literal(value));
        }).ToArray();

        string from = string.Join("\n", members.Select(pair => $"{pair.Literal} => {name}.{pair.Member},"));
        string to = string.Join("\n", members.Select(pair => $"{name}.{pair.Member} => {pair.Literal},"));
        return Unit($"{model.Namespace}.Enums", ["System", "System.Text.Json", "System.Text.Json.Serialization"],
            $$"""
            [JsonConverter(typeof({{name}}JsonConverter))]
            public enum {{name}} { {{string.Join(", ", members.Select(pair => pair.Member))}} }
            """,
            $$"""
            public static class {{name}}Values
            {
                public static {{name}} FromLiteral(string? value) => value switch
                {
                    {{from}}
                    _ => throw new JsonException("Invalid {{name}} value.")
                };

                public static string ToLiteral({{name}} value) => value switch
                {
                    {{to}}
                    _ => throw new JsonException("Invalid {{name}} value.")
                };
            }
            """,
            $$"""
            public sealed class {{name}}JsonConverter : JsonConverter<{{name}}>
            {
                public override {{name}} Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
                    => reader.TokenType == JsonTokenType.String
                        ? {{name}}Values.FromLiteral(reader.GetString())
                        : throw new JsonException("Expected a {{name}} string.");

                public override void Write(Utf8JsonWriter writer, {{name}} value, JsonSerializerOptions options)
                    => writer.WriteStringValue({{name}}Values.ToLiteral(value));
            }
            """);
    }

    [GeneratedRegex("[A-Za-z0-9]+", RegexOptions.CultureInvariant)]
    private static partial Regex Words();
}
