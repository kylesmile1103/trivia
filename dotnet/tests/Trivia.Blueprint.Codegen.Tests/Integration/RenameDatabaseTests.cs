using System.Text.Json;
using Npgsql;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests.Integration;

/// <summary>
/// FR-NC-12 and FR-DM-08 on PostgreSQL: the migrations `migrate` writes for renamed tables and columns keep the rows,
/// in both directions, and a second rename after the markers are cleared keeps them again.
/// </summary>
[Collection("PostgreSQL")]
[Trait("Category", "Integration")]
public sealed class RenameDatabaseTests(PostgresFixture postgres)
{
    private static readonly Guid CustomerId = Guid.Parse("01938a6e-0000-7000-8000-000000000001");

    [Fact]
    public async Task FR_NC_12_TableAndColumnRenamesKeepTheRowsUpAndDown()
    {
        using MigrationScenario scenario = await MigrationScenario.CreateAsync();
        string database = await postgres.CreateDatabaseAsync();
        await DotnetAsync(scenario, ["build", MigrationScenario.ApiProject + "/BackOffice.Api.csproj", "--nologo", "--disable-build-servers"], database);
        await UpdateAsync(scenario, database);
        await ExecuteAsync(database, $"""
            INSERT INTO customers (id, full_name, email, status) VALUES ('{CustomerId}', 'Ada Lovelace', 'ada@example.test', 'active');
            INSERT INTO accounts (account_number, customer_id) VALUES ('0000000001', '{CustomerId}');
            """);

        scenario.RenameEntity("Customer", "Client", "clients");
        scenario.RenameField("Client", "fullName", "displayName");
        scenario.RenameEntity("Account", "Ledger", "ledgers");
        (int status, JsonElement result, string output) = await scenario.MigrateAsync("RenameClient");
        Assert.True(status == 0, output);
        Assert.Equal(3, result.GetProperty("renames").GetArrayLength());
        await UpdateAsync(scenario, database);

        Assert.Equal("Ada Lovelace", await ScalarAsync(database, $"SELECT display_name FROM clients WHERE id = '{CustomerId}'"));
        Assert.Equal("0000000001", await ScalarAsync(database, $"SELECT account_number FROM ledgers WHERE customer_id = '{CustomerId}'"));
        Assert.Equal(0L, await ScalarAsync(database, "SELECT count(*) FROM pg_tables WHERE tablename IN ('customers', 'accounts')"));
        foreach (string constraint in new[] { "PK_clients", "PK_ledgers", "ck_clients_status_enum", "FK_ledgers_clients_customer_id",
            "FK_transactions_clients_reviewer_id", "FK_transactions_ledgers_account_id" })
            Assert.Equal(1L, await ScalarAsync(database, $"SELECT count(*) FROM pg_constraint WHERE conname = '{constraint}'"));
        foreach (string index in new[] { "IX_clients_email", "IX_clients_status", "IX_ledgers_customer_id_account_number" })
            Assert.Equal(1L, await ScalarAsync(database, $"SELECT count(*) FROM pg_indexes WHERE indexname = '{index}'"));
        // The renamed constraints still hold: the status check and the unique email index.
        await Assert.ThrowsAsync<PostgresException>(() => ExecuteAsync(database,
            $"UPDATE clients SET status = 'unknown' WHERE id = '{CustomerId}'"));
        await Assert.ThrowsAsync<PostgresException>(() => ExecuteAsync(database,
            "INSERT INTO clients (id, display_name, email, status) VALUES (gen_random_uuid(), 'Copy', 'ada@example.test', 'active')"));

        // The markers are cleared after a successful migrate, so the next rename starts from displayName.
        scenario.ClearMarkers();
        scenario.RenameField("Client", "displayName", "legalName");
        (status, result, output) = await scenario.MigrateAsync("RenameLegalName");
        Assert.True(status == 0, output);
        await UpdateAsync(scenario, database);
        Assert.Equal("Ada Lovelace", await ScalarAsync(database, $"SELECT legal_name FROM clients WHERE id = '{CustomerId}'"));

        // Down takes both migrations back without losing the row.
        await UpdateAsync(scenario, database, Initial(scenario));
        Assert.Equal("Ada Lovelace", await ScalarAsync(database, $"SELECT full_name FROM customers WHERE id = '{CustomerId}'"));
        Assert.Equal("0000000001", await ScalarAsync(database, $"SELECT account_number FROM accounts WHERE customer_id = '{CustomerId}'"));
        Assert.Equal(1L, await ScalarAsync(database, "SELECT count(*) FROM pg_constraint WHERE conname = 'PK_customers'"));
    }

    private static string Initial(MigrationScenario scenario) =>
        Path.GetFileNameWithoutExtension(Directory.EnumerateFiles(scenario.MigrationsDirectory, "*_Initial.cs").Single());

    // `dotnet ef database update` applies migrations as the generated migration service does at start.
    private static async Task UpdateAsync(MigrationScenario scenario, string connectionString, string? target = null)
    {
        string project = MigrationScenario.ApiProject + "/BackOffice.Api.csproj";
        await DotnetAsync(scenario, ["tool", "run", "dotnet-ef", "--", "database", "update", .. target is null ? Array.Empty<string>() : [target],
            "--project", project, "--startup-project", project, "--context", "AppDbContext", "--no-color"], connectionString);
    }

    private static async Task DotnetAsync(MigrationScenario scenario, string[] arguments, string connectionString)
    {
        using System.Diagnostics.Process process = GeneratedProject.Start("dotnet", scenario.Root, arguments, new Dictionary<string, string>
        {
            ["ConnectionStrings__AppDb"] = connectionString,
            ["MSBUILDDISABLENODEREUSE"] = "1",
            ["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1"
        });
        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        using CancellationTokenSource timeout = new(TimeSpan.FromMinutes(3));
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            process.Kill(entireProcessTree: true);
            throw;
        }
        string output = await stdout + await stderr;
        Assert.True(process.ExitCode == 0, output);
    }

    private static async Task ExecuteAsync(string connectionString, string sql)
    {
        await using NpgsqlConnection connection = new(connectionString);
        await connection.OpenAsync();
        await using NpgsqlCommand command = new(sql, connection);
        await command.ExecuteNonQueryAsync();
    }

    private static async Task<object?> ScalarAsync(string connectionString, string sql)
    {
        await using NpgsqlConnection connection = new(connectionString);
        await connection.OpenAsync();
        await using NpgsqlCommand command = new(sql, connection);
        return await command.ExecuteScalarAsync();
    }
}
