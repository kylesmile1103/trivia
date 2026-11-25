using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Trivia.Blueprint.Codegen.Model;
using Xunit;
using Xunit.Abstractions;

namespace Trivia.Blueprint.Codegen.Tests;

public sealed class PerformanceTests(ITestOutputHelper testOutput)
{
    [Fact]
    public async Task SC_004_PlanningFiftyEntitiesTakesLessThanFiveSeconds()
    {
        LoadedBlueprint bank = ModelLoader.Load(FixtureTests.Bank);
        ModelEntity template = bank.Model.Entities[0];
        ModelEntity[] entities = Enumerable.Range(1, 50).Select(index =>
        {
            string suffix = index.ToString(CultureInfo.InvariantCulture);
            return template with
            {
                Name = "Customer" + suffix,
                Plural = "customers-" + suffix,
                Relations = [],
                Api = template.Api with { Custom = [] }
            };
        }).ToArray();

        using TempDirectory blueprint = new();
        using TempDirectory root = new();
        File.WriteAllText(Path.Combine(blueprint.Path, ModelLoader.ModelFile),
            JsonSerializer.Serialize(bank.Model with { Entities = entities }, ModelLoader.Json));
        using StringWriter output = new();
        using StringWriter errors = new();
        Stopwatch elapsed = Stopwatch.StartNew();
        int code = await Program.RunAsync(["plan", "--blueprint", blueprint.Path, "--root", root.Path], output, errors);
        elapsed.Stop();

        Assert.True(code == 0, output.ToString() + errors);
        using JsonDocument plan = JsonDocument.Parse(output.ToString());
        Assert.Equal(50, plan.RootElement.GetProperty("files").EnumerateArray()
            .Count(item => item.GetProperty("path").GetString()!.EndsWith("Endpoints.g.cs", StringComparison.Ordinal)));
        Assert.Empty(Directory.GetFileSystemEntries(root.Path));
        testOutput.WriteLine($"50 entities planned in {elapsed.Elapsed.TotalMilliseconds:F0} ms.");
        Assert.True(elapsed.Elapsed < TimeSpan.FromSeconds(5), $"Planning took {elapsed.Elapsed}.");
    }
}
