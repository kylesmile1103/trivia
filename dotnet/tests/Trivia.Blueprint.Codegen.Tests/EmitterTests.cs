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

    [Fact]
    public Task FR_NC_05_Contracts()
        => Snapshot("CustomerContracts", CSharp.Print(ContractsEmitter.Emit(Bank, Bank.Entities[0])));

    [Fact]
    public Task FR_NC_06_CrudEndpoints()
        => Snapshot("CustomerEndpoints", CSharp.Print(EndpointsEmitter.Emit(Bank, Bank.Entities[0])));

    [Fact]
    public Task FR_NC_07_SharedListParser()
        => Snapshot("ListQuery", CSharp.Print(ListQueryEmitter.Emit(Bank)));

    [Fact]
    public Task FR_NC_10_ProblemDetailsHandler()
        => Snapshot("ApiProblem", CSharp.Print(ApiProblemEmitter.Emit(Bank)));

    [Fact]
    public Task FR_NC_09_ApiRegistration()
        => Snapshot("ApiRegistration", CSharp.Print(ApiRegistrationEmitter.Emit(ModelLoader.Load(FixtureTests.Bank))));

    private static Task Snapshot(string name, string source, [CallerFilePath] string sourceFile = "")
        => Verifier.Verify(source, sourceFile: sourceFile).UseDirectory("Snapshots").UseFileName(name).DisableDiff();
}
