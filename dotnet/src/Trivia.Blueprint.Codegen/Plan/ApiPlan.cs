using Trivia.Blueprint.Codegen.Model;

namespace Trivia.Blueprint.Codegen.Plan;

public static class ApiPlan
{
    public static FilePlan Create(string root, LoadedBlueprint input, bool force = false)
        => PlanWriter.Plan(root, input.ModelRev, $"src/{input.AppName}.Api", [], force);
}
