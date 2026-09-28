import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(),
  inviteHash: text("invite_hash").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (t) => [index("rooms_expiry").on(t.expiresAt)]);

export const members = sqliteTable("members", {
  id: text("id").primaryKey(),
  roomId: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
}, (t) => [uniqueIndex("members_token").on(t.tokenHash), index("members_room").on(t.roomId)]);

export const messages = sqliteTable("messages", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  id: text("id").notNull(),
  roomId: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
  senderId: text("sender_id").notNull(),
  iv: text("iv").notNull(),
  ciphertext: text("ciphertext").notNull(),
  createdAt: integer("created_at").notNull(),
}, (t) => [
  uniqueIndex("messages_identity").on(t.roomId, t.id),
  uniqueIndex("messages_nonce").on(t.roomId, t.iv),
  index("messages_cursor").on(t.roomId, t.sequence),
  index("messages_rate").on(t.roomId, t.createdAt),
]);

export const limits = sqliteTable("limits", {
  bucket: text("bucket").primaryKey(),
  count: integer("count").notNull(),
  expiresAt: integer("expires_at").notNull(),
});
