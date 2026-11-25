using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Json.Schema;

namespace Trivia.Blueprint.Codegen.Model;

public sealed record Diagnostic(string Code, string Doc, string Pointer, string Message)
{
    public string Severity => "error";
}

public sealed class BlueprintInputException(IReadOnlyList<Diagnostic> diagnostics)
    : Exception(string.Join("\n", diagnostics.Select(item => item.Message)))
{
    public IReadOnlyList<Diagnostic> Diagnostics { get; } = diagnostics;
}

public sealed record LoadedBlueprint(ModelDocument Model, AppDocument? App, string ModelRev)
{
    public string AppName => App?.Name ?? Model.Namespace.Split('.')[0];
}

public static class ModelLoader
{
    public const string ModelFile = "model.blueprint.json";
    public const string AppFile = "app.blueprint.json";

    public static JsonSerializerOptions Json { get; } = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private static readonly Lazy<JsonSchema> ModelSchema = new(() => ReadSchema("model"));
    private static readonly Lazy<JsonSchema> AppSchema = new(() => ReadSchema("app"));

    public static LoadedBlueprint Load(string directory)
    {
        byte[] modelBytes = Read(directory, ModelFile);
        ModelDocument model = LoadDocument<ModelDocument>(modelBytes, ModelFile, ModelSchema.Value);
        string modelRev = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(modelBytes));
        AppDocument? app = File.Exists(Path.Combine(directory, AppFile))
            ? LoadDocument<AppDocument>(Read(directory, AppFile), AppFile, AppSchema.Value)
            : null;
        return new(model, app, modelRev);
    }

    private static T LoadDocument<T>(byte[] bytes, string file, JsonSchema schema)
    {
        try
        {
            ReadOnlySpan<byte> json = bytes.AsSpan();
            if (json.StartsWith(new byte[] { 0xef, 0xbb, 0xbf }))
                json = json[3..];
            JsonNode? value = JsonNode.Parse(json);
            if (value is JsonObject obj && obj["blueprintVersion"] is JsonValue version &&
                version.TryGetValue(out int number) && number != 1)
                throw Failure("unsupported_version", file, "/blueprintVersion",
                    $"Blueprint version {number} is unsupported; expected 1.");

            EvaluationResults result;
            // JsonSchema.Net populates recursive reference constraints on the shared schema.
            lock (schema)
                result = schema.Evaluate(value, new EvaluationOptions { OutputFormat = OutputFormat.List });
            if (!result.IsValid)
            {
                Diagnostic[] findings = result.Details
                    .Where(detail => !detail.IsValid && detail.HasErrors)
                    .SelectMany(detail => detail.Errors!.Values.Select(message =>
                        new Diagnostic("schema_violation", file, detail.InstanceLocation.ToString(), message)))
                    .Distinct()
                    .ToArray();
                throw findings.Length == 0
                    ? Failure("schema_violation", file, "", "The document does not match its JSON Schema.")
                    : new BlueprintInputException(findings);
            }
            return value!.Deserialize<T>(Json)!;
        }
        catch (JsonException exception)
        {
            throw Failure("invalid_json", file, "", exception.Message);
        }
    }

    private static byte[] Read(string directory, string file)
    {
        try
        {
            return File.ReadAllBytes(Path.Combine(directory, file));
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            throw Failure("missing_document", file, "", $"Could not read {file}: {exception.Message}");
        }
    }

    private static BlueprintInputException Failure(string code, string file, string pointer, string message)
        => new([new(code, file, pointer, message)]);

    private static JsonSchema ReadSchema(string kind)
    {
        using Stream resource = typeof(ModelLoader).Assembly.GetManifestResourceStream($"Schemas/{kind}.v1.json")!;
        using StreamReader reader = new(resource);
        return JsonSchema.FromText(reader.ReadToEnd());
    }
}
