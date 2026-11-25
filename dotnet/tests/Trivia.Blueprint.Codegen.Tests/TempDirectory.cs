namespace Trivia.Blueprint.Codegen.Tests;

internal sealed class TempDirectory : IDisposable
{
    public string Path { get; } = Directory.CreateTempSubdirectory("trivia-dotnet-").FullName;

    public void Dispose() => Directory.Delete(Path, recursive: true);
}
