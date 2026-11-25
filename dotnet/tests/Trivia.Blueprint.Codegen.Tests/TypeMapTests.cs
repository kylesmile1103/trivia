using System.Text.Json;
using Trivia.Blueprint.Codegen.Mapping;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

public sealed class TypeMapTests
{
    [Fact]
    public void MatchesEveryCSharpAndPostgresEntryInTheSharedMapping()
    {
        using JsonDocument fixture = JsonDocument.Parse(File.ReadAllText(Path.Combine(FixtureTests.ModelFixtures, "model-mapping.json")));
        Assert.Equal(fixture.RootElement.EnumerateObject().Select(row => row.Name).Order(), TypeMap.Types.Keys.Order());
        foreach (JsonProperty row in fixture.RootElement.EnumerateObject())
        {
            MappedType type = TypeMap.Types[row.Name];
            Assert.Equal(row.Value.GetProperty("csharp").GetString(), type.CSharp);
            Assert.Equal(row.Value.GetProperty("postgres").GetString(), type.Postgres);
            Assert.Equal(row.Value.TryGetProperty("postgresWithoutMaxLength", out JsonElement alternative)
                ? alternative.GetString() : null, type.PostgresWithoutMaxLength);
        }
    }
}
