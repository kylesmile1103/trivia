using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

/// <summary>
/// FR-NC-12 and FR-DM-08 against the real EF CLI: every <c>renamedFrom</c> marker is renamed, already applied or not in
/// the database, and anything else exits 1 and leaves the migrations directory as it was (LLD-09 section 6).
/// </summary>
[Trait("Category", "Build")]
public sealed class RenameMigrationTests
{
    [Fact]
    public async Task FR_NC_12_ReportsEfsOwnColumnRenameAsTheMarkersRename()
    {
        // Renamed twice before migrating (A -> B -> C): the marker keeps A, the column the database has.
        using MigrationScenario scenario = await MigrationScenario.CreateAsync();
        scenario.RenameField("Customer", "notes", "memo");
        scenario.RenameField("Customer", "memo", "remarks");
        Assert.Equal("notes", (string?)scenario.Field("Customer", "remarks")["renamedFrom"]);
        (int status, JsonElement result, string output) = await scenario.MigrateAsync("RenameNotes");
        Assert.True(status == 0, output);
        string migration = scenario.MigrationSource(result);
        Assert.Matches(Operation("RenameColumn", "notes", "customers", "remarks"), migration);
        Assert.DoesNotContain("DropColumn", migration);
        AssertRename(Assert.Single(result.GetProperty("renames").EnumerateArray()),
            "column", "Customer", "remarks", "notes", "customers.notes", "customers.remarks");
        AssertSettled(result, ("Customer", "remarks", "notes", "renamed"));
        Assert.StartsWith("sha256:", result.GetProperty("modelRev").GetString());
    }

    [Fact]
    public async Task FR_NC_12_RefusesARenameWithAShapeChangeAndRestoresTheSnapshotForTheNextRun()
    {
        using MigrationScenario scenario = await MigrationScenario.CreateAsync();
        SortedDictionary<string, byte[]> before = scenario.MigrationFiles();
        scenario.RenameField("Customer", "fullName", "displayName");
        scenario.Field("Customer", "displayName")["maxLength"] = 200;
        (int status, JsonElement result, string output) = await scenario.MigrateAsync("RenameAndWiden");
        Assert.True(status == 1, output);
        JsonElement diagnostic = Assert.Single(result.GetProperty("diagnostics").EnumerateArray());
        Assert.Equal("rename_drops_data", diagnostic.GetProperty("code").GetString());
        Assert.Equal("/entities/0/fields/0/renamedFrom", diagnostic.GetProperty("pointer").GetString());
        Assert.Contains("Customer.displayName", diagnostic.GetProperty("message").GetString());
        Assert.Contains("customers.full_name", diagnostic.GetProperty("message").GetString());
        AssertSameFiles(before, scenario.MigrationFiles());

        // With the snapshot restored, the fixed model migrates the whole change.
        scenario.Field("Customer", "displayName")["maxLength"] = 120;
        (status, result, output) = await scenario.MigrateAsync("RenameAndWiden");
        Assert.True(status == 0, output);
        Assert.Matches(Operation("RenameColumn", "full_name", "customers", "display_name"), scenario.MigrationSource(result));
        AssertSettled(result, ("Customer", "displayName", "fullName", "renamed"));
    }

    [Fact]
    public async Task FR_DM_08_SettlesAFieldAndAnEntityRenamedBeforeTheirFirstMigrationThenRenamesThem()
    {
        using MigrationScenario scenario = await MigrationScenario.CreateAsync();
        scenario.AddField("Customer", new JsonObject { ["name"] = "nickname", ["type"] = "string", ["maxLength"] = 40 });
        scenario.RenameField("Customer", "nickname", "alias");
        scenario.AddEntity("Branch", "branches");
        scenario.RenameEntity("Branch", "Office", "offices");
        (int status, JsonElement result, string output) = await scenario.MigrateAsync("AddAliasAndOffice");
        Assert.True(status == 0, output);
        Assert.Empty(result.GetProperty("renames").EnumerateArray());
        AssertSettled(result, ("Customer", "alias", "nickname", "notInDatabase"), ("Office", null, "Branch", "notInDatabase"));

        scenario.ClearMarkers();
        scenario.RenameField("Customer", "alias", "handle");
        scenario.RenameEntity("Office", "Site", "sites");
        (status, result, output) = await scenario.MigrateAsync("RenameAliasAndOffice");
        Assert.True(status == 0, output);
        string migration = scenario.MigrationSource(result);
        Assert.DoesNotContain("DropTable", migration);
        Assert.DoesNotContain("CreateTable", migration);
        Assert.DoesNotContain("DropColumn", migration);
        Assert.Contains("""RenameTable(name: "offices", newName: "sites");""", migration);
        Assert.Contains("""RenameIndex(name: "IX_offices_title", table: "sites", newName: "IX_sites_title");""", migration);
        AssertSettled(result, ("Customer", "handle", "alias", "renamed"), ("Site", null, "Office", "renamed"));
    }

    [Fact]
    public async Task FR_DM_08_RefusesAMarkerLeftFromAnEarlierMigrationAndLeavesTheFilesByteIdentical()
    {
        using MigrationScenario scenario = await MigrationScenario.CreateAsync();
        scenario.RenameField("Customer", "fullName", "displayName");
        (int status, JsonElement result, string output) = await scenario.MigrateAsync("First");
        Assert.True(status == 0, output);

        // The clear was skipped, so the marker still names fullName after the next rename.
        SortedDictionary<string, byte[]> before = scenario.MigrationFiles();
        scenario.RenameField("Customer", "displayName", "legalName");
        Assert.Equal("fullName", (string?)scenario.Field("Customer", "legalName")["renamedFrom"]);
        scenario.Field("Customer", "legalName")["maxLength"] = 200;
        (status, result, output) = await scenario.MigrateAsync("Second");
        Assert.True(status == 1, output);
        JsonElement diagnostic = Assert.Single(result.GetProperty("diagnostics").EnumerateArray());
        Assert.Equal("rename_marker_stale", diagnostic.GetProperty("code").GetString());
        Assert.Contains("Customer.legalName", diagnostic.GetProperty("message").GetString());
        Assert.Contains("customers.display_name", diagnostic.GetProperty("message").GetString());
        AssertSameFiles(before, scenario.MigrationFiles());
    }

    [Fact]
    public async Task FR_DM_08_RefusesANewFieldsMarkerBesideARemovalUntilTheMarkerIsCleared()
    {
        using MigrationScenario scenario = await MigrationScenario.CreateAsync();
        SortedDictionary<string, byte[]> before = scenario.MigrationFiles();
        scenario.AddField("Customer", new JsonObject { ["name"] = "nickname", ["type"] = "string", ["maxLength"] = 40 });
        scenario.RenameField("Customer", "nickname", "alias");
        scenario.RemoveField("Customer", "notes");
        (int status, JsonElement result, string output) = await scenario.MigrateAsync("AliasWithoutNotes");
        Assert.True(status == 1, output);
        JsonElement diagnostic = Assert.Single(result.GetProperty("diagnostics").EnumerateArray());
        Assert.Equal("rename_marker_stale", diagnostic.GetProperty("code").GetString());
        string message = diagnostic.GetProperty("message").GetString()!;
        Assert.Contains("customers.notes", message);
        Assert.Contains("clearRenameMarkers", message);
        Assert.Contains("migrate the removal separately", message);
        AssertSameFiles(before, scenario.MigrationFiles());

        scenario.ClearMarkers();
        (status, result, output) = await scenario.MigrateAsync("AliasWithoutNotes");
        Assert.True(status == 0, output);
        string migration = scenario.MigrationSource(result);
        Assert.Matches(Operation("DropColumn", "notes", "customers", null), migration);
        Assert.Contains("name: \"alias\"", migration);
        Assert.Empty(result.GetProperty("settled").EnumerateArray());
    }

    [Fact]
    public async Task FR_NC_12_RenamesTablesWithTheirKeysIndexesAndConstraintsAndAFieldInOneMigration()
    {
        using MigrationScenario scenario = await MigrationScenario.CreateAsync();
        scenario.RenameEntity("Customer", "Client", "clients");
        scenario.RenameField("Client", "fullName", "displayName");
        scenario.RenameEntity("Account", "Ledger", "ledgers");
        (int status, JsonElement result, string output) = await scenario.MigrateAsync("RenameClient");
        Assert.True(status == 0, output);
        JsonElement[] renames = result.GetProperty("renames").EnumerateArray().ToArray();
        Assert.Equal(3, renames.Length);
        AssertRename(renames.Single(rename => rename.GetProperty("entity").GetString() == "Client" && !rename.TryGetProperty("field", out _)),
            "table", "Client", null, "Customer", "customers", "clients");
        AssertRename(renames.Single(rename => rename.TryGetProperty("field", out _)),
            "column", "Client", "displayName", "fullName", "customers.full_name", "clients.display_name");
        AssertRename(renames.Single(rename => rename.GetProperty("entity").GetString() == "Ledger"),
            "table", "Ledger", null, "Account", "accounts", "ledgers");

        string migration = scenario.MigrationSource(result);
        Assert.DoesNotContain("DropTable", migration);
        Assert.DoesNotContain("CreateTable", migration);
        foreach (string expected in new[]
        {
            """RenameTable(name: "customers", newName: "clients");""",
            """RenameColumn(name: "full_name", table: "clients", newName: "display_name");""",
            """RenameTable(name: "accounts", newName: "ledgers");""",
            """DropPrimaryKey(name: "PK_customers", table: "customers");""",
            """AddPrimaryKey(name: "PK_clients", table: "clients", column: "id");""",
            """RenameIndex(name: "IX_customers_email", table: "clients", newName: "IX_clients_email");""",
            """RenameIndex(name: "IX_customers_status", table: "clients", newName: "IX_clients_status");""",
            """RenameIndex(name: "IX_accounts_customer_id_account_number", table: "ledgers", newName: "IX_ledgers_customer_id_account_number");""",
            """DropCheckConstraint(name: "ck_customers_status_enum", table: "customers");""",
            """AddCheckConstraint(name: "ck_clients_status_enum", table: "clients", sql: "\"status\" IN (E'pending', E'active', E'suspended')");""",
            """DropForeignKey(name: "FK_accounts_customers_customer_id", table: "accounts");""",
            """AddForeignKey(name: "FK_ledgers_clients_customer_id", table: "ledgers", column: "customer_id", principalTable: "clients", principalColumn: "id", onDelete: ReferentialAction.Restrict);""",
            """RenameTable(name: "clients", newName: "customers");""",
            """RenameColumn(name: "display_name", table: "customers", newName: "full_name");""",
        })
            Assert.Contains(expected, migration);
        AssertSettled(result, ("Client", null, "Customer", "renamed"), ("Client", "displayName", "fullName", "renamed"),
            ("Ledger", null, "Account", "renamed"));

        // The rewritten migration compiles: the next run builds the project with warnings as errors.
        scenario.ClearMarkers();
        (status, _, output) = await scenario.MigrateAsync("Empty");
        Assert.True(status == 0, output);
    }

    [Fact]
    public async Task FR_DM_08_RefusesASwapAndAnOriginThatANewFieldReuses()
    {
        using MigrationScenario swap = await MigrationScenario.CreateAsync();
        SortedDictionary<string, byte[]> before = swap.MigrationFiles();
        swap.RenameField("Customer", "fullName", "swapping");
        swap.RenameField("Customer", "email", "fullName");
        swap.RenameField("Customer", "swapping", "email");
        (int status, JsonElement result, string output) = await swap.MigrateAsync("Swap");
        Assert.True(status == 1, output);
        Assert.Equal(["rename_conflict", "rename_conflict"],
            result.GetProperty("diagnostics").EnumerateArray().Select(item => item.GetProperty("code").GetString()));
        AssertSameFiles(before, swap.MigrationFiles());

        using MigrationScenario reuse = await MigrationScenario.CreateAsync();
        reuse.RenameField("Customer", "notes", "remarks");
        reuse.AddField("Customer", new JsonObject { ["name"] = "notes", ["type"] = "text" });
        (status, result, output) = await reuse.MigrateAsync("Reuse");
        Assert.True(status == 1, output);
        JsonElement diagnostic = Assert.Single(result.GetProperty("diagnostics").EnumerateArray());
        Assert.Equal("rename_conflict", diagnostic.GetProperty("code").GetString());
        Assert.Contains("Customer.remarks", diagnostic.GetProperty("message").GetString());
    }

    [Fact]
    public async Task FR_NC_12_RefusesWhenEfRenamesTheOldColumnToAnotherField()
    {
        // Two new columns have the old column's shape. EF's MigrationsModelDiffer.DiffCollection scans the
        // candidates in reverse over columns sorted by name, so it pairs notes with summary, not remarks.
        using MigrationScenario scenario = await MigrationScenario.CreateAsync();
        SortedDictionary<string, byte[]> before = scenario.MigrationFiles();
        scenario.RenameField("Customer", "notes", "remarks");
        scenario.AddField("Customer", new JsonObject { ["name"] = "summary", ["type"] = "text", ["maxLength"] = 1000 });
        (int status, JsonElement result, string output) = await scenario.MigrateAsync("Summary");
        Assert.True(status == 1, output);
        JsonElement diagnostic = Assert.Single(result.GetProperty("diagnostics").EnumerateArray());
        Assert.Equal("rename_drops_data", diagnostic.GetProperty("code").GetString());
        Assert.Contains("renames to summary", diagnostic.GetProperty("message").GetString());
        AssertSameFiles(before, scenario.MigrationFiles());
    }

    internal static Regex Operation(string method, string name, string table, string? newName) => new(
        $@"\.{method}\(\s*name: ""{Regex.Escape(name)}"",\s*table: ""{Regex.Escape(table)}""" +
        (newName is null ? @"\)" : $@",\s*newName: ""{Regex.Escape(newName)}""\)"));

    internal static void AssertSameFiles(SortedDictionary<string, byte[]> expected, SortedDictionary<string, byte[]> actual)
    {
        Assert.Equal(expected.Keys, actual.Keys);
        foreach ((string file, byte[] bytes) in expected)
            Assert.True(bytes.AsSpan().SequenceEqual(actual[file]), file + " changed.");
    }

    private static void AssertRename(JsonElement rename, string kind, string entity, string? field, string from, string oldName, string newName)
    {
        Assert.Equal(kind, rename.GetProperty("kind").GetString());
        Assert.Equal(entity, rename.GetProperty("entity").GetString());
        Assert.Equal(field, rename.TryGetProperty("field", out JsonElement value) ? value.GetString() : null);
        Assert.Equal(from, rename.GetProperty("from").GetString());
        Assert.Equal(oldName, rename.GetProperty("oldName").GetString());
        Assert.Equal(newName, rename.GetProperty("newName").GetString());
    }

    private static void AssertSettled(JsonElement result, params (string Entity, string? Field, string From, string Outcome)[] expected)
    {
        (string, string?, string, string)[] actual = result.GetProperty("settled").EnumerateArray().Select(marker => (
            marker.GetProperty("entity").GetString()!,
            marker.TryGetProperty("field", out JsonElement field) ? field.GetString() : null,
            marker.GetProperty("from").GetString()!,
            marker.GetProperty("outcome").GetString()!)).ToArray();
        Assert.Equal(expected.OrderBy(item => item.ToString(), StringComparer.Ordinal),
            actual.OrderBy(item => item.ToString(), StringComparer.Ordinal));
    }
}
