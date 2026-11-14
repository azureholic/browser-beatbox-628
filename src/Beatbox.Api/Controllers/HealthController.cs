using Beatbox.Api.Models;
using Microsoft.AspNetCore.Mvc;

namespace Beatbox.Api.Controllers;

[ApiController]
public sealed class HealthController : ControllerBase
{
    [HttpGet("/healthz")]
    [HttpGet("/health")]
    public ActionResult<HealthStatusResponse> GetHealth() =>
        Ok(new HealthStatusResponse("ok", DateTimeOffset.UtcNow));
}
