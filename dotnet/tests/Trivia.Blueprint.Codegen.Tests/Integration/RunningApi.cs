using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace Trivia.Blueprint.Codegen.Tests.Integration;

internal sealed class RunningApi : IAsyncDisposable
{
    private readonly Process process;

    public HttpClient Client { get; }
    public string ConnectionString { get; }

    private RunningApi(Process process, Uri address, string connectionString)
    {
        this.process = process;
        Client = new HttpClient { BaseAddress = address, Timeout = TimeSpan.FromSeconds(30) };
        ConnectionString = connectionString;
    }

    public static async Task<RunningApi> StartAsync(GeneratedProject project, string connectionString,
        IReadOnlyDictionary<string, string>? settings = null)
    {
        string contextFile = File.ReadAllText(Path.Combine(project.ApiDirectory, "Data", "AppDbContext.g.cs"));
        string contextNamespace = Regex.Match(contextFile, @"namespace ([\w.]+);").Groups[1].Value;
        string path = Path.Combine(project.ApiDirectory, "Program.cs");
        string program = File.ReadAllText(path);
        if (!program.Contains("TRIVIA_TEST_CREATE_DB", StringComparison.Ordinal))
            File.WriteAllText(path, "using Microsoft.EntityFrameworkCore;\n" +
                program.Replace("app.Run();", $$"""
                    if (Environment.GetEnvironmentVariable("TRIVIA_TEST_CREATE_DB") == "1")
                    {
                        await using AsyncServiceScope scope = app.Services.CreateAsyncScope();
                        {{contextNamespace}}.AppDbContext db = scope.ServiceProvider.GetRequiredService<{{contextNamespace}}.AppDbContext>();
                        await db.Database.EnsureCreatedAsync();
                    }
                    app.Run();
                    """, StringComparison.Ordinal));
        _ = await project.BuildAsync();

        Dictionary<string, string> environment = new()
        {
            ["ASPNETCORE_ENVIRONMENT"] = "Production",
            ["ConnectionStrings__AppDb"] = connectionString,
            ["TRIVIA_TEST_CREATE_DB"] = "1",
            ["Logging__LogLevel__Default"] = "Warning",
            ["Logging__LogLevel__Microsoft.Hosting.Lifetime"] = "Information"
        };
        if (settings is not null)
            foreach ((string key, string value) in settings)
                environment[key] = value;

        Process process = GeneratedProject.Start("dotnet", project.ApiDirectory,
            [project.ApiAssembly, "--urls", "http://127.0.0.1:0"], environment);
        TaskCompletionSource<Uri> address = new(TaskCreationOptions.RunContinuationsAsynchronously);
        StringBuilder log = new();
        void Capture(object _, DataReceivedEventArgs item)
        {
            if (item.Data is not string line)
                return;
            lock (log)
                log.AppendLine(line);
            const string prefix = "Now listening on: ";
            int at = line.IndexOf(prefix, StringComparison.Ordinal);
            if (at >= 0 && Uri.TryCreate(line[(at + prefix.Length)..].Trim(), UriKind.Absolute, out Uri? url))
                address.TrySetResult(url);
        }
        process.OutputDataReceived += Capture;
        process.ErrorDataReceived += Capture;
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        Task exited = process.WaitForExitAsync();
        try
        {
            Task first = await Task.WhenAny(address.Task, exited).WaitAsync(TimeSpan.FromSeconds(30));
            if (first != address.Task)
                throw new InvalidOperationException("The generated API exited during startup.");
            return new(process, await address.Task, connectionString);
        }
        catch (Exception exception)
        {
            if (!process.HasExited)
                process.Kill(entireProcessTree: true);
            await exited;
            process.Dispose();
            throw new InvalidOperationException(log.ToString(), exception);
        }
    }

    public async ValueTask DisposeAsync()
    {
        Client.Dispose();
        if (!process.HasExited)
            process.Kill(entireProcessTree: true);
        await process.WaitForExitAsync();
        process.Dispose();
    }
}
