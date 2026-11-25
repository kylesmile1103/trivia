using System.Runtime.CompilerServices;
using VerifyTests;
using VerifyXunit;
using Trivia.Blueprint.Codegen.Emit;
using Trivia.Blueprint.Codegen.Model;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

public sealed class EmitterTests
{
    private static ModelDocument Bank => ModelLoader.Load(FixtureTests.Bank).Model;

    [Theory]
    [InlineData("Customer")]
    [InlineData("Account")]
    [InlineData("Transaction")]
    public Task FR_NC_04_Entity(string name)
    {
        ModelDocument bank = Bank;
        return Snapshot(name, CSharp.Print(EntityEmitter.Emit(bank, bank.Entities.Single(entity => entity.Name == name))));
    }

    [Fact]
    public Task FR_NC_04_Enum()
        => Snapshot("CustomerStatus", CSharp.Print(EnumEmitter.Emit(Bank, Bank.Enums[0])));

    [Fact]
    public Task FR_NC_04_DbContext()
        => Snapshot("AppDbContext", CSharp.Print(DbContextEmitter.Emit(Bank)));

    private static Task Snapshot(string name, string source, [CallerFilePath] string sourceFile = "")
        => Verifier.Verify(source, sourceFile: sourceFile).UseDirectory("Snapshots").UseFileName(name).DisableDiff();
}
