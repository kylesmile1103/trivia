using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

public sealed class RegenerationTests
{
    private const string Context = "src/BackOffice.Api/Data/AppDbContext";
    private const string Customer = "src/BackOffice.Api/Features/Customer/CustomerContracts.g.cs";

    [Fact]
    public async Task FR_NC_02_RegenerationKeepsAnImplementedContextHook()
    {
        using TempDirectory blueprint = CopyBank();
        using TempDirectory root = new();
        (int initial, _) = await Run("write", blueprint, root);
        Assert.Equal(0, initial);

        string hookPath = Path.Combine(root.Path, Context + ".cs");
        string hook = File.ReadAllText(hookPath).Replace("    }",
            "        modelBuilder.HasAnnotation(\"User:Hook\", true);\n    }", StringComparison.Ordinal);
        Assert.Contains("User:Hook", hook);
        File.WriteAllText(hookPath, hook);

        string generatedPath = Path.Combine(root.Path, Customer);
        string before = File.ReadAllText(generatedPath);
        ChangeNameLength(blueprint);
        (int changed, JsonElement update) = await Run("write", blueprint, root);
        Assert.Equal(0, changed);
        Assert.Contains(update.GetProperty("files").EnumerateArray(),
            entry => entry.GetProperty("path").GetString() == Customer && entry.GetProperty("action").GetString() == "update");
        string after = File.ReadAllText(generatedPath);
        Assert.NotEqual(before, after);
        Assert.Contains("MaxLength(121)", after);
        Assert.Equal(hook, File.ReadAllText(hookPath));

        (int repeated, JsonElement identical) = await Run("write", blueprint, root);
        Assert.Equal(0, repeated);
        Assert.All(identical.GetProperty("files").EnumerateArray(),
            entry => Assert.Equal("unchanged", entry.GetProperty("action").GetString()));
        Assert.Equal(hook, File.ReadAllText(hookPath));
    }

    private static TempDirectory CopyBank()
    {
        TempDirectory blueprint = new();
        File.Copy(Path.Combine(FixtureTests.Bank, "model.blueprint.json"), Path.Combine(blueprint.Path, "model.blueprint.json"));
        return blueprint;
    }

    private static void ChangeNameLength(TempDirectory blueprint)
    {
        string path = Path.Combine(blueprint.Path, "model.blueprint.json");
        JsonNode document = JsonNode.Parse(File.ReadAllText(path))!;
        document["entities"]![0]!["fields"]![0]!["maxLength"] = 121;
        File.WriteAllText(path, document.ToJsonString());
    }

    private static async Task<(int ExitCode, JsonElement Result)> Run(string command, TempDirectory blueprint, TempDirectory root,
        params string[] flags)
    {
        using StringWriter output = new();
        int exit = await Program.RunAsync([command, "--blueprint", blueprint.Path, "--root", root.Path, .. flags],
            output, TextWriter.Null);
        return (exit, JsonSerializer.Deserialize<JsonElement>(output.ToString()));
    }
}
