using Trivia.Blueprint.Codegen.Model;
using Trivia.Blueprint.Codegen.Plan;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

public sealed class ScaffoldTests
{
    [Fact]
    public void FR_AS_01_And_FR_AS_03_AddAspireProjectsAsScaffolds()
    {
        using TempDirectory root = new();
        LoadedBlueprint bank = ModelLoader.Load(FixtureTests.Bank);
        FilePlan plan = ApiPlan.Create(root.Path, bank);
        string[] projects = ["AppHost", "ServiceDefaults", "MigrationService"];
        foreach (string project in projects)
        {
            string path = $"src/BackOffice.{project}/BackOffice.{project}.csproj";
            Assert.Contains(plan.Files, file => file.Path == path && file.Kind == FileKind.Scaffold);
        }

        PlanWriter.Write(root.Path, plan);
        string Read(string path) => File.ReadAllText(Path.Combine(root.Path, path));
        string solution = Read("BackOffice.slnx");
        Assert.All(projects, project => Assert.Contains($"BackOffice.{project}.csproj", solution));
        string host = Read("src/BackOffice.AppHost/Program.cs");
        Assert.Contains("AddPostgres", host);
        Assert.Contains("AddViteApp", host);
        string defaults = Read("src/BackOffice.ServiceDefaults/Extensions.cs");
        Assert.Contains("AddOpenTelemetry", defaults);
        Assert.Contains("AddStandardResilienceHandler", defaults);
        Assert.Contains("AddServiceDiscovery", defaults);
        Assert.Contains("MapHealthChecks", defaults);
        Assert.Contains("Aspire.Hosting.PostgreSQL", Read("Directory.Packages.props"));
    }

    [Fact]
    public void FR_AS_01_RunsMigrationsToCompletionBeforeStartingTheApi()
    {
        using TempDirectory root = new();
        PlanWriter.Write(root.Path, ApiPlan.Create(root.Path, ModelLoader.Load(FixtureTests.Bank)));
        string Read(string project, string file) => File.ReadAllText(Path.Combine(root.Path, "src", $"BackOffice.{project}", file));

        string host = Read("AppHost", "Program.cs");
        Assert.Contains("AddProject<Projects.BackOffice_MigrationService>", host);
        Assert.Contains(".WaitFor(db)", host);
        Assert.Contains(".WaitForCompletion(migrations)", host);
        Assert.Contains("AddHostedService<Worker>()", Read("MigrationService", "Program.cs"));
        string worker = Read("MigrationService", "Worker.cs");
        Assert.Contains("db.Database.CreateExecutionStrategy().ExecuteAsync(db.Database.MigrateAsync", worker);
        Assert.Contains("StopApplication()", worker);
        Assert.DoesNotContain("Migrate", Read("Api", "Program.cs"));
    }

    [Fact]
    public void FR_NC_02_EmitsAStandaloneSolutionAndPartialFiles()
    {
        using TempDirectory root = new();
        FilePlan plan = ApiPlan.Create(root.Path, ModelLoader.Load(FixtureTests.Bank));
        Assert.Empty(plan.Diagnostics);
        PlanWriter.Write(root.Path, plan);
        string Read(string path) => File.ReadAllText(Path.Combine(root.Path, path));
        Assert.Contains("src/BackOffice.Api/BackOffice.Api.csproj", Read("BackOffice.slnx"));
        Assert.Contains("Microsoft.AspNetCore.OpenApi", Read("Directory.Packages.props"));
        Assert.Contains("net10.0", Read("src/BackOffice.Api/BackOffice.Api.csproj"));
        Assert.Contains("MapGeneratedEndpoints", Read("src/BackOffice.Api/Program.cs"));
        Assert.Contains("partial class Customer", Read("src/BackOffice.Api/Features/Customer/Customer.cs"));
        Assert.Contains("OnModelCreatingPartial", Read("src/BackOffice.Api/Data/AppDbContext.cs"));

        Assert.All(ApiPlan.Create(root.Path, ModelLoader.Load(FixtureTests.Bank)).Files,
            file => Assert.Equal(FileAction.Unchanged, file.Action));
    }
}
