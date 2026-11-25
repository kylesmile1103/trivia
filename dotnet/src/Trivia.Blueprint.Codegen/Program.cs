using System.CommandLine;
using Trivia.Blueprint.Codegen.Commands;

namespace Trivia.Blueprint.Codegen;

public static class Program
{
    public static Task<int> Main(string[] args) => RunAsync(args);

    public static Task<int> RunAsync(string[] args, TextWriter? output = null, TextWriter? error = null)
    {
        InvocationConfiguration configuration = new()
        {
            Output = output ?? Console.Out,
            Error = error ?? Console.Error
        };
        RootCommand command = new("Generate a .NET API from a Trivia blueprint.");
        command.Subcommands.Add(PlanCommand.Create(configuration.Output));
        command.Subcommands.Add(WriteCommand.Create(configuration.Output));
        command.Subcommands.Add(CheckCommand.Create(configuration.Output));
        return command.Parse(args).InvokeAsync(configuration);
    }
}
