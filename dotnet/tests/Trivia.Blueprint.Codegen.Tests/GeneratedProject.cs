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

    public GeneratedProject(LoadedBlueprint input) : this(input.AppName)
    {
        PlanWriter.Write(Root, ApiPlan.Create(Root, input));
    }

    private GeneratedProject(string appName)
    {
        string name = appName + ".Api";
        ApiDirectory = Path.Combine(Root, "src", name);
        ApiAssembly = Path.Combine(ApiDirectory, "bin", "Debug", "net10.0", name + ".dll");
        DocumentPath = Path.Combine(ApiDirectory, "obj", "openapi.json");
        SolutionPath = Path.Combine(Root, appName + ".slnx");
    }

    public static async Task<GeneratedProject> WriteAsync(string blueprint)
    {
        GeneratedProject project = new(ModelLoader.Load(blueprint).AppName);
        try
        {
            using StringWriter output = new();
            using StringWriter errors = new();
            int status = await Program.RunAsync(["write", "--blueprint", blueprint, "--root", project.Root], output, errors);
            Assert.True(status == 0, output.ToString() + errors);
            return project;
        }
        catch
        {
            project.Dispose();
            throw;
        }
    }

    public async Task<string> BuildAsync()
    {
        using Process process = Start("dotnet", Root, ["build", Path.GetFileName(SolutionPath), "-warnaserror", "--nologo", "--disable-build-servers"]);
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
