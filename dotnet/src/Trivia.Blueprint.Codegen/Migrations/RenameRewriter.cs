using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;
using Trivia.Blueprint.Codegen.Model;
using static Trivia.Blueprint.Codegen.Emit.CSharp;

namespace Trivia.Blueprint.Codegen.Migrations;

public sealed record MigrationRename(string Kind, string OldName, string NewName);
public sealed record RenameResult(string Source, IReadOnlyList<MigrationRename> Renames);

public static class RenameRewriter
{
    public static IReadOnlyDictionary<string, string> ReadTables(string snapshot)
    {
        CompilationUnitSyntax root = SyntaxFactory.ParseCompilationUnit(snapshot);
        Dictionary<string, string> tables = new(StringComparer.Ordinal);
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

            string[] mapped = lambda.Body.DescendantNodes().OfType<InvocationExpressionSyntax>()
                .Where(call => call.Expression is MemberAccessExpressionSyntax { Name.Identifier.ValueText: "ToTable" } &&
                    call.ArgumentList.Arguments.Count >= 1)
                .Select(call => StringValue(call.ArgumentList.Arguments[0].Expression))
                .OfType<string>()
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            if (mapped.Length == 1)
                tables.TryAdd(names[^1], mapped[0]);
        }
        return tables;
    }

    public static RenameResult Rewrite(string source, ModelDocument model, IReadOnlyDictionary<string, string> previousTables)
    {
        CompilationUnitSyntax root = SyntaxFactory.ParseCompilationUnit(source);
        if (root.ContainsDiagnostics)
            throw new IOException("The new migration is not valid C#.");
        Operation[] up = Operations(root, "Up");
        Operation[] down = Operations(root, "Down");
        List<TextChange> edits = [];
        List<MigrationRename> renames = [];
        HashSet<TextSpan> used = [];

        foreach (ModelEntity entity in model.Entities)
        {
            string table = Snake(entity.Plural);
            string oldTable = previousTables.GetValueOrDefault(entity.RenamedFrom ?? entity.Name, table);
            if (entity.RenamedFrom is not null && oldTable != table)
            {
                if (!HasIndex(up, table) && !HasIndex(down, oldTable))
                    RewritePair("Table", oldTable, table, table: null);
                continue;
            }

            foreach (ModelField field in entity.Fields)
                if (field.RenamedFrom is string previous && Snake(previous) != Snake(field.Name))
                    RewritePair("Column", Snake(previous), Snake(field.Name), table);
        }

        if (edits.Count == 0)
            return new(source, []);
        string result = SourceText.From(source).WithChanges(edits.OrderBy(edit => edit.Span.Start)).ToString();
        if (SyntaxFactory.ParseCompilationUnit(result).ContainsDiagnostics)
            throw new IOException("The rewritten migration is not valid C#.");
        return new(result, renames);

        void RewritePair(string kind, string from, string to, string? table)
        {
            string addMethod = kind == "Column" ? "AddColumn" : "CreateTable";
            Operation? dropUp = Find(up, $"Drop{kind}", from, table);
            Operation? addUp = Find(up, addMethod, to, table);
            Operation? dropDown = Find(down, $"Drop{kind}", to, table);
            Operation? addDown = Find(down, addMethod, from, table);
            if (dropUp is null || addUp is null || dropDown is null || addDown is null || !SameShape(addUp, addDown))
                return;

            TextSpan[] spans = [dropUp.Span, addUp.Span, dropDown.Span, addDown.Span];
            if (spans.Any(used.Contains))
                return;
            used.UnionWith(spans);
            string tableArgument = table is null ? "" : $"table: {Literal(table)}, ";
            edits.Add(new(dropUp.Span, ""));
            edits.Add(new(dropDown.Span, ""));
            edits.Add(new(addUp.Span, Rename(addUp.Receiver, from, to)));
            edits.Add(new(addDown.Span, Rename(addDown.Receiver, to, from)));
            string prefix = table is null ? "" : table + ".";
            renames.Add(new(kind.ToLowerInvariant(), prefix + from, prefix + to));

            string Rename(string receiver, string oldName, string newName) =>
                $"{receiver}.Rename{kind}(name: {Literal(oldName)}, {tableArgument}newName: {Literal(newName)});";
        }
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
                return new Operation(statement.Span, receiver, ((MemberAccessExpressionSyntax)invocation.Expression).Name, invocation.ArgumentList);
            }).ToArray();
    }

    private static Operation? Find(Operation[] operations, string method, string value, string? table)
    {
        Operation[] matches = operations.Where(operation => operation.Method.Identifier.ValueText == method &&
            operation.Value("name") == value && operation.Value("table") == table && !operation.Has("schema")).Take(2).ToArray();
        return matches.Length == 1 ? matches[0] : null;
    }

    private static bool HasIndex(Operation[] operations, string table) =>
        operations.Any(operation => operation.Method.Identifier.ValueText == "CreateIndex" && operation.Value("table") == table);

    private static bool SameShape(Operation first, Operation second)
    {
        if (!SyntaxFactory.AreEquivalent(first.Method, second.Method))
            return false;
        ArgumentSyntax[] left = first.ShapeArguments;
        ArgumentSyntax[] right = second.ShapeArguments;
        return left.Length == right.Length && left.Zip(right).All(pair => SyntaxFactory.AreEquivalent(pair.First, pair.Second));
    }

    private static string? StringValue(ExpressionSyntax expression) =>
        expression is LiteralExpressionSyntax literal && literal.IsKind(SyntaxKind.StringLiteralExpression)
            ? literal.Token.ValueText : null;

    private sealed record Operation(TextSpan Span, string Receiver, SimpleNameSyntax Method, ArgumentListSyntax Arguments)
    {
        public ArgumentSyntax[] ShapeArguments => Arguments.Arguments
            .Where(argument => Name(argument) is not ("name" or "table")).OrderBy(Name, StringComparer.Ordinal).ToArray();

        public bool Has(string name) => Arguments.Arguments.Any(argument => Name(argument) == name);

        public string? Value(string name) => Arguments.Arguments.FirstOrDefault(argument => Name(argument) == name) is ArgumentSyntax arg
            ? StringValue(arg.Expression) : null;

        private static string? Name(ArgumentSyntax argument) => argument.NameColon?.Name.Identifier.ValueText;
    }
}
