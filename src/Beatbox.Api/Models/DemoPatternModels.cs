namespace Beatbox.Api.Models;

public sealed record HealthStatusResponse(string Status, DateTimeOffset Timestamp);

public sealed record DemoInstrumentTrack(
    string Id,
    string Name,
    IReadOnlyList<bool> Steps);

public sealed record DemoPattern(
    string Id,
    string Name,
    int Bpm,
    int StepCount,
    IReadOnlyList<DemoInstrumentTrack> Instruments);
