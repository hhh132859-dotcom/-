import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  boolean,
} from "drizzle-orm/pg-core";

export const moderationSettings = pgTable("moderation_settings", {
  guildId: text("guild_id").primaryKey(),
  spamEnabled: boolean("spam_enabled").notNull().default(true),
  spamThreshold: integer("spam_threshold").notNull().default(5),
  spamWindowSeconds: integer("spam_window_seconds").notNull().default(8),
  logChannelId: text("log_channel_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const moderationCases = pgTable(
  "moderation_cases",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    action: text("action").notNull(),
    targetUserId: text("target_user_id"),
    moderatorUserId: text("moderator_user_id").notNull(),
    reason: text("reason").notNull(),
    durationSeconds: integer("duration_seconds"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("moderation_cases_guild_created_idx").on(table.guildId, table.createdAt)],
);
