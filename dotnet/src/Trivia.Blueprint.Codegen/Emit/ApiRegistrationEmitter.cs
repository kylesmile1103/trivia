using Microsoft.CodeAnalysis.CSharp.Syntax;
using Trivia.Blueprint.Codegen.Model;
using static Trivia.Blueprint.Codegen.Emit.CSharp;

namespace Trivia.Blueprint.Codegen.Emit;

public static class ApiRegistrationEmitter
{
    public static CompilationUnitSyntax Emit(LoadedBlueprint input)
    {
        string space = input.Model.Namespace;
        string fallback = Literal($"Host=localhost;Database={input.AppName.ToLowerInvariant()};Username=postgres");
        string maps = string.Join("\n", input.Model.Entities.Select(entity => $"app.Map{entity.Name}Endpoints();"));
        return Unit($"{space}.Generated", ["System.Text.Json", "System.Text.Json.Serialization", "Microsoft.AspNetCore.Routing",
            "Microsoft.EntityFrameworkCore", "Microsoft.OpenApi", $"global::{space}.Data",
            .. input.Model.Entities.Select(entity => $"global::{Feature(input.Model, entity.Name)}")],
            $$"""
            public static class ApiRegistration
            {
                public static void AddGeneratedServices(this IServiceCollection services, IConfiguration configuration)
                {
                    services.AddDbContext<AppDbContext>(options =>
                        options.UseNpgsql(configuration.GetConnectionString("AppDb") ?? {{fallback}}));
                    services.AddValidation();
                    services.AddProblemDetails();
                    services.AddExceptionHandler<ApiProblemHandler>();
                    services.Configure<RouteHandlerOptions>(options => options.ThrowOnBadRequest = true);
                    services.ConfigureHttpJsonOptions(options =>
                    {
                        options.SerializerOptions.NumberHandling = JsonNumberHandling.Strict;
                        options.SerializerOptions.DictionaryKeyPolicy = JsonNamingPolicy.CamelCase;
                    });
                    services.AddOpenApi(options => options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1);
                }

                public static void MapGeneratedEndpoints(this WebApplication app)
                {
                    app.UseExceptionHandler();
                    app.UseStatusCodePages(ApiProblemHandler.WriteStatusAsync);
                    app.MapOpenApi();
                    {{maps}}
                }
            }
            """);
    }
}
