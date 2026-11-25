using System.Diagnostics;
using Trivia.Blueprint.Codegen.Model;
using Trivia.Blueprint.Codegen.Plan;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

internal sealed class GeneratedProject : IDisposable
{
    private readonly TempDirectory root = new();
    public string Root => root.Path;
    public string ApiDirectory { get; }
    public string ApiAssembly { get; }
    public string DocumentPath { get; }
    public string SolutionPath { get; }

    public GeneratedProject(LoadedBlueprint input)
    {
        PlanWriter.Write(Root, ApiPlan.Create(Root, input));
        string name = input.AppName + ".Api";
        ApiDirectory = Path.Combine(Root, "src", name);
        ApiAssembly = Path.Combine(ApiDirectory, "bin", "Debug", "net10.0", name + ".dll");
        DocumentPath = Path.Combine(ApiDirectory, "obj", "openapi.json");
        SolutionPath = Path.Combine(Root, input.AppName + ".slnx");
    }

    public async Task<string> BuildAsync()
    {
        using Process process = Start("dotnet", Root, ["build", SolutionPath, "-warnaserror", "--nologo"]);
        Task<string> stdout = process.StandardOutput.ReadToEndAsync();
        Task<string> stderr = process.StandardError.ReadToEndAsync();
        using CancellationTokenSource timeout = new(TimeSpan.FromMinutes(2));
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            process.Kill(entireProcessTree: true);
            throw;
        }
        string output = await stdout + await stderr;
        Assert.True(process.ExitCode == 0, output);
        return output;
    }

    public static Process Start(string executable, string directory, string[] arguments, IReadOnlyDictionary<string, string>? environment = null)
    {
        ProcessStartInfo start = new(executable)
        {
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false
        };
        foreach (string argument in arguments)
            start.ArgumentList.Add(argument);
        if (environment is not null)
            foreach ((string key, string value) in environment)
                start.Environment[key] = value;
        return Process.Start(start)!;
    }

    public void Dispose() => root.Dispose();
}
