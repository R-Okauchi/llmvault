/**
 * Factory for the Phone Wallet Relay Hono routes.
 *
 * Downstream apps provide:
 *   - A getter for their Durable Object namespace binding
 *   - Optional middleware (e.g. session auth) for `POST /pair`
 *   - Optional request-body validator (e.g. Turnstile check)
 *
 * The factory returns a `Hono` sub-app intended to be mounted at e.g.
 * `/v1/relay`, providing:
 *   POST  /pair  — create a relay session, return pairing token + WS URL
 *   GET   /ws    — upgrade to WebSocket, forwarded to the session DO
 */

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { RelayPairResponse } from "../types.js";

export interface CreateRelayRoutesOptions<Env extends object> {
  /** Return the Durable Object namespace binding from your env. */
  getDurableObject: (env: Env) => DurableObjectNamespace;
  /** Middleware applied to `POST /pair` (e.g. a session auth check). */
  sessionMiddleware?: MiddlewareHandler;
  /**
   * Validate the `POST /pair` JSON body.
   * Return `{ ok: false, error }` to reject with 400.
   * Default: accept any JSON body.
   */
  validatePairRequest?: (body: unknown) => { ok: boolean; error?: string };
  /**
   * Allowed origins for WebSocket upgrade requests.
   * Browsers do NOT enforce CORS on WebSocket upgrades, so this check must
   * be done server-side.  PC-role connections (browser) MUST send a matching
   * Origin header.  Mobile-role connections (native) may omit it.
   *
   * Pass a static list or a function that derives the list from the env.
   * If omitted or empty, **all PC-role upgrades are rejected** (safe default).
   */
  allowedWsOrigins?: string[] | ((env: Env) => string[]);
}

export function createRelayRoutes<Env extends object>(
  opts: CreateRelayRoutesOptions<Env>,
): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();

  if (opts.sessionMiddleware) {
    routes.use("/pair", opts.sessionMiddleware);
  }

  /** POST /pair — create a relay session + pairing token. */
  routes.post("/pair", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as unknown;

    if (opts.validatePairRequest) {
      const v = opts.validatePairRequest(body);
      if (!v.ok) {
        return c.json({ error: v.error ?? "Invalid request body" }, 400);
      }
    }

    const sessionId = crypto.randomUUID();
    const pairingToken = generatePairingToken();

    const ns = opts.getDurableObject(c.env);
    const doId = ns.idFromName(sessionId);
    const stub = ns.get(doId);

    const initResponse = await stub.fetch(
      new Request("https://do/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pairingToken,
          pcPublicKey: "", // PC supplies this later via the WebSocket query param
        }),
      }),
    );

    if (!initResponse.ok) {
      return c.json({ error: "Failed to create relay session" }, 500);
    }

    const host = c.req.header("Host") ?? "localhost";
    const protocol = host.includes("localhost") ? "ws" : "wss";
    const relayUrl = `${protocol}://${host}/v1/relay/ws?session=${sessionId}`;

    const response: RelayPairResponse = {
      pairingToken,
      relayUrl,
      sessionId,
      expiresAt: Date.now() + 5 * 60 * 1000,
    };
    return c.json(response);
  });

  /** GET /ws — WebSocket upgrade forwarded to the session DO. */
  routes.get("/ws", async (c) => {
    const upgradeHeader = c.req.header("Upgrade");
    if (upgradeHeader?.toLowerCase() !== "websocket") {
      return c.json({ error: "Expected WebSocket upgrade" }, 400);
    }

    const url = new URL(c.req.url);
    const sessionId = url.searchParams.get("session");
    const role = url.searchParams.get("role");

    if (!sessionId) return c.json({ error: "Missing session parameter" }, 400);
    if (role !== "pc" && role !== "mobile") {
      return c.json({ error: "Invalid role (must be pc or mobile)" }, 400);
    }

    // ── Origin validation (browsers skip CORS for WebSocket upgrades) ──
    const allowed =
      typeof opts.allowedWsOrigins === "function"
        ? opts.allowedWsOrigins(c.env)
        : opts.allowedWsOrigins ?? [];

    const origin = c.req.header("Origin");

    if (role === "pc") {
      // PC role is always a browser — Origin header must be present and allowed.
      if (!origin || !allowed.includes(origin)) {
        return c.json({ error: "Origin not allowed" }, 403);
      }
    } else if (origin && allowed.length > 0 && !allowed.includes(origin)) {
      // Mobile role with an unexpected Origin (e.g. rogue browser tab).
      return c.json({ error: "Origin not allowed" }, 403);
    }

    const ns = opts.getDurableObject(c.env);
    const doId = ns.idFromName(sessionId);
    const stub = ns.get(doId);

    // PC supplies its ECDH public key via query param on connect.
    const pcPublicKey = url.searchParams.get("pcPublicKey");
    if (role === "pc" && pcPublicKey) {
      await stub.fetch(
        new Request("https://do/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pcPublicKey }),
        }),
      );
    }

    const token = url.searchParams.get("token") ?? "";
    const doUrl = `https://do/ws?role=${role}&token=${encodeURIComponent(token)}`;

    const doResponse = await stub.fetch(
      new Request(doUrl, {
        headers: c.req.raw.headers,
      }),
    );

    return new Response(doResponse.body, {
      status: doResponse.status,
      statusText: doResponse.statusText,
      headers: doResponse.headers,
      webSocket: (doResponse as unknown as { webSocket?: WebSocket }).webSocket,
    });
  });

  return routes;
}

function generatePairingToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
