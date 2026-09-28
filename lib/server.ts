import { ROOM_TTL_MS, PAGE_SIZE, TOKEN, UUID, decode64, hashToken, randomToken } from "./protocol.ts";
import type { Room, StoredMessage } from "./protocol.ts";

// The database clock decides expiry inside the actual read/write statement.
const NOW = "(unixepoch() * 1000)";
const ROOM_FIELDS = "id, created_at AS createdAt, expires_at AS expiresAt";
const MESSAGE_FIELDS = "id, sequence, sender_id AS senderId, iv, ciphertext, created_at AS createdAt";
class ApiError extends Error {
  status: number;
  constructor(status: number, code: string) { super(code); this.status = status; }
}
function reply(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: {
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    ...(status === 429 ? { "Retry-After": "60" } : {}),
  } });
}
function tokenFrom(request: Request): string {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!TOKEN.test(token)) throw new ApiError(401, "UNAUTHORIZED");
  try { if (decode64(token).length !== 32) throw new Error(); } catch { throw new ApiError(401, "UNAUTHORIZED"); }
  return token;
}
async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new ApiError(415, "JSON_REQUIRED");
  if (Number(request.headers.get("content-length")) > 20000) throw new ApiError(413, "TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "INVALID_BODY");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 20000) { await reader.cancel(); throw new ApiError(413, "TOO_LARGE"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "INVALID_BODY");
  } finally { reader.releaseLock(); }
}
function checkOrigin(request: Request) {
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new ApiError(403, "BAD_ORIGIN");
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new ApiError(403, "BAD_ORIGIN");
}
// Cloudflare supplies this header; no raw IP is persisted. Buckets expire after two minutes.
async function clientBucket(request: Request) {
  return hashToken(`${Math.floor(Date.now() / 60000)}:${request.headers.get("cf-connecting-ip") ?? "local"}`);
}
async function consumeLimit(db: D1Database, scope: string, max: number): Promise<void> {
  const row = await db.prepare(`INSERT INTO limits (bucket, count, expires_at)
    VALUES (? || ':' || CAST(unixepoch() / 60 AS INTEGER), 1, ${NOW} + 120000)
    ON CONFLICT(bucket) DO UPDATE SET count = count + 1
    WHERE count < ? RETURNING count`).bind(scope, max).first();
  if (!row) throw new ApiError(429, "RATE_LIMIT");
}
export async function cleanupExpired(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM rooms WHERE expires_at <= ${NOW}`),
    db.prepare(`DELETE FROM limits WHERE expires_at <= ${NOW}`),
  ]);
}
async function authorized(db: D1Database, roomId: string, token: string) {
  const row = await db.prepare(`SELECT r.id, r.created_at AS createdAt, r.expires_at AS expiresAt, m.id AS senderId
    FROM rooms r JOIN members m ON m.room_id = r.id
    WHERE r.id = ? AND m.token_hash = ?`).bind(roomId, await hashToken(token)).first<Room & { senderId: string }>();
  if (!row) throw new ApiError(403, "ACCESS_DENIED");
  return row;
}
async function ensureActive(db: D1Database, roomId: string) {
  const active = await db.prepare(`SELECT id FROM rooms WHERE id = ? AND expires_at > ${NOW}`).bind(roomId).first();
  if (!active) { await cleanupExpired(db); throw new ApiError(410, "ROOM_EXPIRED"); }
}

export async function handleApi(request: Request, db: D1Database): Promise<Response> {
  try {
    checkOrigin(request);
    const path = new URL(request.url).pathname;
    if (path === "/api/rooms" && request.method === "POST") {
      const token = tokenFrom(request);
      await jsonBody(request);
      await consumeLimit(db, `create:${await clientBucket(request)}`, 10);
      await cleanupExpired(db);
      const room = await db.prepare(`INSERT INTO rooms (id, invite_hash, created_at, expires_at)
        SELECT ?, ?, ${NOW}, ${NOW} + ? WHERE (SELECT count(*) FROM rooms) < 10
        RETURNING ${ROOM_FIELDS}`).bind(crypto.randomUUID(), await hashToken(token), ROOM_TTL_MS).first<Room>();
      if (!room) throw new ApiError(429, "ROOM_LIMIT");
      return reply({ room }, 201);
    }
    const match = /^\/api\/rooms\/([^/]+)\/(join|messages)$/.exec(path);
    if (!match || !UUID.test(match[1])) throw new ApiError(404, "NOT_FOUND");
    const [, roomId, action] = match;
    const token = tokenFrom(request);
    if (action === "join" && request.method === "POST") {
      await jsonBody(request);
      await consumeLimit(db, `join:${await clientBucket(request)}`, 120);
      const room = await db.prepare(`SELECT ${ROOM_FIELDS} FROM rooms WHERE id = ? AND invite_hash = ?`)
        .bind(roomId, await hashToken(token)).first<Room>();
      if (!room) throw new ApiError(403, "ACCESS_DENIED");
      await consumeLimit(db, `room-join:${roomId}`, 60);
      await ensureActive(db, roomId);
      const senderId = crypto.randomUUID();
      const sessionToken = randomToken();
      const member = await db.prepare(`INSERT INTO members (id, room_id, token_hash)
        SELECT ?, id, ? FROM rooms WHERE id = ? AND expires_at > ${NOW}
        AND (SELECT count(*) FROM members WHERE room_id = ?) < 256 RETURNING id`)
        .bind(senderId, await hashToken(sessionToken), roomId, roomId).first();
      if (!member) { await ensureActive(db, roomId); throw new ApiError(429, "MEMBER_LIMIT"); }
      await ensureActive(db, roomId);
      return reply({ room, senderId, sessionToken, serverNow: Date.now() }, 201);
    }
    if (action !== "messages" || !["GET", "POST"].includes(request.method)) throw new ApiError(405, "METHOD_NOT_ALLOWED");
    const member = await authorized(db, roomId, token);
    await ensureActive(db, roomId);
    if (request.method === "GET") {
      const rawAfter = new URL(request.url).searchParams.get("after") ?? "0";
      if (!/^\d{1,15}$/.test(rawAfter)) throw new ApiError(400, "INVALID_CURSOR");
      const after = Number(rawAfter);
      const result = await db.prepare(`SELECT ${MESSAGE_FIELDS} FROM messages
        WHERE room_id = ? AND sequence > ?
        AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND expires_at > ${NOW})
        ORDER BY sequence LIMIT ?`).bind(roomId, after, roomId, PAGE_SIZE).all<StoredMessage>();
      await ensureActive(db, roomId);
      return reply({ messages: result.results, serverNow: Date.now(), expiresAt: member.expiresAt, hasMore: result.results.length === PAGE_SIZE });
    }
    const body = await jsonBody(request);
    const { id, iv, ciphertext } = body;
    if (typeof id !== "string" || !UUID.test(id) || typeof iv !== "string" || typeof ciphertext !== "string") throw new ApiError(400, "INVALID_MESSAGE");
    try {
      if (decode64(iv).length !== 12 || ciphertext.length > 17000 || decode64(ciphertext).length < 17) throw new Error();
    } catch { throw new ApiError(400, "INVALID_MESSAGE"); }
    function samePayload(message: StoredMessage) {
      if (message.senderId !== member.senderId || message.iv !== iv || message.ciphertext !== ciphertext) throw new ApiError(409, "MESSAGE_CONFLICT");
      return reply({ message });
    }
    const findExisting = () => db.prepare(`SELECT ${MESSAGE_FIELDS} FROM messages WHERE room_id = ? AND id = ?`).bind(roomId, id).first<StoredMessage>();
    const existing = await findExisting();
    if (existing) { await ensureActive(db, roomId); return samePayload(existing); }
    // Atomic quota + expiry guard; a concurrent retry is resolved by the UNIQUE constraint.
    const inserted = await db.prepare(`INSERT INTO messages (id, room_id, sender_id, iv, ciphertext, created_at)
      SELECT ?, id, ?, ?, ?, ${NOW} FROM rooms WHERE id = ? AND expires_at > ${NOW}
      AND (SELECT count(*) FROM messages WHERE room_id = ?) < 2000
      AND (SELECT count(*) FROM messages WHERE room_id = ? AND created_at > ${NOW} - 60000) < 120
      ON CONFLICT DO NOTHING RETURNING ${MESSAGE_FIELDS}`)
      .bind(id, member.senderId, iv, ciphertext, roomId, roomId, roomId).first<StoredMessage>();
    await ensureActive(db, roomId);
    if (inserted) return reply({ message: inserted }, 201);
    const retry = await findExisting();
    if (retry) { await ensureActive(db, roomId); return samePayload(retry); }
    const reusedNonce = await db.prepare("SELECT id FROM messages WHERE room_id = ? AND iv = ?").bind(roomId, iv).first();
    if (reusedNonce) throw new ApiError(409, "NONCE_REUSED");
    const size = await db.prepare("SELECT count(*) AS n FROM messages WHERE room_id = ?").bind(roomId).first<{ n: number }>();
    if (size && size.n >= 2000) throw new ApiError(409, "ROOM_FULL");
    throw new ApiError(429, "MESSAGE_LIMIT");
  } catch (error) {
    if (error instanceof ApiError) return reply({ error: error.message }, error.status);
    // Never log request objects, tokens, nicknames, message bodies or ciphertext.
    console.error("one-chat: database request failed");
    return reply({ error: "SERVICE_UNAVAILABLE" }, 503);
  }
}
