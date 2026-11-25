using Trivia.Blueprint.Codegen.Model;
using Trivia.Blueprint.Codegen.Tests.Integration;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

/// <summary>The bank API built once for the startup tests, which need no database.</summary>
public sealed class BankApiBuild : IDisposable
{
    internal GeneratedProject Project { get; } = new(ModelLoader.Load(FixtureTests.Bank));

    public void Dispose() => Project.Dispose();
}

[Trait("Category", "Build")]
public sealed class StartupTests(BankApiBuild build) : IClassFixture<BankApiBuild>
{
    private static readonly Dictionary<string, string> Development = new() { ["ASPNETCORE_ENVIRONMENT"] = "Development" };

    [Fact]
    public async Task NFR_05_OnlyDevelopmentFallsBackToALocalDatabase()
    {
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            await using RunningApi started = await RunningApi.StartAsync(build.Project, connectionString: null);
        });
        Assert.Contains("ConnectionStrings:AppDb", failure.Message);
        Assert.DoesNotContain("Now listening on:", failure.Message);

        await using RunningApi development = await RunningApi.StartAsync(build.Project, connectionString: null, Development);
        Assert.Equal("Healthy", await development.Client.GetStringAsync("/health"));
    }
}
