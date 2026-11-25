using Trivia.Blueprint.Codegen.Plan;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

public sealed class PlanWriterTests
{
    private const string Api = "src/Bank.Api";
    private const string Generated = Api + "/Features/Customer/Customer.g.cs";
    private const string Scaffold = Api + "/Features/Customer/Customer.cs";
    private const string Other = Api + "/Features/Account/Account.g.cs";

    [Fact]
    public void FR_NC_02_CreatesUpdatesAndPreservesScaffold()
    {
        using TempDirectory root = new();
        EmittedFile[] first = [new(Generated, FileKind.Generated, "first\n"), new(Scaffold, FileKind.Scaffold, "partial\n")];
        FilePlan create = Plan(root, first);
        Assert.All(create.Files, file => Assert.Equal(FileAction.Create, file.Action));
        Assert.Empty(Directory.GetFileSystemEntries(root.Path));
        PlanWriter.Write(root.Path, create);
        Assert.EndsWith("first\n", File.ReadAllText(At(root, Generated)));

        string scaffold = At(root, Scaffold);
        File.AppendAllText(scaffold, "// user edit");
        EmittedFile[] changed = [new(Generated, FileKind.Generated, "second\n"), first[1]];
        FilePlan update = Plan(root, changed);
        Assert.Equal(FileAction.Update, update.Files[0].Action);
        Assert.Equal(FileAction.Unchanged, update.Files[1].Action);
        PlanWriter.Write(root.Path, update);
        Assert.EndsWith("second\n", File.ReadAllText(At(root, Generated)));
        Assert.Equal("partial\n// user edit", File.ReadAllText(scaffold));
        Assert.All(Plan(root, changed).Files, file => Assert.Equal(FileAction.Unchanged, file.Action));

        FilePlan remove = Plan(root, []);
        Assert.Equal(FileAction.Delete, Assert.Single(remove.Files).Action);
        PlanWriter.Write(root.Path, remove);
        Assert.False(File.Exists(At(root, Generated)));
        Assert.True(File.Exists(scaffold));
    }

    [Fact]
    public void FR_NC_03_EditedGeneratedFilesRefuseTheWholeWriteUnlessForced()
    {
        using TempDirectory root = new();
        PlanWriter.Write(root.Path, Plan(root, [new(Generated, FileKind.Generated, "first\n")]));
        string path = At(root, Generated);
        File.AppendAllText(path, "// user edit");
        string edited = File.ReadAllText(path);
        EmittedFile[] output = [new(Other, FileKind.Generated, "other\n"), new(Generated, FileKind.Generated, "second\n")];

        FilePlan guarded = Plan(root, output);
        WriteRefusedException refusal = Assert.Throws<WriteRefusedException>(() => PlanWriter.Write(root.Path, guarded));
        Assert.Equal(2, refusal.ExitCode);
        Assert.Contains(Generated, refusal.Message);
        Assert.Equal(edited, File.ReadAllText(path));
        Assert.False(File.Exists(At(root, Other)));
        Assert.Throws<WriteRefusedException>(() => PlanWriter.Write(root.Path, Plan(root, [])));

        PlanWriter.Write(root.Path, Plan(root, output, force: true));
        Assert.EndsWith("second\n", File.ReadAllText(path));
        Assert.True(File.Exists(At(root, Other)));
    }

    [Theory]
    [InlineData("../outside.g.cs")]
    [InlineData("src/Bank.Api/../../outside.g.cs")]
    [InlineData("/tmp/outside.g.cs")]
    [InlineData("src\\..\\outside.g.cs")]
    public void NFR_05_EscapingPathsRefuseTheWholeWrite(string escape)
    {
        using TempDirectory root = new();
        FilePlan invalid = Plan(root, [new(Generated, FileKind.Generated, "new\n"), new(escape, FileKind.Generated, "escape\n")]);
        Assert.Contains(invalid.Diagnostics, diagnostic => diagnostic.Code == "path_escape");
        Assert.Throws<WriteRefusedException>(() => PlanWriter.Write(root.Path, invalid));
        Assert.Empty(Directory.GetFileSystemEntries(root.Path));
    }

    [Fact]
    public void NFR_12_AChangeAfterPlanningRefusesTheWholeWrite()
    {
        using TempDirectory root = new();
        FilePlan plan = Plan(root, [new(Other, FileKind.Generated, "other\n"), new(Generated, FileKind.Generated, "new\n")]);
        Directory.CreateDirectory(Path.GetDirectoryName(At(root, Generated))!);
        File.WriteAllText(At(root, Generated), "created concurrently");
        Assert.Throws<WriteRefusedException>(() => PlanWriter.Write(root.Path, plan));
        Assert.False(File.Exists(At(root, Other)));
        Assert.Equal("created concurrently", File.ReadAllText(At(root, Generated)));
    }

    [Fact]
    public void NFR_05_SymlinkDirectoriesCannotEscapeTheRoot()
    {
        if (OperatingSystem.IsWindows())
            return; // Creating symlinks on Windows requires Developer Mode or administrator privileges.
        using TempDirectory root = new();
        using TempDirectory outside = new();
        Directory.CreateSymbolicLink(At(root, "src"), outside.Path);
        FilePlan plan = Plan(root, [new(Generated, FileKind.Generated, "new\n")], force: true);
        Assert.Throws<WriteRefusedException>(() => PlanWriter.Write(root.Path, plan));
        Assert.Empty(Directory.GetFileSystemEntries(outside.Path));
    }

    private static FilePlan Plan(TempDirectory root, EmittedFile[] output, bool force = false)
        => PlanWriter.Plan(root.Path, "sha256:fixture", Api, output, force);

    private static string At(TempDirectory root, string relative) => Path.Combine(root.Path, relative);
}
