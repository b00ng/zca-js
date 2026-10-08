import fs from "node:fs";
import path from "node:path";

export type ThreadKind = "user" | "group";

export type AliasTarget = {
    type: ThreadKind;
    id: string;
    description?: string;
};

export type Config = {
    host: string;
    port: number;
    apiKeys: string[];
    dataDir: string;
    credentialsPath: string;
    enableListener: boolean;
    selfListen: boolean;
    zaloLogging: boolean;
    userAgent?: string;
    aliases: Record<string, AliasTarget>;
    send: {
        minIntervalMs: number;
        jitterMs: number;
        maxQueueSize: number;
        timeoutMs: number;
    };
    attachments: {
        maxBytes: number;
        maxCount: number;
        allowUrlFetch: boolean;
    };
    webhook: {
        url?: string;
        secret?: string;
        includeSelf: boolean;
        timeoutMs: number;
        maxRetries: number;
    };
};

function env(name: string): string | undefined {
    const value = process.env[name];
    return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function intEnv(name: string, fallback: number): number {
    const raw = env(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number, got "${raw}"`);
    return Math.floor(value);
}

function boolEnv(name: string, fallback: boolean): boolean {
    const raw = env(name);
    if (raw === undefined) return fallback;
    return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function parseAliases(raw: string, source: string): Record<string, AliasTarget> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`Invalid JSON in ${source}: ${(error as Error).message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${source} must be a JSON object: { "alias": { "type": "group", "id": "..." } }`);
    }

    const aliases: Record<string, AliasTarget> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        const target = value as Partial<AliasTarget>;
        if (
            !target ||
            (target.type !== "user" && target.type !== "group") ||
            typeof target.id !== "string" ||
            !target.id
        ) {
            throw new Error(`Alias "${name}" in ${source} must look like { "type": "user" | "group", "id": "..." }`);
        }
        aliases[name] = { type: target.type, id: target.id, description: target.description };
    }
    return aliases;
}

function loadAliases(dataDir: string): Record<string, AliasTarget> {
    const aliases: Record<string, AliasTarget> = {};

    const file = env("ALIASES_FILE") ?? path.join(dataDir, "aliases.json");
    if (fs.existsSync(file)) Object.assign(aliases, parseAliases(fs.readFileSync(file, "utf-8"), file));

    const inline = env("ALIASES");
    if (inline) Object.assign(aliases, parseAliases(inline, "ALIASES"));

    return aliases;
}

export function loadConfig(): Config {
    const apiKeys = (env("API_KEYS") ?? env("API_KEY") ?? "")
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean);
    if (apiKeys.length === 0) throw new Error("API_KEY (or API_KEYS, comma separated) is required");
    if (apiKeys.some((key) => key.length < 24)) throw new Error("Each API key must be at least 24 characters long");

    const dataDir = path.resolve(env("DATA_DIR") ?? "./data");
    fs.mkdirSync(dataDir, { recursive: true });

    const webhookUrl = env("WEBHOOK_URL");
    const webhookSecret = env("WEBHOOK_SECRET");
    if (webhookUrl && !webhookSecret) throw new Error("WEBHOOK_SECRET is required when WEBHOOK_URL is set");

    return {
        host: env("HOST") ?? "0.0.0.0",
        port: intEnv("PORT", 8080),
        apiKeys,
        dataDir,
        credentialsPath: path.join(dataDir, "credentials.json"),
        enableListener: boolEnv("ENABLE_LISTENER", true),
        selfListen: boolEnv("SELF_LISTEN", false),
        zaloLogging: boolEnv("ZALO_LOGGING", false),
        userAgent: env("ZALO_USER_AGENT"),
        aliases: loadAliases(dataDir),
        send: {
            minIntervalMs: intEnv("SEND_MIN_INTERVAL_MS", 1500),
            jitterMs: intEnv("SEND_JITTER_MS", 1000),
            maxQueueSize: intEnv("SEND_MAX_QUEUE", 200),
            timeoutMs: intEnv("SEND_TIMEOUT_MS", 60_000),
        },
        attachments: {
            maxBytes: intEnv("ATTACHMENT_MAX_MB", 25) * 1024 * 1024,
            maxCount: intEnv("ATTACHMENT_MAX_COUNT", 10),
            allowUrlFetch: boolEnv("ATTACHMENT_ALLOW_URL", true),
        },
        webhook: {
            url: webhookUrl,
            secret: webhookSecret,
            includeSelf: boolEnv("WEBHOOK_INCLUDE_SELF", false),
            timeoutMs: intEnv("WEBHOOK_TIMEOUT_MS", 5000),
            maxRetries: intEnv("WEBHOOK_MAX_RETRIES", 3),
        },
    };
}
