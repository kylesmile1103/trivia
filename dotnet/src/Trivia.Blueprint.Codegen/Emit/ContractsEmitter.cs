using Microsoft.CodeAnalysis.CSharp.Syntax;
using Trivia.Blueprint.Codegen.Model;
using static Trivia.Blueprint.Codegen.Emit.CSharp;

namespace Trivia.Blueprint.Codegen.Emit;

internal sealed record ApiMember(string WireName, string Member, string Type, bool Required,
    ModelField? Field = null, bool Writable = false)
{
    internal string ResponseType => Type + (Required ? "" : "?");
    internal bool ReferenceType => Type is "string" or "JsonDocument";
}

public static class ContractsEmitter
{
    public static CompilationUnitSyntax Emit(ModelDocument model, ModelEntity entity)
    {
        ApiMember[] members = Members(model, entity).ToArray();
        string response = string.Join(",\n", members.Select(member =>
            $"[property: JsonPropertyName({Literal(member.WireName)})] {member.ResponseType} {member.Member}"));
        string request = string.Join("\n", members.Where(member => member.Writable).Select(member => RequestProperty(model, member)));
        string version = entity.Concurrency == true
            ? "\n" + RequestProperty(model, new("version", "Version", "uint", Required: true))
            : "";
        List<string> records =
        [
            $"public sealed record {entity.Name}Response({response});",
            $"public sealed record Create{entity.Name}Request {{ {request} }}",
            $"public sealed record Update{entity.Name}Request {{ {request}{version} }}"
        ];
        if (entity.Api.Operations.Contains("update"))
            records.Add(PatchRecord(model, entity, version));
        if (entity.Api.Operations.Contains("list"))
            records.Add($"public sealed record {entity.Name}Page(IReadOnlyList<{entity.Name}Response> Items, int Total, int Page, int PageSize);");
        foreach (CustomOperation operation in entity.Api.Custom ?? [])
            if (operation.Input is not null)
                records.Add(CustomOperationEmitter.Contract(model, entity, operation));
        return Unit(Feature(model, entity.Name), ["System", "System.ComponentModel.DataAnnotations",
            "System.Text.Json", "System.Text.Json.Serialization"], [.. records]);
    }

    internal static IEnumerable<ApiMember> Members(ModelDocument model, ModelEntity entity)
    {
        yield return new(entity.Key.Name, Member(entity, entity.Key.Name), FieldType(model, entity.Key.Type, null), true);
        foreach (ModelField field in entity.Fields)
            yield return new(field.Name, Member(entity, field.Name), FieldType(model, field.Type, field.Enum),
                field.Required == true, field, field.ReadOnly != true && field.Generated is null);
        foreach (ModelRelation relation in entity.Relations.Where(relation => relation.Kind == "belongsTo"))
            yield return new(relation.ForeignKey, Member(entity, relation.ForeignKey),
                FieldType(model, FindEntity(model, relation.To).Key.Type, null), relation.Required == true, Writable: true);
        if (entity.Concurrency == true)
            yield return new("version", Member(entity, "version"), "uint", Required: true);
    }

    // A PATCH body changes only the members it carries. Each init accessor records that
    // System.Text.Json set its member, which it does only for a property present in the body,
    // null included. The flags are lowercase internal fields, so they cannot collide with the
    // PascalCase wire members, and serialization, OpenAPI and validation ignore them.
    private static string PatchRecord(ModelDocument model, ModelEntity entity, string version)
    {
        ApiMember[] writable = Members(model, entity).Where(member => member.Writable).ToArray();
        IEnumerable<string> properties = writable.Select(member =>
            $"internal readonly bool {Sent(member)};\n" +
            RequestProperty(model, member, patch: true).Replace(" { get; init; }",
                $" {{ get; init {{ field = value; {Sent(member)} = true; }} }}", StringComparison.Ordinal));
        ApiMember[] required = writable.Where(member => member.Required).ToArray();
        string validation = required.Length == 0 ? "" : $$"""

            IEnumerable<ValidationResult> IValidatableObject.Validate(ValidationContext validationContext)
            {
                {{string.Join("\n", required.Select(member => $$"""
                    if ({{Sent(member)}} && {{member.Member}} is null)
                        yield return new({{Literal($"The {member.WireName} field cannot be null.")}}, [{{Literal(member.WireName)}}]);
                    """))}}
            }
            """;
        string interfaces = required.Length == 0 ? "" : " : IValidatableObject";
        return $"public sealed record Patch{entity.Name}Request{interfaces} {{ {string.Join("\n", properties)}{version}{validation} }}";
    }

    internal static string Sent(ApiMember member) => member.WireName + "Sent";

    internal static string RequestProperty(ModelDocument model, ApiMember member, bool patch = false)
    {
        List<string> annotations = [$"JsonPropertyName({Literal(member.WireName)})"];
        if (member.Required && !patch)
            annotations.Add("Required(AllowEmptyStrings = true)");
        string initial = "";
        if (member.Field is ModelField field)
        {
            if (field.MinLength is int min)
                annotations.Add($"MinLength({Number(min)})");
            if (field.MaxLength is int max)
                annotations.Add($"MaxLength({Number(max)})");
            if (field.Pattern is string pattern)
                annotations.Add($"RegularExpression({Literal(pattern)})");
            if (field.Format == "email")
                annotations.Add("EmailAddress");
            if (field.Format == "uri")
                annotations.Add("Url");
            if (field.Format == "password")
                annotations.Add("DataType(DataType.Password)");
            if (field.Description is string description)
                annotations.Add($"global::System.ComponentModel.Description({Literal(description)})");
            if (field.Minimum is not null || field.Maximum is not null)
                annotations.Add(Range(field));
            if (field.Precision is int precision)
                annotations.Add($"global::{model.Namespace}.Generated.DecimalPrecision({Number(precision)}, {Number(field.Scale!.Value)})");
            if (!patch && field.Default.ValueKind is not (System.Text.Json.JsonValueKind.Null or System.Text.Json.JsonValueKind.Undefined))
                initial = $" = {DefaultValue(model, field)};";
        }
        return $"[{string.Join(", ", annotations)}] public {member.Type}? {member.Member} {{ get; init; }}{initial}";
    }

    private static string Range(ModelField field)
    {
        (decimal min, decimal max) = field.Type switch
        {
            "int" => (int.MinValue, int.MaxValue),
            "long" => (long.MinValue, long.MaxValue),
            _ => (decimal.MinValue, decimal.MaxValue)
        };
        string minimum = Literal(Number(field.Minimum ?? min));
        string maximum = Literal(Number(field.Maximum ?? max));
        return $"Range(typeof({field.Type}), {minimum}, {maximum}, ParseLimitsInInvariantCulture = true, ConvertValueInInvariantCulture = true)";
    }
}
