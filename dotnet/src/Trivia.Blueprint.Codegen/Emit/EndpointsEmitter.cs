using Microsoft.CodeAnalysis.CSharp.Syntax;
using Trivia.Blueprint.Codegen.Model;
using static Trivia.Blueprint.Codegen.Emit.CSharp;

namespace Trivia.Blueprint.Codegen.Emit;

public static class EndpointsEmitter
{
    public static CompilationUnitSyntax Emit(ModelDocument model, ModelEntity entity)
    {
        string name = entity.Name;
        string route = $"/api/v1/{entity.Plural}";
        ApiMember[] members = ContractsEmitter.Members(model, entity).ToArray();
        string key = members[0].Member;
        string keyType = members[0].Type;
        string response = $"{name}Response";
        string dbSet = $"db.{name}Set";
        string criteria = $"row => row.{key} == id, cancellationToken";
        string[] writable = members.Where(member => member.Writable).Select(InputAssignment).ToArray();

        List<string> registrations = [];
        List<string> handlers = [];
        foreach (string operation in entity.Api.Operations)
        {
            switch (operation)
            {
                case "list":
                    Register("Get", "", "ListAsync", $"list{Pascal(entity.Plural)}", ".ProducesValidationProblem()");
                    handlers.Add(ListQueryEmitter.Handler(model, entity, members));
                    break;
                case "get":
                    Register("Get", "/{id}", "GetAsync", $"get{name}ById", ".ProducesProblem(404)");
                    handlers.Add($$"""
                        private static async Task<Results<Ok<{{response}}>, NotFound>> GetAsync(
                            {{keyType}} id, AppDbContext db, CancellationToken cancellationToken)
                        {
                            {{name}}? entity = await {{dbSet}}.AsNoTracking().SingleOrDefaultAsync({{criteria}});
                            return entity is null ? TypedResults.NotFound() : TypedResults.Ok(ToResponse(entity));
                        }
                        """);
                    break;
                case "create":
                    Register("Post", "", "CreateAsync", $"create{name}", ".ProducesValidationProblem().ProducesProblem(409)");
                    IEnumerable<string> initial = writable.Concat(members.Where(member =>
                            !member.Writable && member.Field is { Required: true } && member.ReferenceType)
                        .Select(member => $"{member.Member} = {DefaultValue(model, member.Field!)}!"));
                    handlers.Add($$"""
                        private static async Task<Created<{{response}}>> CreateAsync(
                            Create{{name}}Request input, AppDbContext db, CancellationToken cancellationToken)
                        {
                            {{name}} entity = new() { {{string.Join(", ", initial)}} };
                            {{dbSet}}.Add(entity);
                            await db.SaveChangesAsync(cancellationToken);
                            return TypedResults.Created(FormattableString.Invariant($"{{route}}/{entity.{{key}}}"), ToResponse(entity));
                        }
                        """);
                    break;
                case "update":
                    Register("Put", "/{id}", "UpdateAsync", $"update{name}", ".ProducesValidationProblem().ProducesProblem(404).ProducesProblem(409)");
                    string assignments = string.Join("\n", writable.Select(item => "entity." + item + ";")
                        .Concat(entity.Fields.Where(field => field.Generated == "onUpdate")
                            .Select(field => $"entity.{Member(entity, field.Name)} = DateTimeOffset.UtcNow;")));
                    handlers.Add($$"""
                        private static async Task<Results<Ok<{{response}}>, NotFound>> UpdateAsync(
                            {{keyType}} id, Update{{name}}Request input, AppDbContext db, CancellationToken cancellationToken)
                        {
                            {{name}}? entity = await {{dbSet}}.SingleOrDefaultAsync({{criteria}});
                            if (entity is null)
                                return TypedResults.NotFound();
                            {{assignments}}
                            await db.SaveChangesAsync(cancellationToken);
                            return TypedResults.Ok(ToResponse(entity));
                        }
                        """);
                    break;
                case "delete":
                    Register("Delete", "/{id}", "DeleteAsync", $"delete{name}", ".ProducesProblem(404).ProducesProblem(409)");
                    handlers.Add($$"""
                        private static async Task<Results<NoContent, NotFound>> DeleteAsync(
                            {{keyType}} id, AppDbContext db, CancellationToken cancellationToken)
                        {
                            {{name}}? entity = await {{dbSet}}.SingleOrDefaultAsync({{criteria}});
                            if (entity is null)
                                return TypedResults.NotFound();
                            {{dbSet}}.Remove(entity);
                            await db.SaveChangesAsync(cancellationToken);
                            return TypedResults.NoContent();
                        }
                        """);
                    break;
            }
        }

        string projection = string.Join(", ", members.Select(member => "entity." + member.Member));
        return Unit(Feature(model, name), ["System", "Microsoft.AspNetCore.Http.HttpResults",
            "Microsoft.AspNetCore.Mvc", "Microsoft.EntityFrameworkCore",
            $"global::{model.Namespace}.Data", $"global::{model.Namespace}.Generated"],
            $$"""
            public static partial class {{name}}Endpoints
            {
                public static RouteGroupBuilder Map{{name}}Endpoints(this IEndpointRouteBuilder routes)
                {
                    RouteGroupBuilder group = routes.MapGroup({{Literal(route)}}).WithTags({{Literal(Pascal(entity.Plural))}});
                    {{string.Join("\n", registrations)}}
                    return group;
                }

                {{string.Join("\n\n", handlers)}}

                private static {{response}} ToResponse({{name}} entity) => new({{projection}});
            }
            """);

        void Register(string verb, string pattern, string handler, string id, string metadata)
            => registrations.Add($"group.Map{verb}({Literal(pattern)}, {handler}).WithName({Literal(id)}){metadata};");
    }

    private static string InputAssignment(ApiMember member)
    {
        string value = $"input.{member.Member}";
        if (member.Required)
            value += member.ReferenceType ? "!" : ".GetValueOrDefault()";
        if (member.Field?.Type == "datetime")
            value += member.Required ? ".ToUniversalTime()" : "?.ToUniversalTime()";
        return $"{member.Member} = {value}";
    }
}
