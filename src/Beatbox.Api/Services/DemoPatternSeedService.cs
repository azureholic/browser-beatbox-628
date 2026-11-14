using System.Text.Json;
using Beatbox.Api.Models;

namespace Beatbox.Api.Services;

public interface IDemoPatternStore
{
    DemoPattern? CurrentPattern { get; }
    void SetPattern(DemoPattern pattern);
}

public sealed class InMemoryDemoPatternStore : IDemoPatternStore
{
    private DemoPattern? _currentPattern;

    public DemoPattern? CurrentPattern => Volatile.Read(ref _currentPattern);

    public void SetPattern(DemoPattern pattern)
    {
        ArgumentNullException.ThrowIfNull(pattern);
        Volatile.Write(ref _currentPattern, pattern);
    }
}

public sealed class DemoSeedHostedService(
    IWebHostEnvironment environment,
    IDemoPatternStore store,
    ILogger<DemoSeedHostedService> logger) : IHostedService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        if (!environment.IsDevelopment() || store.CurrentPattern is not null)
        {
            return;
        }

        var seedPath = Path.Combine(environment.ContentRootPath, "SeedData", "demo-pattern.json");
        if (!File.Exists(seedPath))
        {
            seedPath = Path.Combine(AppContext.BaseDirectory, "SeedData", "demo-pattern.json");
        }

        await using var stream = File.OpenRead(seedPath);
        var pattern = await JsonSerializer.DeserializeAsync<DemoPattern>(stream, JsonOptions, cancellationToken)
            ?? throw new InvalidOperationException("Failed to deserialize synthetic demo seed pattern.");
        store.SetPattern(pattern);
        logger.LogInformation("Loaded synthetic demo pattern '{Name}' ({Tracks}x{Steps}).", pattern.Name, pattern.Instruments.Count, pattern.StepCount);
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
