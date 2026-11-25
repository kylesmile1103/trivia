using System.Diagnostics;
using Xunit;
using YamlDotNet.RepresentationModel;

namespace Trivia.Blueprint.Codegen.Tests.Integration;

[Trait("Category", "Integration")]
public sealed class ComposeTests
{
    private const string AppHost = "src/BackOffice.AppHost/BackOffice.AppHost.csproj";
    [Fact]
    public async Task FR_AS_09_PublishesAllFourServicesToDockerCompose()
    {
        using GeneratedProject project = await GeneratedProject.WriteAsync(FixtureTests.Bank);
        string web = Directory.CreateDirectory(Path.Combine(project.Root, "web")).FullName;
        File.WriteAllText(Path.Combine(web, "package.json"), """
            {
              "name": "trivia-compose-fixture",
              "private": true,
              "packageManager": "pnpm@12.9.1",
              "scripts": { "dev": "node build.mjs", "build": "node build.mjs" }
            }
            """);
        File.WriteAllText(Path.Combine(web, "build.mjs"), """
            import { mkdirSync, writeFileSync } from 'node:fs';
            mkdirSync('dist', { recursive: true });
            writeFileSync('dist/index.html', '<!DOCTYPE html><title>Trivia</title>');
            """);

        (int exitCode, string output) = await RunAspireAsync(project.Root,
            ["publish", "--apphost", AppHost, "--output-path", "artifacts", "--non-interactive", "--nologo"]);
        Assert.True(exitCode == 0, output);

        string file = Assert.Single(Directory.EnumerateFiles(Path.Combine(project.Root, "artifacts"),
            "*", SearchOption.AllDirectories), candidate => Path.GetFileName(candidate) is "docker-compose.yaml" or "docker-compose.yml");
        using StreamReader content = File.OpenText(file);
        YamlStream yaml = new();
        yaml.Load(content);
        YamlMappingNode document = Assert.IsType<YamlMappingNode>(Assert.Single(yaml.Documents).RootNode);
        YamlMappingNode services = Assert.IsType<YamlMappingNode>(document["services"]);
        Assert.Equal(new[] { "api", "migrations", "postgres", "web" },
            services.Children.Keys.Cast<YamlScalarNode>().Select(key => key.Value).Order());
    }

    [Fact]
    public async Task FR_AS_02_ReportsAnUnavailableContainerRuntime()
    {
        using GeneratedProject project = await GeneratedProject.WriteAsync(FixtureTests.Bank);
        string unavailable = OperatingSystem.IsWindows()
            ? $"npipe:////./pipe/trivia-missing-{Guid.NewGuid():N}"
            : "unix://" + Path.Combine(project.Root, "missing.sock");
        (int exitCode, string output) = await RunAspireAsync(project.Root,
            ["run", "--apphost", AppHost, "--isolated", "--non-interactive", "--nologo", "--",
                "--Trivia:StartWeb=false", "--Trivia:UseDataVolume=false"],
            new Dictionary<string, string>
            {
                ["ASPIRE_CONTAINER_RUNTIME"] = "docker",
                ["DOCKER_HOST"] = unavailable,
                ["DOCKER_CONTEXT"] = ""
            });
        Assert.NotEqual(0, exitCode);
        Assert.Matches("(?i)container runtime ['\"’]?docker", output);
        Assert.Matches("(?i)could not be found|unhealthy|not running|not responding", output);
    }

    private static async Task<(int ExitCode, string Output)> RunAspireAsync(string root, string[] args,
        IReadOnlyDictionary<string, string>? settings = null)
    {
        Dictionary<string, string> environment = new()
        {
            ["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1",
            ["ASPIRE_CLI_TELEMETRY_OPTOUT"] = "1",
            ["MSBUILDDISABLENODEREUSE"] = "1"
        };
        if (settings is not null)
            foreach ((string key, string value) in settings)
                environment[key] = value;
        using Process process = GeneratedProject.Start("aspire", root, args, environment);
        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        using CancellationTokenSource timeout = new(TimeSpan.FromMinutes(4));
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
            throw;
        }
        return (process.ExitCode, await stdout + await stderr);
    }

}
