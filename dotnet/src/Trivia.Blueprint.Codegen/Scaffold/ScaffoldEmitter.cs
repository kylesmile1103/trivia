using System.Xml.Linq;
using Trivia.Blueprint.Codegen.Model;
using Trivia.Blueprint.Codegen.Plan;

namespace Trivia.Blueprint.Codegen.Scaffold;

internal static class ScaffoldEmitter
{
    internal static IEnumerable<EmittedFile> Emit(LoadedBlueprint input, string api)
    {
        string app = input.AppName;
        string space = input.Model.Namespace;
        yield return new($"{app}.slnx", FileKind.Scaffold, Render("Solution.slnx", space, app));
        yield return new("Directory.Packages.props", FileKind.Scaffold, DependencyVersions());
        yield return new($"{api}/{app}.Api.csproj", FileKind.Scaffold, Render("Api.csproj", space, app));
        yield return new($"{api}/Program.cs", FileKind.Scaffold, Render("Program.cs", space, app));
        yield return new($"{api}/Data/AppDbContext.cs", FileKind.Scaffold, Render("AppDbContext.cs", space, app));
        foreach (ModelEntity entity in input.Model.Entities)
        {
            string feature = $"{api}/Features/{entity.Name}/{entity.Name}";
            yield return new($"{feature}.cs", FileKind.Scaffold, Render("Entity.cs", space, app, entity.Name));
            yield return new($"{feature}Endpoints.cs", FileKind.Scaffold, Render("Endpoints.cs", space, app, entity.Name));
        }
    }

    private static string Render(string template, string space, string app, string entity = "")
        => ReadResource($"Scaffold/{template}.txt")
            .Replace("{{Namespace}}", space, StringComparison.Ordinal)
            .Replace("{{App}}", app, StringComparison.Ordinal)
            .Replace("{{Entity}}", entity, StringComparison.Ordinal);

    private static string DependencyVersions()
    {
        XElement template = XElement.Parse(ReadResource("Scaffold/Api.csproj.txt"));
        HashSet<string> references = template.Descendants("PackageReference")
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
        using Stream resource = typeof(ScaffoldEmitter).Assembly.GetManifestResourceStream(name)!;
        using StreamReader reader = new(resource);
        return reader.ReadToEnd().Replace("\r\n", "\n", StringComparison.Ordinal);
    }
}
