using System.Text.Json;
using Trivia.Blueprint.Codegen.Model;
using VerifyTests;
using VerifyXunit;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests;

public sealed class OpenApiTests
{
    [Fact]
    [Trait("Category", "Build")]
    public async Task FR_NC_09_BankDocumentIsCorrectAndByteStable()
    {
        LoadedBlueprint bank = ModelLoader.Load(FixtureTests.Bank);
        using GeneratedProject first = new(bank);
        using GeneratedProject second = new(bank);
        await first.BuildAsync();
        await second.BuildAsync();
        byte[] bytes = File.ReadAllBytes(first.DocumentPath);
        Assert.Equal(bytes, File.ReadAllBytes(second.DocumentPath));
        using JsonDocument parsed = JsonDocument.Parse(bytes);
        JsonElement document = parsed.RootElement;
        Assert.StartsWith("3.1.", document.GetProperty("openapi").GetString());
        JsonElement paths = document.GetProperty("paths");
        JsonElement list = paths.GetProperty("/api/v1/customers").GetProperty("get");
        Assert.Equal("listCustomers", list.GetProperty("operationId").GetString());
        Assert.Equal("Customers", list.GetProperty("tags")[0].GetString());
        JsonElement page = list.GetProperty("parameters").EnumerateArray()
            .Single(item => item.GetProperty("name").GetString() == "pageSize").GetProperty("schema");
        Assert.Equal("integer", page.GetProperty("type").GetString());
        Assert.Equal(20, page.GetProperty("default").GetInt32());
        Assert.Equal(200, page.GetProperty("maximum").GetInt32());
        JsonElement details = paths.GetProperty("/api/v1/customers/{id}");
        Assert.Equal("getCustomerById", details.GetProperty("get").GetProperty("operationId").GetString());
        Assert.Equal("updateCustomer", details.GetProperty("put").GetProperty("operationId").GetString());
        Assert.Equal("deleteCustomer", details.GetProperty("delete").GetProperty("operationId").GetString());
        JsonElement custom = paths.GetProperty("/api/v1/customers/{id}/approve-kyc").GetProperty("post");
        Assert.Equal("approveKycCustomer", custom.GetProperty("operationId").GetString());
        Assert.Contains("501", custom.GetProperty("responses").EnumerateObject().Select(response => response.Name));

        JsonElement schemas = document.GetProperty("components").GetProperty("schemas");
        Assert.Equal(new[] { "pending", "active", "suspended" },
            schemas.GetProperty("CustomerStatus").GetProperty("enum").EnumerateArray().Select(value => value.GetString()));
        Assert.Equal("object", schemas.GetProperty("JsonDocument").GetProperty("type").GetString());
        JsonElement create = schemas.GetProperty("CreateCustomerRequest");
        Assert.Equal(new[] { "fullName", "email" }, create.GetProperty("required").EnumerateArray().Select(item => item.GetString()));
        JsonElement properties = create.GetProperty("properties");
        Assert.Equal("email", properties.GetProperty("email").GetProperty("format").GetString());
        Assert.Equal("string", properties.GetProperty("fullName").GetProperty("type").GetString());
        Assert.Equal("pending", properties.GetProperty("status").GetProperty("default").GetString());
        Assert.Equal(1_000_000, properties.GetProperty("creditLimit").GetProperty("maximum").GetInt32());

        foreach (string name in new[] { "CustomerResponse", "CreateCustomerRequest", "UpdateCustomerRequest", "CustomerPage" })
            Assert.True(schemas.TryGetProperty(name, out _));
        await Verifier.Verify(File.ReadAllText(first.DocumentPath)).UseDirectory("Snapshots").UseFileName("BankOpenApi").DisableDiff();
    }
}
