using System.Text.Json;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Trivia.Blueprint.Codegen.Mapping;
using Trivia.Blueprint.Codegen.Model;
using static Trivia.Blueprint.Codegen.Emit.CSharp;

namespace Trivia.Blueprint.Codegen.Emit;

public static class DbContextEmitter
{
    public static CompilationUnitSyntax Emit(ModelDocument model)
    {
        string sets = string.Join("\n", model.Entities.Select(entity =>
            $"public DbSet<{Entity(model, entity.Name)}> {entity.Name}Set => Set<{Entity(model, entity.Name)}>();"));
        string configurations = string.Join("\n", model.Entities.Select(entity => Configure(model, entity)));
        return Unit($"{model.Namespace}.Data", ["System", "System.Text.Json", "Microsoft.EntityFrameworkCore"],
            $$"""
            public partial class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
            {
                {{sets}}

                protected override void OnModelCreating(ModelBuilder modelBuilder)
                {
                    base.OnModelCreating(modelBuilder);
                    {{configurations}}
                    OnModelCreatingPartial(modelBuilder);
                }

                partial void OnModelCreatingPartial(ModelBuilder modelBuilder);
            }
            """);
    }

    private static string Configure(ModelDocument model, ModelEntity entity)
    {
        List<string> statements = [];
        List<string> checks = [];
        string table = Snake(entity.Plural);
        string key = Member(entity, entity.Key.Name);
        string keyGeneration = entity.Key.Type == "uuid" ? "ValueGeneratedNever()" : "UseIdentityByDefaultColumn()";
        statements.Add($"entity.HasKey(row => row.{key});");
        statements.Add($"entity.Property(row => row.{key}).HasColumnName({Literal(Snake(entity.Key.Name))}).{keyGeneration};");

        foreach (ModelField field in entity.Fields)
        {
            string member = Member(entity, field.Name);
            string column = Snake(field.Name);
            string property = $"entity.Property(row => row.{member}).HasColumnName({Literal(column)}).HasColumnType({Literal(TypeMap.Postgres(field))})";
            if (field.Required == true)
                property += ".IsRequired()";
            if (field.MaxLength is int length)
                property += $".HasMaxLength({Number(length)})";
            if (field.Precision is int precision)
                property += $".HasPrecision({Number(precision)}, {Number(field.Scale!.Value)})";
            if (field.Type == "enum")
            {
                ModelEnum values = FindEnum(model, field.Enum!);
                string converter = Enum(model, field.Enum!) + "Values";
                string cast = field.Required == true ? "" : $"({Enum(model, field.Enum!)}?)";
                property += field.Required == true
                    ? $".HasConversion(value => {converter}.ToLiteral(value), value => {converter}.FromLiteral(value))"
                    : $".HasConversion(value => value.HasValue ? {converter}.ToLiteral(value.Value) : null, value => {cast}{converter}.FromLiteral(value))";
                AddCheck(column, "enum", $"\"{column}\" IN ({string.Join(", ", values.Values.Select(SqlString))})");
            }

            if (field.Default.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null))
            {
                property += field.Type == "json"
                    ? $".HasDefaultValueSql({Literal(SqlString(field.Default.GetRawText()) + "::jsonb")}).ValueGeneratedNever()"
                    : $".HasDefaultValue({DefaultValue(model, field)}).ValueGeneratedNever()";
            }
            else if (field.Generated == "onCreate" || field.Generated == "onUpdate" && field.Required == true)
                property += ".HasDefaultValueSql(\"CURRENT_TIMESTAMP\")";

            statements.Add(property + ";");
            if (field.Unique == true)
                statements.Add($"entity.HasIndex(row => row.{member}).IsUnique();");
            if (field.Minimum is decimal minimum)
                AddCheck(column, "min", $"\"{column}\" >= {Number(minimum)}");
            if (field.Maximum is decimal maximum)
                AddCheck(column, "max", $"\"{column}\" <= {Number(maximum)}");
        }

        foreach (ModelRelation relation in entity.Relations.Where(relation => relation.Kind == "belongsTo"))
        {
            ModelEntity target = FindEntity(model, relation.To);
            ModelRelation? inverse = target.Relations.FirstOrDefault(candidate => candidate.Kind == "hasMany" &&
                candidate.To == entity.Name && candidate.ForeignKey == relation.ForeignKey);
            string many = inverse is null ? "" : $"row => row.{Member(target, inverse.Name)}";
            string foreignKey = Member(entity, relation.ForeignKey);
            string behavior = relation.OnDelete switch { "cascade" => "Cascade", "setNull" => "SetNull", _ => "Restrict" };
            statements.Add($"entity.Property(row => row.{foreignKey}).HasColumnName({Literal(Snake(relation.ForeignKey))});");
            statements.Add($"entity.HasOne(row => row.{Member(entity, relation.Name)}).WithMany({many})" +
                $".HasForeignKey(row => row.{foreignKey}).OnDelete(DeleteBehavior.{behavior});");
        }

        foreach (ModelIndex index in entity.Indexes)
        {
            string[] members = index.Fields.Select(field => $"row.{Member(entity, field)}").ToArray();
            string expression = members.Length == 1 ? members[0] : $"new {{ {string.Join(", ", members)} }}";
            statements.Add($"entity.HasIndex(row => {expression}){(index.Unique == true ? ".IsUnique()" : "")};");
        }

        if (entity.Concurrency == true)
            statements.Add($"entity.Property(row => row.{Member(entity, "version")}).IsRowVersion();");

        string tableConfig = checks.Count == 0 ? "" : $", table => {{ {string.Join("\n", checks)} }}";
        return $"modelBuilder.Entity<{Entity(model, entity.Name)}>(entity => {{ " +
            $"entity.ToTable({Literal(table)}{tableConfig}); {string.Join("\n", statements)} }});";

        void AddCheck(string column, string suffix, string condition)
            => checks.Add($"table.HasCheckConstraint({Literal($"ck_{table}_{column}_{suffix}")}, {Literal(condition)});");
    }
}
