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
        Assert.Equal("patchCustomer", details.GetProperty("patch").GetProperty("operationId").GetString());
        // Contract-sync lists PATCH as a custom operation, so its entry explains itself.
        Assert.Equal("Change some fields of the customer", details.GetProperty("patch").GetProperty("summary").GetString());
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

        // A PATCH member is optional with no default, and a required one is still never null.
        JsonElement patch = schemas.GetProperty("PatchCustomerRequest");
        Assert.False(patch.TryGetProperty("required", out _), patch.ToString());
        JsonElement patchProperties = patch.GetProperty("properties");
        Assert.Equal("string", patchProperties.GetProperty("fullName").GetProperty("type").GetString());
        Assert.False(patchProperties.GetProperty("status").TryGetProperty("default", out _));
        Assert.False(patchProperties.GetProperty("creditLimit").TryGetProperty("default", out _));
        Assert.Equal(["null", "string"], patchProperties.GetProperty("notes").GetProperty("type")
            .EnumerateArray().Select(type => type.GetString()));

        foreach (string name in new[] { "CustomerResponse", "CreateCustomerRequest", "UpdateCustomerRequest", "PatchCustomerRequest", "CustomerPage" })
            Assert.True(schemas.TryGetProperty(name, out _));
        await Verifier.Verify(File.ReadAllText(first.DocumentPath)).UseDirectory("Snapshots").UseFileName("BankOpenApi").DisableDiff();
    }
    [Fact]
    [Trait("Category", "Build")]
    public async Task FR_NC_09_EnumUsedOnlyOnNullableFieldsRetainsItsWireValues()
    {
        LoadedBlueprint bank = ModelLoader.Load(FixtureTests.Bank);
        ModelEntity customer = bank.Model.Entities.Single(entity => entity.Name == "Customer");
        ModelField segment = customer.Fields.Single(field => field.Name == "status") with
        {
            Name = "segment", Enum = "CustomerSegment", Required = false, Default = default
        };
        ModelDocument model = bank.Model with
        {
            Enums = [.. bank.Model.Enums, new("CustomerSegment", ["retail", "business"])],
            Entities = bank.Model.Entities.Select(entity => entity == customer
                ? entity with { Fields = [.. entity.Fields, segment] }
                : entity).ToArray()
        };
        using GeneratedProject project = new(bank with { Model = model });
        await project.BuildAsync();

        using JsonDocument document = JsonDocument.Parse(File.ReadAllBytes(project.DocumentPath));
        JsonElement schemas = document.RootElement.GetProperty("components").GetProperty("schemas");
        JsonElement enumeration = schemas.GetProperty("CustomerSegment");
        Assert.Equal("string", enumeration.GetProperty("type").GetString());
        Assert.Equal(new[] { "retail", "business" }, enumeration.GetProperty("enum")
            .EnumerateArray().Select(value => value.GetString()));
        foreach (string record in new[] { "CustomerResponse", "CreateCustomerRequest", "UpdateCustomerRequest" })
        {
            JsonElement alternatives = schemas.GetProperty(record).GetProperty("properties")
                .GetProperty("segment").GetProperty("oneOf");
            Assert.Collection(alternatives.EnumerateArray(),
                nil => Assert.Equal("null", nil.GetProperty("type").GetString()),
                value => Assert.Equal("#/components/schemas/CustomerSegment", value.GetProperty("$ref").GetString()));
        }
    }
}
