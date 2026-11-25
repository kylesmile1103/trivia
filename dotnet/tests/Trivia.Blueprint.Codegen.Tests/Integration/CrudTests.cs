using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Npgsql;
using Trivia.Blueprint.Codegen.Model;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests.Integration;

[Collection("PostgreSQL")]
[Trait("Category", "Integration")]
public sealed class CrudTests(PostgresFixture postgres)
{
    private const string Customers = "/api/v1/customers";

    [Fact]
    public async Task FR_NC_06_FR_NC_10_CRUDAndProblemDetailsAgainstPostgres()
    {
        using GeneratedProject project = new(ModelLoader.Load(FixtureTests.Bank));
        await using RunningApi api = await postgres.StartAsync(project);
        HttpClient client = api.Client;

        using HttpResponseMessage invalid = await client.PostAsJsonAsync(Customers,
            new { fullName = "A", email = "invalid", creditLimit = -1 });
        JsonElement validation = await ReadProblem(invalid, HttpStatusCode.BadRequest);
        JsonElement errors = validation.GetProperty("errors");
        Assert.True(errors.TryGetProperty("fullName", out _), errors.ToString());
        Assert.True(errors.TryGetProperty("email", out _), errors.ToString());
        Assert.True(errors.TryGetProperty("creditLimit", out _), errors.ToString());

        using HttpResponseMessage invalidEnum = await client.PostAsJsonAsync(Customers,
            new { fullName = "Ann Example", email = "ann@example.test", status = "PENDING" });
        Assert.True((await ReadProblem(invalidEnum, HttpStatusCode.BadRequest)).GetProperty("errors").TryGetProperty("status", out _));

        using HttpResponseMessage created = await client.PostAsJsonAsync(Customers,
            new { fullName = "Ann Example", email = "ann@example.test", birthDate = "1999-02-03" });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        JsonElement customer = await created.Content.ReadFromJsonAsync<JsonElement>();
        Guid id = customer.GetProperty("id").GetGuid();
        Assert.Equal(7, id.Version);
        string location = Customers + "/" + id;
        Assert.Equal(location, created.Headers.Location?.OriginalString);
        Assert.Equal("Ann Example", customer.GetProperty("fullName").GetString());
        Assert.Equal("pending", customer.GetProperty("status").GetString());
        Assert.Equal(0, customer.GetProperty("creditLimit").GetDecimal());
        Assert.Equal("1999-02-03", customer.GetProperty("birthDate").GetString());
        Assert.True(customer.GetProperty("createdAt").GetDateTimeOffset() > DateTimeOffset.UnixEpoch);

        using HttpResponseMessage loaded = await client.GetAsync(location);
        Assert.Equal(HttpStatusCode.OK, loaded.StatusCode);
        Assert.True(JsonElement.DeepEquals(customer, await loaded.Content.ReadFromJsonAsync<JsonElement>()));

        using HttpResponseMessage duplicate = await client.PostAsJsonAsync(Customers,
            new { fullName = "Another Name", email = "ann@example.test" });
        Assert.Equal("unique", (await ReadProblem(duplicate, HttpStatusCode.Conflict)).GetProperty("code").GetString());

        using HttpResponseMessage updated = await client.PutAsJsonAsync(location,
            new { fullName = "Ann Updated", email = "ann-new@example.test", status = "active", creditLimit = 42.50m });
        Assert.Equal(HttpStatusCode.OK, updated.StatusCode);
        JsonElement body = await updated.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(id, body.GetProperty("id").GetGuid());
        Assert.Equal("active", body.GetProperty("status").GetString());
        Assert.Equal("Ann Updated", body.GetProperty("fullName").GetString());
        Assert.Equal(42.50m, body.GetProperty("creditLimit").GetDecimal());

        await using NpgsqlConnection connection = new(api.ConnectionString);
        await connection.OpenAsync();
        await using NpgsqlCommand insert = new(
            "INSERT INTO accounts (account_number, frozen, customer_id) VALUES ('0123456789', false, @id) RETURNING id", connection);
        insert.Parameters.AddWithValue("id", id);
        int account = Assert.IsType<int>(await insert.ExecuteScalarAsync());
        JsonElement accountRecord = await client.GetFromJsonAsync<JsonElement>($"/api/v1/accounts/{account}");
        Assert.Equal(id, accountRecord.GetProperty("customerId").GetGuid());
        Assert.False(accountRecord.TryGetProperty("customer", out _));

        using HttpResponseMessage blocked = await client.DeleteAsync(location);
        Assert.Equal("in_use", (await ReadProblem(blocked, HttpStatusCode.Conflict)).GetProperty("code").GetString());
        await using NpgsqlCommand remove = new("DELETE FROM accounts", connection);
        Assert.Equal(1, await remove.ExecuteNonQueryAsync());

        using HttpResponseMessage deleted = await client.DeleteAsync(location);
        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);
        Assert.Equal("", await deleted.Content.ReadAsStringAsync());
        using HttpResponseMessage missing = await client.GetAsync(location);
        await ReadProblem(missing, HttpStatusCode.NotFound);
        using HttpResponseMessage missingUpdate = await client.PutAsJsonAsync(location,
            new { fullName = "Ann Updated", email = "ann-new@example.test" });
        await ReadProblem(missingUpdate, HttpStatusCode.NotFound);
        using HttpResponseMessage missingDelete = await client.DeleteAsync(location);
        await ReadProblem(missingDelete, HttpStatusCode.NotFound);
    }

    internal static async Task<JsonElement> ReadProblem(HttpResponseMessage response, HttpStatusCode expected)
    {
        string raw = await response.Content.ReadAsStringAsync();
        Assert.True(response.StatusCode == expected, $"Expected {expected}, got {response.StatusCode}: {raw}");
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        Assert.DoesNotContain("stackTrace", raw, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("INSERT INTO", raw, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("PostgresException", raw, StringComparison.OrdinalIgnoreCase);
        JsonElement body = JsonSerializer.Deserialize<JsonElement>(raw);
        Assert.Equal((int)expected, body.GetProperty("status").GetInt32());
        return body;
    }
}
