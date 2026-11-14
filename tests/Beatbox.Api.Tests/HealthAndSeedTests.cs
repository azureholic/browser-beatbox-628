using System.Net;
using System.Net.Http.Json;
using Beatbox.Api.Models;
using Beatbox.Api.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;

namespace Beatbox.Api.Tests;

public sealed class HealthAndSeedTests
{
    [Theory]
    [InlineData("/healthz")]
    [InlineData("/health")]
    public async Task HealthEndpoints_Return200OkWithStatusPayload(string route)
    {
        await using var factory = new WebApplicationFactory<Program>();
        using var client = factory.CreateClient();

        using var response = await client.GetAsync(route);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var payload = await response.Content.ReadFromJsonAsync<HealthStatusResponse>();
        Assert.NotNull(payload);
        Assert.Equal("ok", payload.Status);
        Assert.True(payload.Timestamp <= DateTimeOffset.UtcNow.AddMinutes(1));
    }

    [Fact]
    public async Task StartupSeed_LoadsFourBySixteenSyntheticPatternInDevelopment()
    {
        await using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b => b.UseEnvironment("Development"));
        using var client = factory.CreateClient();
        using var response = await client.GetAsync("/healthz");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var pattern = factory.Services.GetRequiredService<IDemoPatternStore>().CurrentPattern;
        Assert.NotNull(pattern);
        Assert.Equal(16, pattern.StepCount);
        Assert.Equal(4, pattern.Instruments.Count);
        Assert.All(pattern.Instruments, track =>
        {
            Assert.False(string.IsNullOrWhiteSpace(track.Id));
            Assert.False(string.IsNullOrWhiteSpace(track.Name));
            Assert.Equal(16, track.Steps.Count);
            Assert.Contains(true, track.Steps);
        });
    }

    [Fact]
    public async Task StartupSeed_DoesNotLoadDemoSeedInProduction()
    {
        await using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b => b.UseEnvironment("Production"));
        using var client = factory.CreateClient();
        using var response = await client.GetAsync("/healthz");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Null(factory.Services.GetRequiredService<IDemoPatternStore>().CurrentPattern);
    }
}
