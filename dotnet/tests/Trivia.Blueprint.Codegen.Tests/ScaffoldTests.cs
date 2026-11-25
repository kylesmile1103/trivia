using Trivia.Blueprint.Codegen.Model;
using Trivia.Blueprint.Codegen.Plan;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

public sealed class ScaffoldTests
{
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
