using System.Text.Json;
using System.Text.Json.Nodes;
using Trivia.Blueprint.Codegen.Model;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

/// <summary>
/// The bank solution after its Initial migration, with a model that tests edit the way the TypeScript model ops do
/// (LLD-08 section 4), then generate and migrate with the real EF CLI. Each scenario copies one prepared solution.
/// </summary>
internal sealed class MigrationScenario : IDisposable
{
    public const string ApiProject = "src/BackOffice.Api";
    private static readonly Lazy<Task<string>> Prepared = new(PrepareAsync);
    private readonly TempDirectory blueprint = new();
    private readonly TempDirectory solution = new();

    public JsonObject Model { get; private set; } = null!;
    public string Root => solution.Path;
    public string Blueprint => blueprint.Path;
    public string MigrationsDirectory => Path.Combine(Root, ApiProject, "Data", "Migrations");

    private MigrationScenario()
    {
    }

    public static async Task<MigrationScenario> CreateAsync()
    {
        string template = await Prepared.Value;
        MigrationScenario scenario = new();
        try
        {
            Copy(Path.Combine(template, "solution"), scenario.Root);
            File.Copy(Path.Combine(template, "blueprint", ModelLoader.ModelFile), Path.Combine(scenario.Blueprint, ModelLoader.ModelFile));
            scenario.Model = JsonNode.Parse(File.ReadAllText(Path.Combine(scenario.Blueprint, ModelLoader.ModelFile)))!.AsObject();
            return scenario;
        }
        catch
        {
            scenario.Dispose();
            throw;
        }
    }

    /// <summary>Writes the model, regenerates the API and adds a migration. Returns migrate's exit code and JSON.</summary>
    public async Task<(int Status, JsonElement Result, string Output)> MigrateAsync(string name)
    {
        File.WriteAllText(Path.Combine(Blueprint, ModelLoader.ModelFile), Model.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
        (int written, string writeOutput) = await RunAsync(["write", "--blueprint", Blueprint, "--root", Root]);
        Assert.True(written == 0, writeOutput);
        (int status, string output) = await RunAsync(["migrate", name, "--blueprint", Blueprint, "--root", Root]);
        using JsonDocument document = JsonDocument.Parse(output);
        return (status, document.RootElement.Clone(), output);
    }

    /// <summary>The bytes of every file under Data/Migrations, by file name.</summary>
    public SortedDictionary<string, byte[]> MigrationFiles() =>
        new(Directory.EnumerateFiles(MigrationsDirectory).ToDictionary(file => Path.GetFileName(file), File.ReadAllBytes),
            StringComparer.Ordinal);

    public string MigrationSource(JsonElement result) =>
        File.ReadAllText(Path.Combine(Root, result.GetProperty("migration").GetString()!));

    public JsonObject Entity(string name) =>
        Model["entities"]!.AsArray().Select(entity => entity!.AsObject()).Single(entity => (string?)entity["name"] == name);

    public JsonObject Field(string entity, string name) =>
        Entity(entity)["fields"]!.AsArray().Select(field => field!.AsObject()).Single(field => (string?)field["name"] == name);

    /// <summary>renameField: keeps the first name as the marker and clears it when renamed back.</summary>
    public void RenameField(string entity, string from, string to)
    {
        JsonObject owner = Entity(entity);
        JsonObject field = Field(entity, from);
        Rename(field, to);
        foreach (JsonObject index in owner["indexes"]!.AsArray().Select(index => index!.AsObject()))
            Replace(index["fields"]!.AsArray(), from, to);
        foreach (string list in new[] { "filterable", "sortable", "searchable" })
            if (owner["api"]![list] is JsonArray names)
                Replace(names, from, to);
    }

    /// <summary>renameEntity with the plural changed alongside, as the designer pairs it with setEntity.</summary>
    public void RenameEntity(string from, string to, string plural)
    {
        JsonObject entity = Entity(from);
        Rename(entity, to);
        entity["plural"] = plural;
        foreach (JsonObject owner in Model["entities"]!.AsArray().Select(item => item!.AsObject()))
        {
            foreach (JsonObject relation in owner["relations"]!.AsArray().Select(item => item!.AsObject()))
                if ((string?)relation["to"] == from)
                    relation["to"] = to;
            if (owner["api"]!["custom"] is JsonArray custom)
                foreach (JsonObject operation in custom.Select(item => item!.AsObject()))
                    if ((string?)operation["returns"] == from)
                        operation["returns"] = to;
        }
    }

    public void AddField(string entity, JsonObject field) => Entity(entity)["fields"]!.AsArray().Add(field);

    public void RemoveField(string entity, string name)
    {
        JsonArray fields = Entity(entity)["fields"]!.AsArray();
        fields.Remove(fields.Single(field => (string?)field!["name"] == name));
    }

    public void AddEntity(string name, string plural) => Model["entities"]!.AsArray().Add(JsonNode.Parse($$"""
        {
          "name": "{{name}}", "plural": "{{plural}}",
          "key": { "name": "id", "type": "uuid", "generated": "v7" },
          "fields": [{ "name": "title", "type": "string", "required": true, "maxLength": 80 }],
          "relations": [], "indexes": [{ "fields": ["title"] }], "api": { "operations": ["list", "get"] }
        }
        """));

    /// <summary>What the guarded clearRenameMarkers op does after a successful migrate.</summary>
    public void ClearMarkers()
    {
        foreach (JsonObject entity in Model["entities"]!.AsArray().Select(item => item!.AsObject()))
        {
            entity.Remove("renamedFrom");
            foreach (JsonObject field in entity["fields"]!.AsArray().Select(item => item!.AsObject()))
                field.Remove("renamedFrom");
        }
    }

    public void Dispose()
    {
        blueprint.Dispose();
        solution.Dispose();
    }

    private static void Rename(JsonObject item, string name)
    {
        string origin = (string?)item["renamedFrom"] ?? (string)item["name"]!;
        item["name"] = name;
        if (origin == name)
            item.Remove("renamedFrom");
        else
            item["renamedFrom"] = origin;
    }

    private static void Replace(JsonArray names, string from, string to)
    {
        for (int index = 0; index < names.Count; index++)
            if ((string?)names[index] == from)
                names[index] = to;
    }

    private static async Task<(int Status, string Output)> RunAsync(string[] arguments)
    {
        using StringWriter output = new();
        using StringWriter error = new();
        int status = await Program.RunAsync(arguments, output, error);
        return (status, output.ToString() + error);
    }

    private static async Task<string> PrepareAsync()
    {
        string root = Directory.CreateTempSubdirectory("trivia-migration-template-").FullName;
        AppDomain.CurrentDomain.ProcessExit += (_, _) =>
        {
            try
            {
                Directory.Delete(root, recursive: true);
            }
            catch (IOException)
            {
            }
        };
        string blueprint = Directory.CreateDirectory(Path.Combine(root, "blueprint")).FullName;
        string solution = Directory.CreateDirectory(Path.Combine(root, "solution")).FullName;
        File.Copy(Path.Combine(FixtureTests.Bank, ModelLoader.ModelFile), Path.Combine(blueprint, ModelLoader.ModelFile));
        (int written, string writeOutput) = await RunAsync(["write", "--blueprint", blueprint, "--root", solution]);
        Assert.True(written == 0, writeOutput);
        (int migrated, string migrateOutput) = await RunAsync(["migrate", "Initial", "--blueprint", blueprint, "--root", solution]);
        Assert.True(migrated == 0, migrateOutput);
        return root;
    }

    // Sources only: each copy restores and builds on its own.
    private static void Copy(string source, string destination)
    {
        foreach (string directory in Directory.EnumerateDirectories(source))
        {
            string name = Path.GetFileName(directory);
            if (name is "bin" or "obj")
                continue;
            Copy(directory, Directory.CreateDirectory(Path.Combine(destination, name)).FullName);
        }
        foreach (string file in Directory.EnumerateFiles(source))
            File.Copy(file, Path.Combine(destination, Path.GetFileName(file)));
    }
}
