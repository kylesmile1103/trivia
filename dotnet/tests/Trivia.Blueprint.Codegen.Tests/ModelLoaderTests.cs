using System.Text.Json;
using System.Text.Json.Nodes;
using Trivia.Blueprint.Codegen.Model;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

public sealed class ModelLoaderTests
{
    [Fact]
    public async Task LoadsTheRecursiveSchemaConcurrently()
    {
        using ManualResetEventSlim start = new();
        Task<LoadedBlueprint>[] loads = Enumerable.Range(0, 24).Select(_ => Task.Run(() =>
        {
            start.Wait();
            return ModelLoader.Load(FixtureTests.Bank);
        })).ToArray();
        start.Set();
        Assert.All(await Task.WhenAll(loads), blueprint => Assert.Equal("BackOffice", blueprint.AppName));
    }

    [Fact]
    public void BankModelRoundTripsWithoutLoss()
    {
        LoadedBlueprint loaded = ModelLoader.Load(FixtureTests.Bank);
        JsonNode? expected = JsonNode.Parse(File.ReadAllText(Path.Combine(FixtureTests.Bank, "model.blueprint.json")));
        Assert.True(JsonNode.DeepEquals(expected, JsonSerializer.SerializeToNode(loaded.Model, ModelLoader.Json)));
        Assert.Equal("BackOffice", loaded.AppName);
        Assert.Null(loaded.App);
        Assert.StartsWith("sha256:", loaded.ModelRev);
    }

    [Fact]
    public void SchemaDiagnosticsMatchBlueprintShape()
    {
        string directory = Path.Combine(FixtureTests.ModelFixtures, "invalid", "schema_violation");
        BlueprintInputException error = Assert.Throws<BlueprintInputException>(() => ModelLoader.Load(directory));
        Assert.Contains(error.Diagnostics, finding => finding.Code == "schema_violation" &&
            finding.Doc == "model.blueprint.json" && finding.Pointer.StartsWith("/entities", StringComparison.Ordinal));
    }

    [Fact]
    public void AppSettingsRoundTripWithoutLoss()
    {
        using TempDirectory directory = new();
        File.Copy(Path.Combine(FixtureTests.Bank, "model.blueprint.json"), Path.Combine(directory.Path, "model.blueprint.json"));
        string app = """
            {"$schema":"https://trivia.dev/schemas/blueprint/app.v1.json","blueprintVersion":1,
             "name":"Bank","targets":{"web":"vite-refine","api":"dotnet-minimal"},"auth":{"mode":"oidc"},
             "theme":{"tokens":{"accent":"blue"}},"nav":[{"page":"Home","label":"Home","icon":"house"}]}
            """;
        File.WriteAllText(Path.Combine(directory.Path, "app.blueprint.json"), app);
        LoadedBlueprint loaded = ModelLoader.Load(directory.Path);
        Assert.Equal("Bank", loaded.AppName);
        Assert.Equal("oidc", loaded.App?.Auth?.Mode);
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(app), JsonSerializer.SerializeToNode(loaded.App, ModelLoader.Json)));
    }

    [Fact]
    public void RefusesANewerVersionBeforeEvaluatingItsShape()
    {
        using TempDirectory directory = new();
        File.WriteAllText(Path.Combine(directory.Path, "model.blueprint.json"), """{"blueprintVersion":2}""");
        Diagnostic error = Assert.Single(Assert.Throws<BlueprintInputException>(() => ModelLoader.Load(directory.Path)).Diagnostics);
        Assert.Equal(new Diagnostic("unsupported_version", "model.blueprint.json", "/blueprintVersion",
            "Blueprint version 2 is unsupported; expected 1."), error);
    }
}
