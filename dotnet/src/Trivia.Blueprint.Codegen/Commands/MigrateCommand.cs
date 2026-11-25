using System.CommandLine;
using System.ComponentModel;
using System.Diagnostics;
using System.Text.Json;
using Microsoft.CodeAnalysis.CSharp;
using Trivia.Blueprint.Codegen.Model;
using Trivia.Blueprint.Codegen.Plan;

namespace Trivia.Blueprint.Codegen.Commands;

internal static class MigrateCommand
{
    private const string Migrations = "Data/Migrations";

    internal static Command Create(TextWriter output)
    {
        Argument<string> name = new("name") { Description = "The new migration's C# name." };
        Option<string> root = new("--root") { Required = true, Description = "The generated solution directory." };
        Option<string?> blueprint = new("--blueprint") { Description = "The blueprint directory, if outside the solution." };

        Command command = new("migrate", "Add an EF Core migration for the generated API.");
        command.Arguments.Add(name);
        command.Options.Add(root);
        command.Options.Add(blueprint);
        command.SetAction((parse, cancellationToken) =>
            RunAsync(parse.GetValue(name)!, parse.GetValue(root)!, parse.GetValue(blueprint), output, cancellationToken));
        return command;
    }

    private static async Task<int> RunAsync(string name, string root, string? blueprint, TextWriter output, CancellationToken cancellationToken)
    {
        if (!SyntaxFacts.IsValidIdentifier(name) || name.StartsWith('@') || SyntaxFacts.GetKeywordKind(name) != SyntaxKind.None)
            return Fail(output, new("invalid_migration_name", "", "", "Provide a migration name that is a valid C# identifier."));

        try
        {
            root = Path.GetFullPath(root);
            string source = blueprint ?? Path.Combine(root, "blueprint");
            LoadedBlueprint? input = blueprint is not null || File.Exists(Path.Combine(source, ModelLoader.ModelFile))
                ? ModelLoader.Load(source)
                : null;
            string relative = LocateProject(root, input?.AppName);
            string project = Ownership.Resolve(root, relative);
            string migrationsPath = Path.GetDirectoryName(relative)!.Replace(Path.DirectorySeparatorChar, '/') + "/" + Migrations;
            string directory = Ownership.Resolve(root, migrationsPath, directory: true);
            HashSet<string> before = MigrationFiles(directory).ToHashSet(StringComparer.Ordinal);

            (int build, string buildOutput) = await RunDotnet(root, ["build", project, "-warnaserror", "--nologo"], cancellationToken);
            if (build != 0)
                return Fail(output, new("migration_build_failed", relative, "", buildOutput));

            string[] arguments = ["ef", "migrations", "add", name, "--project", project,
                "--startup-project", project, "--context", "AppDbContext", "--output-dir", Migrations, "--no-build", "--no-color"];
            (int status, string message) = await RunDotnet(root, arguments, cancellationToken);
            if (status != 0)
                return Fail(output, new("migration_failed", relative, "", message));

            string[] added = MigrationFiles(directory).Where(path => !before.Contains(path) &&
                Path.GetFileName(path).EndsWith($"_{name}.cs", StringComparison.Ordinal)).ToArray();
            if (added.Length != 1)
                return Fail(output, new("migration_missing", migrationsPath, "", "EF did not produce exactly one new migration."));

            string migration = Path.GetRelativePath(root, added[0]).Replace(Path.DirectorySeparatorChar, '/');
            _ = Ownership.Resolve(root, migration);
            output.WriteLine(JsonSerializer.Serialize(new { migration, diagnostics = Array.Empty<Diagnostic>() }, ModelLoader.Json));
            return 0;
        }
        catch (BlueprintInputException exception)
        {
            output.WriteLine(JsonSerializer.Serialize(new { diagnostics = exception.Diagnostics }, ModelLoader.Json));
            return 1;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or
            ArgumentException or Win32Exception or OperationCanceledException)
        {
            return Fail(output, new("migration_failed", "", "", exception.Message));
        }
    }

    private static string LocateProject(string root, string? app)
    {
        if (app is not null)
        {
            string expected = $"src/{app}.Api/{app}.Api.csproj";
            if (!File.Exists(Ownership.Resolve(root, expected)))
                throw new IOException($"The API project {expected} is missing.");
            return expected;
        }

        string source = Ownership.Resolve(root, "src", directory: true);
        string[] projects = Directory.EnumerateDirectories(source, "*.Api").Select(directory =>
        {
            string name = Path.GetFileName(directory);
            return $"src/{name}/{name}.csproj";
        }).Where(path => File.Exists(Ownership.Resolve(root, path))).ToArray();
        return projects.Length == 1 ? projects[0] :
            throw new IOException("Expected exactly one generated API project under src. Use --blueprint to identify it.");
    }

    private static IEnumerable<string> MigrationFiles(string directory) =>
        Directory.Exists(directory) ? Directory.EnumerateFiles(directory, "*.cs") : [];

    private static async Task<(int Status, string Message)> RunDotnet(string root, string[] arguments, CancellationToken cancellationToken)
    {
        ProcessStartInfo start = new("dotnet")
        {
            WorkingDirectory = root,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        foreach (string argument in arguments)
            start.ArgumentList.Add(argument);
        using Process process = Process.Start(start) ?? throw new IOException("Could not start dotnet.");
        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        using CancellationTokenSource deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(TimeSpan.FromMinutes(2));
        try
        {
            await process.WaitForExitAsync(deadline.Token);
        }
        catch (OperationCanceledException)
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
            throw;
        }
        return (process.ExitCode, (await stdout + await stderr).Trim());
    }

    private static int Fail(TextWriter output, Diagnostic diagnostic)
    {
        output.WriteLine(JsonSerializer.Serialize(new { diagnostics = new[] { diagnostic } }, ModelLoader.Json));
        return 1;
    }
}
