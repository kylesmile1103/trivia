using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Testing;
using Trivia.Blueprint.Codegen.Model;
using Xunit;
using Xunit.Abstractions;

namespace Trivia.Blueprint.Codegen.Tests.Integration;

[Trait("Category", "Integration")]
public sealed class AppHostTests(ITestOutputHelper output)
{
    private const string Customers = "/api/v1/customers";

    [Fact]
    public async Task FR_AS_01_And_FR_AS_02_StartsTheGeneratedGraphAndServesCrud()
    {
        using TempDirectory blueprint = new();
        ModelDocument model = ModelLoader.Load(FixtureTests.Bank).Model;
        ModelEntity[] entities = model.Entities.Select(entity => entity.Name == "Customer"
            ? entity with { Api = entity.Api with { Filterable = [.. entity.Api.Filterable!, "creditLimit", "birthDate"] } }
            : entity).ToArray();
        File.WriteAllText(Path.Combine(blueprint.Path, ModelLoader.ModelFile),
            JsonSerializer.Serialize(model with { Entities = entities }, ModelLoader.Json));
        using GeneratedProject project = await GeneratedProject.WriteAsync(blueprint.Path);
        using StringWriter migration = new();
        int status = await Program.RunAsync(
            ["migrate", "Initial", "--blueprint", blueprint.Path, "--root", project.Root], migration, TextWriter.Null);
        Assert.True(status == 0, migration.ToString());
        await project.BuildAsync();

        using CancellationTokenSource timeout = new(TimeSpan.FromMinutes(3));
        CancellationToken token = timeout.Token;
        string assembly = Path.Combine(project.Root, "src", "BackOffice.AppHost", "bin", "Debug", "net10.0",
            "BackOffice.AppHost.dll");
        Type entry = Assembly.LoadFrom(assembly).EntryPoint!.DeclaringType!;
        IDistributedApplicationTestingBuilder builder = await DistributedApplicationTestingBuilder.CreateAsync(
            entry, ["--Trivia:StartWeb=false", "--Trivia:UseDataVolume=false"], token);
        Assert.DoesNotContain(builder.Resources, resource => resource.Name == "web");

        await using DistributedApplication app = await builder.BuildAsync(token);
        await app.StartAsync(token);
        await app.ResourceNotifications.WaitForResourceHealthyAsync("api", WaitBehavior.StopOnResourceUnavailable, token);
        using HttpClient client = app.CreateHttpClient("api");
        Assert.Equal("Healthy", await client.GetStringAsync("/health", token));

        using HttpResponseMessage created = await client.PostAsJsonAsync(Customers,
            new { fullName = "Aspire Customer", email = "aspire@example.test" }, token);
        string content = await created.Content.ReadAsStringAsync(token);
        Assert.True(created.StatusCode == HttpStatusCode.Created, content);
        Uri location = Assert.IsType<Uri>(created.Headers.Location);
        JsonElement item = await client.GetFromJsonAsync<JsonElement>(location, token);
        Assert.Equal("Aspire Customer", item.GetProperty("fullName").GetString());
        JsonElement list = await client.GetFromJsonAsync<JsonElement>(Customers, token);
        Assert.Equal(1, list.GetProperty("total").GetInt32());

        using HttpResponseMessage updated = await client.PutAsJsonAsync(location,
            new { fullName = "Updated Customer", email = "aspire@example.test" }, token);
        Assert.Equal(HttpStatusCode.OK, updated.StatusCode);
        using HttpResponseMessage deleted = await client.DeleteAsync(location, token);
        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);
        using HttpResponseMessage missing = await client.GetAsync(location, token);
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        output.WriteLine("API became healthy after the migration and completed CRUD.");
        await FR_AS_06_RunDataProvider(client.BaseAddress!, token);
    }

    private static async Task FR_AS_06_RunDataProvider(Uri baseAddress, CancellationToken token)
    {
        string directory = Path.Combine(AppContext.BaseDirectory, "Provider");
        using Process node = GeneratedProject.Start("node", directory,
            ["--experimental-strip-types", "data-provider.mjs", baseAddress.AbsoluteUri]);
        Task<string> stdout = node.StandardOutput.ReadToEndAsync();
        Task<string> stderr = node.StandardError.ReadToEndAsync();
        try
        {
            await node.WaitForExitAsync(token);
        }
        catch (OperationCanceledException)
        {
            if (!node.HasExited)
                node.Kill(entireProcessTree: true);
            throw;
        }
        string text = await stdout + await stderr;
        Assert.True(node.ExitCode == 0, text);
    }
}
