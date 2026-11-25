using Microsoft.CodeAnalysis.CSharp.Syntax;
using Trivia.Blueprint.Codegen.Model;
using static Trivia.Blueprint.Codegen.Emit.CSharp;

namespace Trivia.Blueprint.Codegen.Emit;

public static class ApiProblemEmitter
{
    public static CompilationUnitSyntax Emit(ModelDocument model)
        => Unit($"{model.Namespace}.Generated",
            ["System.Text.Json", "Microsoft.AspNetCore.Diagnostics", "Microsoft.EntityFrameworkCore", "Npgsql"],
            """
            public sealed class ApiProblemException(int status, string title, string? code = null,
                IReadOnlyDictionary<string, string[]>? errors = null) : Exception(title)
            {
                public int Status { get; } = status;
                public string? Code { get; } = code;
                public IReadOnlyDictionary<string, string[]>? Errors { get; } = errors;
            }
            """,
            """
            internal sealed class ApiProblemHandler : IExceptionHandler
            {
                public async ValueTask<bool> TryHandleAsync(HttpContext http, Exception exception, CancellationToken cancellationToken)
                {
                    IResult result = exception switch
                    {
                        ApiProblemException problem => Create(problem.Status, problem.Message, problem.Code, problem.Errors),
                        BadHttpRequestException { StatusCode: 400, InnerException: JsonException json } =>
                            InvalidRequest(JsonField(json)),
                        BadHttpRequestException bad => Create(bad.StatusCode),
                        DbUpdateException { InnerException: PostgresException postgres } => FromPostgres(postgres),
                        _ => Create(500, "An unexpected error occurred.")
                    };
                    await result.ExecuteAsync(http);
                    return true;
                }

                internal static Task WriteStatusAsync(StatusCodeContext context)
                    => Create(context.HttpContext.Response.StatusCode).ExecuteAsync(context.HttpContext);

                private static IResult FromPostgres(PostgresException exception) => exception.SqlState switch
                {
                    PostgresErrorCodes.UniqueViolation => Create(409, "A unique value already exists.", "unique"),
                    PostgresErrorCodes.ForeignKeyViolation => Create(409, "A related record prevents this change.", "in_use"),
                    PostgresErrorCodes.CheckViolation or PostgresErrorCodes.NotNullViolation or
                    PostgresErrorCodes.NumericValueOutOfRange or PostgresErrorCodes.StringDataRightTruncation => InvalidRequest("request"),
                    _ => Create(500, "An unexpected error occurred.")
                };

                private static IResult Create(int status, string? title = null, string? code = null,
                    IReadOnlyDictionary<string, string[]>? errors = null)
                {
                    if (status == 400)
                        return errors is null ? InvalidRequest("request") : TypedResults.ValidationProblem(errors, title: title);
                    Dictionary<string, object?>? extensions = code is null ? null : new() { ["code"] = code };
                    return TypedResults.Problem(statusCode: status, title: title, extensions: extensions);
                }

                private static IResult InvalidRequest(string field)
                    => TypedResults.ValidationProblem(new Dictionary<string, string[]> { [field] = ["The request value is invalid."] });

                private static string JsonField(JsonException exception)
                    => exception.Path is { Length: > 2 } path && path.StartsWith("$.", StringComparison.Ordinal)
                        ? path[2..] : "request";
            }
            """);
}
