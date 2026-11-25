using System.Text.Json;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Trivia.Blueprint.Codegen.Model;
using static Trivia.Blueprint.Codegen.Emit.CSharp;

namespace Trivia.Blueprint.Codegen.Emit;

public static class ApiRegistrationEmitter
{
    public static CompilationUnitSyntax Emit(LoadedBlueprint input)
    {
        ModelDocument model = input.Model;
        string space = model.Namespace;
        string fallback = Literal($"Host=localhost;Database={input.AppName.ToLowerInvariant()};Username=postgres");
        bool oidc = input.App?.Auth?.Mode == "oidc";
        string require = oidc ? ".RequireAuthorization()" : "";
        string maps = string.Join("\n", model.Entities.Select(entity => $"app.Map{entity.Name}Endpoints(){require};"));
        string authServices = oidc ? """
            services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(options =>
            {
                options.Authority = configuration["Authentication:Authority"];
                options.Audience = configuration["Authentication:Audience"];
                options.IncludeErrorDetails = false;
            });
            services.AddAuthorization();
            """ : "";
        string authMiddleware = oidc ? "app.UseAuthentication(); app.UseAuthorization();" : "";
        string lists = string.Join(" or ", model.Entities.Where(entity => entity.Api.Operations.Contains("list"))
            .Select(entity => Literal("list" + Pascal(entity.Plural))));
        string addListMetadata = lists.Length == 0 ? "" : $$"""
            options.AddOperationTransformer((operation, context, cancellationToken) =>
            {
                if (operation.OperationId is {{lists}})
                    DescribePageParameters(operation);
                return Task.CompletedTask;
            });
            """;
        return Unit($"{space}.Generated", ["System.Text.Json", "System.Text.Json.Nodes",
            "System.Text.Json.Serialization", "Microsoft.AspNetCore.OpenApi", "Microsoft.AspNetCore.Routing",
            "Microsoft.EntityFrameworkCore", "Microsoft.OpenApi", $"global::{space}.Data",
            .. (oidc ? new[] { "Microsoft.AspNetCore.Authentication.JwtBearer" } : []),
            .. model.Entities.Select(entity => $"global::{Feature(model, entity.Name)}")],
            $$"""
            public static class ApiRegistration
            {
                public static void AddGeneratedServices(this IServiceCollection services, IConfiguration configuration)
                {
                    services.AddDbContext<AppDbContext>(options =>
                        options.UseNpgsql(configuration.GetConnectionString("AppDb") ?? {{fallback}}));
                    {{authServices}}
                    services.AddValidation();
                    services.AddProblemDetails();
                    services.AddExceptionHandler<ApiProblemHandler>();
                    services.Configure<RouteHandlerOptions>(options => options.ThrowOnBadRequest = true);
                    services.ConfigureHttpJsonOptions(options =>
                    {
                        options.SerializerOptions.NumberHandling = JsonNumberHandling.Strict;
                        options.SerializerOptions.DictionaryKeyPolicy = JsonNamingPolicy.CamelCase;
                    });
                    services.AddOpenApi(options =>
                    {
                        options.OpenApiVersion = OpenApiSpecVersion.OpenApi3_1;
                        options.AddSchemaTransformer(DescribeSchema);
                        options.AddDocumentTransformer(DescribeInputs);
                        {{(oidc ? "options.AddDocumentTransformer(DescribeBearerSecurity);" : "")}}
                        {{addListMetadata}}
                    });
                }

                public static void MapGeneratedEndpoints(this WebApplication app)
                {
                    app.UseExceptionHandler();
                    app.UseStatusCodePages(ApiProblemHandler.WriteStatusAsync);
                    {{authMiddleware}}
                    app.MapOpenApi(){{require}};
                    {{maps}}
                }

                {{SchemaTransformer(model)}}
                {{(oidc ? BearerSecurity : "")}}

                private static void DescribePageParameters(OpenApiOperation operation)
                {
                    foreach (OpenApiParameter parameter in (operation.Parameters ?? []).OfType<OpenApiParameter>())
                    {
                        if (parameter.Name is "page" or "pageSize")
                        {
                            bool size = parameter.Name == "pageSize";
                            parameter.Schema = new OpenApiSchema
                            {
                                Type = JsonSchemaType.Integer,
                                Format = "int32",
                                Minimum = "1",
                                Maximum = size ? "200" : "2147483647",
                                Default = JsonValue.Create(size ? 20 : 1)
                            };
                        }
                    }
                }
            }
            """);
    }

    private const string BearerSecurity = """
        private static Task DescribeBearerSecurity(OpenApiDocument document, OpenApiDocumentTransformerContext context,
            CancellationToken cancellationToken)
        {
            document.Components ??= new OpenApiComponents();
            document.Components.SecuritySchemes ??= new Dictionary<string, IOpenApiSecurityScheme>();
            document.Components.SecuritySchemes["bearer"] = new OpenApiSecurityScheme
            {
                Type = SecuritySchemeType.Http,
                Scheme = "bearer",
                BearerFormat = "JWT"
            };
            document.Security = [new OpenApiSecurityRequirement
            {
                [new OpenApiSecuritySchemeReference("bearer", document)] = []
            }];
            return Task.CompletedTask;
        }
        """;

    private static string SchemaTransformer(ModelDocument model)
    {
        List<string> statements = [];
        foreach (ModelEnum enumeration in model.Enums)
        {
            string literals = string.Join(", ", enumeration.Values.Select(value => $"JsonValue.Create({Literal(value)})!"));
            statements.Add($$"""
                if (type == typeof({{Enum(model, enumeration.Name)}}))
                {
                    schema.Type = JsonSchemaType.String;
                    schema.Enum = [{{literals}}];
                }
                """);
        }
        List<string> inputs = [];
        foreach (ModelEntity entity in model.Entities)
        {
            ModelField[] fields = entity.Fields.Where(field => field.ReadOnly != true && field.Generated is null).ToArray();
            AddInput($"Create{entity.Name}Request", fields, entity.Relations);
            AddInput($"Update{entity.Name}Request", fields, entity.Relations, entity.Concurrency == true);
            if (entity.Api.Operations.Contains("update"))
                AddInput($"Patch{entity.Name}Request", fields, entity.Relations, entity.Concurrency == true, patch: true);
            foreach (CustomOperation operation in entity.Api.Custom ?? [])
                AddInput(CustomOperationEmitter.Request(entity, operation), operation.Input ?? [], []);
        }

        return $$"""
            private static Task DescribeSchema(OpenApiSchema schema, OpenApiSchemaTransformerContext context, CancellationToken cancellationToken)
            {
                Type type = Nullable.GetUnderlyingType(context.JsonTypeInfo.Type) ?? context.JsonTypeInfo.Type;
                if (type == typeof(JsonDocument))
                    schema.Type = JsonSchemaType.Object;
                {{string.Join("\n", statements)}}
                return Task.CompletedTask;
            }

            private static Task DescribeInputs(OpenApiDocument document, OpenApiDocumentTransformerContext context, CancellationToken cancellationToken)
            {
                {{string.Join("\n", inputs)}}
                return Task.CompletedTask;
            }

            private static void DescribeInput(OpenApiSchema schema, string name, bool nonNull, string? format, string? defaultJson)
            {
                if (defaultJson is not null)
                    schema.Required?.Remove(name);
                if (schema.Properties?.TryGetValue(name, out IOpenApiSchema? value) != true || value is not OpenApiSchema property)
                    return;
                if (nonNull)
                {
                    if (property.Type is JsonSchemaType type)
                        property.Type = type & ~JsonSchemaType.Null;
                    if (property.OneOf is IList<IOpenApiSchema> alternatives)
                        for (int index = alternatives.Count - 1; index >= 0; index--)
                            if (alternatives[index].Type == JsonSchemaType.Null)
                                alternatives.RemoveAt(index);
                }
                if (format is not null)
                    property.Format = format;
                if (defaultJson is not null)
                    property.Default = JsonNode.Parse(defaultJson);
            }
            """;

        void AddInput(string name, ModelField[] fields, ModelRelation[] relations, bool version = false, bool patch = false)
        {
            string properties = DescribeFields($"{name}Contract", fields, relations, patch);
            if (version)
                properties += $"\nDescribeInput({name}Contract, \"version\", true, null, null);";
            if (properties.Length == 0)
                return;
            inputs.Add($$"""
                if (document.Components?.Schemas?.TryGetValue({{Literal(name)}}, out IOpenApiSchema? {{name}}Schema) == true &&
                    {{name}}Schema is OpenApiSchema {{name}}Contract)
                {
                    {{properties}}
                }
                """);
        }
    }

    // A PATCH member is optional and has no default: leaving it out keeps the stored value.
    // A required member stays non-null, since a PATCH cannot clear it.
    private static string DescribeFields(string schema, ModelField[] fields, ModelRelation[] relations, bool patch)
    {
        IEnumerable<string> statements = fields
            .Where(field => field.Required == true || field.Format is not null || (!patch && field.Default.ValueKind != JsonValueKind.Undefined))
            .Select(field =>
            {
                string format = field.Format is string value ? Literal(value) : "null";
                string defaultJson = !patch && field.Default.ValueKind != JsonValueKind.Undefined ? Literal(field.Default.GetRawText()) : "null";
                return $"DescribeInput({schema}, {Literal(field.Name)}, {(field.Required == true ? "true" : "false")}, {format}, {defaultJson});";
            });
        return string.Join("\n", statements.Concat(relations.Where(relation => relation.Kind == "belongsTo" && relation.Required == true)
            .Select(relation => $"DescribeInput({schema}, {Literal(relation.ForeignKey)}, true, null, null);")));
    }
}
