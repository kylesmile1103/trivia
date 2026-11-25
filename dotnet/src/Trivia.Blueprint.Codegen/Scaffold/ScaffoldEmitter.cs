using System.Xml.Linq;
using Trivia.Blueprint.Codegen.Emit;
using Trivia.Blueprint.Codegen.Model;
using Trivia.Blueprint.Codegen.Plan;

namespace Trivia.Blueprint.Codegen.Scaffold;

internal static class ScaffoldEmitter
{
    private static readonly string[] Projects = ["AppHost", "ServiceDefaults", "MigrationService"];

    internal static IEnumerable<EmittedFile> Emit(LoadedBlueprint input, string api)
    {
        string app = input.AppName;
        string space = input.Model.Namespace;
        yield return new($"{app}.slnx", FileKind.Scaffold, Render("Solution.slnx", space, app));
        yield return new(".config/dotnet-tools.json", FileKind.Scaffold, Render("dotnet-tools.json", space, app));
        yield return new("Directory.Packages.props", FileKind.Scaffold, DependencyVersions());
        yield return new($"{api}/{app}.Api.csproj", FileKind.Scaffold, Render("Api.csproj", space, app));
        yield return new($"{api}/Program.cs", FileKind.Scaffold, Render("Program.cs", space, app));
        yield return new($"{api}/Data/AppDbContext.cs", FileKind.Scaffold, Render("AppDbContext.cs", space, app));
        foreach (string project in Projects)
            yield return new($"src/{app}.{project}/{app}.{project}.csproj", FileKind.Scaffold,
                Render($"{project}/{project}.csproj", space, app));
        yield return new($"src/{app}.AppHost/Program.cs", FileKind.Scaffold,
            Render("AppHost/Program.cs", space, app)
                .Replace("{{WebResource}}", input.App?.Targets.Web == "next-refine" ? "AddNextJsApp" : "AddViteApp",
                    StringComparison.Ordinal));
        yield return new($"src/{app}.AppHost/Properties/launchSettings.json", FileKind.Scaffold,
            Render("AppHost/launchSettings.json", space, app));
        yield return new($"src/{app}.ServiceDefaults/Extensions.cs", FileKind.Scaffold,
            Render("ServiceDefaults/Extensions.cs", space, app));
        yield return new($"src/{app}.MigrationService/Program.cs", FileKind.Scaffold,
            Render("MigrationService/Program.cs", space, app));
        yield return new($"src/{app}.MigrationService/Worker.cs", FileKind.Scaffold,
            Render("MigrationService/Worker.cs", space, app));
        foreach (ModelEntity entity in input.Model.Entities)
        {
            string feature = $"{api}/Features/{entity.Name}/{entity.Name}";
            yield return new($"{feature}.cs", FileKind.Scaffold, Render("Entity.cs", space, app, entity.Name));
            yield return new($"{feature}Endpoints.cs", FileKind.Scaffold, Render("Endpoints.cs", space, app, entity.Name));
            foreach (CustomOperation operation in entity.Api.Custom ?? [])
            {
                string stub = Render("CustomOperation.cs", space, app, entity.Name)
                    .Replace("{{Signature}}", CustomOperationEmitter.Signature(input.Model, entity, operation, bind: false), StringComparison.Ordinal)
                    .Replace("{{Result}}", CustomOperationEmitter.Result(input.Model, operation), StringComparison.Ordinal);
                yield return new($"{feature}.{CustomOperationEmitter.Suffix(operation)}.cs", FileKind.Scaffold, stub,
                    $"Implement {operation.Name} for {entity.Name}.");
            }
        }
    }

    private static string Render(string template, string space, string app, string entity = "")
        => ReadResource($"Scaffold/{template}.txt")
            .Replace("{{Namespace}}", space, StringComparison.Ordinal)
            .Replace("{{App}}", app, StringComparison.Ordinal)
            .Replace("{{Entity}}", entity, StringComparison.Ordinal);

    private static string DependencyVersions()
    {
        IEnumerable<string> templates = Projects.Select(project => $"{project}/{project}").Prepend("Api");
        HashSet<string> references = templates
            .SelectMany(template => XElement.Parse(ReadResource($"Scaffold/{template}.csproj.txt")).Descendants("PackageReference"))
            .Select(reference => (string)reference.Attribute("Include")!)
            .ToHashSet(StringComparer.Ordinal);
        XElement dependencies = XElement.Parse(ReadResource("PackageVersions"));
        foreach (XElement version in dependencies.Descendants("PackageVersion").ToArray())
            if (!references.Remove((string)version.Attribute("Include")!))
                version.Remove();
        if (references.Count != 0)
            throw new InvalidOperationException("Unpinned scaffold dependencies: " + string.Join(", ", references));
        return dependencies.ToString().Replace("\r\n", "\n", StringComparison.Ordinal) + "\n";
    }

    private static string ReadResource(string name)
    {
        using Stream resource = typeof(ScaffoldEmitter).Assembly.GetManifestResourceStream(name)
            ?? typeof(ScaffoldEmitter).Assembly.GetManifestResourceStream(name.Replace('/', '\\').Replace("Scaffold\\", "Scaffold/", StringComparison.Ordinal))
            ?? throw new InvalidOperationException($"Missing scaffold resource: {name}");
        using StreamReader reader = new(resource);
        return reader.ReadToEnd().Replace("\r\n", "\n", StringComparison.Ordinal);
    }
}
