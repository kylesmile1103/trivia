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

    [Fact]
    public async Task NFR_05_WithoutAuthenticationTheDocumentIsServedOnlyInDevelopment()
    {
        // Nothing here touches the database; the setting only has to be present outside Development.
        const string unused = "Host=127.0.0.1;Port=1;Database=unused;Username=unused";
        Dictionary<string, string> noDatabase = new() { ["TRIVIA_TEST_CREATE_DB"] = "0" };
        await using (RunningApi production = await RunningApi.StartAsync(build.Project, unused, noDatabase))
        {
            using HttpResponseMessage hidden = await production.Client.GetAsync("/openapi/v1.json");
            Assert.Equal(System.Net.HttpStatusCode.NotFound, hidden.StatusCode);
        }

        await using RunningApi development = await RunningApi.StartAsync(build.Project, unused,
            new Dictionary<string, string>(noDatabase) { ["ASPNETCORE_ENVIRONMENT"] = "Development" });
        using HttpResponseMessage served = await development.Client.GetAsync("/openapi/v1.json");
        Assert.Equal(System.Net.HttpStatusCode.OK, served.StatusCode);
        Assert.Contains("\"patchCustomer\"", await served.Content.ReadAsStringAsync());
        Assert.True(File.Exists(build.Project.DocumentPath), "The build-time document must not depend on the environment.");
    }
}
