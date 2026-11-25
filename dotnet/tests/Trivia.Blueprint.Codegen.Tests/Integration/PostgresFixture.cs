using System.Net.Sockets;
using Npgsql;
using Testcontainers.PostgreSql;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests.Integration;

[CollectionDefinition("PostgreSQL")]
public sealed class PostgresCollection : ICollectionFixture<PostgresFixture>;

public sealed class PostgresFixture : IAsyncLifetime
{
    private readonly PostgreSqlContainer container = new PostgreSqlBuilder("postgres:17").Build();

    public async Task InitializeAsync()
    {
        await container.StartAsync();
        // A Docker VM can publish the host port after PostgreSQL is ready inside the container.
        using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(20));
        while (true)
        {
            try
            {
                await using NpgsqlConnection connection = new(container.GetConnectionString());
                await connection.OpenAsync(timeout.Token);
                return;
            }
            catch (NpgsqlException exception) when (exception.InnerException is SocketException && !timeout.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(200), timeout.Token);
            }
        }
    }
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
