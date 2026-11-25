using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Trivia.Blueprint.Codegen.Model;
using Xunit;

namespace Trivia.Blueprint.Codegen.Tests.Integration;

[Collection("PostgreSQL")]
[Trait("Category", "Integration")]
public sealed class AuthTests(PostgresFixture postgres)
{
    private const string Issuer = "https://issuer.example.test";
    private const string Audience = "test-bank";
    private const string SigningKey = "trivia-test-only-key-for-hs256-signing";

    [Fact]
    public async Task FR_NC_13_OidcRequiresAValidTokenAndAdvertisesBearerSecurity()
    {
        LoadedBlueprint bank = ModelLoader.Load(FixtureTests.Bank);
        AppDocument app = new("https://trivia.dev/schemas/blueprint/app.v1.json", 1, bank.AppName,
            new("vite-refine", "dotnet-minimal"), new("oidc"), null, null);
        using GeneratedProject project = new(bank with { App = app });

        string program = Path.Combine(project.ApiDirectory, "Program.cs");
        string content = File.ReadAllText(program);
        File.WriteAllText(program, content.Replace("WebApplication app = builder.Build();", $$"""
            // Supply test-only issuer metadata without contacting an external identity provider.
            builder.Services.PostConfigure<Microsoft.AspNetCore.Authentication.JwtBearer.JwtBearerOptions>("Bearer", options =>
            {
                Microsoft.IdentityModel.Protocols.OpenIdConnect.OpenIdConnectConfiguration configuration = new() { Issuer = "{{Issuer}}" };
                configuration.SigningKeys.Add(new Microsoft.IdentityModel.Tokens.SymmetricSecurityKey(
                    System.Text.Encoding.UTF8.GetBytes("{{SigningKey}}")));
                options.ConfigurationManager = new Microsoft.IdentityModel.Protocols.StaticConfigurationManager<
                    Microsoft.IdentityModel.Protocols.OpenIdConnect.OpenIdConnectConfiguration>(configuration);
            });

            WebApplication app = builder.Build();
            """, StringComparison.Ordinal));
        await using RunningApi api = await postgres.StartAsync(project, new Dictionary<string, string>
        {
            ["Authentication__Authority"] = Issuer,
            ["Authentication__Audience"] = Audience
        });
        HttpClient client = api.Client;
        using HttpResponseMessage anonymous = await client.GetAsync("/api/v1/customers");
        await CrudTests.ReadProblem(anonymous, HttpStatusCode.Unauthorized);
        Assert.Contains(anonymous.Headers.WwwAuthenticate, header => header.Scheme == "Bearer");
        using HttpResponseMessage anonymousSpec = await client.GetAsync("/openapi/v1.json");
        Assert.Equal(HttpStatusCode.Unauthorized, anonymousSpec.StatusCode);

        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Token("other-audience"));
        using HttpResponseMessage wrongAudience = await client.GetAsync("/api/v1/customers");
        Assert.Equal(HttpStatusCode.Unauthorized, wrongAudience.StatusCode);

        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", Token(Audience));
        using HttpResponseMessage authorized = await client.GetAsync("/api/v1/customers");
        Assert.Equal(HttpStatusCode.OK, authorized.StatusCode);
        JsonElement doc = await client.GetFromJsonAsync<JsonElement>("/openapi/v1.json");
        JsonElement bearer = doc.GetProperty("components").GetProperty("securitySchemes").GetProperty("bearer");
        Assert.Equal("http", bearer.GetProperty("type").GetString());
        Assert.Equal("bearer", bearer.GetProperty("scheme").GetString());
        Assert.True(doc.GetProperty("security")[0].TryGetProperty("bearer", out _));

        using JsonDocument built = JsonDocument.Parse(File.ReadAllText(project.DocumentPath));
        Assert.True(built.RootElement.GetProperty("security")[0].TryGetProperty("bearer", out _));
    }

    private static string Token(string audience)
    {
        string header = Encode(JsonSerializer.SerializeToUtf8Bytes(new { alg = "HS256", typ = "JWT" }));
        string payload = Encode(JsonSerializer.SerializeToUtf8Bytes(new
        {
            iss = Issuer, aud = audience, sub = "test-user", exp = DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeSeconds()
        }));
        string unsigned = header + "." + payload;
        byte[] signature = HMACSHA256.HashData(Encoding.UTF8.GetBytes(SigningKey), Encoding.UTF8.GetBytes(unsigned));
        return unsigned + "." + Encode(signature);
    }

    private static string Encode(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
