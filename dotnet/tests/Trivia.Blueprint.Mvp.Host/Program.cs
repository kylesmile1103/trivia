using System.Reflection;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Testing;

Type entry = Assembly.LoadFrom(Path.GetFullPath(args[0])).EntryPoint!.DeclaringType!;
using CancellationTokenSource timeout = new(TimeSpan.FromMinutes(3));
CancellationToken token = timeout.Token;
IDistributedApplicationTestingBuilder builder = await DistributedApplicationTestingBuilder.CreateAsync(
    entry, ["--Trivia:StartWeb=false", "--Trivia:UseDataVolume=false"], token);
await using DistributedApplication app = await builder.BuildAsync(token);
await app.StartAsync(token);
await app.ResourceNotifications.WaitForResourceHealthyAsync("api", WaitBehavior.StopOnResourceUnavailable, token);

// The Node parent owns the pipe. EOF also shuts down the AppHost if the parent exits.
Console.WriteLine($"TRIVIA_MVP_API={app.GetEndpoint("api")}");
Console.ReadLine();
