export class HttpError extends Error {
    constructor(
        public status: number,
        public code: string,
        message: string,
        public details?: unknown,
    ) {
        super(message);
    }
}

export function badRequest(message: string, details?: unknown): HttpError {
    return new HttpError(400, "BAD_REQUEST", message, details);
}
