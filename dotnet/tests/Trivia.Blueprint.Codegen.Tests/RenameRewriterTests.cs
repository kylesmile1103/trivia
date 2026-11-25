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

    [Fact]
    public void FR_NC_12_RewritesMatchingColumnPairsInBothDirections()
    {
        ModelDocument model = WithColumnHint();
        RenameResult result = RenameRewriter.Rewrite(Columns, model, new Dictionary<string, string>());
        Assert.Equal(new MigrationRename("column", "customers.old_name", "customers.full_name"), Assert.Single(result.Renames));
        Assert.Contains("""migrationBuilder.RenameColumn(name: "old_name", table: "customers", newName: "full_name");""", result.Source);
        Assert.Contains("""migrationBuilder.RenameColumn(name: "full_name", table: "customers", newName: "old_name");""", result.Source);
        Assert.Contains("        // Keep this comment and the unrelated operation byte-for-byte.\n", result.Source);
        Assert.Contains("        migrationBuilder.Sql(\"SELECT 1\");\n", result.Source);
        Assert.DoesNotContain("DropColumn", result.Source);
        Assert.DoesNotContain("AddColumn", result.Source);
    }

    [Fact]
    public void LeavesTypeChangesAndMissingHintsUntouched()
    {
        ModelDocument model = WithColumnHint();
        string changedType = Columns.Replace("""name: "old_name", table: "customers", type: "varchar(120)" """.TrimEnd(),
            """name: "old_name", table: "customers", type: "text" """.TrimEnd(), StringComparison.Ordinal);
        Assert.NotEqual(Columns, changedType);
        RenameResult result = RenameRewriter.Rewrite(changedType, model, new Dictionary<string, string>());
        Assert.Empty(result.Renames);
        Assert.Equal(changedType, result.Source);
        Assert.Equal(Columns, RenameRewriter.Rewrite(Columns, ModelLoader.Load(FixtureTests.Bank).Model,
            new Dictionary<string, string>()).Source);
    }

    [Fact]
    public void FindsTheOldPluralInTheEfSnapshotAndRewritesAnEquivalentTable()
    {
        ModelDocument model = ModelLoader.Load(FixtureTests.Bank).Model;
        model.Entities[0] = model.Entities[0] with { RenamedFrom = "Client" };
        IReadOnlyDictionary<string, string> tables = RenameRewriter.ReadTables("""
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
        RenameResult result = RenameRewriter.Rewrite(migration, model, tables);
        Assert.Equal(new MigrationRename("table", "old_people", "customers"), Assert.Single(result.Renames));
        Assert.Contains("""m.RenameTable(name: "old_people", newName: "customers");""", result.Source);
        Assert.Contains("""m.RenameTable(name: "customers", newName: "old_people");""", result.Source);
    }

    private static ModelDocument WithColumnHint()
    {
        ModelDocument model = ModelLoader.Load(FixtureTests.Bank).Model;
        ModelField[] fields = model.Entities[0].Fields;
        fields[0] = fields[0] with { RenamedFrom = "oldName" };
        return model;
    }
}
