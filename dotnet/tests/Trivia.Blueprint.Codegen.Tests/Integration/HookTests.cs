using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Trivia.Blueprint.Codegen.Model;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests.Integration;

[Collection("PostgreSQL")]
[Trait("Category", "Integration")]
public sealed class HookTests(PostgresFixture postgres)
{
    [Fact]
    public async Task FR_NC_08_HooksCanRejectScopeAndRollBackWrites()
    {
        using GeneratedProject project = new(ModelLoader.Load(FixtureTests.Bank));
        string path = Path.Combine(project.ApiDirectory, "Features", "Customer", "CustomerEndpoints.cs");
        Assert.True(File.Exists(path));
        File.WriteAllText(path, """
            using BackOffice.Data;
            using BackOffice.Generated;

            namespace BackOffice.Features.Customer;

            public static partial class CustomerEndpoints
            {
                static partial void ConfigureQuery(ref IQueryable<Customer> query, HttpContext http)
                {
                    if (http.Request.Headers.ContainsKey("X-Scoped"))
                        query = query.Where(customer => customer.FullName.StartsWith("Scoped"));
                }

                static partial void OnCreating(Customer entity, CreateCustomerRequest request, AppDbContext db)
                {
                    if (request.FullName == "Reject")
                        throw new ApiProblemException(400, "Rejected by hook.");
                }

                static partial void OnCreated(Customer entity, AppDbContext db)
                {
                    if (entity.FullName == "Rollback")
                        throw new ApiProblemException(409, "Rejected after save.", "hook_rejected");
                }
            }
            """);
        await using RunningApi api = await postgres.StartAsync(project);
        const string pathRoot = "/api/v1/customers";
        async Task<HttpResponseMessage> Create(string name) =>
            await api.Client.PostAsJsonAsync(pathRoot, new { fullName = name, email = name.Replace(" ", "") + "@example.test" });

        using HttpResponseMessage rejected = await Create("Reject");
        Assert.Equal("Rejected by hook.", (await CrudTests.ReadProblem(rejected, HttpStatusCode.BadRequest)).GetProperty("title").GetString());
        using HttpResponseMessage rolledBack = await Create("Rollback");
        Assert.Equal("hook_rejected", (await CrudTests.ReadProblem(rolledBack, HttpStatusCode.Conflict)).GetProperty("code").GetString());
        using HttpResponseMessage inside = await Create("Scoped Customer");
        using HttpResponseMessage outside = await Create("Other Customer");
        Assert.Equal(HttpStatusCode.Created, inside.StatusCode);
        Assert.Equal(HttpStatusCode.Created, outside.StatusCode);
        Assert.Equal(2, (await api.Client.GetFromJsonAsync<JsonElement>(pathRoot)).GetProperty("total").GetInt32());

        api.Client.DefaultRequestHeaders.Add("X-Scoped", "1");
        JsonElement scoped = await api.Client.GetFromJsonAsync<JsonElement>(pathRoot);
        Assert.Equal(1, scoped.GetProperty("total").GetInt32());
        Assert.Equal("Scoped Customer", scoped.GetProperty("items")[0].GetProperty("fullName").GetString());
        using HttpResponseMessage hidden = await api.Client.GetAsync(outside.Headers.Location);
        await CrudTests.ReadProblem(hidden, HttpStatusCode.NotFound);
        using HttpResponseMessage cannotDelete = await api.Client.DeleteAsync(outside.Headers.Location);
        await CrudTests.ReadProblem(cannotDelete, HttpStatusCode.NotFound);
    }
}
