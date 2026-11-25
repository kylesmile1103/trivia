using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

public sealed class FixtureTests
{
    public static string ModelFixtures => Path.Combine(AppContext.BaseDirectory, "Fixtures");
    public static string Bank => Path.Combine(ModelFixtures, "valid", "bank");

    [Fact]
    public void BuildCopiesTheModelFixtures()
    {
        Assert.Contains("CustomerStatus", File.ReadAllText(Path.Combine(Bank, "model.blueprint.json")));
        Assert.Contains("timestamptz", File.ReadAllText(Path.Combine(ModelFixtures, "model-mapping.json")));
    }
}
