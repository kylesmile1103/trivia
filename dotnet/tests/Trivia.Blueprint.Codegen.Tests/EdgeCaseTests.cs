using System.Text.Json;
using Trivia.Blueprint.Codegen.Model;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

public sealed class EdgeCaseTests
{
    [Fact]
    [Trait("Category", "Build")]
    public async Task SC_001_AnEmptyModelBuildsAndHasNoApiPaths()
    {
        LoadedBlueprint bank = ModelLoader.Load(FixtureTests.Bank);
        using GeneratedProject project = new(bank with { Model = bank.Model with { Entities = [], Enums = [] } });
        Assert.Contains("0 Warning(s)", await project.BuildAsync());
        using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(project.DocumentPath));
        Assert.Empty(doc.RootElement.GetProperty("paths").EnumerateObject());
    }

    [Fact]
    public async Task ANewerBlueprintIsRefusedBeforeAnyFileIsWritten()
    {
        using TempDirectory root = new();
        using TempDirectory input = new();
        File.WriteAllText(Path.Combine(input.Path, ModelLoader.ModelFile), """{"blueprintVersion":2}""");
        using StringWriter output = new();
        int code = await Program.RunAsync(["write", "--blueprint", input.Path, "--root", root.Path], output, TextWriter.Null);
        Assert.Equal(1, code);
        using JsonDocument result = JsonDocument.Parse(output.ToString());
        JsonElement diagnostic = Assert.Single(result.RootElement.GetProperty("diagnostics").EnumerateArray());
        Assert.Equal("unsupported_version", diagnostic.GetProperty("code").GetString());
        Assert.Equal("/blueprintVersion", diagnostic.GetProperty("pointer").GetString());
        Assert.Empty(Directory.GetFileSystemEntries(root.Path));
    }
}
