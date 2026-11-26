using System.CommandLine;
using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis.CSharp;
using Trivia.Blueprint.Codegen.Migrations;
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

        Run? run = null;
        try
        {
            root = Path.GetFullPath(root);
            string source = blueprint ?? Path.Combine(root, "blueprint");
            LoadedBlueprint? input = blueprint is not null || File.Exists(Path.Combine(source, ModelLoader.ModelFile))
                ? ModelLoader.Load(source)
                : null;
            string relative = LocateProject(root, input?.AppName);
            string migrationsPath = Path.GetDirectoryName(relative)!.Replace(Path.DirectorySeparatorChar, '/') + "/" + Migrations;
            string directory = Ownership.Resolve(root, migrationsPath, directory: true);
            string snapshot = Ownership.Resolve(root, migrationsPath + "/AppDbContextModelSnapshot.cs");
            PreviousModel previous = input is not null && File.Exists(snapshot)
                ? RenameRewriter.ReadSnapshot(File.ReadAllText(snapshot))
                : PreviousModel.Empty;

            // A relative path keeps NuGet project identities consistent when the working directory
            // is an OS alias, such as /var on macOS.
            (int build, string buildOutput) = await RunDotnet(root, ["build", relative, "-warnaserror", "--nologo", "--disable-build-servers"], cancellationToken);
            if (build != 0)
                return Fail(output, new("migration_build_failed", relative, "", buildOutput));

            bool localTool = HasLocalTool(root);
            if (localTool)
            {
                (int restore, string restoreOutput) = await RunDotnet(root,
                    ["tool", "restore", "--tool-manifest", ".config/dotnet-tools.json"], cancellationToken);
                if (restore != 0)
                    return Fail(output, new("migration_tool_restore_failed", ".config/dotnet-tools.json", "", restoreOutput));
            }
            string[] tool = localTool ? ["tool", "run", "dotnet-ef", "--"] : ["ef"];
            string[] arguments = [.. tool, "migrations", "add", name, "--project", relative,
                "--startup-project", relative, "--context", "AppDbContext", "--output-dir", Migrations, "--no-build", "--no-color"];
            run = new(directory, snapshot);
            (int status, string message) = await RunDotnet(root, arguments, cancellationToken);
            if (status != 0)
                return run.Undo(() => Fail(output, new("migration_failed", relative, "", message)));

            string[] added = run.Added().Where(path => Path.GetFileName(path).EndsWith($"_{name}.cs", StringComparison.Ordinal)).ToArray();
            if (added.Length != 1)
                return run.Undo(() => Fail(output, new("migration_missing", migrationsPath, "", "EF did not produce exactly one new migration.")));

            string migration = Path.GetRelativePath(root, added[0]).Replace(Path.DirectorySeparatorChar, '/');
            RenameResult renamed = input is null
                ? new("", [], [], [])
                : RewriteNewMigration(Ownership.Resolve(root, migration), input.Model, previous);
            if (renamed.Diagnostics.Count > 0)
                return run.Undo(() =>
                {
                    output.WriteLine(JsonSerializer.Serialize(new { modelRev = input!.ModelRev, diagnostics = renamed.Diagnostics }, ModelLoader.Json));
                    return 1;
                });
            output.WriteLine(JsonSerializer.Serialize(new
            {
                migration,
                modelRev = input?.ModelRev,
                renames = renamed.Renames,
                settled = renamed.Settled,
                diagnostics = Array.Empty<Diagnostic>()
            }, ModelLoader.Json));
            return 0;
        }
        catch (BlueprintInputException exception)
        {
            output.WriteLine(JsonSerializer.Serialize(new { diagnostics = exception.Diagnostics }, ModelLoader.Json));
            return 1;
        }
        catch (Exception exception) when (exception is IOException or JsonException or UnauthorizedAccessException or
            ArgumentException or Win32Exception or OperationCanceledException)
        {
            Diagnostic failure = new("migration_failed", "", "", exception.Message);
            return run is null ? Fail(output, failure) : run.Undo(() => Fail(output, failure));
        }
    }

    /// <summary>
    /// What one `ef migrations add` may change: new files in the migrations directory and EF's model snapshot.
    /// A failed run puts both back, so the next run sees the same difference again.
    /// </summary>
    private sealed class Run
    {
        private readonly string directory;
        private readonly bool directoryExisted;
        private readonly HashSet<string> before;
        private readonly string snapshot;
        private readonly byte[]? snapshotBytes;

        public Run(string directory, string snapshot)
        {
            this.directory = directory;
            this.snapshot = snapshot;
            directoryExisted = Directory.Exists(directory);
            before = MigrationFiles(directory).ToHashSet(StringComparer.Ordinal);
            snapshotBytes = File.Exists(snapshot) ? File.ReadAllBytes(snapshot) : null;
        }

        public IEnumerable<string> Added() => MigrationFiles(directory).Where(path => !before.Contains(path));

        public int Undo(Func<int> report)
        {
            foreach (string file in Added().Where(file => file != snapshot).ToArray())
                File.Delete(file);
            if (snapshotBytes is null)
                File.Delete(snapshot);
            else if (!File.ReadAllBytes(snapshot).AsSpan().SequenceEqual(snapshotBytes))
                File.WriteAllBytes(snapshot, snapshotBytes);
            if (!directoryExisted && Directory.Exists(directory) && !Directory.EnumerateFileSystemEntries(directory).Any())
                Directory.Delete(directory);
            return report();
        }
    }

    private static bool HasLocalTool(string root)
    {
        string manifest = Ownership.Resolve(root, ".config/dotnet-tools.json");
        if (!File.Exists(manifest))
            return false;
        using JsonDocument document = JsonDocument.Parse(File.ReadAllBytes(manifest));
        return document.RootElement.ValueKind == JsonValueKind.Object &&
            document.RootElement.TryGetProperty("tools", out JsonElement tools) &&
            tools.ValueKind == JsonValueKind.Object && tools.TryGetProperty("dotnet-ef", out _);
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
        // The EF CLI invokes MSBuild too. Reusable nodes can outlive it and keep these pipes open.
        start.Environment["MSBUILDDISABLENODEREUSE"] = "1";
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

    private static RenameResult RewriteNewMigration(string file, ModelDocument model, PreviousModel previous)
    {
        if (!model.Entities.Any(entity => entity.RenamedFrom is not null || entity.Fields.Any(field => field.RenamedFrom is not null)))
            return new("", [], [], []);
        byte[] bytes = File.ReadAllBytes(file);
        bool hasBom = bytes.AsSpan().StartsWith(Encoding.UTF8.GetPreamble());
        string source = Encoding.UTF8.GetString(bytes.AsSpan(hasBom ? 3 : 0));
        RenameResult rewritten = RenameRewriter.Rewrite(source, model, previous);
        if (rewritten.Diagnostics.Count > 0 || rewritten.Source == source)
            return rewritten;
        string temporary = $"{file}.{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllText(temporary, rewritten.Source, new UTF8Encoding(encoderShouldEmitUTF8Identifier: hasBom));
            if (!File.ReadAllBytes(file).AsSpan().SequenceEqual(bytes))
                throw new IOException("The new migration changed while applying rename hints.");
            File.Move(temporary, file, overwrite: true);
        }
        finally
        {
            File.Delete(temporary);
        }
        return rewritten;
    }

    private static int Fail(TextWriter output, Diagnostic diagnostic)
    {
        output.WriteLine(JsonSerializer.Serialize(new { diagnostics = new[] { diagnostic } }, ModelLoader.Json));
        return 1;
    }
}
