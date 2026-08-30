// Northwind Coffee — checkout API (.NET).
//
// A small ASP.NET Core service that the browser storefront calls. It shows the
// two .NET packages together:
//
//   ZipLogger.Extensions.Logging   every ILogger<T> call ships to ZipLogger, and
//                                  registers IEventTracker for product analytics
//   ZipLogger.Metrics.AspNetCore   request duration, status, and route as metrics
//
// Nothing in the handlers below knows about ZipLogger for *logging*. They log through
// ILogger the way any ASP.NET Core service already does.
//
// Events are different, and deliberately explicit: IEventTracker.Track() is called for
// the things the business cares about. The browser tracks what the shopper did; the
// server tracks what actually happened to the money, because revenue is not something
// you take the client's word for. The two share an identity, so they describe one
// person rather than two.
//
// The deliberate defect lives in ApplyPromotion: a promo code with an empty
// discount table throws, which is a real exception from a real line.

using System.Collections.Concurrent;
using ZipLogger.Client;
using ZipLogger.Extensions.Logging;
using ZipLogger.Metrics.AspNetCore;

var builder = WebApplication.CreateBuilder(args);

var endpoint = Environment.GetEnvironmentVariable("ZIPLOGGER_ENDPOINT") ?? "https://app.ziplogger.dev";
var apiKey = Environment.GetEnvironmentVariable("ZIPLOGGER_API_KEY") ?? "";
var environment = Environment.GetEnvironmentVariable("ZIPLOGGER_ENVIRONMENT") ?? "production";

if (string.IsNullOrWhiteSpace(apiKey))
{
    Console.Error.WriteLine("ZIPLOGGER_API_KEY is required");
    return 1;
}

// Ship this service's own logs, not the framework's per-request chatter. Without this
// filter, "Request starting" / "Executing endpoint" lines at Information level outnumber
// the application's own logs several to one.
builder.Logging.AddFilter("Microsoft", LogLevel.Warning);

builder.Logging.AddZipLogger(options =>
{
    options.Endpoint = endpoint;
    options.ApiKey = apiKey;
    options.Source = "checkout";
    options.Environment = environment;
    options.Tags = ["demo", "dotnet"];
});

builder.Services.AddZipLoggerMetrics(options =>
{
    options.Endpoint = endpoint;
    options.ApiKey = apiKey;
    options.Service = "checkout";
});

// The storefront is served from a different origin in the demo deployment.
builder.Services.AddCors(options => options.AddDefaultPolicy(policy =>
    policy.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));

var app = builder.Build();

app.UseCors();
app.UseZipLoggerMetrics();

var catalog = new[]
{
    new Product("ETH-YIRG-250", "Ethiopia Yirgacheffe", 18.50m),
    new Product("COL-HUILA-1K", "Colombia Huila 1kg", 42.00m),
    new Product("KEN-AA-250", "Kenya AA", 21.00m),
    new Product("BRZ-SANTOS-500", "Brazil Santos 500g", 15.75m),
    new Product("DECAF-SWP-250", "Swiss Water Decaf", 19.25m),
};

// Promotions the storefront can apply. WELCOME10 is configured; the seasonal code
// was added to the storefront before its discount table was filled in here.
var discounts = new ConcurrentDictionary<string, decimal>(
    new Dictionary<string, decimal> { ["WELCOME10"] = 0.10m });

static decimal ApplyPromotion(decimal subtotal, string promoCode, ConcurrentDictionary<string, decimal> discounts)
{
    if (string.IsNullOrEmpty(promoCode)) return subtotal;

    // Defect: an unconfigured promo code reaches this line and throws.
    var rate = discounts[promoCode];
    return Math.Round(subtotal * (1 - rate), 2);
}

app.MapGet("/health", () => Results.Ok(new { status = "healthy" }));

app.MapGet("/api/products", (ILogger<Program> log) =>
{
    log.LogInformation("Catalog listed with {ProductCount} products", catalog.Length);
    return Results.Ok(catalog);
});

app.MapPost("/api/checkout", (CheckoutRequest request, ILogger<Program> log, IEventTracker events) =>
{
    var orderId = $"NW-{Random.Shared.Next(100000, 999999)}";
    var product = catalog.FirstOrDefault(p => p.Sku == request.Sku);

    // The storefront sends the ids its browser SDK is using. Linking them here means the
    // anonymous browsing that preceded a sign-in belongs to the account that signed in.
    if (!string.IsNullOrEmpty(request.UserId) && !string.IsNullOrEmpty(request.AnonymousId))
    {
        events.Identify(request.UserId, request.AnonymousId);
    }

    if (product is null)
    {
        log.LogWarning("Checkout referenced unknown sku {Sku} for order {OrderId}", request.Sku, orderId);
        return Results.BadRequest(new { error = $"Unknown sku {request.Sku}" });
    }

    var subtotal = product.Price * request.Quantity;

    try
    {
        var total = ApplyPromotion(subtotal, request.PromoCode ?? "", discounts);

        log.LogInformation(
            "Checkout completed for order {OrderId}: {Quantity} x {Sku} at {Total:0.00} EUR (promo {PromoCode})",
            orderId, request.Quantity, request.Sku, total, request.PromoCode ?? "none");

        // Server-authoritative revenue, attributed to the same person the browser is tracking.
        events.Track("order_confirmed", new
        {
            orderId,
            sku = request.Sku,
            quantity = request.Quantity,
            value = total,
            currency = "EUR",
            promoCode = request.PromoCode ?? "none",
        }, userId: request.UserId, anonymousId: request.AnonymousId, sessionId: request.SessionId);

        return Results.Ok(new { orderId, sku = request.Sku, quantity = request.Quantity, total });
    }
    catch (KeyNotFoundException ex)
    {
        log.LogError(ex, "Checkout failed for order {OrderId}: promotion {PromoCode} is not configured",
            orderId, request.PromoCode);

        // Tracked as well as logged: the log is for whoever debugs it, the event is so a
        // funnel shows how much revenue the broken promo code actually cost.
        events.Track("checkout_failed", new
        {
            orderId,
            sku = request.Sku,
            quantity = request.Quantity,
            reason = "promotion_not_configured",
            promoCode = request.PromoCode ?? "none",
            value = subtotal,
        }, userId: request.UserId, anonymousId: request.AnonymousId, sessionId: request.SessionId);

        return Results.Problem($"Promotion {request.PromoCode} is not configured", statusCode: 500);
    }
});

app.Logger.LogInformation("Checkout API started with {ProductCount} products", catalog.Length);

app.Run();
return 0;

internal sealed record Product(string Sku, string Name, decimal Price);
// UserId / AnonymousId / SessionId come from the browser SDK's `identity`, so server-side
// events land on the same person as the browser's.
internal sealed record CheckoutRequest(
    string Sku, int Quantity, string? PromoCode,
    string? UserId = null, string? AnonymousId = null, string? SessionId = null);
