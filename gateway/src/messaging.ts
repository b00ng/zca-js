import fs from "node:fs";
import path from "node:path";
import { ThreadType, Urgency } from "zca-js";
import type { Mention, MessageContent } from "zca-js";
import { resolveAttachments, isImageFilename } from "./attachments.js";
import type { AttachmentInput } from "./attachments.js";
import type { Config, ThreadKind } from "./config.js";
import { HttpError, badRequest } from "./errors.js";
import type { SendQueue } from "./queue.js";
import type { ZaloSession } from "./zalo-session.js";

export type RecipientInput = string | { type?: ThreadKind; id?: string; phone?: string; alias?: string };

export type SendMessageRequest = {
    to: RecipientInput;
    text?: string;
    /** Group only: prefix the message with "@All" and notify every member */
    mentionAll?: boolean;
    /** Group only: raw mentions, positions are relative to `text` */
    mentions?: Mention[];
    urgency?: "default" | "important" | "urgent";
    /** Message disappears after this many milliseconds */
    ttl?: number;
    attachments?: AttachmentInput[];
};

export type ResolvedRecipient = { type: ThreadKind; id: string; alias?: string };

export type SendMessageResult = {
    to: ResolvedRecipient;
    messageId: string | null;
    attachmentIds: string[];
    sentAt: string;
};

const URGENCY: Record<string, Urgency> = {
    default: Urgency.Default,
    important: Urgency.Important,
    urgent: Urgency.Urgent,
};

export function normalizePhone(phone: string): string {
    let digits = phone.replace(/[^\d+]/g, "");
    if (digits.startsWith("+")) digits = digits.slice(1);
    if (digits.startsWith("0")) digits = "84" + digits.slice(1);
    if (!/^\d{9,15}$/.test(digits)) throw badRequest(`Invalid phone number: ${phone}`);
    return digits;
}

export class Messenger {
    private phoneCachePath: string;
    private phoneCache: Record<string, string> = {};

    constructor(
        private config: Config,
        private session: ZaloSession,
        private queue: SendQueue,
    ) {
        this.phoneCachePath = path.join(config.dataDir, "phone-cache.json");
        try {
            if (fs.existsSync(this.phoneCachePath)) {
                this.phoneCache = JSON.parse(fs.readFileSync(this.phoneCachePath, "utf-8"));
            }
        } catch {
            this.phoneCache = {};
        }
    }

    /** Looks a phone number up on Zalo (cached on disk: Zalo rate-limits phone lookups). */
    async lookupPhone(phone: string): Promise<{ uid: string; displayName?: string; zaloName?: string }> {
        const normalized = normalizePhone(phone);
        const cached = this.phoneCache[normalized];
        if (cached) return { uid: cached };

        const api = this.session.requireApi();
        let user;
        try {
            user = await api.findUser(normalized);
        } catch (error) {
            throw new HttpError(404, "USER_NOT_FOUND", `No Zalo user for phone ${phone}: ${(error as Error).message}`);
        }
        if (!user?.uid) throw new HttpError(404, "USER_NOT_FOUND", `No Zalo user (or hidden) for phone ${phone}`);

        this.phoneCache[normalized] = user.uid;
        fs.writeFileSync(this.phoneCachePath, JSON.stringify(this.phoneCache, null, 2));
        return { uid: user.uid, displayName: user.display_name, zaloName: user.zalo_name };
    }

    async resolveRecipient(input: RecipientInput): Promise<ResolvedRecipient> {
        if (!input) throw badRequest('"to" is required');

        const aliasName = typeof input === "string" ? input : input.alias;
        if (aliasName) {
            const alias = this.config.aliases[aliasName];
            if (!alias) throw new HttpError(404, "UNKNOWN_ALIAS", `Unknown recipient alias "${aliasName}"`);
            return { type: alias.type, id: alias.id, alias: aliasName };
        }
        if (typeof input !== "object") throw badRequest('"to" must be an alias string or an object');

        if (input.type !== "user" && input.type !== "group") throw badRequest('"to.type" must be "user" or "group"');
        if (input.id) return { type: input.type, id: String(input.id) };
        if (input.phone) {
            if (input.type !== "user") throw badRequest('"to.phone" can only be used with type "user"');
            return { type: "user", id: (await this.lookupPhone(input.phone)).uid };
        }
        throw badRequest('"to" needs "id", "phone" (user only) or "alias"');
    }

    async send(request: SendMessageRequest): Promise<SendMessageResult> {
        if (!request || typeof request !== "object") throw badRequest("JSON body required");
        const text = request.text ?? "";
        if (typeof text !== "string") throw badRequest('"text" must be a string');
        const attachmentInputs = request.attachments ?? [];
        if (!Array.isArray(attachmentInputs)) throw badRequest('"attachments" must be an array');
        if (!text.trim() && attachmentInputs.length === 0) throw badRequest('"text" or "attachments" is required');
        if (request.urgency && !(request.urgency in URGENCY)) {
            throw badRequest('"urgency" must be "default", "important" or "urgent"');
        }

        const api = this.session.requireApi();
        const to = await this.resolveRecipient(request.to);
        const threadType = to.type === "group" ? ThreadType.Group : ThreadType.User;

        let msg = text;
        let mentions: Mention[] | undefined;
        if (to.type === "group") {
            mentions = Array.isArray(request.mentions) ? [...request.mentions] : [];
            if (request.mentionAll) {
                const prefix = "@All ";
                mentions = mentions.map((m) => ({ ...m, pos: m.pos + prefix.length }));
                mentions.unshift({ pos: 0, len: prefix.length - 1, uid: "-1" });
                msg = prefix + msg;
            }
        } else if (request.mentionAll || request.mentions?.length) {
            throw badRequest("Mentions are only supported for group messages");
        }

        const attachments = await resolveAttachments(attachmentInputs, this.config.attachments);
        const needsListener = attachments.some((a) => typeof a !== "string" && !isImageFilename(a.filename));
        if (needsListener && !this.session.listenerConnected) {
            // zca-js waits for a websocket event to finish non-image uploads
            throw new HttpError(
                503,
                "LISTENER_REQUIRED",
                "Non-image attachments need the Zalo listener (ENABLE_LISTENER=true and connected)",
            );
        }

        const content: MessageContent = {
            msg,
            mentions: mentions?.length ? mentions : undefined,
            urgency: request.urgency ? URGENCY[request.urgency] : undefined,
            ttl: typeof request.ttl === "number" && request.ttl > 0 ? request.ttl : undefined,
            attachments: attachments.length ? attachments : undefined,
        };

        const response = await this.queue.push(() => api.sendMessage(content, to.id, threadType));
        return {
            to,
            messageId: response.message ? String(response.message.msgId) : null,
            attachmentIds: response.attachment.map((a) => String(a.msgId)),
            sentAt: new Date().toISOString(),
        };
    }

    async listGroups() {
        const api = this.session.requireApi();
        const all = await api.getAllGroups();
        const ids = Object.keys(all.gridVerMap ?? {});
        const groups: Array<{ id: string; name: string; totalMember: number; isAdmin: boolean }> = [];
        const ownId = api.getOwnId();

        for (let i = 0; i < ids.length; i += 50) {
            const info = await api.getGroupInfo(ids.slice(i, i + 50));
            for (const [id, group] of Object.entries(info.gridInfoMap ?? {})) {
                groups.push({
                    id,
                    name: group.name,
                    totalMember: group.totalMember,
                    isAdmin: group.creatorId === ownId || (group.adminIds ?? []).includes(ownId),
                });
            }
        }
        return groups.sort((a, b) => a.name.localeCompare(b.name));
    }

    async listFriends() {
        const api = this.session.requireApi();
        const friends = await api.getAllFriends();
        return friends.map((f) => ({
            id: f.userId,
            displayName: f.displayName,
            zaloName: f.zaloName,
            phoneNumber: f.phoneNumber || undefined,
        }));
    }
}
