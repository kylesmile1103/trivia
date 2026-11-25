using Trivia.Blueprint.Codegen.Emit;
using Trivia.Blueprint.Codegen.Model;
using Trivia.Blueprint.Codegen.Scaffold;

namespace Trivia.Blueprint.Codegen.Plan;

public static class ApiPlan
{
    public static FilePlan Create(string root, LoadedBlueprint input, bool force = false)
    {
        string api = $"src/{input.AppName}.Api";
        ModelDocument model = input.Model;
        return PlanWriter.Plan(root, input.ModelRev, api, EmitFiles(api, model).Concat(EmitProject(api, input)), force);
    }

    private static IEnumerable<EmittedFile> EmitProject(string api, LoadedBlueprint input)
    {
        yield return new($"{api}/Generated/ApiRegistration.g.cs", FileKind.Generated, CSharp.Print(ApiRegistrationEmitter.Emit(input)));
        yield return new($"{api}/Generated/ApiProblem.g.cs", FileKind.Generated, CSharp.Print(ApiProblemEmitter.Emit(input.Model)));
        yield return new($"{api}/Generated/ListQuery.g.cs", FileKind.Generated, CSharp.Print(ListQueryEmitter.Emit(input.Model)));
        foreach (EmittedFile file in ScaffoldEmitter.Emit(input, api))
            yield return file;
    }

    private static IEnumerable<EmittedFile> EmitFiles(string api, ModelDocument model)
    {
        foreach (ModelEnum values in model.Enums)
            yield return new($"{api}/Enums/{values.Name}.g.cs", FileKind.Generated, CSharp.Print(EnumEmitter.Emit(model, values)));
        foreach (ModelEntity entity in model.Entities)
        {
            string feature = $"{api}/Features/{entity.Name}/{entity.Name}";
            yield return new($"{feature}.g.cs", FileKind.Generated, CSharp.Print(EntityEmitter.Emit(model, entity)));
            yield return new($"{feature}Contracts.g.cs", FileKind.Generated, CSharp.Print(ContractsEmitter.Emit(model, entity)));
            yield return new($"{feature}Endpoints.g.cs", FileKind.Generated, CSharp.Print(EndpointsEmitter.Emit(model, entity)));
        }
        yield return new($"{api}/Data/AppDbContext.g.cs", FileKind.Generated, CSharp.Print(DbContextEmitter.Emit(model)));
    }
}
