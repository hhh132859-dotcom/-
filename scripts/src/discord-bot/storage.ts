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

export type TicketSettings = {
  supportRoleId: string | null;
  categoryId: string | null;
};

export type TicketRecord = {
  id: number;
  guildId: string;
  channelId: string;
  openerUserId: string;
  supportRoleId: string;
  status: "open" | "closed";
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

export async function getTicketSettings(
  guildId: string,
): Promise<TicketSettings> {
  const result = await pool.query<TicketSettings>(
    `SELECT
       support_role_id AS "supportRoleId",
       category_id AS "categoryId"
     FROM ticket_settings
     WHERE guild_id = $1`,
    [guildId],
  );
  return result.rows[0] ?? { supportRoleId: null, categoryId: null };
}

export async function saveTicketSupportRole(
  guildId: string,
  roleId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO ticket_settings (guild_id, support_role_id)
     VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET
       support_role_id = EXCLUDED.support_role_id,
       updated_at = NOW()`,
    [guildId, roleId],
  );
}

export async function saveTicketCategory(
  guildId: string,
  categoryId: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO ticket_settings (guild_id, category_id)
     VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET
       category_id = EXCLUDED.category_id,
       updated_at = NOW()`,
    [guildId, categoryId],
  );
}

export async function findOpenTicketForUser(
  guildId: string,
  openerUserId: string,
): Promise<TicketRecord | null> {
  const result = await pool.query<TicketRecord>(
    `SELECT
       id,
       guild_id AS "guildId",
       channel_id AS "channelId",
       opener_user_id AS "openerUserId",
       support_role_id AS "supportRoleId",
       status
     FROM support_tickets
     WHERE guild_id = $1 AND opener_user_id = $2 AND status = 'open'
     ORDER BY id DESC
     LIMIT 1`,
    [guildId, openerUserId],
  );
  return result.rows[0] ?? null;
}

export async function getTicketById(
  guildId: string,
  ticketId: number,
): Promise<TicketRecord | null> {
  const result = await pool.query<TicketRecord>(
    `SELECT
       id,
       guild_id AS "guildId",
       channel_id AS "channelId",
       opener_user_id AS "openerUserId",
       support_role_id AS "supportRoleId",
       status
     FROM support_tickets
     WHERE guild_id = $1 AND id = $2`,
    [guildId, ticketId],
  );
  return result.rows[0] ?? null;
}

export async function createTicket(input: {
  guildId: string;
  channelId: string;
  openerUserId: string;
  supportRoleId: string;
}): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO support_tickets (
       guild_id, channel_id, opener_user_id, support_role_id
     )
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [input.guildId, input.channelId, input.openerUserId, input.supportRoleId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("The ticket could not be saved.");
  return row.id;
}

export async function closeTicket(
  ticketId: number,
  closedByUserId: string | null,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE support_tickets
     SET status = 'closed', closed_at = NOW(), closed_by_user_id = $2
     WHERE id = $1 AND status = 'open'
     RETURNING id`,
    [ticketId, closedByUserId],
  );
  return result.rowCount === 1;
}

export async function reopenTicket(ticketId: number): Promise<boolean> {
  const result = await pool.query(
    `UPDATE support_tickets
     SET status = 'open', closed_at = NULL, closed_by_user_id = NULL
     WHERE id = $1 AND status = 'closed'
     RETURNING id`,
    [ticketId],
  );
  return result.rowCount === 1;
}
