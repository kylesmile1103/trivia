using System.CommandLine;
using Trivia.Blueprint.Codegen.Plan;

namespace Trivia.Blueprint.Codegen.Commands;

internal static class WriteCommand
{
    internal static Command Create(TextWriter output) =>
        PlanCommand.CreateGenerationCommand("write", "Apply the file plan.", output,
            new Option<bool>("--force") { Description = "Replace or remove modified generated files." },
            (plan, root, _) =>
            {
                try
                {
                    PlanWriter.Write(root, plan);
                    return (0, plan, false);
                }
                catch (WriteRefusedException exception)
                {
                    return (exception.ExitCode, plan with { Diagnostics = exception.Diagnostics }, false);
                }
            });
}
