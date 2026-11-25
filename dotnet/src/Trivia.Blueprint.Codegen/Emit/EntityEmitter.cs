using System.Text.Json;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using static Trivia.Blueprint.Codegen.Emit.CSharp;
using Trivia.Blueprint.Codegen.Model;

namespace Trivia.Blueprint.Codegen.Emit;

public static class EntityEmitter
{
    public static CompilationUnitSyntax Emit(ModelDocument model, ModelEntity entity)
    {
        List<string> properties = [];
        string keyDefault = entity.Key.Type == "uuid" ? " = Guid.CreateVersion7();" : "";
        properties.Add($"public {FieldType(model, entity.Key.Type, null)} {Member(entity, entity.Key.Name)} {{ get; set; }}{keyDefault}");
        foreach (ModelField field in entity.Fields)
        {
            string type = FieldType(model, field.Type, field.Enum);
            string required = field.Required == true && type is "string" or "JsonDocument" ? "required " : "";
            string nullable = field.Required == true ? "" : "?";
            string initial = field.Default.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined
                ? "" : $" = {DefaultValue(model, field)};";
            properties.Add($"public {required}{type}{nullable} {Member(entity, field.Name)} {{ get; set; }}{initial}");
        }

        foreach (ModelRelation relation in entity.Relations)
        {
            string related = Entity(model, relation.To);
            string property = Member(entity, relation.Name);
            if (relation.Kind == "hasMany")
            {
                ModelRelation first = entity.Relations.First(candidate => candidate.Kind == "hasMany" &&
                    candidate.To == relation.To && candidate.ForeignKey == relation.ForeignKey);
                properties.Add(first == relation
                    ? $"public ICollection<{related}> {property} {{ get; }} = new List<{related}>();"
                    : $"[NotMapped] public ICollection<{related}> {property} => {Member(entity, first.Name)};");
                continue;
            }
            string keyType = FindEntity(model, relation.To).Key.Type;
            bool required = relation.Required == true;
            string suffix = required ? "" : "?";
            properties.Add($"public {FieldType(model, keyType, null)}{suffix} {Member(entity, relation.ForeignKey)} {{ get; set; }}");
            properties.Add($"public {related}{suffix} {property} {{ get; set; }}{(required ? " = null!;" : "")}");
        }

        return Unit(Feature(model, entity.Name), ["System", "System.Collections.Generic", "System.ComponentModel.DataAnnotations.Schema", "System.Text.Json"],
            $"public partial class {entity.Name} {{ {string.Join("\n", properties)} }}");
    }
}
