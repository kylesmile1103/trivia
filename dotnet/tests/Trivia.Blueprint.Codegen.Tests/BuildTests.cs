using System.Text.Json;
using Trivia.Blueprint.Codegen.Model;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

public sealed class BuildTests
{
    [Fact]
    [Trait("Category", "Build")]
    public async Task FR_NC_11_And_FR_AS_01_BankSolutionBuildsWithWarningsAsErrors()
    {
        using GeneratedProject project = await GeneratedProject.WriteAsync(FixtureTests.Bank);
        string output = await project.BuildAsync();
        Assert.Contains("0 Warning(s)", output);
        foreach (string name in new[] { "BackOffice.Api", "BackOffice.AppHost", "BackOffice.MigrationService", "BackOffice.ServiceDefaults" })
        {
            Assert.True(File.Exists(Path.Combine(project.Root, "src", name, "bin", "Debug", "net10.0", name + ".dll")),
                $"The solution build did not produce {name}.dll.");
        }
        Assert.True(File.Exists(project.DocumentPath), "Build produced no OpenAPI document.");
    }

    [Fact]
    [Trait("Category", "Build")]
    public async Task FR_NC_06_BuildTimeDocumentIncludesGeneratedRoutesAndProblemStatuses()
    {
        using GeneratedProject project = new(ModelLoader.Load(FixtureTests.Bank));
        _ = await project.BuildAsync();
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(project.DocumentPath));
        JsonElement paths = document.RootElement.GetProperty("paths");
        Assert.True(paths.TryGetProperty("/api/v1/customers", out JsonElement customers), paths.ToString());
        JsonElement responses = customers.GetProperty("post").GetProperty("responses");
        Assert.Equal(new[] { "201", "400", "409" }, responses.EnumerateObject().Select(item => item.Name).Order().ToArray());
    }
}
