using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

public sealed class ToolTests
{
    [Fact]
    public async Task FR_NC_01_ToolHasACommandLine()
    {
        Assert.Equal(0, await Program.RunAsync(["--help"]));
    }
}
