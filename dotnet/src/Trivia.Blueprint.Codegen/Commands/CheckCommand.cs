using System.CommandLine;
using Trivia.Blueprint.Codegen.Model;
using Trivia.Blueprint.Codegen.Plan;

namespace Trivia.Blueprint.Codegen.Commands;

internal static class CheckCommand
{
    internal static Command Create(TextWriter output) =>
        PlanCommand.CreateGenerationCommand("check", "Check whether generated files are current.", output,
            flag: null, (plan, _, _) =>
            {
                List<Diagnostic> diagnostics = [.. plan.Diagnostics];
                foreach (PlannedFile file in plan.Files)
                    if (file.Kind == FileKind.Generated && file.Action != FileAction.Unchanged &&
                        !plan.Diagnostics.Any(diagnostic => diagnostic.Doc == file.Path))
                        diagnostics.Add(new("stale_generated_file", file.Path, "", "The generated file is out of date."));
                return (diagnostics.Count == 0 ? 0 : 1, plan with { Diagnostics = diagnostics }, false);
            });
}
