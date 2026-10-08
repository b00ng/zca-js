import fs from "node:fs";
import { CloseReason, LoginQRCallbackEventType, Zalo, ZaloApiLoginQRAborted } from "zca-js";
import type { API, Credentials, LoginQRCallbackEvent, Message } from "zca-js";
import type { Config } from "./config.js";
import { HttpError } from "./errors.js";
import { log } from "./log.js";

export type SessionState = "starting" | "logged_out" | "awaiting_scan" | "scanned" | "logged_in";
export type ListenerState = "disabled" | "stopped" | "connecting" | "connected" | "closed";

type PendingQr = {
    image: string; // base64 PNG
    generatedAt: number;
    abort: () => unknown;
};

const QR_TTL_MS = 100_000; // zca-js expires a QR code after 100s
const HEALTH_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const CREDENTIALS_SAVE_INTERVAL_MS = 60 * 60 * 1000;
const LISTENER_RESTART_DELAY_MS = 5 * 60 * 1000;

export class ZaloSession {
    private zalo: Zalo;
    private api: API | null = null;

    state: SessionState = "starting";
    listenerState: ListenerState;
    account: { uid: string; displayName?: string } | null = null;
    lastError: string | null = null;
    loggedInAt: number | null = null;
    private qr: PendingQr | null = null;
    private qrWaiters: Array<(qr: PendingQr | Error) => void> = [];
    private timers: NodeJS.Timeout[] = [];
    private listenerRestartTimer: NodeJS.Timeout | null = null;
    private messageHandlers: Array<(message: Message) => void> = [];

    constructor(private config: Config) {
        this.zalo = new Zalo({
            selfListen: config.selfListen,
            checkUpdate: false,
            logging: config.zaloLogging,
        });
        this.listenerState = config.enableListener ? "stopped" : "disabled";
    }

    onMessage(handler: (message: Message) => void) {
        this.messageHandlers.push(handler);
    }

    /** Returns the logged-in API or throws a 503-friendly error. */
    requireApi(): API {
        if (!this.api || this.state !== "logged_in") {
            throw new HttpError(
                503,
                "NOT_LOGGED_IN",
                "Zalo account is not logged in. Call POST /v1/auth/qr and scan the QR code.",
            );
        }
        return this.api;
    }

    get listenerConnected() {
        return this.listenerState === "connected";
    }

    async start() {
        const credentials = this.readCredentials();
        if (!credentials) {
            this.state = "logged_out";
            log.warn("No saved credentials. Call POST /v1/auth/qr to log in.");
            return;
        }

        try {
            const api = await this.zalo.login(credentials);
            await this.onLoggedIn(api);
        } catch (error) {
            this.state = "logged_out";
            this.lastError = `Login with saved credentials failed: ${(error as Error).message}`;
            log.error(this.lastError, "- the session has probably expired, log in again with the QR code.");
        }
    }

    /**
     * Starts (or reuses) a QR login flow and resolves once a QR image is available.
     */
    async requestQr(): Promise<{ image: string; expiresAt: number }> {
        if (this.state === "logged_in") {
            throw new HttpError(
                409,
                "ALREADY_LOGGED_IN",
                "Already logged in. Call POST /v1/auth/logout first to switch account.",
            );
        }

        if (this.qr && Date.now() - this.qr.generatedAt < QR_TTL_MS - 5000) {
            return { image: this.qr.image, expiresAt: this.qr.generatedAt + QR_TTL_MS };
        }

        const qrPromise = new Promise<PendingQr>((resolve, reject) => {
            this.qrWaiters.push((result) => (result instanceof Error ? reject(result) : resolve(result)));
        });

        if (this.state !== "awaiting_scan" && this.state !== "scanned") {
            this.state = "awaiting_scan";
            this.qr = null;
            this.runQrLogin();
        }

        const qr = await qrPromise.catch((error: Error) => {
            throw new HttpError(502, "QR_LOGIN_FAILED", error.message);
        });
        return { image: qr.image, expiresAt: qr.generatedAt + QR_TTL_MS };
    }

    getQrImage(): Buffer | null {
        if (!this.qr || Date.now() - this.qr.generatedAt >= QR_TTL_MS) return null;
        return Buffer.from(this.qr.image, "base64");
    }

    private flushQrWaiters(result: PendingQr | Error) {
        const waiters = this.qrWaiters;
        this.qrWaiters = [];
        for (const waiter of waiters) waiter(result);
    }

    private runQrLogin() {
        const userAgent =
            this.config.userAgent ??
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

        const callback = (event: LoginQRCallbackEvent) => {
            switch (event.type) {
                case LoginQRCallbackEventType.QRCodeGenerated:
                    this.qr = { image: event.data.image, generatedAt: Date.now(), abort: event.actions.abort };
                    log.info("QR code generated, waiting for scan (expires in 100s)");
                    this.flushQrWaiters(this.qr);
                    break;
                case LoginQRCallbackEventType.QRCodeExpired:
                    log.warn("QR code expired before it was scanned");
                    this.qr = null;
                    event.actions.abort();
                    break;
                case LoginQRCallbackEventType.QRCodeScanned:
                    this.state = "scanned";
                    log.info(`QR scanned by "${event.data.display_name}", waiting for confirmation on the phone`);
                    break;
                case LoginQRCallbackEventType.QRCodeDeclined:
                    log.warn("QR login was declined on the phone");
                    this.qr = null;
                    event.actions.abort();
                    break;
                case LoginQRCallbackEventType.GotLoginInfo:
                    this.writeCredentials({
                        cookie: event.data.cookie,
                        imei: event.data.imei,
                        userAgent: event.data.userAgent,
                    });
                    break;
            }
        };

        this.zalo
            .loginQR({ userAgent }, callback)
            .then((api) => this.onLoggedIn(api))
            .catch((error: Error) => {
                this.qr = null;
                if (this.state !== "logged_in") this.state = "logged_out";
                const aborted = error instanceof ZaloApiLoginQRAborted;
                this.lastError = aborted ? "QR login expired or was declined" : `QR login failed: ${error?.message}`;
                log.warn(this.lastError);
                this.flushQrWaiters(new Error(this.lastError));
            });
    }

    private async onLoggedIn(api: API) {
        this.api = api;
        this.state = "logged_in";
        this.qr = null;
        this.lastError = null;
        this.loggedInAt = Date.now();
        this.account = { uid: api.getOwnId() };

        try {
            const info = await api.fetchAccountInfo();
            this.account.displayName = info.profile?.displayName;
        } catch (error) {
            log.warn("Could not fetch account info:", (error as Error).message);
        }
        log.info(`Logged in as ${this.account.displayName ?? "?"} (uid ${this.account.uid})`);

        this.persistCredentials();
        this.startListener();

        this.clearTimers();
        this.timers.push(setInterval(() => this.persistCredentials(), CREDENTIALS_SAVE_INTERVAL_MS));
        this.timers.push(setInterval(() => void this.healthCheck(), HEALTH_CHECK_INTERVAL_MS));
    }

    private async healthCheck() {
        if (!this.api) return;
        try {
            await this.api.fetchAccountInfo();
            if (this.lastError?.startsWith("Health check")) this.lastError = null;
        } catch (error) {
            this.lastError = `Health check failed: ${(error as Error).message}`;
            log.error(this.lastError);
        }
    }

    private startListener() {
        if (!this.config.enableListener || !this.api) return;
        const listener = this.api.listener;

        listener.removeAllListeners();
        listener.on("connected", () => {
            this.listenerState = "connected";
            log.info("Listener connected");
        });
        listener.on("disconnected", (code, reason) => {
            this.listenerState = "connecting";
            log.warn(`Listener disconnected (${code} ${reason}), retrying`);
        });
        listener.on("closed", (code, reason) => {
            this.listenerState = "closed";
            if (code === CloseReason.ManualClosure) return;
            const hint =
                code === CloseReason.DuplicateConnection
                    ? " - Zalo Web was probably opened in a browser with this account"
                    : "";
            log.error(`Listener closed (${code} ${reason})${hint}. Restarting in ${LISTENER_RESTART_DELAY_MS / 1000}s`);
            this.scheduleListenerRestart();
        });
        listener.on("error", (error) => log.error("Listener error:", (error as Error)?.message ?? error));
        listener.on("message", (message) => {
            for (const handler of this.messageHandlers) {
                try {
                    handler(message);
                } catch (error) {
                    log.error("Message handler failed:", (error as Error).message);
                }
            }
        });

        this.listenerState = "connecting";
        try {
            listener.start({ retryOnClose: true });
        } catch (error) {
            log.error("Could not start listener:", (error as Error).message);
            this.scheduleListenerRestart();
        }
    }

    private scheduleListenerRestart() {
        if (this.listenerRestartTimer) return;
        this.listenerRestartTimer = setTimeout(() => {
            this.listenerRestartTimer = null;
            if (this.state === "logged_in" && this.listenerState === "closed") this.startListener();
        }, LISTENER_RESTART_DELAY_MS);
    }

    async logout() {
        this.clearTimers();
        this.qr?.abort();
        this.qr = null;
        if (this.api) {
            try {
                this.api.listener.removeAllListeners();
                this.api.listener.stop();
            } catch {
                // ignore
            }
        }
        this.api = null;
        this.account = null;
        this.loggedInAt = null;
        this.state = "logged_out";
        this.listenerState = this.config.enableListener ? "stopped" : "disabled";
        fs.rmSync(this.config.credentialsPath, { force: true });
        log.info("Logged out and removed saved credentials");
    }

    shutdown() {
        this.persistCredentials();
        this.clearTimers();
        this.api?.listener.stop();
    }

    private clearTimers() {
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [];
        if (this.listenerRestartTimer) clearTimeout(this.listenerRestartTimer);
        this.listenerRestartTimer = null;
    }

    /** Saves the current cookie jar so a container restart does not require a new QR scan. */
    private persistCredentials() {
        if (!this.api) return;
        try {
            const ctx = this.api.getContext();
            this.writeCredentials({
                cookie: ctx.cookie.toJSON()?.cookies ?? [],
                imei: ctx.imei,
                userAgent: ctx.userAgent,
            });
        } catch (error) {
            log.error("Could not save credentials:", (error as Error).message);
        }
    }

    private readCredentials(): Credentials | null {
        try {
            if (!fs.existsSync(this.config.credentialsPath)) return null;
            const parsed = JSON.parse(fs.readFileSync(this.config.credentialsPath, "utf-8")) as Partial<Credentials>;
            if (!parsed.cookie || !parsed.imei || !parsed.userAgent) return null;
            return parsed as Credentials;
        } catch (error) {
            log.error("Could not read credentials:", (error as Error).message);
            return null;
        }
    }

    private writeCredentials(credentials: Credentials) {
        const tmp = `${this.config.credentialsPath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(credentials), { mode: 0o600 });
        fs.renameSync(tmp, this.config.credentialsPath);
    }
}
