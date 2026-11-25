using Trivia.Blueprint.Codegen.Emit;
using Trivia.Blueprint.Codegen.Model;

namespace Trivia.Blueprint.Codegen.Plan;

public static class ApiPlan
{
    public static FilePlan Create(string root, LoadedBlueprint input, bool force = false)
    {
        string api = $"src/{input.AppName}.Api";
        ModelDocument model = input.Model;
        return PlanWriter.Plan(root, input.ModelRev, api, EmitFiles(api, model), force);
    }

    private static IEnumerable<EmittedFile> EmitFiles(string api, ModelDocument model)
    {
        foreach (ModelEnum values in model.Enums)
            yield return new($"{api}/Enums/{values.Name}.g.cs", FileKind.Generated, CSharp.Print(EnumEmitter.Emit(model, values)));
        foreach (ModelEntity entity in model.Entities)
            yield return new($"{api}/Features/{entity.Name}/{entity.Name}.g.cs", FileKind.Generated, CSharp.Print(EntityEmitter.Emit(model, entity)));
        yield return new($"{api}/Data/AppDbContext.g.cs", FileKind.Generated, CSharp.Print(DbContextEmitter.Emit(model)));
    }
}
