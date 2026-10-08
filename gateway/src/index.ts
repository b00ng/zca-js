import { loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { IdempotencyCache } from "./idempotency.js";
import { log } from "./log.js";
import { Messenger } from "./messaging.js";
import { SendQueue } from "./queue.js";
import { createServer, trackRecentThreads } from "./server.js";
import { WebhookDispatcher, toEvent } from "./webhook.js";
import { ZaloSession } from "./zalo-session.js";

let config: Config;
try {
    config = loadConfig();
} catch (error) {
    log.error(`Invalid configuration: ${(error as Error).message}`);
    process.exit(1);
}
const session = new ZaloSession(config);
const queue = new SendQueue(config.send);
const messenger = new Messenger(config, session, queue);
const webhook = new WebhookDispatcher(config.webhook);
const recent = trackRecentThreads();

session.onMessage((message) => {
    const event = toEvent(message);
    recent.record(event);
    webhook.dispatch(event);
});

const server = createServer({
    config,
    session,
    messenger,
    queue,
    idempotency: new IdempotencyCache(),
    recentThreads: recent.list,
});

server.listen(config.port, config.host, () => {
    log.info(`Zalo gateway listening on http://${config.host}:${config.port}`);
    log.info(
        `Listener: ${config.enableListener ? "on" : "off"}, webhook: ${webhook.enabled ? config.webhook.url : "off"}, aliases: ${Object.keys(config.aliases).join(", ") || "none"}`,
    );
});

void session.start();

function shutdown(signal: string) {
    log.info(`${signal} received, shutting down`);
    session.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (error) => log.error("Unhandled rejection:", (error as Error)?.message ?? error));
