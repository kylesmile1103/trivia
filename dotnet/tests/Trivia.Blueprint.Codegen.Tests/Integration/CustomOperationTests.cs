using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Trivia.Blueprint.Codegen.Model;
using Trivia.Blueprint.Codegen.Plan;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests.Integration;

[Collection("PostgreSQL")]
[Trait("Category", "Integration")]
public sealed class CustomOperationTests(PostgresFixture postgres)
{
    [Fact]
    public async Task FR_NC_08_CustomOperationStartsAsAStubAndSurvivesRegeneration()
    {
        LoadedBlueprint input = ModelLoader.Load(FixtureTests.Bank);
        using TempDirectory root = new();
        const string stub = "src/BackOffice.Api/Features/Customer/Customer.ApproveKyc.cs";
        FilePlan planned = ApiPlan.Create(root.Path, input);
        Assert.Equal(stub, Assert.Single(planned.Todo).Path);
        using GeneratedProject project = new(input);
        string path = Path.Combine(project.Root, stub);
        Assert.True(File.Exists(path));

        const string customers = "/api/v1/customers";
        await using (RunningApi api = await postgres.StartAsync(project))
        {
            using HttpResponseMessage stubbed = await api.Client.PostAsJsonAsync(
                customers + "/" + Guid.NewGuid() + "/approve-kyc", new { reason = "verified" });
            await CrudTests.ReadProblem(stubbed, HttpStatusCode.NotImplemented);
        }

        string implemented = """
            using BackOffice.Data;
            using Microsoft.AspNetCore.Http.HttpResults;

            namespace BackOffice.Features.Customer;

            public static partial class CustomerEndpoints
            {
                private static async partial Task<Results<Ok<CustomerResponse>, ProblemHttpResult>> HandleApproveKycAsync(
                    Guid id, ApproveKycCustomerRequest input, AppDbContext db, HttpContext http, CancellationToken cancellationToken)
                {
                    Customer? customer = await db.CustomerSet.FindAsync([id], cancellationToken);
                    if (customer is null)
                        return TypedResults.Problem(statusCode: 404);
                    customer.Status = BackOffice.Enums.CustomerStatus.Active;
                    customer.Notes = input.Reason;
                    await db.SaveChangesAsync(cancellationToken);
                    return TypedResults.Ok(ToResponse(customer));
                }
            }
            """;
        File.WriteAllText(path, implemented);
        FilePlan repeated = ApiPlan.Create(project.Root, input);
        Assert.Empty(repeated.Todo);
        PlanWriter.Write(project.Root, repeated);
        Assert.Equal(implemented, File.ReadAllText(path));

        await using (RunningApi api = await postgres.StartAsync(project))
        {
            using HttpResponseMessage created = await api.Client.PostAsJsonAsync(customers,
                new { fullName = "Verify Customer", email = "verify@example.test" });
            Assert.Equal(HttpStatusCode.Created, created.StatusCode);
            using HttpResponseMessage invalid = await api.Client.PostAsJsonAsync(
                created.Headers.Location + "/approve-kyc", new { reason = new string('x', 501) });
            await CrudTests.ReadProblem(invalid, HttpStatusCode.BadRequest);
            using HttpResponseMessage completed = await api.Client.PostAsJsonAsync(
                created.Headers.Location + "/approve-kyc", new { reason = "verified" });
            Assert.Equal(HttpStatusCode.OK, completed.StatusCode);
            JsonElement customer = await completed.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("active", customer.GetProperty("status").GetString());
            Assert.Equal("verified", customer.GetProperty("notes").GetString());
        }

        ModelEntity[] entities = (ModelEntity[])input.Model.Entities.Clone();
        entities[0] = entities[0] with { Api = entities[0].Api with { Custom = [] } };
        LoadedBlueprint retired = input with { Model = input.Model with { Entities = entities } };
        PlanWriter.Write(project.Root, ApiPlan.Create(project.Root, retired));
        Assert.Equal(implemented, File.ReadAllText(path));
        _ = await project.BuildAsync();
    }
}
