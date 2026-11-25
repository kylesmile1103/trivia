using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

public sealed class DeterminismTests
{
    [Fact]
    public async Task FR_NC_01_NFR_02_ByteIdenticalPlansAndFilesAcrossRoots()
    {
        using TempDirectory first = new();
        using TempDirectory second = new();
        (int firstCode, string firstPlan) = await Run("plan", FixtureTests.Bank, first.Path, "--content");
        (int secondCode, string secondPlan) = await Run("plan", FixtureTests.Bank, second.Path, "--content");
        Assert.Equal(0, firstCode);
        Assert.Equal(0, secondCode);
        Assert.Equal(firstPlan, secondPlan);
        Assert.Empty(Directory.GetFileSystemEntries(first.Path));
        Assert.Empty(Directory.GetFileSystemEntries(second.Path));

        Assert.Equal(0, (await Run("write", FixtureTests.Bank, first.Path)).Code);
        Assert.Equal(0, (await Run("write", FixtureTests.Bank, second.Path)).Code);
        using JsonDocument plan = JsonDocument.Parse(firstPlan);
        foreach (JsonElement item in plan.RootElement.GetProperty("files").EnumerateArray())
        {
            string path = item.GetProperty("path").GetString()!;
            byte[] expected = Encoding.UTF8.GetBytes(item.GetProperty("content").GetString()!);
            Assert.Equal("sha256:" + Convert.ToHexStringLower(SHA256.HashData(expected)), item.GetProperty("hash").GetString());
            Assert.Equal(expected, File.ReadAllBytes(Path.Combine(first.Path, path)));
            Assert.Equal(expected, File.ReadAllBytes(Path.Combine(second.Path, path)));
        }
    }

    [Fact]
    public async Task FR_NC_01_CheckReportsDriftWithoutWriting()
    {
        using TempDirectory root = new();
        using TempDirectory blueprint = new();
        string modelPath = Path.Combine(blueprint.Path, "model.blueprint.json");
        File.Copy(Path.Combine(FixtureTests.Bank, "model.blueprint.json"), modelPath);
        Assert.Equal(0, (await Run("write", blueprint.Path, root.Path)).Code);
        Assert.Equal(0, (await Run("check", blueprint.Path, root.Path)).Code);
        string path = Path.Combine(root.Path, "src/BackOffice.Api/Data/AppDbContext.g.cs");
        byte[] before = File.ReadAllBytes(path);

        JsonNode model = JsonNode.Parse(File.ReadAllText(modelPath))!;
        model["entities"]![0]!["fields"]![0]!["maxLength"] = 121;
        File.WriteAllText(modelPath, model.ToJsonString());
        (int code, string result) = await Run("check", blueprint.Path, root.Path);
        Assert.Equal(1, code);
        using JsonDocument plan = JsonDocument.Parse(result);
        Assert.Contains(plan.RootElement.GetProperty("diagnostics").EnumerateArray(), item =>
            item.GetProperty("code").GetString() == "stale_generated_file" &&
            item.GetProperty("doc").GetString() == "src/BackOffice.Api/Data/AppDbContext.g.cs");
        Assert.Equal(before, File.ReadAllBytes(path));
    }

    private static async Task<(int Code, string Output)> Run(string command, string blueprint, string root, params string[] flags)
    {
        using StringWriter output = new();
        int code = await Program.RunAsync([command, "--blueprint", blueprint, "--root", root, .. flags], output, TextWriter.Null);
        return (code, output.ToString());
    }
}
