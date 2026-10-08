import crypto from "node:crypto";
import type { Message } from "zca-js";
import { ThreadType } from "zca-js";
import type { Config } from "./config.js";
import { log } from "./log.js";

export type IncomingMessageEvent = {
    event: "message";
    eventId: string;
    receivedAt: string;
    thread: { type: "user" | "group"; id: string };
    sender: { id: string; name: string };
    isSelf: boolean;
    messageId: string;
    msgType: string;
    text: string | null;
    content: unknown;
    timestamp: number;
};

export function toEvent(message: Message): IncomingMessageEvent {
    const data = message.data;
    return {
        event: "message",
        eventId: crypto.randomUUID(),
        receivedAt: new Date().toISOString(),
        thread: { type: message.type === ThreadType.Group ? "group" : "user", id: message.threadId },
        sender: { id: data.uidFrom, name: data.dName },
        isSelf: message.isSelf,
        messageId: String(data.msgId),
        msgType: data.msgType,
        text: typeof data.content === "string" ? data.content : null,
        content: data.content,
        timestamp: Number(data.ts),
    };
}

export function sign(secret: string, timestamp: string, body: string) {
    return "sha256=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** Forwards incoming Zalo messages to WEBHOOK_URL, signed with HMAC-SHA256, with retries. */
export class WebhookDispatcher {
    constructor(private config: Config["webhook"]) {}

    get enabled() {
        return !!this.config.url;
    }

    dispatch(event: IncomingMessageEvent) {
        if (!this.config.url || !this.config.secret) return;
        if (event.isSelf && !this.config.includeSelf) return;
        void this.deliver(event, 0);
    }

    private async deliver(event: IncomingMessageEvent, attempt: number): Promise<void> {
        const body = JSON.stringify(event);
        const timestamp = Math.floor(Date.now() / 1000).toString();
        try {
            const response = await fetch(this.config.url!, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-zalo-gateway-event": event.event,
                    "x-zalo-gateway-event-id": event.eventId,
                    "x-zalo-gateway-timestamp": timestamp,
                    "x-zalo-gateway-signature": sign(this.config.secret!, timestamp, body),
                },
                body,
                signal: AbortSignal.timeout(this.config.timeoutMs),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
        } catch (error) {
            if (attempt >= this.config.maxRetries) {
                log.error(`Webhook ${event.eventId} dropped after ${attempt + 1} attempts:`, (error as Error).message);
                return;
            }
            const delay = 1000 * 2 ** attempt;
            log.warn(`Webhook ${event.eventId} failed (${(error as Error).message}), retrying in ${delay}ms`);
            await new Promise((resolve) => setTimeout(resolve, delay));
            return this.deliver(event, attempt + 1);
        }
    }
}
