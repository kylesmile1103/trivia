using Trivia.Blueprint.Codegen.Migrations;
using Trivia.Blueprint.Codegen.Model;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

public sealed class RenameRewriterTests
{
    private const string Columns = """
        public partial class Rename : Migration
        {
            protected override void Up(MigrationBuilder migrationBuilder)
            {
                // Keep this comment and the unrelated operation byte-for-byte.
                migrationBuilder.DropColumn(name: "old_name", table: "customers");
                migrationBuilder.Sql("SELECT 1");
                migrationBuilder.AddColumn<string>(name: "full_name", table: "customers", type: "varchar(120)", nullable: false);
            }

            protected override void Down(MigrationBuilder migrationBuilder)
            {
                migrationBuilder.DropColumn(name: "full_name", table: "customers");
                migrationBuilder.AddColumn<string>(name: "old_name", table: "customers", type: "varchar(120)", nullable: false);
            }
        }
        """;

    // The bank's customers table as the previous EF snapshot records it.
    private static readonly string[] CustomerColumns =
        ["id", "full_name", "email", "status", "credit_limit", "notes", "created_at", "birth_date", "external_ref"];

    [Fact]
    public void FR_NC_12_RewritesMatchingColumnPairsInBothDirections()
    {
        ModelDocument model = WithColumnHint("fullName", "oldName");
        RenameResult result = RenameRewriter.Rewrite(Columns, model, Snapshot(("Customer", "customers", ["id", "old_name"])));
        Assert.Empty(result.Diagnostics);
        Assert.Equal(new MigrationRename("column", "Customer", "fullName", "oldName", "customers.old_name", "customers.full_name"),
            Assert.Single(result.Renames));
        Assert.Equal(new SettledMarker("Customer", "fullName", "oldName", "renamed"), Assert.Single(result.Settled));
        Assert.Contains("""migrationBuilder.RenameColumn(name: "old_name", table: "customers", newName: "full_name");""", result.Source);
        Assert.Contains("""migrationBuilder.RenameColumn(name: "full_name", table: "customers", newName: "old_name");""", result.Source);
        Assert.Contains("        // Keep this comment and the unrelated operation byte-for-byte.\n", result.Source);
        Assert.Contains("        migrationBuilder.Sql(\"SELECT 1\");\n", result.Source);
        Assert.DoesNotContain("DropColumn", result.Source);
        Assert.DoesNotContain("AddColumn", result.Source);
    }

    [Fact]
    public void RefusesARenameWhoseColumnWouldBeDroppedBecauseItsShapeChanges()
    {
        // This used to pass through untouched, leaving EF's drop of old_name and exit 0.
        ModelDocument model = WithColumnHint("fullName", "oldName");
        string changedType = Columns.Replace("""name: "old_name", table: "customers", type: "varchar(120)" """.TrimEnd(),
            """name: "old_name", table: "customers", type: "text" """.TrimEnd(), StringComparison.Ordinal);
        Assert.NotEqual(Columns, changedType);
        RenameResult result = RenameRewriter.Rewrite(changedType, model, Snapshot(("Customer", "customers", ["id", "old_name"])));
        Diagnostic diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal("rename_drops_data", diagnostic.Code);
        Assert.Equal("/entities/0/fields/0/renamedFrom", diagnostic.Pointer);
        Assert.Contains("Customer.fullName", diagnostic.Message);
        Assert.Contains("customers.old_name", diagnostic.Message);
        Assert.Empty(result.Renames);
        Assert.Equal(changedType, result.Source);

        Assert.Equal(Columns, RenameRewriter.Rewrite(Columns, ModelLoader.Load(FixtureTests.Bank).Model, PreviousModel.Empty).Source);
    }

    [Fact]
    public void CountsEfsOwnRenameColumnAsTheRename()
    {
        ModelDocument model = WithColumnHint("fullName", "displayName", rename: true);
        string migration = """
            public partial class Rename : Migration
            {
                protected override void Up(MigrationBuilder migrationBuilder)
                {
                    migrationBuilder.RenameColumn(
                        name: "full_name",
                        table: "customers",
                        newName: "display_name");
                }

                protected override void Down(MigrationBuilder migrationBuilder)
                {
                    migrationBuilder.RenameColumn(
                        name: "display_name",
                        table: "customers",
                        newName: "full_name");
                }
            }
            """;
        RenameResult result = RenameRewriter.Rewrite(migration, model, Snapshot(("Customer", "customers", CustomerColumns)));
        Assert.Empty(result.Diagnostics);
        Assert.Equal(migration, result.Source);
        Assert.Equal(new MigrationRename("column", "Customer", "displayName", "fullName", "customers.full_name", "customers.display_name"),
            Assert.Single(result.Renames));
        Assert.Equal("renamed", Assert.Single(result.Settled).Outcome);
    }

    [Fact]
    public void RefusesWhenEfRenamesTheOldColumnToAnotherField()
    {
        ModelDocument model = WithColumnHint("fullName", "displayName", rename: true);
        string migration = """
            public partial class Rename : Migration
            {
                protected override void Up(MigrationBuilder m)
                {
                    m.RenameColumn(name: "full_name", table: "customers", newName: "legal_name");
                    m.AddColumn<string>(name: "display_name", table: "customers", type: "varchar(120)", nullable: false, defaultValue: "");
                }

                protected override void Down(MigrationBuilder m)
                {
                    m.DropColumn(name: "display_name", table: "customers");
                    m.RenameColumn(name: "legal_name", table: "customers", newName: "full_name");
                }
            }
            """;
        RenameResult result = RenameRewriter.Rewrite(migration, model, Snapshot(("Customer", "customers", CustomerColumns)));
        Diagnostic diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal("rename_drops_data", diagnostic.Code);
        Assert.Contains("legal_name", diagnostic.Message);
        Assert.Empty(result.Renames);
    }

    [Fact]
    public void RefusesAStaleOriginWhenTheMigrationDropsAColumnOfTheSameTable()
    {
        // displayName <- name over a snapshot that holds full_name: the marker outlived its migration.
        ModelDocument model = WithColumnHint("fullName", "displayName", rename: true, origin: "name");
        string migration = """
            public partial class Rename : Migration
            {
                protected override void Up(MigrationBuilder m)
                {
                    m.DropColumn(name: "full_name", table: "customers");
                    m.AddColumn<string>(name: "display_name", table: "customers", type: "text", nullable: false, defaultValue: "");
                }

                protected override void Down(MigrationBuilder m)
                {
                    m.DropColumn(name: "display_name", table: "customers");
                    m.AddColumn<string>(name: "full_name", table: "customers", type: "varchar(120)", nullable: false, defaultValue: "");
                }
            }
            """;
        RenameResult result = RenameRewriter.Rewrite(migration, model, Snapshot(("Customer", "customers", CustomerColumns)));
        Diagnostic diagnostic = Assert.Single(result.Diagnostics);
        Assert.Equal("rename_marker_stale", diagnostic.Code);
        Assert.Contains("Customer.displayName", diagnostic.Message);
        Assert.Contains("customers.full_name", diagnostic.Message);
        Assert.Contains("clearRenameMarkers", diagnostic.Message);
    }

    [Fact]
    public void SettlesMarkersThatHaveNothingToRename()
    {
        ModelDocument model = WithColumnHint("fullName", "displayName", rename: true);
        model.Entities[1] = model.Entities[1] with { RenamedFrom = "Ledger" };
        const string empty = """
            public partial class Rename : Migration
            {
                protected override void Up(MigrationBuilder m) { }
                protected override void Down(MigrationBuilder m) { }
            }
            """;
        // The snapshot already has display_name, and no Ledger or Account entity.
        RenameResult result = RenameRewriter.Rewrite(empty, model,
            Snapshot(("Customer", "customers", ["id", "display_name"])));
        Assert.Empty(result.Diagnostics);
        Assert.Empty(result.Renames);
        Assert.Equal(
            [new SettledMarker("Account", null, "Ledger", "notInDatabase"), new SettledMarker("Customer", "displayName", "fullName", "alreadyApplied")],
            result.Settled.OrderBy(marker => marker.Entity, StringComparer.Ordinal));
        Assert.Equal(empty, result.Source);
    }

    [Fact]
    public void RefusesAMarkerWhoseOriginIsALivePeer()
    {
        const string empty = """
            public partial class Rename : Migration
            {
                protected override void Up(MigrationBuilder m) { }
                protected override void Down(MigrationBuilder m) { }
            }
            """;
        // A swap: fullName <- email and email <- fullName.
        ModelDocument swap = ModelLoader.Load(FixtureTests.Bank).Model;
        ModelField[] fields = swap.Entities[0].Fields;
        fields[0] = fields[0] with { RenamedFrom = "email" };
        fields[1] = fields[1] with { RenamedFrom = "fullName" };
        RenameResult swapped = RenameRewriter.Rewrite(empty, swap, Snapshot(("Customer", "customers", CustomerColumns)));
        Assert.Equal(["rename_conflict", "rename_conflict"], swapped.Diagnostics.Select(diagnostic => diagnostic.Code));
        Assert.Contains(swapped.Diagnostics, diagnostic => diagnostic.Message.Contains("Customer.fullName", StringComparison.Ordinal));

        // An entity renamed from a name another entity now uses.
        ModelDocument reused = ModelLoader.Load(FixtureTests.Bank).Model;
        reused.Entities[0] = reused.Entities[0] with { RenamedFrom = "Account" };
        Diagnostic diagnostic = Assert.Single(RenameRewriter.Rewrite(empty, reused, PreviousModel.Empty).Diagnostics);
        Assert.Equal("rename_conflict", diagnostic.Code);
        Assert.Equal("/entities/0/renamedFrom", diagnostic.Pointer);
    }

    [Fact]
    public void ReadsEachEntitysTableAndColumnsFromTheEfSnapshot()
    {
        PreviousModel previous = RenameRewriter.ReadSnapshot("""
            partial class AppDbContextModelSnapshot : ModelSnapshot
            {
                protected override void BuildModel(ModelBuilder modelBuilder)
                {
                    modelBuilder.Entity("BackOffice.Features.Account.Account", b =>
                        {
                            b.Property<int>("Id")
                                .ValueGeneratedOnAdd()
                                .HasColumnType("integer")
                                .HasColumnName("id");

                            NpgsqlPropertyBuilderExtensions.UseIdentityByDefaultColumn(b.Property<int>("Id"));

                            b.Property<Guid>("CustomerId")
                                .HasColumnType("uuid")
                                .HasColumnName("customer_id");

                            b.HasKey("Id");

                            b.ToTable("accounts", null, t =>
                                {
                                    t.HasCheckConstraint("ck_accounts_sequence_number_min", "\"sequence_number\" >= 1");
                                });
                        });

                    modelBuilder.Entity("BackOffice.Features.Account.Account", b =>
                        {
                            b.HasOne("BackOffice.Features.Customer.Customer", "Customer")
                                .WithMany("Accounts")
                                .HasForeignKey("CustomerId");
                        });
                }
            }
            """);
        SnapshotEntity account = Assert.Single(previous.Entities).Value;
        Assert.Equal("accounts", account.Table);
        Assert.Equal(["customer_id", "id"], account.Columns.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void RewritesATableRenameIntoEfsRenameOperations()
    {
        // EF's output for Customer -> Client (plural clients) with fullName -> displayName, trimmed to
        // the operations it emits. Down lists the columns alphabetically, Up in model order.
        string migration = """
            public partial class RenameClient : Migration
            {
                protected override void Up(MigrationBuilder migrationBuilder)
                {
                    migrationBuilder.DropForeignKey(
                        name: "FK_accounts_customers_customer_id",
                        table: "accounts");

                    migrationBuilder.DropTable(
                        name: "customers");

                    migrationBuilder.CreateTable(
                        name: "clients",
                        columns: table => new
                        {
                            id = table.Column<Guid>(type: "uuid", nullable: false),
                            display_name = table.Column<string>(type: "varchar(120)", maxLength: 120, nullable: false),
                            email = table.Column<string>(type: "text", nullable: false),
                            parent_id = table.Column<Guid>(type: "uuid", nullable: true)
                        },
                        constraints: table =>
                        {
                            table.PrimaryKey("PK_clients", x => x.id);
                            table.ForeignKey(
                                name: "FK_clients_clients_parent_id",
                                column: x => x.parent_id,
                                principalTable: "clients",
                                principalColumn: "id");
                            table.CheckConstraint("ck_clients_display_name_min", "char_length(\"display_name\") >= 2");
                        });

                    migrationBuilder.CreateIndex(
                        name: "IX_clients_display_name",
                        table: "clients",
                        column: "display_name");

                    migrationBuilder.CreateIndex(
                        name: "IX_clients_email",
                        table: "clients",
                        column: "email");

                    migrationBuilder.CreateIndex(
                        name: "IX_clients_parent_id",
                        table: "clients",
                        column: "parent_id");

                    migrationBuilder.AddForeignKey(
                        name: "FK_accounts_clients_customer_id",
                        table: "accounts",
                        column: "customer_id",
                        principalTable: "clients",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                }

                protected override void Down(MigrationBuilder migrationBuilder)
                {
                    migrationBuilder.DropForeignKey(
                        name: "FK_accounts_clients_customer_id",
                        table: "accounts");

                    migrationBuilder.DropTable(
                        name: "clients");

                    migrationBuilder.CreateTable(
                        name: "customers",
                        columns: table => new
                        {
                            id = table.Column<Guid>(type: "uuid", nullable: false),
                            email = table.Column<string>(type: "text", nullable: false),
                            full_name = table.Column<string>(type: "varchar(120)", maxLength: 120, nullable: false),
                            parent_id = table.Column<Guid>(type: "uuid", nullable: true)
                        },
                        constraints: table =>
                        {
                            table.PrimaryKey("PK_customers", x => x.id);
                            table.ForeignKey(
                                name: "FK_customers_customers_parent_id",
                                column: x => x.parent_id,
                                principalTable: "customers",
                                principalColumn: "id");
                            table.CheckConstraint("ck_customers_full_name_min", "char_length(\"full_name\") >= 2");
                        });

                    migrationBuilder.CreateIndex(
                        name: "IX_customers_email",
                        table: "customers",
                        column: "email",
                        unique: true);

                    migrationBuilder.CreateIndex(
                        name: "IX_customers_full_name",
                        table: "customers",
                        column: "full_name");

                    migrationBuilder.CreateIndex(
                        name: "IX_customers_parent_id",
                        table: "customers",
                        column: "parent_id");

                    migrationBuilder.AddForeignKey(
                        name: "FK_accounts_customers_customer_id",
                        table: "accounts",
                        column: "customer_id",
                        principalTable: "customers",
                        principalColumn: "id",
                        onDelete: ReferentialAction.Restrict);
                }
            }
            """;
        ModelDocument model = ClientModel();
        RenameResult result = RenameRewriter.Rewrite(migration, model,
            Snapshot(("Customer", "customers", ["id", "email", "full_name", "parent_id"])));
        Assert.Empty(result.Diagnostics);
        Assert.Equal(
            [
                new MigrationRename("table", "Client", null, "Customer", "customers", "clients"),
                new MigrationRename("column", "Client", "displayName", "fullName", "customers.full_name", "clients.display_name")
            ],
            result.Renames);

        string up = Method(result.Source, "Up");
        string down = Method(result.Source, "Down");
        Assert.DoesNotContain("DropTable", result.Source);
        Assert.DoesNotContain("CreateTable", result.Source);
        // The unique index on email became a plain one, so it is dropped and created, while the
        // other two are renamed (display_name through the column rename).
        AssertInOrder(up,
            "name: \"FK_accounts_customers_customer_id\",",
            """migrationBuilder.DropForeignKey(name: "FK_customers_customers_parent_id", table: "customers");""",
            """migrationBuilder.DropPrimaryKey(name: "PK_customers", table: "customers");""",
            """migrationBuilder.DropCheckConstraint(name: "ck_customers_full_name_min", table: "customers");""",
            """migrationBuilder.DropIndex(name: "IX_customers_email", table: "customers");""",
            """migrationBuilder.RenameTable(name: "customers", newName: "clients");""",
            """migrationBuilder.RenameColumn(name: "full_name", table: "clients", newName: "display_name");""",
            """migrationBuilder.AddPrimaryKey(name: "PK_clients", table: "clients", column: "id");""",
            """migrationBuilder.AddForeignKey(name: "FK_clients_clients_parent_id", table: "clients", column: "parent_id", principalTable: "clients", principalColumn: "id");""",
            """migrationBuilder.AddCheckConstraint(name: "ck_clients_display_name_min", table: "clients", sql: "char_length(\"display_name\") >= 2");""",
            """migrationBuilder.RenameIndex(name: "IX_customers_full_name", table: "clients", newName: "IX_clients_display_name");""",
            "name: \"IX_clients_email\",",
            """migrationBuilder.RenameIndex(name: "IX_customers_parent_id", table: "clients", newName: "IX_clients_parent_id");""",
            "name: \"FK_accounts_clients_customer_id\",");
        AssertInOrder(down,
            "name: \"FK_accounts_clients_customer_id\",",
            """migrationBuilder.DropForeignKey(name: "FK_clients_clients_parent_id", table: "clients");""",
            """migrationBuilder.DropPrimaryKey(name: "PK_clients", table: "clients");""",
            """migrationBuilder.DropCheckConstraint(name: "ck_clients_display_name_min", table: "clients");""",
            """migrationBuilder.DropIndex(name: "IX_clients_email", table: "clients");""",
            """migrationBuilder.RenameTable(name: "clients", newName: "customers");""",
            """migrationBuilder.RenameColumn(name: "display_name", table: "customers", newName: "full_name");""",
            """migrationBuilder.AddPrimaryKey(name: "PK_customers", table: "customers", column: "id");""",
            """migrationBuilder.AddForeignKey(name: "FK_customers_customers_parent_id", table: "customers", column: "parent_id", principalTable: "customers", principalColumn: "id");""",
            """migrationBuilder.AddCheckConstraint(name: "ck_customers_full_name_min", table: "customers", sql: "char_length(\"full_name\") >= 2");""",
            "name: \"IX_customers_email\",",
            """migrationBuilder.RenameIndex(name: "IX_clients_display_name", table: "customers", newName: "IX_customers_full_name");""",
            """migrationBuilder.RenameIndex(name: "IX_clients_parent_id", table: "customers", newName: "IX_customers_parent_id");""",
            "name: \"FK_accounts_customers_customer_id\",");
        Assert.DoesNotContain("        \n", result.Source);
        Assert.DoesNotContain("\n\n\n", result.Source);
    }

    [Fact]
    public void RefusesATableRenameThatAlsoChangesItsColumns()
    {
        string migration = """
            public partial class RenameClient : Migration
            {
                protected override void Up(MigrationBuilder m)
                {
                    m.DropTable(name: "customers");
                    m.CreateTable(name: "clients",
                        columns: table => new { id = table.Column<Guid>(type: "uuid", nullable: false), display_name = table.Column<string>(type: "text", nullable: false), email = table.Column<string>(type: "text", nullable: false), parent_id = table.Column<Guid>(type: "uuid", nullable: true) },
                        constraints: table => table.PrimaryKey("PK_clients", x => x.id));
                }

                protected override void Down(MigrationBuilder m)
                {
                    m.DropTable(name: "clients");
                    m.CreateTable(name: "customers",
                        columns: table => new { id = table.Column<Guid>(type: "uuid", nullable: false), email = table.Column<string>(type: "text", nullable: false), full_name = table.Column<string>(type: "varchar(120)", maxLength: 120, nullable: false), parent_id = table.Column<Guid>(type: "uuid", nullable: true) },
                        constraints: table => table.PrimaryKey("PK_customers", x => x.id));
                }
            }
            """;
        RenameResult result = RenameRewriter.Rewrite(migration, ClientModel(),
            Snapshot(("Customer", "customers", ["id", "email", "full_name", "parent_id"])));
        Assert.Equal(migration, result.Source);
        Assert.Empty(result.Renames);
        Diagnostic table = Assert.Single(result.Diagnostics, diagnostic => diagnostic.Pointer == "/entities/0/renamedFrom");
        Assert.Equal("rename_drops_data", table.Code);
        Assert.Contains("Client", table.Message);
        Assert.Contains("table customers", table.Message);
        Assert.Contains("display_name", table.Message);
    }

    [Fact]
    public void FindsTheOldPluralInTheEfSnapshotAndRewritesAnEquivalentTable()
    {
        ModelDocument model = ModelLoader.Load(FixtureTests.Bank).Model;
        model.Entities[0] = model.Entities[0] with { RenamedFrom = "Client" };
        PreviousModel previous = RenameRewriter.ReadSnapshot("""
            class AppDbContextModelSnapshot : ModelSnapshot
            {
                protected override void BuildModel(ModelBuilder modelBuilder)
                {
                    modelBuilder.Entity("BackOffice.Features.Client.Client", b =>
                    {
                        b.ToTable("old_people");
                    });
                }
            }
            """);
        string migration = """
            internal class Rename : Migration
            {
                protected override void Up(MigrationBuilder m)
                {
                    m.DropTable(name: "old_people");
                    m.CreateTable(name: "customers", columns: table => new { id = table.Column<int>(nullable: false) },
                        constraints: table => table.PrimaryKey("PK_shared", x => x.id));
                }

                protected override void Down(MigrationBuilder m)
                {
                    m.DropTable(name: "customers");
                    m.CreateTable(name: "old_people", columns: table => new { id = table.Column<int>(nullable: false) },
                        constraints: table => table.PrimaryKey("PK_shared", x => x.id));
                }
            }
            """;
        RenameResult result = RenameRewriter.Rewrite(migration, model, previous);
        Assert.Empty(result.Diagnostics);
        Assert.Equal(new MigrationRename("table", "Customer", null, "Client", "old_people", "customers"), Assert.Single(result.Renames));
        Assert.Contains("""m.RenameTable(name: "old_people", newName: "customers");""", result.Source);
        Assert.Contains("""m.RenameTable(name: "customers", newName: "old_people");""", result.Source);
        Assert.DoesNotContain("PrimaryKey", result.Source);
    }

    private static ModelDocument ClientModel()
    {
        ModelDocument model = ModelLoader.Load(FixtureTests.Bank).Model;
        ModelEntity customer = model.Entities[0];
        ModelField[] fields =
        [
            customer.Fields[0] with { Name = "displayName", RenamedFrom = "fullName" },
            customer.Fields[1],
            customer.Fields[0] with { Name = "parentId", Type = "uuid", MinLength = null, MaxLength = null, Required = null }
        ];
        model.Entities[0] = customer with { Name = "Client", Plural = "clients", RenamedFrom = "Customer", Fields = fields };
        return model;
    }

    private static ModelDocument WithColumnHint(string field, string from, bool rename = false, string? origin = null)
    {
        ModelDocument model = ModelLoader.Load(FixtureTests.Bank).Model;
        ModelField[] fields = model.Entities[0].Fields;
        int index = Array.FindIndex(fields, item => item.Name == field);
        fields[index] = rename
            ? fields[index] with { Name = from, RenamedFrom = origin ?? field }
            : fields[index] with { RenamedFrom = from };
        return model;
    }

    private static PreviousModel Snapshot(params (string Entity, string Table, string[] Columns)[] entities) =>
        new(entities.ToDictionary(entity => entity.Entity,
            entity => new SnapshotEntity(entity.Table, entity.Columns.ToHashSet(StringComparer.Ordinal)), StringComparer.Ordinal));

    private static string Method(string source, string name)
    {
        int start = source.IndexOf($"void {name}(", StringComparison.Ordinal);
        int next = source.IndexOf("protected override", start + 1, StringComparison.Ordinal);
        return next < 0 ? source[start..] : source[start..next];
    }

    private static void AssertInOrder(string text, params string[] fragments)
    {
        int at = 0;
        foreach (string fragment in fragments)
        {
            int found = text.IndexOf(fragment, at, StringComparison.Ordinal);
            Assert.True(found >= 0, $"Expected after offset {at}: {fragment}\n{text}");
            at = found + fragment.Length;
        }
    }
}
