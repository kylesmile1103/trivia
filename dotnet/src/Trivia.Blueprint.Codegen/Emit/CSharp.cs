using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Trivia.Blueprint.Codegen.Mapping;
using Trivia.Blueprint.Codegen.Model;
using static Microsoft.CodeAnalysis.CSharp.SyntaxFactory;

namespace Trivia.Blueprint.Codegen.Emit;

public static partial class CSharp
{
    public static string Print(CompilationUnitSyntax tree)
    {
        Microsoft.CodeAnalysis.Diagnostic[] diagnostics = tree.GetDiagnostics().ToArray();
        if (diagnostics.Length != 0)
            throw new InvalidOperationException(string.Join("\n", diagnostics.AsEnumerable()));
        return tree.NormalizeWhitespace(indentation: "    ", eol: "\n").ToFullString() + "\n";
    }

    internal static CompilationUnitSyntax Unit(string space, string[] imports, params string[] declarations)
        => CompilationUnit()
            .WithUsings(List(imports.Select(import => UsingDirective(ParseName(import)))))
            .AddMembers(FileScopedNamespaceDeclaration(ParseName(space))
                .WithMembers(List(declarations.Select(source => ParseMemberDeclaration(source)!))));

    internal static string Literal(string value) => SyntaxFactory.Literal(value).Text;
    internal static string Number(decimal value) => value.ToString(CultureInfo.InvariantCulture);
    internal static string Pascal(string value) => string.Concat(value.Split('-').Select(part => char.ToUpperInvariant(part[0]) + part[1..]));
    internal static string Member(ModelEntity entity, string value) => Pascal(value) == entity.Name ? "_" + Pascal(value) : Pascal(value);
    internal static string Snake(string value) => CaseBoundary().Replace(value, "_").Replace('-', '_').ToLowerInvariant();
    internal static string SqlString(string value) => "E'" + value.Replace("\\", "\\\\", StringComparison.Ordinal)
        .Replace("'", "''", StringComparison.Ordinal) + "'";

    [GeneratedRegex("(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", RegexOptions.CultureInvariant)]
    private static partial Regex CaseBoundary();

    internal static string Feature(ModelDocument model, string entity) => $"{model.Namespace}.Features.{entity}";
    internal static string Entity(ModelDocument model, string entity) => $"global::{Feature(model, entity)}.{entity}";
    internal static string Enum(ModelDocument model, string name) => $"global::{model.Namespace}.Enums.{name}";
    internal static string FieldType(ModelDocument model, string type, string? enumName)
        => enumName is null ? TypeMap.Types[type].CSharp : Enum(model, enumName);

    internal static string DefaultValue(ModelDocument model, ModelField field)
    {
        JsonElement value = field.Default;
        if (value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            return "null";
        string Text() => Literal(value.GetString()!);
        return field.Type switch
        {
            "string" or "text" => Text(),
            "int" => Number(value.GetInt32()),
            "long" => Number(value.GetInt64()) + "L",
            "decimal" => Number(value.GetDecimal()) + "m",
            "bool" => value.GetBoolean() ? "true" : "false",
            "uuid" => $"Guid.Parse({Text()})",
            "date" => $"DateOnly.ParseExact({Text()}, \"yyyy-MM-dd\", global::System.Globalization.CultureInfo.InvariantCulture)",
            "datetime" => $"DateTimeOffset.Parse({Text()}, global::System.Globalization.CultureInfo.InvariantCulture).ToUniversalTime()",
            "enum" => $"{Enum(model, field.Enum!)}Values.FromLiteral({Text()})",
            "json" => $"JsonDocument.Parse({Literal(value.GetRawText())})",
            _ => throw new InvalidOperationException($"Unsupported default type {field.Type}.")
        };
    }

    internal static ModelEntity FindEntity(ModelDocument model, string name) =>
        model.Entities.FirstOrDefault(entity => entity.Name == name) ??
        throw new BlueprintInputException([new("dangling_reference", ModelLoader.ModelFile, "/entities", $"No entity named {name}.")]);

    internal static ModelEnum FindEnum(ModelDocument model, string name) =>
        model.Enums.FirstOrDefault(values => values.Name == name) ??
        throw new BlueprintInputException([new("dangling_reference", ModelLoader.ModelFile, "/enums", $"No enum named {name}.")]);
}
