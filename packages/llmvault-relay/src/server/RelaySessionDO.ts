/**
 * Durable Object for Phone Wallet Relay session management.
 *
 * Manages WebSocket connections between a PC browser and a mobile app.
 * The relay is zero-knowledge: it only forwards E2E encrypted blobs
 * without decrypting or inspecting message content.
 *
 * Lifecycle:
 *   1. POST /init → creates DO, stores pairing token + PC public key
 *   2. PC connects via WebSocket → stored as pcSocket
 *   3. Mobile connects with pairing token → stored as mobileSocket
 *   4. Key exchange messages forwarded between peers
 *   5. All subsequent "encrypted" messages forwarded as-is
 *   6. Idle timeout (30min) or absolute timeout (24h) → disconnect both
 */

import { DurableObject } from "cloudflare:workers";
import { computeShortCode } from "../crypto.js";

const PAIRING_TTL_MS = 5 * 60 * 1000; // 5 minutes
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const ABSOLUTE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_MESSAGES_PER_MINUTE = 100;

type SessionState = "pending" | "paired" | "connected" | "disconnected";

interface SessionData {
  state: SessionState;
  pairingToken: string;
  pcPublicKey: string;
  createdAt: number;
  lastActivityAt: number;
  tokenConsumed: boolean;
}

// ── Envelope validation (lightweight runtime type guard) ──────────────

/** Known envelope fields per message type. Unknown fields are stripped. */
const KNOWN_FIELDS: Record<string, readonly string[]> = {
  ping: ["type"],
  pong: ["type"],
  keyExchange: ["type", "sessionId", "mobilePublicKey"],
  encrypted: ["type", "sessionId", "requestId", "ciphertextBase64", "ivBase64", "sequence"],
  disconnect: ["type", "sessionId", "reason"],
};

/**
 * Validate a parsed WS message and strip unknown fields.
 * Returns a clean object with only known fields, or null if invalid.
 */
function validateEnvelope(raw: Record<string, unknown>): Record<string, unknown> | null {
  const type = raw.type;
  if (typeof type !== "string") return null;

  const fields = KNOWN_FIELDS[type];
  if (!fields) return null; // unknown type → reject

  const clean: Record<string, unknown> = {};
  for (const key of fields) {
    if (key in raw) clean[key] = raw[key];
  }
  return clean;
}

export class RelaySessionDO extends DurableObject {
  private sessionData: SessionData | null = null;
  private messageCount = 0;
  private messageCountResetAt = 0;

  // Socket references are retrieved via `ctx.getWebSockets(tag)` rather than
  // held in instance variables so the DO survives WebSocket hibernation:
  // the tags `"pc"` and `"mobile"` are supplied to `acceptWebSocket()`.
  private getPcSocket(): WebSocket | null {
    return this.ctx.getWebSockets("pc")[0] ?? null;
  }
  private getMobileSocket(): WebSocket | null {
    return this.ctx.getWebSockets("mobile")[0] ?? null;
  }

  // MARK: - HTTP Handler

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/init") {
      return this.handleInit(request);
    }

    if (url.pathname === "/ws") {
      return this.handleWebSocket(request, url);
    }

    return new Response("Not found", { status: 404 });
  }

  // MARK: - Init (called by the route factory to set up the session)

  private async handleInit(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      pairingToken?: string;
      pcPublicKey?: string;
    };

    // `/init` is called twice: once by POST /pair (to create the session)
    // and once by GET /ws?role=pc (to populate pcPublicKey before upgrade).
    if (!this.sessionData) {
      this.sessionData = (await this.ctx.storage.get<SessionData>("session")) ?? null;
    }

    const now = Date.now();
    if (!this.sessionData) {
      this.sessionData = {
        state: "pending",
        pairingToken: body.pairingToken ?? "",
        pcPublicKey: body.pcPublicKey ?? "",
        createdAt: now,
        lastActivityAt: now,
        tokenConsumed: false,
      };
    } else {
      // Update only the fields that were supplied.
      if (body.pairingToken) this.sessionData.pairingToken = body.pairingToken;
      if (body.pcPublicKey) this.sessionData.pcPublicKey = body.pcPublicKey;
    }

    await this.ctx.storage.put("session", this.sessionData);
    await this.ctx.storage.setAlarm(this.sessionData.createdAt + PAIRING_TTL_MS);

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // MARK: - WebSocket Upgrade

  private async handleWebSocket(request: Request, url: URL): Promise<Response> {
    const role = url.searchParams.get("role");
    const token = url.searchParams.get("token");

    if (!this.sessionData) {
      this.sessionData = (await this.ctx.storage.get<SessionData>("session")) ?? null;
    }

    if (!this.sessionData) {
      return new Response("Session not found", { status: 404 });
    }

    if (this.sessionData.state === "disconnected") {
      return new Response("Session expired", { status: 410 });
    }

    if (role !== "pc" && role !== "mobile") {
      return new Response("Invalid role", { status: 400 });
    }

    // Mobile side must present the single-use pairing token.
    if (role === "mobile") {
      if (!token || token !== this.sessionData.pairingToken) {
        return new Response("Invalid pairing token", { status: 403 });
      }
      if (this.sessionData.tokenConsumed) {
        return new Response("Pairing token already used", { status: 403 });
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [role]);

    if (role === "mobile") {
      this.sessionData.tokenConsumed = true;
      this.sessionData.pairingToken = ""; // Scrub from memory
      this.sessionData.state = "paired";
      this.sessionData.lastActivityAt = Date.now();
      await this.ctx.storage.put("session", this.sessionData);

      // Forward PC's public key to mobile so it can derive the shared secret.
      this.sendToSocket(server, {
        type: "keyExchange",
        sessionId: this.ctx.id.toString(),
        pcPublicKey: this.sessionData.pcPublicKey,
      });

      await this.ctx.storage.setAlarm(Date.now() + IDLE_TIMEOUT_MS);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // MARK: - WebSocket Hibernation Handlers

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(message);
    } catch {
      this.sendToSocket(ws, {
        type: "error",
        code: "INVALID_JSON",
        message: "Invalid JSON message",
      });
      return;
    }

    const parsed = validateEnvelope(raw);
    if (!parsed) {
      this.sendToSocket(ws, {
        type: "error",
        code: "INVALID_ENVELOPE",
        message: "Unknown or malformed message type",
      });
      return;
    }

    const msgType = parsed.type as string;

    if (!this.checkRateLimit()) {
      this.sendToSocket(ws, {
        type: "error",
        code: "RATE_LIMITED",
        message: "Too many messages",
      });
      return;
    }

    if (this.sessionData) {
      this.sessionData.lastActivityAt = Date.now();
    }

    switch (msgType) {
      case "ping":
        this.sendToSocket(ws, { type: "pong" });
        break;

      case "pong":
        break;

      case "keyExchange": {
        // Mobile sends its public key → forward to PC and announce `paired`.
        const senderTags = this.ctx.getTags(ws);
        const pcSocket = this.getPcSocket();
        if (senderTags.includes("mobile") && pcSocket) {
          this.sendToSocket(pcSocket, parsed);

          const mobilePublicKey = parsed.mobilePublicKey as string;
          // Re-hydrate sessionData in case the DO was hibernated and lost in-memory state.
          if (!this.sessionData) {
            this.sessionData = (await this.ctx.storage.get<SessionData>("session")) ?? null;
          }
          const pcPublicKey = this.sessionData?.pcPublicKey ?? "";
          const shortCode = await computeShortCode(pcPublicKey, mobilePublicKey);

          const sessionId = this.ctx.id.toString();
          const pairedMsg = { type: "paired", sessionId, shortCode };
          this.sendToSocket(pcSocket, pairedMsg);
          this.sendToSocket(ws, pairedMsg);

          if (this.sessionData) {
            this.sessionData.state = "connected";
            await this.ctx.storage.put("session", this.sessionData);
          }

          await this.ctx.storage.setAlarm(Date.now() + IDLE_TIMEOUT_MS);
        }
        break;
      }

      case "encrypted": {
        // Forward opaque encrypted blobs between peers (zero-knowledge relay).
        const senderTags = this.ctx.getTags(ws);
        const peer = senderTags.includes("pc") ? this.getMobileSocket() : this.getPcSocket();
        if (peer) {
          this.sendToSocket(peer, parsed);
          await this.ctx.storage.setAlarm(Date.now() + IDLE_TIMEOUT_MS);
        }
        break;
      }

      case "disconnect": {
        await this.disconnectBoth((parsed.reason as string) ?? "client_request");
        break;
      }

      default:
        this.sendToSocket(ws, {
          type: "error",
          code: "UNKNOWN_TYPE",
          message: `Unknown message type: ${msgType}`,
        });
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string): Promise<void> {
    const tags = this.ctx.getTags(ws);
    const role = tags.includes("pc") ? "pc" : "mobile";
    const peer = tags.includes("pc") ? this.getMobileSocket() : this.getPcSocket();

    if (peer) {
      this.sendToSocket(peer, {
        type: "disconnect",
        sessionId: this.ctx.id.toString(),
        reason: `${role}_disconnected`,
      });
    }

    // After this socket closes, getWebSockets() excludes it automatically.
    // Mark the session disconnected once both peers are gone.
    const remaining = this.ctx.getWebSockets().filter((s) => s !== ws);
    if (remaining.length === 0 && this.sessionData) {
      this.sessionData.state = "disconnected";
      await this.ctx.storage.put("session", this.sessionData);
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    try {
      ws.close(1011, "WebSocket error");
    } catch {
      /* already closed */
    }
    await this.webSocketClose(ws, 1011, "error");
  }

  // MARK: - Alarm (timeout handling)

  async alarm(): Promise<void> {
    if (!this.sessionData) {
      this.sessionData = (await this.ctx.storage.get<SessionData>("session")) ?? null;
    }

    if (!this.sessionData) return;

    const now = Date.now();

    if (now - this.sessionData.createdAt >= ABSOLUTE_TIMEOUT_MS) {
      await this.disconnectBoth("absolute_timeout");
      return;
    }

    if (
      this.sessionData.state === "pending" &&
      !this.sessionData.tokenConsumed &&
      now - this.sessionData.createdAt >= PAIRING_TTL_MS
    ) {
      await this.disconnectBoth("pairing_expired");
      return;
    }

    if (now - this.sessionData.lastActivityAt >= IDLE_TIMEOUT_MS) {
      await this.disconnectBoth("idle_timeout");
      return;
    }

    const nextAlarm = this.sessionData.lastActivityAt + IDLE_TIMEOUT_MS;
    if (nextAlarm > now) {
      await this.ctx.storage.setAlarm(nextAlarm);
    }
  }

  // MARK: - Helpers

  private async disconnectBoth(reason: string): Promise<void> {
    const msg = {
      type: "disconnect",
      sessionId: this.ctx.id.toString(),
      reason,
    };

    for (const sock of this.ctx.getWebSockets()) {
      this.sendToSocket(sock, msg);
      try {
        sock.close(1000, reason);
      } catch {
        /* already closed */
      }
    }

    if (this.sessionData) {
      this.sessionData.state = "disconnected";
      await this.ctx.storage.put("session", this.sessionData);
    }
  }

  private sendToSocket(ws: WebSocket, data: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(data));
    } catch {
      // Socket already closed — ignore
    }
  }

  private checkRateLimit(): boolean {
    const now = Date.now();
    if (now - this.messageCountResetAt >= 60_000) {
      this.messageCount = 0;
      this.messageCountResetAt = now;
    }
    this.messageCount++;
    return this.messageCount <= MAX_MESSAGES_PER_MINUTE;
  }
}
