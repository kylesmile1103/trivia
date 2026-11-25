using System.CommandLine;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Trivia.Blueprint.Codegen.Model;
using Trivia.Blueprint.Codegen.Plan;

namespace Trivia.Blueprint.Codegen.Commands;

internal static class PlanCommand
{
    private static readonly JsonSerializerOptions Json = new(ModelLoader.Json)
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) }
    };

    internal static Command Create(TextWriter output)
    {
        Option<bool> content = new("--content") { Description = "Include proposed file contents." };
        return CreateGenerationCommand("plan", "Preview the generated files.", output, content,
            (plan, _, includeContent) => (plan.Diagnostics.Count == 0 ? 0 : 1, plan, includeContent));
    }

    internal static Command CreateGenerationCommand(string name, string description, TextWriter output,
        Option<bool>? flag, Func<FilePlan, string, bool, (int ExitCode, FilePlan Result, bool Content)> action)
    {
        Option<string> blueprint = new("--blueprint") { Required = true, Description = "The blueprint directory." };
        Option<string> root = new("--root") { Required = true, Description = "The output solution directory." };
        Option<string> web = new("--web-dir")
        {
            Description = "The solution-relative directory for the web app.",
            DefaultValueFactory = _ => "web"
        };
        Command command = new(name, description);
        command.Options.Add(blueprint);
        command.Options.Add(root);
        command.Options.Add(web);
        if (flag is not null)
            command.Options.Add(flag);

        command.SetAction(parse =>
        {
            string rootPath = parse.GetValue(root)!;
            bool enabled = flag is not null && parse.GetValue(flag);
            try
            {
                LoadedBlueprint input = ModelLoader.Load(parse.GetValue(blueprint)!);
                FilePlan plan = ApiPlan.Create(rootPath, input, force: name == "write" && enabled, webDirectory: parse.GetValue(web)!);
                (int exitCode, FilePlan result, bool content) = action(plan, rootPath, enabled);
                Print(output, result, content);
                return exitCode;
            }
            catch (BlueprintInputException exception)
            {
                Print(output, new(Hashing.Generator, "", [], [], exception.Diagnostics), content: false);
                return 1;
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException)
            {
                Print(output, new(Hashing.Generator, "", [], [],
                    [new("invalid_root", rootPath, "", exception.Message)]), content: false);
                return 1;
            }
        });
        return command;
    }

    private static void Print(TextWriter output, FilePlan plan, bool content)
    {
        output.WriteLine(JsonSerializer.Serialize(new
        {
            plan.Generator,
            plan.ModelRev,
            Files = plan.Files.Select(file => new
            {
                file.Path, file.Kind, file.Action, file.Hash,
                Content = content && file.After is not null ? Encoding.UTF8.GetString(file.After) : null
            }),
            plan.Todo,
            plan.Diagnostics
        }, Json));
    }
}
