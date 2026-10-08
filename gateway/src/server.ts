import crypto from "node:crypto";
import http from "node:http";
import type { Config } from "./config.js";
import { HttpError, badRequest } from "./errors.js";
import type { IdempotencyCache } from "./idempotency.js";
import { log } from "./log.js";
import { LOGIN_PAGE } from "./login-page.js";
import type { Messenger, SendMessageRequest } from "./messaging.js";
import type { SendQueue } from "./queue.js";
import type { IncomingMessageEvent } from "./webhook.js";
import type { ZaloSession } from "./zalo-session.js";

type Deps = {
    config: Config;
    session: ZaloSession;
    messenger: Messenger;
    queue: SendQueue;
    idempotency: IdempotencyCache;
    recentThreads: () => RecentThread[];
};

export type RecentThread = {
    type: "user" | "group";
    id: string;
    lastSender: string;
    lastText: string | null;
    lastMessageAt: string;
};

type Handler = (ctx: { req: http.IncomingMessage; url: URL; body: () => Promise<unknown> }) => Promise<Reply>;
type Reply = {
    status?: number;
    json?: unknown;
    body?: Buffer | string;
    contentType?: string;
    headers?: Record<string, string>;
};

const MAX_BODY_BYTES = (Number(process.env.BODY_MAX_MB) || 40) * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new HttpError(413, "BODY_TOO_LARGE", `Request body exceeds ${MAX_BODY_BYTES} bytes`));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            if (size === 0) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
            } catch {
                reject(badRequest("Body must be valid JSON"));
            }
        });
        req.on("error", reject);
    });
}

function safeEqual(a: string, b: string) {
    const ha = crypto.createHash("sha256").update(a).digest();
    const hb = crypto.createHash("sha256").update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function authenticate(req: http.IncomingMessage, keys: string[]) {
    const header = req.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ")
        ? header.slice(7).trim()
        : String(req.headers["x-api-key"] ?? "");
    if (!token || !keys.some((key) => safeEqual(key, token))) {
        throw new HttpError(401, "UNAUTHORIZED", "Missing or invalid API key");
    }
}

export function createServer(deps: Deps) {
    const { config, session, messenger, queue, idempotency } = deps;

    const status = () => ({
        state: session.state,
        account: session.account,
        loggedInAt: session.loggedInAt ? new Date(session.loggedInAt).toISOString() : null,
        listener: session.listenerState,
        queueSize: queue.size,
        lastError: session.lastError,
    });

    const publicRoutes: Record<string, Handler> = {
        "GET /health": async () => ({ json: { status: "ok" } }),
        "GET /ready": async () => ({
            status: session.state === "logged_in" ? 200 : 503,
            json: { ready: session.state === "logged_in", state: session.state },
        }),
        "GET /login": async () => ({ body: LOGIN_PAGE, contentType: "text/html; charset=utf-8" }),
    };

    const routes: Record<string, Handler> = {
        "GET /v1/status": async () => ({ json: status() }),

        "POST /v1/auth/qr": async () => {
            const qr = await session.requestQr();
            return {
                json: {
                    state: session.state,
                    qr: {
                        imageBase64: qr.image,
                        mimeType: "image/png",
                        expiresAt: new Date(qr.expiresAt).toISOString(),
                    },
                },
            };
        },
        "GET /v1/auth/qr.png": async () => {
            const image = session.getQrImage();
            if (!image) throw new HttpError(404, "NO_QR", "No active QR code. Call POST /v1/auth/qr first");
            return { body: image, contentType: "image/png", headers: { "cache-control": "no-store" } };
        },
        "POST /v1/auth/logout": async () => {
            await session.logout();
            return { json: status() };
        },

        "POST /v1/messages": async ({ req, body }) => {
            const key = req.headers["idempotency-key"];
            const { result, replayed } = idempotency.run(typeof key === "string" ? key : undefined, async () =>
                messenger.send((await body()) as SendMessageRequest),
            );
            return { json: await result, headers: replayed ? { "idempotent-replayed": "true" } : undefined };
        },

        "GET /v1/groups": async () => ({ json: { groups: await messenger.listGroups() } }),
        "GET /v1/friends": async () => ({ json: { friends: await messenger.listFriends() } }),
        "GET /v1/users/lookup": async ({ url }) => {
            const phone = url.searchParams.get("phone");
            if (!phone) throw badRequest("Query parameter ?phone= is required");
            return { json: await messenger.lookupPhone(phone) };
        },
        "GET /v1/aliases": async () => ({ json: { aliases: config.aliases } }),
        "GET /v1/threads/recent": async () => ({ json: { threads: deps.recentThreads() } }),
    };

    return http.createServer(async (req, res) => {
        const started = Date.now();
        const url = new URL(req.url ?? "/", "http://localhost");
        const routeKey = `${req.method} ${url.pathname.replace(/\/+$/, "") || "/"}`;
        let statusCode = 500;

        const send = (reply: Reply) => {
            statusCode = reply.status ?? 200;
            const headers: Record<string, string> = { ...(reply.headers ?? {}) };
            let payload: Buffer | string;
            if (reply.json !== undefined) {
                headers["content-type"] = "application/json; charset=utf-8";
                payload = JSON.stringify(reply.json);
            } else {
                headers["content-type"] = reply.contentType ?? "text/plain; charset=utf-8";
                payload = reply.body ?? "";
            }
            res.writeHead(statusCode, headers);
            res.end(payload);
        };

        try {
            const publicHandler = publicRoutes[routeKey];
            const handler = publicHandler ?? routes[routeKey];
            if (!handler) throw new HttpError(404, "NOT_FOUND", `No route for ${routeKey}`);
            if (!publicHandler) authenticate(req, config.apiKeys);

            let bodyPromise: Promise<unknown> | null = null;
            send(await handler({ req, url, body: () => (bodyPromise ??= readBody(req)) }));
        } catch (error) {
            // anything that is not an HttpError comes from zca-js / Zalo itself
            const err = error instanceof HttpError ? error : new HttpError(502, "ZALO_ERROR", (error as Error).message);
            if (err.status >= 500) log.error(`${routeKey} failed:`, err.message);
            send({
                status: err.status,
                json: { error: { code: err.code, message: err.message, details: err.details } },
            });
        } finally {
            if (url.pathname !== "/health") log.info(`${routeKey} ${statusCode} ${Date.now() - started}ms`);
        }
    });
}

export function trackRecentThreads(limit = 50) {
    const threads = new Map<string, RecentThread>();
    return {
        record(event: IncomingMessageEvent) {
            const key = `${event.thread.type}:${event.thread.id}`;
            threads.delete(key);
            threads.set(key, {
                type: event.thread.type,
                id: event.thread.id,
                lastSender: event.sender.name,
                lastText: event.text?.slice(0, 100) ?? null,
                lastMessageAt: event.receivedAt,
            });
            if (threads.size > limit) threads.delete(threads.keys().next().value!);
        },
        list: () => [...threads.values()].reverse(),
    };
}
