using System.Text.Json;
using Trivia.Blueprint.Codegen.Model;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

public sealed class MigrationCommandTests
{
    [Fact]
    [Trait("Category", "Build")]
    public async Task FR_NC_12_EfAddsMigrationsWithoutEditingEarlierFiles()
    {
        using GeneratedProject project = new(ModelLoader.Load(FixtureTests.Bank));
        (int initial, string result) = await Run(project, "InitialBank");
        Assert.True(initial == 0, result);
        using JsonDocument first = JsonDocument.Parse(result);
        string relative = first.RootElement.GetProperty("migration").GetString()!;
        Assert.StartsWith("src/BackOffice.Api/Data/Migrations/", relative);
        Assert.EndsWith("_InitialBank.cs", relative);
        string migration = Path.Combine(project.Root, relative);
        string designer = Path.ChangeExtension(migration, ".Designer.cs");
        byte[] original = File.ReadAllBytes(migration);
        byte[] originalDesigner = File.ReadAllBytes(designer);

        (int next, string nextResult) = await Run(project, "NextBank");
        Assert.True(next == 0, nextResult);
        using JsonDocument second = JsonDocument.Parse(nextResult);
        Assert.EndsWith("_NextBank.cs", second.RootElement.GetProperty("migration").GetString());
        Assert.Equal(original, File.ReadAllBytes(migration));
        Assert.Equal(originalDesigner, File.ReadAllBytes(designer));

        (int refused, string refusedResult) = await Run(project, "../Escape");
        Assert.Equal(1, refused);
        Assert.Contains("invalid_migration_name", refusedResult);
    }

    private static async Task<(int ExitCode, string Output)> Run(GeneratedProject project, string name)
    {
        using StringWriter output = new();
        using StringWriter error = new();
        int status = await Program.RunAsync(["migrate", name, "--root", project.Root], output, error);
        return (status, output.ToString() + error);
    }
}
