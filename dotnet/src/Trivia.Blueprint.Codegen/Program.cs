using System.CommandLine;

namespace Trivia.Blueprint.Codegen;

public static class Program
{
    public static Task<int> Main(string[] args) => RunAsync(args);

    public static Task<int> RunAsync(string[] args)
    {
        RootCommand command = new("Generate a .NET API from a Trivia blueprint.");
        return command.Parse(args).InvokeAsync();
    }
}
