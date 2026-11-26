using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Trivia.Blueprint.Codegen.Model;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests.Integration;

[Collection("PostgreSQL")]
[Trait("Category", "Integration")]
public sealed class ConcurrencyTests(PostgresFixture postgres)
{
    [Fact]
    public async Task FR_NC_10_UpdatesUsePostgresXminAndRejectStaleVersions()
    {
        LoadedBlueprint bank = ModelLoader.Load(FixtureTests.Bank);
        ModelEntity[] entities = [.. bank.Model.Entities];
        entities[0] = entities[0] with { Concurrency = true };
        using GeneratedProject project = new(bank with { Model = bank.Model with { Entities = entities } });
        await using RunningApi api = await postgres.StartAsync(project);

        using HttpResponseMessage create = await api.Client.PostAsJsonAsync("/api/v1/customers",
            new { fullName = "Version One", email = "version@example.test" });
        Assert.Equal(HttpStatusCode.Created, create.StatusCode);
        JsonElement record = await create.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(record.TryGetProperty("version", out JsonElement token), record.ToString());
        uint version = token.GetUInt32();
        Uri location = Assert.IsType<Uri>(create.Headers.Location);

        using HttpResponseMessage missing = await api.Client.PutAsJsonAsync(location,
            new { fullName = "Version Two", email = "version@example.test" });
        Assert.True((await CrudTests.ReadProblem(missing, HttpStatusCode.BadRequest))
            .GetProperty("errors").TryGetProperty("version", out _));

        using HttpResponseMessage update = await api.Client.PutAsJsonAsync(location,
            new { fullName = "Version Two", email = "version@example.test", version });
        Assert.Equal(HttpStatusCode.OK, update.StatusCode);
        JsonElement current = await update.Content.ReadFromJsonAsync<JsonElement>();
        uint currentVersion = current.GetProperty("version").GetUInt32();
        Assert.NotEqual(version, currentVersion);

        using HttpResponseMessage stale = await api.Client.PutAsJsonAsync(location,
            new { fullName = "Stale Update", email = "version@example.test", version });
        Assert.Equal("stale", (await CrudTests.ReadProblem(stale, HttpStatusCode.Conflict)).GetProperty("code").GetString());
        JsonElement reloaded = await api.Client.GetFromJsonAsync<JsonElement>(location);
        Assert.Equal(currentVersion, reloaded.GetProperty("version").GetUInt32());
        Assert.Equal("Version Two", reloaded.GetProperty("fullName").GetString());

        using HttpResponseMessage patchWithout = await api.Client.PatchAsJsonAsync(location, new { notes = "No version" });
        Assert.True((await CrudTests.ReadProblem(patchWithout, HttpStatusCode.BadRequest))
            .GetProperty("errors").TryGetProperty("version", out _));
        using HttpResponseMessage stalePatch = await api.Client.PatchAsJsonAsync(location, new { notes = "Stale", version });
        Assert.Equal("stale", (await CrudTests.ReadProblem(stalePatch, HttpStatusCode.Conflict)).GetProperty("code").GetString());
        using HttpResponseMessage patched = await api.Client.PatchAsJsonAsync(location, new { notes = "Current", version = currentVersion });
        Assert.Equal(HttpStatusCode.OK, patched.StatusCode);
        JsonElement afterPatch = await patched.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("Current", afterPatch.GetProperty("notes").GetString());
        Assert.Equal("Version Two", afterPatch.GetProperty("fullName").GetString());
        Assert.NotEqual(currentVersion, afterPatch.GetProperty("version").GetUInt32());
    }
}
