using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace GrokBot.WindowsSmoke.FakeDocker;

internal sealed class DockerState
{
    public bool NetworkExists { get; set; }
    public bool VolumeExists { get; set; }
    public bool ContainerExists { get; set; }
    public bool ContainerRunning { get; set; }
    public string Image { get; set; } = "";
    public string NetworkMode { get; set; } = "";
    public List<string> Environment { get; set; } = [];
    public Dictionary<string, string> Labels { get; set; } = [];
}

internal static class Program
{
    private const string Container = "grok-bot-local-vm";
    private const string Network = "grok-bot-local-vm-net";
    private const string Volume = "grok-bot-local-vm-control";
    private const string Image = "public.ecr.aws/k0i0n2g5/cursorenvironments/universal@sha256:3f9e25e1e382b7c4b71e08eb549098a6106fadc615feba848e6cc5c1ef4be3b6";
    private const string GatewayTokenFile = "SAND_GATEWAY_TOKEN_FILE=/run/grok-bot-control/gateway-token";
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    private static string StatePath => RequiredEnvironment("GROK_BOT_SMOKE_DOCKER_STATE");
    private static string TranscriptPath => RequiredEnvironment("GROK_BOT_SMOKE_DOCKER_TRANSCRIPT");
    private static string ForbiddenSha256 => RequiredEnvironment("GROK_BOT_SMOKE_FORBIDDEN_SHA256");
    private static int ForbiddenLength => int.Parse(RequiredEnvironment("GROK_BOT_SMOKE_FORBIDDEN_LENGTH"));
    private static string MutexName
    {
        get
        {
            string stateIdentity = Path.GetFullPath(StatePath).ToUpperInvariant();
            string digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(stateIdentity)));
            return @$"Local\GrokBotWindowsSmokeFakeDocker-{digest[..24]}";
        }
    }

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0) return Fail("missing Docker command");
            if (args.Any(ContainsForbiddenSecret)) return Fail("the 9Router API key reached Docker argv");
            using Mutex mutex = new(false, MutexName);
            bool acquired;
            try { acquired = mutex.WaitOne(TimeSpan.FromSeconds(30)); }
            catch (AbandonedMutexException) { acquired = true; }
            if (!acquired) return Fail("timed out waiting for the fake Docker state lock");
            try
            {
                AppendTranscript(args);
                return Dispatch(args);
            }
            finally { mutex.ReleaseMutex(); }
        }
        catch (Exception error)
        {
            return Fail(error.Message);
        }
    }

    private static int Dispatch(string[] args)
    {
        DockerState state = LoadState();
        switch (args[0])
        {
            case "info":
                Console.WriteLine("27.5.1-smoke");
                return 0;
            case "network":
                return NetworkCommand(state, args.Skip(1).ToArray());
            case "volume":
                return VolumeCommand(state, args.Skip(1).ToArray());
            case "container":
                return ContainerCommand(state, args.Skip(1).ToArray());
            case "inspect":
                return InspectContainer(state, args);
            case "run":
                return RunContainer(state, args.Skip(1).ToArray());
            case "exec":
                return ExecContainer(state, args.Skip(1).ToArray());
            case "start":
            case "restart":
                Require(args.Contains(Container, StringComparer.Ordinal), "start/restart did not name the owned container");
                Require(state.ContainerExists, "start/restart requested a missing container");
                state.ContainerRunning = true;
                SaveState(state);
                Console.WriteLine(Container);
                return 0;
            case "stop":
                Require(args.Contains(Container, StringComparer.Ordinal), "stop did not name the owned container");
                if (!state.ContainerExists) return 1;
                state.ContainerRunning = false;
                SaveState(state);
                Console.WriteLine(Container);
                return 0;
            case "rm":
                Require(args.Contains(Container, StringComparer.Ordinal), "rm did not name the owned container");
                state.ContainerExists = false;
                state.ContainerRunning = false;
                SaveState(state);
                Console.WriteLine(Container);
                return 0;
            case "logs":
                Console.WriteLine("strict fake Docker container log");
                return 0;
            default:
                return Fail($"unsupported Docker command: {args[0]}");
        }
    }

    private static int NetworkCommand(DockerState state, string[] args)
    {
        Require(args.Length > 0, "missing network subcommand");
        if (args[0] == "inspect")
        {
            if (!state.NetworkExists)
            {
                Console.Error.WriteLine($"Error response from daemon: network {Network} not found");
                return 1;
            }
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                Driver = "bridge",
                Internal = false,
                Labels = new Dictionary<string, string> { ["com.grok-bot.local-vm-network"] = "1" },
                Options = new Dictionary<string, string> { ["com.docker.network.bridge.enable_icc"] = "false" },
                Containers = new Dictionary<string, object>(),
            }));
            return 0;
        }
        if (args[0] == "ls")
        {
            Require(OptionValue(args, "--filter") == $"name=^{Network}$", "network absence check did not use the exact name filter");
            Require(OptionValue(args, "--format") == "{{.Name}}", "network absence check format changed");
            if (state.NetworkExists) Console.WriteLine(Network);
            return 0;
        }
        Require(args[0] == "create", $"unsupported network subcommand: {args[0]}");
        Require(OptionValue(args, "--driver") == "bridge", "local network is not bridge-backed");
        Require(OptionValue(args, "--opt") == "com.docker.network.bridge.enable_icc=false", "local network did not disable ICC");
        Require(OptionValues(args, "--label").Contains("com.grok-bot.local-vm-network=1", StringComparer.Ordinal), "local network owner label is missing");
        Require(args[^1] == Network, "unexpected local network name");
        state.NetworkExists = true;
        SaveState(state);
        Console.WriteLine(Network);
        return 0;
    }

    private static int VolumeCommand(DockerState state, string[] args)
    {
        Require(args.Length > 0, "missing volume subcommand");
        if (args[0] == "inspect")
        {
            if (!state.VolumeExists)
            {
                Console.Error.WriteLine($"Error: No such volume: {Volume}");
                return 1;
            }
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                Driver = "local",
                Labels = new Dictionary<string, string> { ["com.grok-bot.local-vm.control"] = "1" },
            }));
            return 0;
        }
        if (args[0] == "ls")
        {
            Require(OptionValue(args, "--filter") == $"name=^{Volume}$", "volume absence check did not use the exact name filter");
            Require(OptionValue(args, "--format") == "{{.Name}}", "volume absence check format changed");
            if (state.VolumeExists) Console.WriteLine(Volume);
            return 0;
        }
        Require(args[0] == "create", $"unsupported volume subcommand: {args[0]}");
        Require(OptionValues(args, "--label").Contains("com.grok-bot.local-vm-control=1", StringComparer.Ordinal), "control volume owner label is missing");
        Require(args[^1] == Volume, "unexpected control volume name");
        state.VolumeExists = true;
        SaveState(state);
        Console.WriteLine(Volume);
        return 0;
    }

    private static int InspectContainer(DockerState state, string[] args)
    {
        Require(args[^1] == Container, "inspect did not name the owned container");
        if (!state.ContainerExists)
        {
            Console.Error.WriteLine($"Error: No such object: {Container}");
            return 1;
        }
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            State = new { Running = state.ContainerRunning },
            Config = new { state.Image, Env = state.Environment, state.Labels },
            HostConfig = new { NetworkMode = state.NetworkMode },
        }));
        return 0;
    }

    private static int ContainerCommand(DockerState state, string[] args)
    {
        Require(args.Length > 0 && args[0] == "ls", "only exact container absence checks are supported");
        Require(args.Contains("--all", StringComparer.Ordinal), "container absence check omitted stopped containers");
        Require(OptionValue(args, "--filter") == $"name=^/{Container}$", "container absence check did not use the exact name filter");
        Require(OptionValue(args, "--format") == "{{.Names}}", "container absence check format changed");
        if (state.ContainerExists) Console.WriteLine(Container);
        return 0;
    }

    private static int RunContainer(DockerState state, string[] args)
    {
        if (args.Contains("--rm", StringComparer.Ordinal))
        {
            string input = Console.In.ReadToEnd();
            Require(input.Trim().Length >= 32, "gateway token provision received no token");
            Require(!ContainsForbiddenSecret(input.Trim()), "9Router API key was passed as gateway token stdin");
            Require(OptionValue(args, "--platform") == "linux/amd64", "token provision platform changed");
            Require(OptionValue(args, "--network") == "none", "token provision must have no network");
            Require(OptionValue(args, "--user") == "0:0", "token provision user changed");
            Require(OptionValue(args, "--cap-drop") == "ALL", "token provision retained capabilities");
            Require(OptionValue(args, "--security-opt") == "no-new-privileges:true", "token provision lacks no-new-privileges");
            Require(OptionValue(args, "--entrypoint") == "/bin/sh", "token provision entrypoint changed");
            Require(OptionValues(args, "--mount").Contains($"type=volume,src={Volume},dst=/control", StringComparer.Ordinal), "token provision control mount changed");
            Require(args.Contains(Image, StringComparer.Ordinal), "token provision image digest changed");
            return 0;
        }

        Require(args.Contains("--detach", StringComparer.Ordinal), "owned container was not detached");
        Require(OptionValue(args, "--name") == Container, "owned container name changed");
        Require(OptionValue(args, "--platform") == "linux/amd64", "owned container platform changed");
        Require(OptionValue(args, "--restart") == "unless-stopped", "owned container restart policy changed");
        Require(OptionValue(args, "--network") == Network, "owned container network changed");
        Require(OptionValue(args, "--security-opt") == "no-new-privileges:true", "owned container lacks no-new-privileges");
        Require(OptionValue(args, "--cap-drop") == "NET_RAW", "owned container NET_RAW policy changed");
        Require(args[^1] == Image, "owned container image digest changed");

        List<string> labels = OptionValues(args, "--label");
        Dictionary<string, string> parsedLabels = ParseKeyValues(labels);
        Require(parsedLabels.GetValueOrDefault("com.grok-bot.local-vm") == "1", "owned container label is missing");
        Require(parsedLabels.GetValueOrDefault("com.grok-bot.local-vm.schema-version") == "11", "owned container schema changed");
        Require(parsedLabels.GetValueOrDefault("com.grok-bot.local-vm.inference-credential") == "0", "standalone 9Router received an inference credential mount");
        Require(parsedLabels.GetValueOrDefault("com.grok-bot.local-vm.local-auth-provider") == "none", "standalone 9Router received a provider auth mount");
        Require(parsedLabels.GetValueOrDefault("com.grok-bot.local-vm.model-shell") == "box", "model-facing shell is not isolated as box");
        foreach (string dynamicLabel in new[] { "host-sha256", "box-exec-daemon-sha256", "exec-daemon-wrapper-sha256", "gateway-token-sha256" })
        {
            string value = parsedLabels.GetValueOrDefault($"com.grok-bot.local-vm.{dynamicLabel}") ?? "";
            Require(value.Length == 64 && value.All(Uri.IsHexDigit), $"invalid {dynamicLabel} label");
        }

        List<string> environment = OptionValues(args, "--env");
        Require(environment.Contains(GatewayTokenFile, StringComparer.Ordinal), "gateway token file environment is missing");
        Require(!environment.Any(value => value.StartsWith("SAND_GATEWAY_TOKEN=", StringComparison.Ordinal)), "gateway token leaked into environment");
        Require(environment.Contains("SAND_BOX_EXEC_SHELL_USER=box", StringComparer.Ordinal), "model shell user is not box");
        Require(!environment.Any(value => value.StartsWith("SAND_DEV_INFERENCE_TOKEN_FILE=", StringComparison.Ordinal)), "standalone 9Router received an inference token path");

        HashSet<string> published = OptionValues(args, "--publish").ToHashSet(StringComparer.Ordinal);
        HashSet<string> expectedPublished = new(StringComparer.Ordinal)
        {
            "127.0.0.1:1340:1340",
            "127.0.0.1:6080:6080",
            "127.0.0.1:6081:6081",
        };
        Require(published.SetEquals(expectedPublished), $"unexpected published ports: {string.Join(",", published)}");

        List<string> mounts = OptionValues(args, "--mount");
        Require(mounts.Contains($"type=volume,src={Volume},dst=/run/grok-bot-control,readonly", StringComparer.Ordinal), "gateway token mount is not read-only");
        Require(mounts.Count(value => value.StartsWith("type=bind,", StringComparison.Ordinal) && value.EndsWith(",readonly", StringComparison.Ordinal)) >= 3, "runtime bind mounts are not read-only");
        Require(OptionValues(args, "--volume").Contains("grok-bot-local-vm-workspace:/workspace", StringComparer.Ordinal), "workspace volume changed");
        Require(OptionValues(args, "--volume").Contains("grok-bot-local-vm-data:/home/box/sand-data", StringComparer.Ordinal), "data volume changed");

        state.ContainerExists = true;
        state.ContainerRunning = true;
        state.Image = Image;
        state.NetworkMode = Network;
        state.Environment = environment;
        state.Labels = parsedLabels;
        SaveState(state);
        Console.WriteLine("strict-smoke-container-id");
        return 0;
    }

    private static int ExecContainer(DockerState state, string[] args)
    {
        Require(state.ContainerExists && state.ContainerRunning, "attestation ran before the owned container was ready");
        Require(OptionValue(args, "--user") == "0:0", "attestation user changed");
        Require(args.Contains(Container, StringComparer.Ordinal), "attestation did not name the owned container");
        string command = args[^1];
        foreach (string marker in new[]
        {
            "/exec-daemon/index.js serve --port 1337",
            "CapEff:",
            "NoNewPrivs:",
            "test \"$found\" -eq 1",
            "test ! -r /run/grok-bot-control/gateway-token",
        }) Require(command.Contains(marker, StringComparison.Ordinal), $"model-shell attestation lost marker: {marker}");
        return 0;
    }

    private static List<string> OptionValues(IReadOnlyList<string> args, string option)
    {
        List<string> values = [];
        for (int index = 0; index + 1 < args.Count; index++)
        {
            if (args[index] == option) values.Add(args[index + 1]);
        }
        return values;
    }

    private static string? OptionValue(IReadOnlyList<string> args, string option) => OptionValues(args, option).FirstOrDefault();

    private static Dictionary<string, string> ParseKeyValues(IEnumerable<string> values)
    {
        Dictionary<string, string> result = new(StringComparer.Ordinal);
        foreach (string value in values)
        {
            int separator = value.IndexOf('=');
            Require(separator > 0, $"malformed key/value option: {value}");
            result[value[..separator]] = value[(separator + 1)..];
        }
        return result;
    }

    private static DockerState LoadState()
    {
        if (!File.Exists(StatePath)) return new DockerState();
        return JsonSerializer.Deserialize<DockerState>(File.ReadAllText(StatePath)) ?? new DockerState();
    }

    private static void SaveState(DockerState state)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(StatePath)!);
        string temporary = $"{StatePath}.{Environment.ProcessId}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(state, JsonOptions));
        File.Move(temporary, StatePath, true);
    }

    private static void AppendTranscript(IEnumerable<string> args)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(TranscriptPath)!);
        string line = JsonSerializer.Serialize(new { atUtc = DateTime.UtcNow.ToString("O"), args });
        File.AppendAllText(TranscriptPath, line + Environment.NewLine);
    }

    private static string RequiredEnvironment(string name)
    {
        string? value = Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrWhiteSpace(value)) throw new InvalidOperationException($"missing {name}");
        return value;
    }

    private static bool ContainsForbiddenSecret(string value)
    {
        int length = ForbiddenLength;
        if (length <= 0 || value.Length < length) return false;
        for (int offset = 0; offset <= value.Length - length; offset++)
        {
            string candidate = value.Substring(offset, length);
            string digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(candidate))).ToLowerInvariant();
            if (digest == ForbiddenSha256) return true;
        }
        return false;
    }

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static int Fail(string message)
    {
        Console.Error.WriteLine($"strict fake Docker rejected command: {message}");
        return 64;
    }
}
