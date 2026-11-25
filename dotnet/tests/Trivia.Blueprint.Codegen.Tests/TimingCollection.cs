using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

/// <summary>
/// Timing budgets run with no other test class beside them. xUnit runs collections in parallel,
/// and the build tests' <c>dotnet build</c> runs would otherwise share the CPU with the clock.
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class TimingCollection
{
    public const string Name = "Timing";
}
