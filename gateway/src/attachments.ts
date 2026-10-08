import path from "node:path";
import { imageSize } from "image-size";
import type { AttachmentSource } from "zca-js";
import type { Config } from "./config.js";
import { HttpError, badRequest } from "./errors.js";

export type AttachmentInput = {
    /** Public/internal URL the gateway downloads the file from */
    url?: string;
    /** File content as base64 (optionally a data: URL) */
    base64?: string;
    /** File name incl. extension, e.g. "report.pdf". Required for base64, derived from the URL otherwise */
    filename?: string;
};

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif"];

export function isImageFilename(filename: string) {
    return IMAGE_EXTENSIONS.includes(extensionOf(filename));
}

function extensionOf(filename: string) {
    return path.extname(filename).slice(1).toLowerCase();
}

function sanitizeFilename(name: string) {
    return path
        .basename(name)
        .replace(/[\\/:*?"<>|\r\n]+/g, "_")
        .slice(0, 200);
}

async function download(url: string, maxBytes: number): Promise<{ data: Buffer; filename?: string }> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw badRequest(`Invalid attachment url: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw badRequest("Attachment url must be http(s)");

    const response = await fetch(parsed, { signal: AbortSignal.timeout(30_000) }).catch((error: Error) => {
        throw new HttpError(502, "ATTACHMENT_DOWNLOAD_FAILED", `Cannot download ${url}: ${error.message}`);
    });
    if (!response.ok || !response.body) {
        throw new HttpError(502, "ATTACHMENT_DOWNLOAD_FAILED", `Cannot download ${url}: HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw tooLarge(maxBytes);

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body) {
        total += chunk.length;
        if (total > maxBytes) throw tooLarge(maxBytes);
        chunks.push(Buffer.from(chunk));
    }

    const disposition = response.headers.get("content-disposition") ?? "";
    const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
    const fromPath = path.basename(decodeURIComponent(parsed.pathname));
    return { data: Buffer.concat(chunks), filename: fromHeader ?? (fromPath || undefined) };
}

function tooLarge(maxBytes: number) {
    return new HttpError(413, "ATTACHMENT_TOO_LARGE", `Attachment exceeds ${Math.round(maxBytes / 1024 / 1024)}MB`);
}

/** Turns API attachment inputs into zca-js buffer sources (with the metadata zca-js needs). */
export async function resolveAttachments(
    inputs: AttachmentInput[],
    config: Config["attachments"],
): Promise<AttachmentSource[]> {
    if (inputs.length > config.maxCount) throw badRequest(`At most ${config.maxCount} attachments per message`);

    const sources: AttachmentSource[] = [];
    for (const [index, input] of inputs.entries()) {
        if (!input || typeof input !== "object") throw badRequest(`attachments[${index}] must be an object`);

        let data: Buffer;
        let filename = input.filename;
        if (input.base64) {
            const raw = input.base64.replace(/^data:[^;]+;base64,/, "");
            data = Buffer.from(raw, "base64");
            if (data.length === 0) throw badRequest(`attachments[${index}].base64 is empty or invalid`);
            if (data.length > config.maxBytes) throw tooLarge(config.maxBytes);
        } else if (input.url) {
            if (!config.allowUrlFetch) throw badRequest("Attachment URLs are disabled (ATTACHMENT_ALLOW_URL=false)");
            const downloaded = await download(input.url, config.maxBytes);
            data = downloaded.data;
            filename ??= downloaded.filename;
        } else {
            throw badRequest(`attachments[${index}] needs either "url" or "base64"`);
        }

        if (!filename) throw badRequest(`attachments[${index}].filename is required`);
        filename = sanitizeFilename(filename);
        if (!extensionOf(filename)) throw badRequest(`attachments[${index}].filename must have an extension`);

        const metadata: { totalSize: number; width?: number; height?: number } = { totalSize: data.length };
        if (isImageFilename(filename)) {
            try {
                const size = imageSize(data);
                metadata.width = size.width;
                metadata.height = size.height;
            } catch {
                throw badRequest(`attachments[${index}] (${filename}) is not a valid image`);
            }
        }

        sources.push({ data, filename: filename as `${string}.${string}`, metadata });
    }
    return sources;
}
