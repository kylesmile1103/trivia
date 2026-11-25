using Trivia.Blueprint.Codegen.Model;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

public sealed class BuildTests
{
    [Fact]
    [Trait("Category", "Build")]
    public async Task FR_NC_11_BankSolutionBuildsWithWarningsAsErrors()
    {
        using GeneratedProject project = new(ModelLoader.Load(FixtureTests.Bank));
        string output = await project.BuildAsync();
        Assert.Contains("0 Warning(s)", output);
        Assert.True(File.Exists(project.DocumentPath), "Build produced no OpenAPI document.");
    }
}
