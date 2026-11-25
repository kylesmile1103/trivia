using Npgsql;
using Testcontainers.PostgreSql;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests.Integration;

[CollectionDefinition("PostgreSQL")]
public sealed class PostgresCollection : ICollectionFixture<PostgresFixture>;

public sealed class PostgresFixture : IAsyncLifetime
{
    private readonly PostgreSqlContainer container = new PostgreSqlBuilder("postgres:17").Build();

    public Task InitializeAsync() => container.StartAsync();
    public Task DisposeAsync() => container.DisposeAsync().AsTask();

    internal async Task<RunningApi> StartAsync(GeneratedProject project, IReadOnlyDictionary<string, string>? settings = null)
    {
        string database = "test_" + Guid.NewGuid().ToString("N");
        await using NpgsqlConnection connection = new(container.GetConnectionString());
        await connection.OpenAsync();
        await using NpgsqlCommand command = new($"CREATE DATABASE {database}", connection);
        await command.ExecuteNonQueryAsync();

        string connectionString = new NpgsqlConnectionStringBuilder(container.GetConnectionString())
        {
            Database = database
        }.ConnectionString;
        return await RunningApi.StartAsync(project, connectionString, settings);
    }
}
