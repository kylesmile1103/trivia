using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Npgsql;
using Trivia.Blueprint.Codegen.Model;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests.Integration;

[Collection("PostgreSQL")]
[Trait("Category", "Integration")]
public sealed class ModelEdgeTests(PostgresFixture postgres)
{
    [Fact]
    public async Task FR_NC_04_NonIdentifierLiteralsAndSelfRelationsRoundTrip()
    {
        LoadedBlueprint reviews = ModelLoader.Load(Path.Combine(FixtureTests.ModelFixtures, "valid", "reviews"));
        using GeneratedProject project = new(reviews);
        await using RunningApi api = await postgres.StartAsync(project);

        const string parent = "00000000-0000-4000-8000-000000000001";
        const string child = "00000000-0000-4000-8000-000000000002";
        await using NpgsqlConnection connection = new(api.ConnectionString);
        await connection.OpenAsync();
        await using NpgsqlCommand insert = new("""
            INSERT INTO review_queues DEFAULT VALUES;
            INSERT INTO review_cases (id, stage, queue_id) VALUES (@parent, 'in-review', 1);
            INSERT INTO review_cases (id, stage, queue_id, parent_case_id) VALUES (@child, '1st-review', 1, @parent);
            """, connection);
        insert.Parameters.AddWithValue("parent", Guid.Parse(parent));
        insert.Parameters.AddWithValue("child", Guid.Parse(child));
        await insert.ExecuteNonQueryAsync();

        const string query = "/api/v1/review-cases?filter=stage:eq:1st-review";
        JsonElement data = await api.Client.GetFromJsonAsync<JsonElement>(query);
        JsonElement row = Assert.Single(data.GetProperty("items").EnumerateArray());
        Assert.Equal(child, row.GetProperty("id").GetString());
        Assert.Equal("1st-review", row.GetProperty("stage").GetString());
        Assert.Equal(parent, row.GetProperty("parentCaseId").GetString());

        using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(project.DocumentPath));
        Assert.Equal(new[] { "in-review", "approved", "1st-review" }, doc.RootElement.GetProperty("components")
            .GetProperty("schemas").GetProperty("ReviewStage").GetProperty("enum")
            .EnumerateArray().Select(value => value.GetString()));

        await using NpgsqlCommand delete = new("DELETE FROM review_cases WHERE id = @parent", connection);
        delete.Parameters.AddWithValue("parent", Guid.Parse(parent));
        await delete.ExecuteNonQueryAsync();
        JsonElement after = await api.Client.GetFromJsonAsync<JsonElement>(query);
        Assert.Equal(JsonValueKind.Null, after.GetProperty("items")[0].GetProperty("parentCaseId").ValueKind);
    }

    [Fact]
    public async Task FR_NC_05_DecimalScaleDoesNotSilentlyRoundInput()
    {
        using GeneratedProject project = new(ModelLoader.Load(FixtureTests.Bank));
        await using RunningApi api = await postgres.StartAsync(project);
        using HttpResponseMessage response = await api.Client.PostAsJsonAsync("/api/v1/customers",
            new { fullName = "Scale Example", email = "scale@example.test", creditLimit = 1.001m });
        JsonElement body = await CrudTests.ReadProblem(response, HttpStatusCode.BadRequest);
        Assert.True(body.GetProperty("errors").TryGetProperty("creditLimit", out _));
    }
}
