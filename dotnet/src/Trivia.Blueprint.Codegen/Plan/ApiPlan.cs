using System.Text.RegularExpressions;
using Trivia.Blueprint.Codegen.Emit;
using Trivia.Blueprint.Codegen.Model;
using Trivia.Blueprint.Codegen.Scaffold;

namespace Trivia.Blueprint.Codegen.Plan;

public static class ApiPlan
{
    public static FilePlan Create(string root, LoadedBlueprint input, bool force = false, string webDirectory = "web")
    {
        if (webDirectory.Split('/').Any(part =>
            !Regex.IsMatch(part, @"\A[A-Za-z0-9._ -]+\z") || part.Trim() != part || part is "." or ".."))
            throw new IOException("The web directory must be a solution-relative path with no parent segments.");
        _ = Ownership.Resolve(Path.GetFullPath(root), $"{webDirectory}/openapi", directory: true);
        string api = $"src/{input.AppName}.Api";
        ModelDocument model = input.Model;
        FilePlan plan = PlanWriter.Plan(root, input.ModelRev, api, EmitFiles(api, model).Concat(EmitProject(api, input, webDirectory)), force);
        return AuthWarning(input) is Diagnostic warning ? plan with { Diagnostics = [.. plan.Diagnostics, warning] } : plan;
    }

    // `none` stays the development default, but an API published that way answers anyone.
    private static Diagnostic? AuthWarning(LoadedBlueprint input)
    {
        AppAuth? auth = input.App?.Auth;
        if ((auth?.Mode ?? "none") != "none")
            return null;
        return new("auth_none", ModelLoader.AppFile, auth is null ? "" : "/auth/mode",
            "auth.mode is none, so the generated API accepts every request without authentication and serves " +
            "its OpenAPI document only in Development. Before publishing it, set auth.mode to oidc or put an " +
            "authenticating gateway in front of it.", "warning");
    }

    private static IEnumerable<EmittedFile> EmitProject(string api, LoadedBlueprint input, string webDirectory)
    {
        yield return new($"{api}/Generated/ApiRegistration.g.cs", FileKind.Generated, CSharp.Print(ApiRegistrationEmitter.Emit(input)));
        yield return new($"{api}/Generated/ApiProblem.g.cs", FileKind.Generated, CSharp.Print(ApiProblemEmitter.Emit(input.Model)));
        yield return new($"{api}/Generated/ListQuery.g.cs", FileKind.Generated, CSharp.Print(ListQueryEmitter.Emit(input.Model)));
        foreach (EmittedFile file in ScaffoldEmitter.Emit(input, api, webDirectory))
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
            foreach (CustomOperation operation in entity.Api.Custom ?? [])
                yield return new($"{feature}.{CustomOperationEmitter.Suffix(operation)}.g.cs", FileKind.Generated,
                    CSharp.Print(CustomOperationEmitter.Emit(model, entity, operation)));
        }
        yield return new($"{api}/Data/AppDbContext.g.cs", FileKind.Generated, CSharp.Print(DbContextEmitter.Emit(model)));
    }
}
