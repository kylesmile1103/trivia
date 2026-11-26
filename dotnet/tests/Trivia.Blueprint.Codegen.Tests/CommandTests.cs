using System.Text.Json;
using Trivia.Blueprint.Codegen.Model;
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
        // The bank fixture has no app document, so authentication defaults to none: a warning only.
        Assert.Equal(["auth_none"], plan.RootElement.GetProperty("diagnostics").EnumerateArray()
            .Select(item => item.GetProperty("code").GetString()));
        Assert.Empty(Directory.GetFileSystemEntries(root.Path));
    }

    [Theory]
    [InlineData(false, null, "", "There is no app.blueprint.json, so auth.mode defaults to none")]
    [InlineData(true, null, "", "auth.mode is none")]
    [InlineData(true, """{"mode":"none"}""", "/auth/mode", "auth.mode is none")]
    [InlineData(true, """{"mode":"oidc"}""", null, null)]
    public async Task NFR_05_PlanAndWriteWarnOnceWhenTheApiHasNoAuthentication(
        bool appDocument, string? auth, string? pointer, string? opening)
    {
        using TempDirectory root = new();
        using TempDirectory blueprint = new();
        File.Copy(Path.Combine(FixtureTests.Bank, ModelLoader.ModelFile), Path.Combine(blueprint.Path, ModelLoader.ModelFile));
        string members = auth is null ? "" : $",\"auth\":{auth}";
        if (appDocument)
            File.WriteAllText(Path.Combine(blueprint.Path, ModelLoader.AppFile), $$"""
                {"$schema":"https://trivia.dev/schemas/blueprint/app.v1.json","blueprintVersion":1,"name":"BackOffice",
                 "targets":{"web":"vite-refine","api":"dotnet-minimal"}{{members}}}
                """);

        foreach (string verb in new[] { "plan", "write", "check" })
        {
            using StringWriter output = new();
            int code = await Program.RunAsync([verb, "--blueprint", blueprint.Path, "--root", root.Path], output, TextWriter.Null);
            Assert.True(code == 0, verb + ": " + output);
            using JsonDocument result = JsonDocument.Parse(output.ToString());
            JsonElement[] diagnostics = [.. result.RootElement.GetProperty("diagnostics").EnumerateArray()];
            // check answers whether the generated files are current, and CI reads any entry as stale.
            if (pointer is null || verb == "check")
            {
                Assert.Empty(diagnostics);
                continue;
            }
            JsonElement warning = Assert.Single(diagnostics);
            Assert.Equal("auth_none", warning.GetProperty("code").GetString());
            Assert.Equal("warning", warning.GetProperty("severity").GetString());
            Assert.Equal(ModelLoader.AppFile, warning.GetProperty("doc").GetString());
            Assert.Equal(pointer, warning.GetProperty("pointer").GetString());
            string message = warning.GetProperty("message").GetString()!;
            Assert.StartsWith(opening!, message);
            Assert.Contains("oidc", message);
        }
        Assert.True(File.Exists(Path.Combine(root.Path, "src/BackOffice.Api/Generated/ApiRegistration.g.cs")));
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
