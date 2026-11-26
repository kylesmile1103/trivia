using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Npgsql;
using Trivia.Blueprint.Codegen.Model;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests.Integration;

[Collection("PostgreSQL")]
[Trait("Category", "Integration")]
public sealed class ListTests(PostgresFixture postgres)
{
    private const string Customers = "/api/v1/customers";
    private const string Accounts = "/api/v1/accounts";
    private const string Transactions = "/api/v1/transactions";

    [Fact]
    public async Task FR_NC_07_PagesSortsFiltersAndSearchesUsingTypedColumns()
    {
        LoadedBlueprint bank = ModelLoader.Load(FixtureTests.Bank);
        ModelEntity[] entities = bank.Model.Entities.Select(entity => entity with
        {
            Api = entity.Api with
            {
                Filterable = [entity.Key.Name, .. entity.Fields.Where(field => field.Type != "json").Select(field => field.Name),
                    .. entity.Relations.Where(relation => relation.Kind == "belongsTo").Select(relation => relation.ForeignKey)]
            }
        }).ToArray();
        using GeneratedProject project = new(bank with { Model = bank.Model with { Entities = entities } });
        await using RunningApi api = await postgres.StartAsync(project);
        await Seed(api.ConnectionString);
        HttpClient client = api.Client;
        JsonElement page = await client.GetFromJsonAsync<JsonElement>(Customers + "?page=2&pageSize=20");
        Assert.Equal(45, page.GetProperty("total").GetInt32());
        Assert.Equal(2, page.GetProperty("page").GetInt32());
        Assert.Equal(20, page.GetProperty("pageSize").GetInt32());
        Assert.Equal(20, page.GetProperty("items").GetArrayLength());
        Assert.EndsWith("000000000021", page.GetProperty("items")[0].GetProperty("id").GetString());

        JsonElement sorted = await client.GetFromJsonAsync<JsonElement>(
            Customers + "?sort=fullName,-createdAt&filter=fullName:eq:Shared");
        Assert.Equal(new[] { "000000000004", "000000000003" },
            sorted.GetProperty("items").EnumerateArray().Select(row => row.GetProperty("id").GetString()![^12..]));
        Assert.Equal(2, await Count(Customers + "?q=ann"));
        Assert.Equal(1, await Count(Customers + "?q=%25"));

        (string Path, string Filter, int Total)[] cases =
        [
            (Customers, "fullName:eq:Shared", 2),
            (Customers, "fullName:ne:Shared", 43),
            (Customers, "notes:contains:0:00", 1),
            // Refine's contains and startswith ignore case (containss and startswiths do not),
            // and a wildcard character in the value matches only itself.
            (Customers, "fullName:startswith:Ann", 2),
            (Customers, "fullName:startswith:ann", 2),
            (Customers, "fullName:contains:sHARED", 2),
            (Customers, "notes:contains:APPOINTMENT", 1),
            (Customers, "fullName:contains:%", 1),
            (Customers, "fullName:startswith:_", 0),
            (Customers, "fullName:in:Shared,Ann %", 3),
            (Customers, "notes:null:true", 44),
            (Customers, "notes:null:false", 1),
            (Customers, "creditLimit:lt:3", 2),
            (Customers, "creditLimit:lte:3", 3),
            (Customers, "creditLimit:gt:43", 2),
            (Customers, "creditLimit:gte:43", 3),
            (Customers, "birthDate:eq:2000-01-02", 1),
            (Customers, "birthDate:gt:2000-02-13", 2),
            (Customers, "createdAt:eq:2000-01-02T01:00:00+01:00", 1),
            (Customers, "status:in:active,pending", 45),
            (Customers, "id:eq:00000000-0000-4000-8000-000000000003", 1),
            (Accounts, "frozen:eq:true", 1),
            (Accounts, "sequenceNumber:in:1,3", 2),
            (Accounts, "id:gte:2", 2),
            (Accounts, "customerId:eq:00000000-0000-4000-8000-000000000003", 1),
            (Transactions, "ledgerSequence:gt:9007199254740992", 2),
            (Transactions, "reviewerId:null:true", 3)
        ];
        foreach ((string path, string filter, int total) in cases)
            Assert.Equal(total, await Count(path + "?filter=" + Uri.EscapeDataString(filter)));

        Assert.Equal(2, await Count(Customers + "?filter=creditLimit:gte:2&filter=creditLimit:lt:4"));
        Assert.Equal(0, (await client.GetFromJsonAsync<JsonElement>(Customers + "?page=2147483647"))
            .GetProperty("items").GetArrayLength());

        (string Query, string Field)[] invalid =
        [
            ("page=0", "page"), ("page=bad", "page"), ("pageSize=0", "pageSize"),
            ("pageSize=201", "pageSize"), ("sort=email", "sort"), ("sort=-", "sort"),
            ("filter=missing:eq:test", "filter"), ("filter=fullName", "filter"),
            ("filter=fullName:bad:test", "filter"), ("filter=creditLimit:contains:1", "filter"),
            ("filter=creditLimit:eq:invalid", "filter"), ("filter=creditLimit:in:1,", "filter"),
            ("filter=notes:null:maybe", "filter"), ("filter=fullName:null:false", "filter"),
            ("filter=status:eq:ACTIVE", "filter")
        ];
        foreach ((string query, string field) in invalid)
        {
            using HttpResponseMessage response = await client.GetAsync(Customers + "?" + query);
            JsonElement problem = await CrudTests.ReadProblem(response, HttpStatusCode.BadRequest);
            Assert.True(problem.GetProperty("errors").TryGetProperty(field, out _), problem.ToString());
        }

        async Task<int> Count(string path) => (await client.GetFromJsonAsync<JsonElement>(path)).GetProperty("total").GetInt32();
    }

    private static async Task Seed(string connectionString)
    {
        await using NpgsqlConnection connection = new(connectionString);
        await connection.OpenAsync();
        await using NpgsqlCommand command = new("""
            INSERT INTO customers (id, full_name, email, status, credit_limit, notes, birth_date, created_at)
            SELECT ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
              CASE WHEN i = 1 THEN 'Ann %' WHEN i = 2 THEN 'ann lower' WHEN i IN (3, 4) THEN 'Shared' ELSE 'Person ' || i END,
              i || '@example.test', CASE WHEN i % 2 = 0 THEN 'active' ELSE 'pending' END,
              i, CASE WHEN i = 1 THEN '10:00 appointment' END, DATE '2000-01-01' + i, TIMESTAMPTZ '2000-01-01 00:00:00Z' + i * INTERVAL '1 day'
            FROM generate_series(1, 45) i;
            INSERT INTO accounts (account_number, sequence_number, frozen, customer_id)
            SELECT lpad(i::text, 10, '0'), i, i = 3, ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid
            FROM generate_series(1, 3) i;
            INSERT INTO transactions (account_id, ledger_sequence, details)
            SELECT i, 9007199254740991 + i, '{"source":"test"}'::jsonb FROM generate_series(1, 3) i;
            """, connection);
        await command.ExecuteNonQueryAsync();
    }
}
