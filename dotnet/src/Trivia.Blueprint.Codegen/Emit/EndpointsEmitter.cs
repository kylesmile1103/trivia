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
                            {{keyType}} id, AppDbContext db, HttpContext http, CancellationToken cancellationToken)
                        {
                            {{name}}? entity = await Scoped(db, http, tracked: false).SingleOrDefaultAsync({{criteria}});
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
                            await using IDbContextTransaction transaction = await db.Database.BeginTransactionAsync(cancellationToken);
                            OnCreating(entity, input, db);
                            {{dbSet}}.Add(entity);
                            await db.SaveChangesAsync(cancellationToken);
                            OnCreated(entity, db);
                            await transaction.CommitAsync(cancellationToken);
                            return TypedResults.Created(FormattableString.Invariant($"{{route}}/{entity.{{key}}}"), ToResponse(entity));
                        }
                        """);
                    break;
                case "update":
                    Register("Put", "/{id}", "UpdateAsync", $"update{name}", ".ProducesValidationProblem().ProducesProblem(404).ProducesProblem(409)");
                    // Contract-sync lists PATCH as a custom operation beside the PUT update slot,
                    // so the summary says what it is for.
                    string summary = Literal($"Change some fields of the {Snake(name).Replace('_', ' ')}");
                    Register("Patch", "/{id}", "PatchAsync", $"patch{name}",
                        $".WithSummary({summary}).ProducesValidationProblem().ProducesProblem(404).ProducesProblem(409)");
                    string confirmVersion = entity.Concurrency == true ? $$"""
                        if (entity.{{Member(entity, "version")}} != input.Version)
                            throw new ApiProblemException(409, "The record changed after it was read.", "stale");
                        """ : "";
                    string assignments = string.Join("\n", writable.Select(item => "entity." + item + ";")
                        .Concat(entity.Fields.Where(field => field.Generated == "onUpdate")
                            .Select(field => $"entity.{Member(entity, field.Name)} = DateTimeOffset.UtcNow;")));
                    // A PATCH overlays the members it carries on the stored record and then saves
                    // that merged record like a PUT, so OnUpdating sees the same request either way.
                    IEnumerable<string> merged = members.Where(member => member.Writable).Select(member =>
                            $"{member.Member} = patch.{ContractsEmitter.Sent(member)} ? patch.{member.Member} : entity.{member.Member}")
                        .Concat(entity.Concurrency == true ? ["Version = patch.Version"] : []);
                    string lookup = $"{name}? entity = await Scoped(db, http, tracked: true).SingleOrDefaultAsync({criteria});";
                    handlers.Add($$"""
                        private static async Task<Results<Ok<{{response}}>, NotFound>> UpdateAsync(
                            {{keyType}} id, Update{{name}}Request input, AppDbContext db, HttpContext http, CancellationToken cancellationToken)
                        {
                            {{lookup}}
                            if (entity is null)
                                return TypedResults.NotFound();
                            return await SaveUpdateAsync(entity, input, db, cancellationToken);
                        }

                        private static async Task<Results<Ok<{{response}}>, NotFound>> PatchAsync(
                            {{keyType}} id, Patch{{name}}Request patch, AppDbContext db, HttpContext http, CancellationToken cancellationToken)
                        {
                            {{lookup}}
                            if (entity is null)
                                return TypedResults.NotFound();
                            Update{{name}}Request input = new() { {{string.Join(", ", merged)}} };
                            return await SaveUpdateAsync(entity, input, db, cancellationToken);
                        }

                        private static async Task<Ok<{{response}}>> SaveUpdateAsync(
                            {{name}} entity, Update{{name}}Request input, AppDbContext db, CancellationToken cancellationToken)
                        {
                            {{confirmVersion}}
                            {{assignments}}
                            await using IDbContextTransaction transaction = await db.Database.BeginTransactionAsync(cancellationToken);
                            OnUpdating(entity, input, db);
                            await db.SaveChangesAsync(cancellationToken);
                            OnUpdated(entity, db);
                            await transaction.CommitAsync(cancellationToken);
                            return TypedResults.Ok(ToResponse(entity));
                        }
                        """);
                    break;
                case "delete":
                    Register("Delete", "/{id}", "DeleteAsync", $"delete{name}", ".ProducesProblem(404).ProducesProblem(409)");
                    handlers.Add($$"""
                        private static async Task<Results<NoContent, NotFound>> DeleteAsync(
                            {{keyType}} id, AppDbContext db, HttpContext http, CancellationToken cancellationToken)
                        {
                            {{name}}? entity = await Scoped(db, http, tracked: true).SingleOrDefaultAsync({{criteria}});
                            if (entity is null)
                                return TypedResults.NotFound();
                            await using IDbContextTransaction transaction = await db.Database.BeginTransactionAsync(cancellationToken);
                            OnDeleting(entity, db);
                            {{dbSet}}.Remove(entity);
                            await db.SaveChangesAsync(cancellationToken);
                            OnDeleted(entity, db);
                            await transaction.CommitAsync(cancellationToken);
                            return TypedResults.NoContent();
                        }
                        """);
                    break;
            }
        }

        foreach (CustomOperation operation in entity.Api.Custom ?? [])
            registrations.Add(CustomOperationEmitter.Registration(entity, operation));

        string projection = string.Join(", ", members.Select(member => "entity." + member.Member));
        return Unit(Feature(model, name), ["System", "Microsoft.AspNetCore.Http.HttpResults",
            "Microsoft.AspNetCore.Mvc", "Microsoft.EntityFrameworkCore", "Microsoft.EntityFrameworkCore.Storage",
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

                private static IQueryable<{{name}}> Scoped(AppDbContext db, HttpContext http, bool tracked)
                {
                    IQueryable<{{name}}> query = tracked ? {{dbSet}} : {{dbSet}}.AsNoTracking();
                    ConfigureQuery(ref query, http);
                    return query;
                }

                private static {{response}} ToResponse({{name}} entity) => new({{projection}});

                static partial void ConfigureQuery(ref IQueryable<{{name}}> query, HttpContext http);
                static partial void OnCreating({{name}} entity, Create{{name}}Request request, AppDbContext db);
                static partial void OnCreated({{name}} entity, AppDbContext db);
                static partial void OnUpdating({{name}} entity, Update{{name}}Request request, AppDbContext db);
                static partial void OnUpdated({{name}} entity, AppDbContext db);
                static partial void OnDeleting({{name}} entity, AppDbContext db);
                static partial void OnDeleted({{name}} entity, AppDbContext db);
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
