using System.Diagnostics;
using Xunit;
using YamlDotNet.RepresentationModel;

namespace Trivia.Blueprint.Codegen.Tests.Integration;

[Trait("Category", "Integration")]
public sealed class ComposeTests
{
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

        using Process process = GeneratedProject.Start("aspire", project.Root,
            ["publish", "--apphost", "src/BackOffice.AppHost/BackOffice.AppHost.csproj",
                "--output-path", "artifacts", "--non-interactive", "--nologo"],
            new Dictionary<string, string> { ["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1", ["ASPIRE_CLI_TELEMETRY_OPTOUT"] = "1" });
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
        string output = await stdout + await stderr;
        Assert.True(process.ExitCode == 0, output);

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
}
