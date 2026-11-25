using System.Text.Json;
using Trivia.Blueprint.Codegen.Plan;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

public sealed class CommandTests
{
    [Fact]
    public async Task FR_NC_01_PlanPrintsJsonWithoutWriting()
    {
        using TempDirectory root = new();
        using StringWriter output = new();
        Assert.Equal(0, await Run("plan", root, output, "--content"));
        using JsonDocument plan = JsonDocument.Parse(output.ToString());
        Assert.StartsWith("sha256:", plan.RootElement.GetProperty("modelRev").GetString());
        Assert.Empty(plan.RootElement.GetProperty("diagnostics").EnumerateArray());
        Assert.Empty(Directory.GetFileSystemEntries(root.Path));
    }

    [Fact]
    public async Task FR_NC_03_CheckAndWriteReturnDistinctExitCodes()
    {
        using TempDirectory root = new();
        const string leftover = "src/BackOffice.Api/Features/Retired/Retired.g.cs";
        FilePlan old = PlanWriter.Plan(root.Path, "sha256:old", "src/BackOffice.Api",
            [new(leftover, FileKind.Generated, "old\n")]);
        PlanWriter.Write(root.Path, old);
        string path = Path.Combine(root.Path, leftover);
        File.AppendAllText(path, "// hand edit");

        using StringWriter output = new();
        Assert.Equal(1, await Run("check", root, output));
        Assert.Contains(leftover, output.ToString());
        Assert.Equal(2, await Run("write", root, output));
        Assert.EndsWith("// hand edit", File.ReadAllText(path));
        Assert.Equal(0, await Run("write", root, output, "--force"));
        Assert.False(File.Exists(path));
    }

    private static Task<int> Run(string verb, TempDirectory root, TextWriter output, params string[] options)
        => Program.RunAsync([verb, "--blueprint", FixtureTests.Bank, "--root", root.Path, .. options], output, TextWriter.Null);
}
