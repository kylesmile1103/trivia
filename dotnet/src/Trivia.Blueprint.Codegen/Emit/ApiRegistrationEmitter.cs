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
        return Unit($"{space}.Generated", ["Microsoft.EntityFrameworkCore", "Microsoft.OpenApi", $"global::{space}.Data"],
            $$"""
            public static class ApiRegistration
            {
                public static void AddGeneratedServices(this IServiceCollection services, IConfiguration configuration)
                {
                    services.AddDbContext<AppDbContext>(options =>
                        options.UseNpgsql(configuration.GetConnectionString("AppDb") ?? {{fallback}}));
                    services.AddOpenApi(options => options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1);
                }

                public static void MapGeneratedEndpoints(this WebApplication app)
                {
                    app.MapOpenApi();
                }
            }
            """);
    }
}
