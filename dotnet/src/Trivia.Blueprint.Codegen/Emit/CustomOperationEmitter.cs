using System.Text.RegularExpressions;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Trivia.Blueprint.Codegen.Model;
using static Trivia.Blueprint.Codegen.Emit.CSharp;

namespace Trivia.Blueprint.Codegen.Emit;

internal static partial class CustomOperationEmitter
{
    internal static string Suffix(CustomOperation operation) => Pascal(operation.Name);
    internal static string Request(ModelEntity entity, CustomOperation operation) => $"{Suffix(operation)}{entity.Name}Request";
    private static string Handler(CustomOperation operation) => $"Handle{Suffix(operation)}Async";

    internal static string Registration(ModelEntity entity, CustomOperation operation)
    {
        string route = operation.Path.Length == 0 ? "" : "/" + operation.Path;
        string id = operation.Name + entity.Name;
        string validation = operation.Input is null ? "" : ".ProducesValidationProblem()";
        return $"group.MapMethods({Literal(route)}, [{Literal(operation.Method)}], {Handler(operation)})" +
            $".WithName({Literal(id)}).ProducesProblem(501){validation};";
    }

    internal static CompilationUnitSyntax Emit(ModelDocument model, ModelEntity entity, CustomOperation operation)
        => Unit(Feature(model, entity.Name), ["Microsoft.AspNetCore.Http.HttpResults", "Microsoft.AspNetCore.Mvc",
                $"global::{model.Namespace}.Data"],
            $"public static partial class {entity.Name}Endpoints {{ {Signature(model, entity, operation, bind: true)}; }}");

    internal static string Contract(ModelDocument model, ModelEntity entity, CustomOperation operation)
    {
        string properties = string.Join("\n", (operation.Input ?? []).Select(field =>
            ContractsEmitter.RequestProperty(model,
                new(field.Name, Member(entity, field.Name), FieldType(model, field.Type, field.Enum), field.Required == true, field))));
        return $"public sealed record {Request(entity, operation)} {{ {properties} }}";
    }

    internal static string Signature(ModelDocument model, ModelEntity entity, CustomOperation operation, bool bind)
    {
        List<string> parameters = [];
        HashSet<string> reserved = new(StringComparer.Ordinal) { "input", "db", "http", "cancellationToken" };
        foreach (Match match in Segments().Matches(operation.Path))
        {
            string route = match.Groups[1].Value;
            string type = route == "id" ? FieldType(model, entity.Key.Type, null) : "string";
            string name = route;
            while (!reserved.Add(name))
                name = "_" + name;
            string attribute = bind ? $"[FromRoute(Name = {Literal(route)})] " : "";
            parameters.Add($"{attribute}{type} @{name}");
        }

        if (operation.Input is not null)
            parameters.Add($"{(bind ? "[FromBody] " : "")}{Request(entity, operation)} input");
        parameters.AddRange(["AppDbContext db", "HttpContext http", "CancellationToken cancellationToken"]);
        return $"private static partial Task<{Result(model, operation)}> {Handler(operation)}({string.Join(", ", parameters)})";
    }

    internal static string Result(ModelDocument model, CustomOperation operation)
    {
        string success = operation.Returns is string entity
            ? $"Ok<{Entity(model, entity)}Response>" : "NoContent";
        return $"Results<{success}, ProblemHttpResult>";
    }

    [GeneratedRegex(@"\{([a-z][A-Za-z0-9]*)\}", RegexOptions.CultureInvariant)]
    private static partial Regex Segments();
}
