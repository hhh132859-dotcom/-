import pg from "pg";

const { Pool } = pg;

const databaseUrl = process.env["DATABASE_URL"];

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required to store moderation settings and cases.",
  );
}

export const pool = new Pool({ connectionString: databaseUrl });

export type GuildSettings = {
  spamEnabled: boolean;
  spamThreshold: number;
  spamWindowSeconds: number;
  logChannelId: string | null;
};

export type CaseInput = {
  guildId: string;
  action: string;
  targetUserId: string | null;
  moderatorUserId: string;
  reason: string;
  durationSeconds?: number | null;
};

const defaultSettings: GuildSettings = {
  spamEnabled: true,
  spamThreshold: 5,
  spamWindowSeconds: 8,
  logChannelId: null,
};

export async function getGuildSettings(
  guildId: string,
): Promise<GuildSettings> {
  const result = await pool.query<GuildSettings>(
    `SELECT
       spam_enabled AS "spamEnabled",
       spam_threshold AS "spamThreshold",
       spam_window_seconds AS "spamWindowSeconds",
       log_channel_id AS "logChannelId"
     FROM moderation_settings
     WHERE guild_id = $1`,
    [guildId],
  );

  return result.rows[0] ?? defaultSettings;
}

export async function saveSpamSettings(
  guildId: string,
  settings: Pick<
    GuildSettings,
    "spamEnabled" | "spamThreshold" | "spamWindowSeconds"
  >,
): Promise<void> {
  await pool.query(
    `INSERT INTO moderation_settings (
       guild_id, spam_enabled, spam_threshold, spam_window_seconds
     )
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (guild_id) DO UPDATE SET
       spam_enabled = EXCLUDED.spam_enabled,
       spam_threshold = EXCLUDED.spam_threshold,
       spam_window_seconds = EXCLUDED.spam_window_seconds,
       updated_at = NOW()`,
    [
      guildId,
      settings.spamEnabled,
      settings.spamThreshold,
      settings.spamWindowSeconds,
    ],
  );
}

export async function saveLogChannel(
  guildId: string,
  channelId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO moderation_settings (guild_id, log_channel_id)
     VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET
       log_channel_id = EXCLUDED.log_channel_id,
       updated_at = NOW()`,
    [guildId, channelId],
  );
}

export async function saveCase(input: CaseInput): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO moderation_cases (
       guild_id, action, target_user_id, moderator_user_id, reason, duration_seconds
     )
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      input.guildId,
      input.action,
      input.targetUserId,
      input.moderatorUserId,
      input.reason,
      input.durationSeconds ?? null,
    ],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error("The moderation action was not recorded.");
  }

  return row.id;
}
