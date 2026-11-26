using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using Trivia.Blueprint.Codegen.Model;
using static Trivia.Blueprint.Codegen.Emit.CSharp;
using Diagnostic = Trivia.Blueprint.Codegen.Model.Diagnostic;

namespace Trivia.Blueprint.Codegen.Migrations;

/// <summary>A RenameTable or RenameColumn in the final migration that carries out a <c>renamedFrom</c> marker.</summary>
public sealed record MigrationRename(string Kind, string Entity, string? Field, string From, string OldName, string NewName);

/// <summary>
/// A marker the migration accounted for: <c>renamed</c>, <c>alreadyApplied</c> (the previous snapshot has the
/// current name and not the old one) or <c>notInDatabase</c> (it has neither).
/// </summary>
public sealed record SettledMarker(string Entity, string? Field, string From, string Outcome);

public sealed record RenameResult(string Source, IReadOnlyList<MigrationRename> Renames,
    IReadOnlyList<SettledMarker> Settled, IReadOnlyList<Diagnostic> Diagnostics);

/// <summary>An entity's table and columns in EF's model snapshot before the new migration.</summary>
public sealed record SnapshotEntity(string Table, IReadOnlySet<string> Columns);

public sealed record PreviousModel(IReadOnlyDictionary<string, SnapshotEntity> Entities)
{
    public static PreviousModel Empty { get; } = new(new Dictionary<string, SnapshotEntity>(StringComparer.Ordinal));
}

/// <summary>
/// Accounts for every <c>renamedFrom</c> marker against the previous EF snapshot (LLD-09 section 6). Each marker is
/// renamed in the migration, already applied, or not in the database. Anything else is a diagnostic, and the caller
/// discards the migration: a declared rename never becomes a drop.
/// </summary>
public static class RenameRewriter
{
    private const string ModelDoc = ModelLoader.ModelFile;

    public static PreviousModel ReadSnapshot(string snapshot)
    {
        CompilationUnitSyntax root = SyntaxFactory.ParseCompilationUnit(snapshot);
        Dictionary<string, string> tables = new(StringComparer.Ordinal);
        Dictionary<string, Dictionary<string, string?>> properties = new(StringComparer.Ordinal);
        foreach (InvocationExpressionSyntax entity in root.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            if (entity.Expression is not MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Entity" } ||
                entity.ArgumentList.Arguments.Count != 2 ||
                StringValue(entity.ArgumentList.Arguments[0].Expression) is not string name ||
                entity.ArgumentList.Arguments[1].Expression is not LambdaExpressionSyntax lambda)
                continue;
            string[] names = name.Split('.');
            if (names.Length < 3 || names[^1] != names[^2] || names[^3] != "Features")
                continue;

            InvocationExpressionSyntax[] calls = lambda.Body.DescendantNodes().OfType<InvocationExpressionSyntax>().ToArray();
            string[] mapped = calls
                .Where(call => call.Expression is MemberAccessExpressionSyntax { Name.Identifier.ValueText: "ToTable" } &&
                    call.ArgumentList.Arguments.Count >= 1)
                .Select(call => StringValue(call.ArgumentList.Arguments[0].Expression))
                .OfType<string>()
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            if (mapped.Length == 1)
                tables.TryAdd(names[^1], mapped[0]);

            Dictionary<string, string?> columns = properties.TryGetValue(names[^1], out Dictionary<string, string?>? known)
                ? known : properties[names[^1]] = new(StringComparer.Ordinal);
            foreach (InvocationExpressionSyntax property in calls.Where(call =>
                call.Expression is MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Property" } &&
                call.ArgumentList.Arguments.Count == 1))
            {
                if (StringValue(property.ArgumentList.Arguments[0].Expression) is not string propertyName)
                    continue;
                string? column = ColumnName(property);
                if (!columns.TryGetValue(propertyName, out string? existing) || existing is null)
                    columns[propertyName] = column;
            }
        }
        return new(tables.ToDictionary(pair => pair.Key, pair => new SnapshotEntity(pair.Value,
            (properties.GetValueOrDefault(pair.Key) ?? []).Select(property => property.Value ?? property.Key)
                .ToHashSet(StringComparer.Ordinal)), StringComparer.Ordinal));

        // The column a property chain names with HasColumnName, if any.
        static string? ColumnName(InvocationExpressionSyntax property)
        {
            SyntaxNode node = property;
            while (node.Parent is MemberAccessExpressionSyntax access && access.Parent is InvocationExpressionSyntax call)
            {
                if (access.Name.Identifier.ValueText == "HasColumnName" && call.ArgumentList.Arguments.Count == 1)
                    return StringValue(call.ArgumentList.Arguments[0].Expression);
                node = call;
            }
            return null;
        }
    }

    public static RenameResult Rewrite(string source, ModelDocument model, PreviousModel previous)
    {
        CompilationUnitSyntax root = SyntaxFactory.ParseCompilationUnit(source);
        if (root.ContainsDiagnostics)
            throw new IOException("The new migration is not valid C#.");
        Marker[] markers = Markers(model).ToArray();
        if (markers.Length == 0)
            return new(source, [], [], []);

        List<Diagnostic> diagnostics = [];
        HashSet<Marker> conflicted = [];
        foreach (Marker marker in markers)
            if (Conflict(model, marker) is string conflict)
            {
                conflicted.Add(marker);
                diagnostics.Add(new("rename_conflict", ModelDoc, marker.Pointer, conflict));
            }

        Rewriter rewriter = new(root, source);
        Dictionary<int, string> tableFailures = [];
        Dictionary<(int, int), string> columnFailures = [];
        foreach (ModelEntity entity in model.Entities)
        {
            int index = Array.IndexOf(model.Entities, entity);
            Resolution resolved = Resolve(entity, previous);
            if (resolved.Previous is not SnapshotEntity snapshot)
                continue;
            (int Index, string Old, string New)[] columns = entity.Fields
                .Select((field, at) => (Field: field, At: at))
                .Where(item => item.Field.RenamedFrom is string from && !conflicted.Contains(new(index, item.At, from, "")) &&
                    Snake(from) != Snake(item.Field.Name) && snapshot.Columns.Contains(Snake(from)))
                .Select(item => (item.At, Snake(item.Field.RenamedFrom!), Snake(item.Field.Name)))
                .ToArray();
            string table = Snake(entity.Plural);
            if (snapshot.Table != table)
            {
                if (entity.RenamedFrom is not null && resolved.Old && !conflicted.Any(marker => marker.Entity == index && marker.Field is null) &&
                    rewriter.Table(snapshot.Table, table, columns.Select(column => (column.Old, column.New)).ToArray()) is string failure)
                    tableFailures[index] = failure;
                continue;
            }
            foreach ((int field, string from, string to) in columns)
                if (rewriter.Column(table, from, to) is string failure)
                    columnFailures[(index, field)] = failure;
        }

        string result = rewriter.Apply();
        CompilationUnitSyntax final = SyntaxFactory.ParseCompilationUnit(result);
        if (final.ContainsDiagnostics)
            throw new IOException("The rewritten migration is not valid C#.");
        Operation[] up = Operations(final, "Up");
        Operation[] down = Operations(final, "Down");

        List<MigrationRename> renames = [];
        List<SettledMarker> settled = [];
        foreach (Marker marker in markers.Where(marker => !conflicted.Contains(marker)))
        {
            ModelEntity entity = model.Entities[marker.Entity];
            Resolution resolved = Resolve(entity, previous);
            string table = Snake(entity.Plural);
            if (marker.Field is int fieldIndex)
            {
                ModelField field = entity.Fields[fieldIndex];
                (string? outcome, string? failure) = Column(entity, field, resolved.Previous, table, up, down,
                    tableFailures.GetValueOrDefault(marker.Entity) ?? columnFailures.GetValueOrDefault((marker.Entity, fieldIndex)));
                Record(marker, field.Name, outcome, failure, $"{resolved.Previous?.Table}.{Snake(marker.From)}", $"{table}.{Snake(field.Name)}");
            }
            else
            {
                (string? outcome, string? failure) = Table(entity, resolved, table, up, down, tableFailures.GetValueOrDefault(marker.Entity));
                Record(marker, null, outcome, failure, resolved.Previous?.Table ?? "", table);
            }
        }

        return diagnostics.Count > 0
            ? new(source, [], [], diagnostics)
            : new(result, renames, settled, []);

        void Record(Marker marker, string? field, string? outcome, string? failure, string oldName, string newName)
        {
            ModelEntity entity = model.Entities[marker.Entity];
            if (failure is not null)
            {
                diagnostics.Add(new(outcome == "stale" ? "rename_marker_stale" : "rename_drops_data", ModelDoc, marker.Pointer, failure));
                return;
            }
            settled.Add(new(entity.Name, field, marker.From, outcome!));
            if (outcome == "renamed")
                renames.Add(new(field is null ? "table" : "column", entity.Name, field, marker.From, oldName, newName));
        }
    }

    private sealed record Marker(int Entity, int? Field, string From, string Pointer)
    {
        public bool Equals(Marker? other) => other is not null && other.Entity == Entity && other.Field == Field;
        public override int GetHashCode() => HashCode.Combine(Entity, Field);
    }

    private sealed record Resolution(SnapshotEntity? Previous, bool Old, bool Current);

    private static IEnumerable<Marker> Markers(ModelDocument model)
    {
        for (int entity = 0; entity < model.Entities.Length; entity++)
        {
            if (model.Entities[entity].RenamedFrom is string from)
                yield return new(entity, null, from, $"/entities/{entity}/renamedFrom");
            ModelField[] fields = model.Entities[entity].Fields;
            for (int field = 0; field < fields.Length; field++)
                if (fields[field].RenamedFrom is string origin)
                    yield return new(entity, field, origin, $"/entities/{entity}/fields/{field}/renamedFrom");
        }
    }

    // The entity's table in the previous snapshot, through its own marker when it has one.
    private static Resolution Resolve(ModelEntity entity, PreviousModel previous)
    {
        SnapshotEntity? old = entity.RenamedFrom is string from ? previous.Entities.GetValueOrDefault(from) : null;
        SnapshotEntity? current = previous.Entities.GetValueOrDefault(entity.Name);
        return new(old ?? current, old is not null, current is not null);
    }

    // Rule B: an origin that another live item now uses cannot be told apart from a swap.
    private static string? Conflict(ModelDocument model, Marker marker)
    {
        ModelEntity entity = model.Entities[marker.Entity];
        if (marker.Field is not int index)
        {
            ModelEntity? peer = model.Entities.FirstOrDefault(other => other != entity &&
                string.Equals(other.Name, marker.From, StringComparison.OrdinalIgnoreCase));
            return peer is null ? null :
                $"{entity.Name} is marked as renamed from {marker.From}, but the model still has an entity named {peer.Name}. " +
                "Migrate one rename at a time: undo this rename, migrate the first one, then reuse the name.";
        }
        ModelField field = entity.Fields[index];
        string column = Snake(marker.From);
        string? other = entity.Fields.Where(item => item != field).Select(item => item.Name)
            .Append(entity.Key.Name)
            .Concat(entity.Relations.Where(relation => relation.Kind == "belongsTo").Select(relation => relation.ForeignKey))
            .FirstOrDefault(name => string.Equals(name, marker.From, StringComparison.OrdinalIgnoreCase) || Snake(name) == column);
        return other is null ? null :
            $"{entity.Name}.{field.Name} is marked as renamed from {marker.From}, but {entity.Name} still has {other}, " +
            "so the migration cannot tell which data belongs where. Migrate one rename at a time: undo this rename, " +
            "migrate the first one, then reuse the name.";
    }

    private static (string? Outcome, string? Failure) Table(ModelEntity entity, Resolution resolved, string table,
        Operation[] up, Operation[] down, string? reason)
    {
        string label = $"{entity.Name} is marked as renamed from {entity.RenamedFrom}";
        if (resolved.Old)
        {
            string old = resolved.Previous!.Table;
            if (old == table && !up.Any(operation => operation.Is("DropTable") && operation.Value("name") == old))
                return ("alreadyApplied", null);
            if (Renamed(up, "RenameTable", null, old, table) && Renamed(down, "RenameTable", null, table, old))
                return ("renamed", null);
            return (null, $"{label}, but the migration {Removal(up, "Table", null, old, table)} table {old} instead of renaming it" +
                (reason is null ? "." : $": {reason}.") +
                " Migrate the rename on its own first, then make the other changes in a later migration.");
        }
        if (resolved.Current)
            return ("alreadyApplied", null);
        string[] dropped = up.Where(operation => operation.Is("DropTable")).Select(operation => operation.Value("name")).OfType<string>().ToArray();
        if (up.Any(operation => operation.Is("CreateTable") && operation.Value("name") == table) && dropped.Length > 0)
            return ("stale", $"{label}, but the previous migration has no {entity.RenamedFrom} or {entity.Name}, and this " +
                $"migration creates table {table} while dropping table {string.Join(", ", dropped)}. If {entity.Name} is new, " +
                "clear its marker with the guarded clearRenameMarkers op and migrate again; if it should keep the data of a " +
                "dropped table, clear the marker and rename it from the entity that table belongs to; otherwise migrate the " +
                "removal separately.");
        return ("notInDatabase", null);
    }

    private static (string? Outcome, string? Failure) Column(ModelEntity entity, ModelField field, SnapshotEntity? previous,
        string table, Operation[] up, Operation[] down, string? reason)
    {
        string label = $"{entity.Name}.{field.Name} is marked as renamed from {field.RenamedFrom}";
        string from = Snake(field.RenamedFrom!);
        string to = Snake(field.Name);
        if (previous is null)
            return ("notInDatabase", null);
        if (previous.Columns.Contains(from) && from != to)
        {
            string[] tables = [previous.Table, table];
            if (Renamed(up, "RenameColumn", tables, from, to) && Renamed(down, "RenameColumn", tables, to, from))
                return ("renamed", null);
            return (null, $"{label}, but the migration {Removal(up, "Column", tables, from, to)} column {previous.Table}.{from} " +
                "instead of renaming it" + (reason is null ? "." : $": {reason}.") +
                " Rename the field in one migration and make the other changes in the next.");
        }
        if (previous.Columns.Contains(to))
            return ("alreadyApplied", null);
        string[] dropped = up.Where(operation => operation.Is("DropColumn") && operation.Value("table") == table)
            .Select(operation => $"{table}.{operation.Value("name")}").ToArray();
        if (up.Any(operation => operation.Is("AddColumn") && operation.Value("table") == table && operation.Value("name") == to) &&
            dropped.Length > 0)
            return ("stale", $"{label}, but the previous migration has no column {from} or {to} on {table}, and this migration " +
                $"adds {to} while dropping {string.Join(", ", dropped)}. If {field.Name} is new, clear its marker with the guarded " +
                "clearRenameMarkers op and migrate again; if it should keep the data of a dropped column, clear the marker and " +
                "rename it from the field that column belongs to; otherwise migrate the removal separately.");
        return ("notInDatabase", null);
    }

    private static bool Renamed(Operation[] operations, string method, string[]? tables, string from, string to) =>
        operations.Any(operation => operation.Is(method) && operation.Value("name") == from && operation.Value("newName") == to &&
            (tables is null ? operation.Value("table") is null : tables.Contains(operation.Value("table"))) && !operation.Has("schema"));

    private static string Removal(Operation[] up, string kind, string[]? tables, string from, string to)
    {
        Operation? renamed = up.FirstOrDefault(operation => operation.Is("Rename" + kind) && operation.Value("name") == from &&
            (tables is null || tables.Contains(operation.Value("table"))));
        if (renamed?.Value("newName") is string elsewhere && elsewhere != to)
            return $"renames to {elsewhere}";
        return up.Any(operation => operation.Is("Drop" + kind) && operation.Value("name") == from &&
            (tables is null || tables.Contains(operation.Value("table")))) ? "drops" : "does not rename";
    }

    private static Operation[] Operations(CompilationUnitSyntax tree, string member)
    {
        MethodDeclarationSyntax? method = tree.DescendantNodes().OfType<MethodDeclarationSyntax>()
            .FirstOrDefault(method => method.Identifier.ValueText == member &&
                method.Modifiers.Any(SyntaxKind.OverrideKeyword) && method.ParameterList.Parameters.Count == 1);
        if (method?.Body is null)
            return [];

        string receiver = method.ParameterList.Parameters[0].Identifier.Text;
        return method.Body.Statements.OfType<ExpressionStatementSyntax>()
            .Where(statement => statement.Expression is InvocationExpressionSyntax
            {
                Expression: MemberAccessExpressionSyntax { Expression: IdentifierNameSyntax identifier }
            } && identifier.Identifier.Text == receiver)
            .Select(statement =>
            {
                InvocationExpressionSyntax invocation = (InvocationExpressionSyntax)statement.Expression;
                return new Operation(statement, receiver, ((MemberAccessExpressionSyntax)invocation.Expression).Name, invocation.ArgumentList);
            }).ToArray();
    }

    private static string? StringValue(ExpressionSyntax? expression) =>
        expression is LiteralExpressionSyntax literal && literal.IsKind(SyntaxKind.StringLiteralExpression)
            ? literal.Token.ValueText : null;

    private static string? Name(ArgumentSyntax argument) => argument.NameColon?.Name.Identifier.ValueText;

    private sealed record Operation(ExpressionStatementSyntax Statement, string Receiver, SimpleNameSyntax Method, ArgumentListSyntax Arguments)
    {
        public TextSpan Span => Statement.Span;

        public bool Is(string method) => Method.Identifier.ValueText == method;

        public ArgumentSyntax[] ShapeArguments => Arguments.Arguments
            .Where(argument => Name(argument) is not ("name" or "table")).OrderBy(Name, StringComparer.Ordinal).ToArray();

        public bool Has(string name) => Arguments.Arguments.Any(argument => Name(argument) == name);

        public ArgumentSyntax? Argument(string name) => Arguments.Arguments.FirstOrDefault(argument => Name(argument) == name);

        public string? Value(string name) => Argument(name) is ArgumentSyntax arg ? StringValue(arg.Expression) : null;
    }

    /// <summary>Collects span edits to one migration. Every failure is returned as a reason, never thrown.</summary>
    private sealed class Rewriter(CompilationUnitSyntax root, string source)
    {
        private readonly Operation[] up = Operations(root, "Up");
        private readonly Operation[] down = Operations(root, "Down");
        private readonly List<TextChange> edits = [];
        private readonly HashSet<TextSpan> used = [];
        private readonly string newline = source.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";

        public string Apply() => edits.Count == 0 ? source :
            SourceText.From(source).WithChanges(edits.OrderBy(edit => edit.Span.Start)).ToString();

        /// <summary>A DropColumn and AddColumn pair with the same shape in both directions becomes a RenameColumn.</summary>
        public string? Column(string table, string from, string to)
        {
            if (Renamed(up, "RenameColumn", [table], from, to) && Renamed(down, "RenameColumn", [table], to, from))
                return null;
            Operation? dropUp = Find(up, "DropColumn", from, table);
            Operation? addUp = Find(up, "AddColumn", to, table);
            Operation? dropDown = Find(down, "DropColumn", to, table);
            Operation? addDown = Find(down, "AddColumn", from, table);
            if (dropUp is null || addUp is null || dropDown is null || addDown is null)
                return "EF did not emit a matching drop and add of the column";
            if (!SameShape(addUp, addDown))
                return "its column definition also changes";
            Operation[] all = [dropUp, addUp, dropDown, addDown];
            if (all.Any(operation => used.Contains(operation.Span)))
                return "another rename already uses these operations";
            used.UnionWith(all.Select(operation => operation.Span));
            Delete(dropUp);
            Delete(dropDown);
            Replace(addUp, [RenameColumn(addUp.Receiver, from, table, to)]);
            Replace(addDown, [RenameColumn(addDown.Receiver, to, table, from)]);
            return null;
        }

        /// <summary>
        /// A DropTable and CreateTable pair becomes EF's own form of a table rename: drop the owned foreign keys, the
        /// primary key and the check constraints, rename the table and its columns, add the constraints back under
        /// their new names and rename the matching indexes. Columns must match exactly after the declared renames.
        /// </summary>
        public string? Table(string from, string to, (string Old, string New)[] columns)
        {
            Operation? dropUp = Find(up, "DropTable", from, null);
            Operation? createUp = Find(up, "CreateTable", to, null);
            Operation? dropDown = Find(down, "DropTable", to, null);
            Operation? createDown = Find(down, "CreateTable", from, null);
            if (dropUp is null || createUp is null || dropDown is null || createDown is null)
                return "EF did not emit a matching drop and create of the table";
            Operation[] all = [dropUp, createUp, dropDown, createDown];
            if (all.Any(operation => used.Contains(operation.Span)))
                return "another rename already uses these operations";
            if (TableShape.Read(createUp, out string? newProblem) is not TableShape target)
                return newProblem;
            if (TableShape.Read(createDown, out string? oldProblem) is not TableShape origin)
                return oldProblem;

            Dictionary<string, string> forward = columns.ToDictionary(column => column.Old, column => column.New, StringComparer.Ordinal);
            Dictionary<string, string> backward = columns.ToDictionary(column => column.New, column => column.Old, StringComparer.Ordinal);
            string[] changed = origin.Columns.Keys.Select(column => forward.GetValueOrDefault(column, column))
                .Union(target.Columns.Keys, StringComparer.Ordinal)
                .Where(column => !target.Columns.TryGetValue(column, out ExpressionSyntax? definition) ||
                    !origin.Columns.TryGetValue(backward.GetValueOrDefault(column, column), out ExpressionSyntax? before) ||
                    !SyntaxFactory.AreEquivalent(definition, before))
                .Order(StringComparer.Ordinal).ToArray();
            if (changed.Length > 0)
                return $"the migration also adds, removes or changes column {string.Join(", ", changed)}";
            if (!SamePrimaryKeyColumns(origin, target, forward))
                return "its primary key columns change";

            (Operation Old, Operation New)[] indexesUp = PairIndexes(down, from, up, to, forward);
            (Operation Old, Operation New)[] indexesDown = PairIndexes(up, to, down, from, backward);
            used.UnionWith(all.Select(operation => operation.Span));
            Rename(dropUp, createUp, origin, target, from, to, columns, indexesUp, up, down);
            Rename(dropDown, createDown, target, origin, to, from, columns.Select(column => (column.New, column.Old)).ToArray(),
                indexesDown, down, up);
            return null;
        }

        private void Rename(Operation drop, Operation create, TableShape origin, TableShape target, string from, string to,
            (string Old, string New)[] columns, (Operation Old, Operation New)[] indexes, Operation[] same, Operation[] opposite)
        {
            string receiver = drop.Receiver;
            List<string> before = [];
            bool samePrimaryKey = origin.PrimaryKey?.Name == target.PrimaryKey?.Name;
            // EF drops a foreign key of a dropped table itself when tables reference each other in a cycle.
            before.AddRange(origin.ForeignKeys
                .Where(key => !same.Any(operation => operation.Is("DropForeignKey") && operation.Value("name") == key.Name &&
                    operation.Value("table") == from))
                .Select(key => $"{receiver}.DropForeignKey(name: {Literal(key.Name)}, table: {Literal(from)});"));
            if (origin.PrimaryKey is Constraint primary && !samePrimaryKey)
                before.Add($"{receiver}.DropPrimaryKey(name: {Literal(primary.Name)}, table: {Literal(from)});");
            before.AddRange(origin.Checks.Select(check => $"{receiver}.DropCheckConstraint(name: {Literal(check.Name)}, table: {Literal(from)});"));
            // Indexes of the old table without a counterpart: the opposite direction creates them.
            HashSet<TextSpan> paired = indexes.Select(pair => pair.Old.Span).ToHashSet();
            before.AddRange(opposite.Where(operation => operation.Is("CreateIndex") && operation.Value("table") == from &&
                    !paired.Contains(operation.Span) && operation.Value("name") is not null)
                .Select(operation => $"{receiver}.DropIndex(name: {Literal(operation.Value("name")!)}, table: {Literal(from)});"));
            before.Add($"{receiver}.RenameTable(name: {Literal(from)}, newName: {Literal(to)});");
            before.AddRange(columns.Select(column => RenameColumn(receiver, column.Old, to, column.New)));
            Replace(drop, before);

            List<string> after = [];
            if (target.PrimaryKey is Constraint key && !samePrimaryKey)
                after.Add($"{receiver}.AddPrimaryKey(name: {Literal(key.Name)}, table: {Literal(to)}, {key.Arguments});");
            foreach (Constraint constraint in target.Others)
                after.Add(constraint.Kind == "ForeignKey"
                    ? $"{receiver}.AddForeignKey(name: {Literal(constraint.Name)}, table: {Literal(to)}, {constraint.Arguments});"
                    : $"{receiver}.AddCheckConstraint(name: {Literal(constraint.Name)}, table: {Literal(to)}, sql: {constraint.Arguments});");
            Replace(create, after);

            foreach ((Operation old, Operation created) in indexes)
                Replace(created, [$"{created.Receiver}.RenameIndex(name: {Literal(old.Value("name")!)}, table: {Literal(to)}, " +
                    $"newName: {Literal(created.Value("name")!)});"]);
        }

        // Pairs each index the migration creates on the new table with an index of the old table that has the
        // same arguments once its columns are renamed.
        private static (Operation Old, Operation New)[] PairIndexes(Operation[] olds, string from, Operation[] news, string to,
            Dictionary<string, string> renames)
        {
            List<Operation> remaining = olds.Where(operation => operation.Is("CreateIndex") && operation.Value("table") == from &&
                operation.Value("name") is not null && !operation.Has("schema")).ToList();
            List<(Operation, Operation)> pairs = [];
            foreach (Operation created in news.Where(operation => operation.Is("CreateIndex") && operation.Value("table") == to &&
                operation.Value("name") is not null && !operation.Has("schema")))
            {
                Operation? match = remaining.FirstOrDefault(old => SameIndex(old, created, renames));
                if (match is null)
                    continue;
                remaining.Remove(match);
                pairs.Add((match, created));
            }
            return [.. pairs];
        }

        private static bool SameIndex(Operation old, Operation created, Dictionary<string, string> renames)
        {
            if (!SyntaxFactory.AreEquivalent(old.Method, created.Method))
                return false;
            ArgumentSyntax[] left = old.ShapeArguments;
            ArgumentSyntax[] right = created.ShapeArguments;
            return left.Length == right.Length && left.Zip(right).All(pair =>
                Name(pair.First) == Name(pair.Second) && Name(pair.First) is "column" or "columns"
                    ? Strings(pair.First.Expression, renames) is string[] mapped && Strings(pair.Second.Expression, []) is string[] names &&
                        mapped.SequenceEqual(names, StringComparer.Ordinal)
                    : SyntaxFactory.AreEquivalent(pair.First, pair.Second));
        }

        private static string[]? Strings(ExpressionSyntax expression, Dictionary<string, string> renames)
        {
            IEnumerable<ExpressionSyntax> items = expression switch
            {
                LiteralExpressionSyntax literal => [literal],
                ArrayCreationExpressionSyntax { Initializer: { } initializer } => initializer.Expressions,
                ImplicitArrayCreationExpressionSyntax { Initializer: { } initializer } => initializer.Expressions,
                CollectionExpressionSyntax collection => collection.Elements.OfType<ExpressionElementSyntax>().Select(element => element.Expression),
                _ => []
            };
            string?[] values = items.Select(StringValue).ToArray();
            return values.Length == 0 || values.Any(value => value is null) ? null
                : values.Select(value => renames.GetValueOrDefault(value!, value!)).ToArray();
        }

        private static bool SamePrimaryKeyColumns(TableShape origin, TableShape target, Dictionary<string, string> renames) =>
            (origin.PrimaryKey, target.PrimaryKey) switch
            {
                (null, null) => true,
                (Constraint left, Constraint right) => left.Columns.Select(column => renames.GetValueOrDefault(column, column))
                    .SequenceEqual(right.Columns, StringComparer.Ordinal),
                _ => false
            };

        private static string RenameColumn(string receiver, string from, string table, string to) =>
            $"{receiver}.RenameColumn(name: {Literal(from)}, table: {Literal(table)}, newName: {Literal(to)});";

        private static Operation? Find(Operation[] operations, string method, string value, string? table)
        {
            Operation[] matches = operations.Where(operation => operation.Is(method) &&
                operation.Value("name") == value && operation.Value("table") == table && !operation.Has("schema")).Take(2).ToArray();
            return matches.Length == 1 ? matches[0] : null;
        }

        private static bool SameShape(Operation first, Operation second)
        {
            if (!SyntaxFactory.AreEquivalent(first.Method, second.Method))
                return false;
            ArgumentSyntax[] left = first.ShapeArguments;
            ArgumentSyntax[] right = second.ShapeArguments;
            return left.Length == right.Length && left.Zip(right).All(pair => SyntaxFactory.AreEquivalent(pair.First, pair.Second));
        }

        // Replaces one statement with others at its indentation, separated by a blank line as EF writes them.
        private void Replace(Operation operation, IReadOnlyList<string> statements)
        {
            if (statements.Count == 0)
            {
                Delete(operation);
                return;
            }
            int start = operation.Span.Start;
            int line = LineStart(start);
            string indent = line < start ? source[line..start] : "";
            edits.Add(new(operation.Span, string.Join(newline + newline + indent, statements)));
        }

        // Deletes a statement's own line and one adjoining blank line (before it, else after it). Comments and code
        // on other lines stay. A statement sharing its line with other code loses only its own span.
        private void Delete(Operation operation)
        {
            int start = LineStart(operation.Span.Start);
            int end = operation.Statement.FullSpan.End;
            bool ownLine = (start == 0 || source[start - 1] == '\n') && end > 0 && source[end - 1] == '\n';
            if (!ownLine)
            {
                edits.Add(new(operation.Span, ""));
                return;
            }
            if (start > 0)
            {
                // The line before ends at start - 1, the newline before this one.
                int previous = start >= 2 ? source.LastIndexOf('\n', start - 2) + 1 : 0;
                if (string.IsNullOrWhiteSpace(source[previous..(start - 1)]))
                {
                    edits.Add(new(TextSpan.FromBounds(previous, end), ""));
                    return;
                }
            }
            int next = source.IndexOf('\n', end);
            if (next >= 0 && string.IsNullOrWhiteSpace(source[end..next]))
                end = next + 1;
            edits.Add(new(TextSpan.FromBounds(start, end), ""));
        }

        // The start of the line holding `offset` when only spaces or tabs precede it there, otherwise `offset`.
        private int LineStart(int offset)
        {
            int at = offset;
            while (at > 0 && source[at - 1] is ' ' or '\t')
                at--;
            return at == 0 || source[at - 1] == '\n' ? at : offset;
        }
    }

    private sealed record Constraint(string Kind, string Name, string Arguments, string[] Columns);

    /// <summary>The columns and constraints of one CreateTable, or why they cannot be read.</summary>
    private sealed record TableShape(Dictionary<string, ExpressionSyntax> Columns, Constraint? PrimaryKey, Constraint[] ForeignKeys,
        Constraint[] Checks, Constraint[] Others)
    {
        public static TableShape? Read(Operation create, out string? problem)
        {
            problem = "EF's CreateTable has a form the rename cannot carry over";
            if (create.Arguments.Arguments.Any(argument => Name(argument) is not ("name" or "columns" or "constraints")))
                return null;
            if (create.Argument("columns")?.Expression is not SimpleLambdaExpressionSyntax
                {
                    ExpressionBody: AnonymousObjectCreationExpressionSyntax columns
                })
                return null;
            Dictionary<string, ExpressionSyntax> definitions = new(StringComparer.Ordinal);
            foreach (AnonymousObjectMemberDeclaratorSyntax member in columns.Initializers)
            {
                if (member.NameEquals is null || ColumnName(member) is not string name || !definitions.TryAdd(name, member.Expression))
                    return null;
            }

            List<Constraint> all = [];
            if (create.Argument("constraints")?.Expression is SimpleLambdaExpressionSyntax lambda)
            {
                ExpressionSyntax[] calls = lambda.Block is BlockSyntax block
                    ? block.Statements.Select(statement => statement is ExpressionStatementSyntax expression ? expression.Expression : null!).ToArray()
                    : [lambda.ExpressionBody!];
                foreach (ExpressionSyntax call in calls)
                {
                    if (call is not InvocationExpressionSyntax
                        {
                            Expression: MemberAccessExpressionSyntax { Name.Identifier.ValueText: var kind }
                        } invocation || ReadConstraint(kind, invocation) is not Constraint constraint)
                    {
                        problem = "its constraints include a kind the rename cannot carry over";
                        return null;
                    }
                    all.Add(constraint);
                }
            }
            else if (create.Has("constraints"))
                return null;

            Constraint[] primary = all.Where(constraint => constraint.Kind == "PrimaryKey").ToArray();
            if (primary.Length > 1)
                return null;
            problem = null;
            return new(definitions, primary.SingleOrDefault(),
                all.Where(constraint => constraint.Kind == "ForeignKey").ToArray(),
                all.Where(constraint => constraint.Kind == "CheckConstraint").ToArray(),
                all.Where(constraint => constraint.Kind != "PrimaryKey").ToArray());
        }

        private static string? ColumnName(AnonymousObjectMemberDeclaratorSyntax member)
        {
            // table.Column<T>(name: "...") overrides the member name.
            if (member.Expression is InvocationExpressionSyntax invocation &&
                invocation.ArgumentList.Arguments.FirstOrDefault(argument => Name(argument) == "name") is ArgumentSyntax name)
                return StringValue(name.Expression);
            return member.NameEquals!.Name.Identifier.ValueText;
        }

        private static Constraint? ReadConstraint(string kind, InvocationExpressionSyntax invocation)
        {
            SeparatedSyntaxList<ArgumentSyntax> arguments = invocation.ArgumentList.Arguments;
            switch (kind)
            {
                case "PrimaryKey" when arguments.Count == 2 && arguments.All(argument => Name(argument) is null or "name" or "columns") &&
                    StringValue(Positional(arguments, 0, "name")) is string name &&
                    Members(Positional(arguments, 1, "columns")) is string[] columns:
                    return new(kind, name, columns.Length == 1
                        ? $"column: {Literal(columns[0])}"
                        : $"columns: new[] {{ {string.Join(", ", columns.Select(Literal))} }}", columns);
                case "CheckConstraint" when arguments.Count == 2 && arguments.All(argument => Name(argument) is null or "name" or "sql") &&
                    StringValue(Positional(arguments, 0, "name")) is string check && Positional(arguments, 1, "sql") is ExpressionSyntax sql:
                    return new(kind, check, sql.ToString(), []);
                case "ForeignKey" when arguments.All(argument => Name(argument) is not null) &&
                    arguments.FirstOrDefault(argument => Name(argument) == "name") is { } keyName &&
                    StringValue(keyName.Expression) is string foreign:
                {
                    List<string> rest = [];
                    foreach (ArgumentSyntax argument in arguments.Where(argument => Name(argument) != "name"))
                    {
                        string? text = Name(argument) switch
                        {
                            "column" => Members(argument.Expression) is [string column] ? $"column: {Literal(column)}" : null,
                            "columns" => Members(argument.Expression) is { Length: > 0 } keys
                                ? $"columns: new[] {{ {string.Join(", ", keys.Select(Literal))} }}" : null,
                            "principalTable" or "principalColumn" or "principalColumns" or "principalSchema" or "onUpdate" or "onDelete" =>
                                argument.ToString(),
                            _ => null
                        };
                        if (text is null)
                            return null;
                        rest.Add(text);
                    }
                    return new(kind, foreign, string.Join(", ", rest), []);
                }
                default:
                    return null;
            }
        }

        private static ExpressionSyntax? Positional(SeparatedSyntaxList<ArgumentSyntax> arguments, int index, string name) =>
            arguments.FirstOrDefault(argument => Name(argument) == name)?.Expression ??
            (index < arguments.Count && Name(arguments[index]) is null ? arguments[index].Expression : null);

        // The columns of `x => x.a` or `x => new { x.a, x.b }`.
        private static string[]? Members(ExpressionSyntax? expression)
        {
            if (expression is not SimpleLambdaExpressionSyntax { ExpressionBody: { } body } lambda)
                return null;
            string parameter = lambda.Parameter.Identifier.ValueText;
            IEnumerable<ExpressionSyntax> members = body is AnonymousObjectCreationExpressionSyntax anonymous
                ? anonymous.Initializers.Select(initializer => initializer.NameEquals is null ? initializer.Expression : null!)
                : [body];
            string?[] names = members.Select(member => member is MemberAccessExpressionSyntax
            {
                Expression: IdentifierNameSyntax { Identifier.ValueText: var owner }, Name.Identifier.ValueText: var column
            } && owner == parameter ? column : null).ToArray();
            return names.Length == 0 || names.Any(name => name is null) ? null : names.Select(name => name!).ToArray();
        }
    }
}
