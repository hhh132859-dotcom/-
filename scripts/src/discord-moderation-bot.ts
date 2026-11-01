import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Client as DiscordClient,
  type Message,
} from "discord.js";
import pino from "pino";
import { commandData } from "./discord-bot/commands";
import {
  getGuildSettings,
  pool,
  saveCase,
  saveLogChannel,
  saveSpamSettings,
} from "./discord-bot/storage";

const logger = pino({ level: process.env["LOG_LEVEL"] ?? "info" });
const spamMessageTimes = new Map<string, number[]>();
const automaticTimeouts = new Map<string, number>();
const settingsCache = new Map<
  string,
  { expiresAt: number; settings: Awaited<ReturnType<typeof getGuildSettings>> }
>();
const SETTINGS_CACHE_MS = 10_000;
const SPAM_TIMEOUT_MS = 5 * 60 * 1000;

function requireGuild(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    throw new Error("This command can only be used in a server.");
  }
  return interaction.guild;
}

function requirePermission(
  interaction: ChatInputCommandInteraction,
  permission: bigint,
  label: string,
): void {
  if (!interaction.memberPermissions?.has(permission)) {
    throw new Error(`You need the ${label} permission to use this command.`);
  }
}

async function getSettings(guildId: string) {
  const cached = settingsCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.settings;
  }

  const settings = await getGuildSettings(guildId);
  settingsCache.set(guildId, {
    settings,
    expiresAt: Date.now() + SETTINGS_CACHE_MS,
  });
  return settings;
}

async function postLog(
  client: DiscordClient,
  guildId: string,
  text: string,
): Promise<void> {
  const settings = await getSettings(guildId);
  if (!settings.logChannelId) return;

  try {
    const channel = await client.channels.fetch(settings.logChannelId);
    if (!channel || !("send" in channel) || typeof channel.send !== "function") {
      logger.warn({ guildId, channelId: settings.logChannelId }, "Invalid moderation log channel");
      return;
    }

    await channel.send({
      content: text,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logger.error(
      { err: error, guildId, channelId: settings.logChannelId },
      "Could not send moderation log",
    );
  }
}

async function recordAndLog(
  client: DiscordClient,
  input: {
    guildId: string;
    action: string;
    targetUserId: string | null;
    moderatorUserId: string;
    reason: string;
    durationSeconds?: number | null;
  },
): Promise<number> {
  const caseId = await saveCase(input);
  const target = input.targetUserId ? `<@${input.targetUserId}>` : "no member";
  await postLog(
    client,
    input.guildId,
    `**Case #${caseId} · ${input.action}**\n` +
      `Member: ${target}\n` +
      `Moderator: <@${input.moderatorUserId}>\n` +
      `Reason: ${input.reason}`,
  );
  return caseId;
}

async function replyPrivately(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ content });
    return;
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function handleCommand(
  client: DiscordClient,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = requireGuild(interaction);

  switch (interaction.commandName) {
    case "warn": {
      requirePermission(
        interaction,
        PermissionFlagsBits.ModerateMembers,
        "Moderate Members",
      );
      const target = interaction.options.getUser("user", true);
      if (target.id === interaction.user.id) {
        throw new Error("You cannot warn yourself.");
      }

      const reason = interaction.options.getString("reason", true);
      const caseId = await recordAndLog(client, {
        guildId: guild.id,
        action: "warning",
        targetUserId: target.id,
        moderatorUserId: interaction.user.id,
        reason,
      });
      await replyPrivately(interaction, `Warning recorded as case #${caseId}.`);
      return;
    }

    case "timeout": {
      requirePermission(
        interaction,
        PermissionFlagsBits.ModerateMembers,
        "Moderate Members",
      );
      const target = interaction.options.getUser("user", true);
      if (target.id === interaction.user.id) {
        throw new Error("You cannot timeout yourself.");
      }

      const minutes = interaction.options.getInteger("minutes", true);
      const reason = interaction.options.getString("reason", true);
      const member = await guild.members.fetch(target.id);
      await member.timeout(minutes * 60_000, reason);
      const caseId = await recordAndLog(client, {
        guildId: guild.id,
        action: "timeout",
        targetUserId: target.id,
        moderatorUserId: interaction.user.id,
        reason,
        durationSeconds: minutes * 60,
      });
      await replyPrivately(
        interaction,
        `${target.tag} was timed out for ${minutes} minute(s). Case #${caseId}.`,
      );
      return;
    }

    case "kick": {
      requirePermission(interaction, PermissionFlagsBits.KickMembers, "Kick Members");
      const target = interaction.options.getUser("user", true);
      if (target.id === interaction.user.id) {
        throw new Error("You cannot kick yourself.");
      }

      const reason = interaction.options.getString("reason", true);
      const member = await guild.members.fetch(target.id);
      await member.kick(reason);
      const caseId = await recordAndLog(client, {
        guildId: guild.id,
        action: "kick",
        targetUserId: target.id,
        moderatorUserId: interaction.user.id,
        reason,
      });
      await replyPrivately(interaction, `${target.tag} was kicked. Case #${caseId}.`);
      return;
    }

    case "clear": {
      requirePermission(
        interaction,
        PermissionFlagsBits.ManageMessages,
        "Manage Messages",
      );
      const amount = interaction.options.getInteger("amount", true);
      const channel = interaction.channel;
      if (
        !channel ||
        !("bulkDelete" in channel) ||
        typeof channel.bulkDelete !== "function"
      ) {
        throw new Error("Use this command in a server text channel.");
      }

      const deleted = await channel.bulkDelete(amount, true);
      const caseId = await recordAndLog(client, {
        guildId: guild.id,
        action: "clear",
        targetUserId: null,
        moderatorUserId: interaction.user.id,
        reason: `Deleted ${deleted.size} recent message(s) in #${"name" in channel ? channel.name : "channel"}.`,
      });
      await replyPrivately(
        interaction,
        `Deleted ${deleted.size} message(s). Messages older than 14 days are skipped. Case #${caseId}.`,
      );
      return;
    }

    case "mod-config": {
      requirePermission(interaction, PermissionFlagsBits.ManageGuild, "Manage Server");
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === "spam") {
        const spamEnabled = interaction.options.getBoolean("enabled", true);
        const spamThreshold = interaction.options.getInteger("threshold", true);
        const spamWindowSeconds = interaction.options.getInteger(
          "window_seconds",
          true,
        );
        await saveSpamSettings(guild.id, {
          spamEnabled,
          spamThreshold,
          spamWindowSeconds,
        });
        settingsCache.delete(guild.id);
        await replyPrivately(
          interaction,
          spamEnabled
            ? `Anti-spam is on: ${spamThreshold} messages in ${spamWindowSeconds} seconds triggers a 5-minute timeout.`
            : "Automatic anti-spam timeouts are off.",
        );
        return;
      }

      if (subcommand === "log-channel") {
        const channel = interaction.options.getChannel("channel", true);
        await saveLogChannel(guild.id, channel.id);
        settingsCache.delete(guild.id);
        await replyPrivately(
          interaction,
          `Moderation logs will be sent to <#${channel.id}>.`,
        );
        return;
      }

      const settings = await getSettings(guild.id);
      const logChannel = settings.logChannelId
        ? `<#${settings.logChannelId}>`
        : "not set";
      await replyPrivately(
        interaction,
        `Anti-spam: ${settings.spamEnabled ? "on" : "off"} · ` +
          `${settings.spamThreshold} messages / ${settings.spamWindowSeconds} seconds · ` +
          `log channel: ${logChannel}`,
      );
      return;
    }

    default:
      throw new Error("This command is not recognized.");
  }
}

async function handleMessage(client: DiscordClient, message: Message): Promise<void> {
  if (!message.guild || message.author.bot) return;

  const guildId = message.guild.id;
  const userId = message.author.id;
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const timeoutUntil = automaticTimeouts.get(key) ?? 0;

  if (timeoutUntil > now) return;
  automaticTimeouts.delete(key);

  const settings = await getSettings(guildId);
  if (!settings.spamEnabled) return;

  const windowMs = settings.spamWindowSeconds * 1000;
  const recentMessages = (spamMessageTimes.get(key) ?? []).filter(
    (timestamp) => now - timestamp <= windowMs,
  );
  recentMessages.push(now);

  if (recentMessages.length < settings.spamThreshold) {
    spamMessageTimes.set(key, recentMessages);
    return;
  }

  spamMessageTimes.delete(key);
  automaticTimeouts.set(key, now + SPAM_TIMEOUT_MS);

  try {
    const member =
      message.member ?? (await message.guild.members.fetch(message.author.id));
    await member.timeout(
      SPAM_TIMEOUT_MS,
      `Automatic anti-spam: ${settings.spamThreshold} messages in ${settings.spamWindowSeconds} seconds`,
    );
    await recordAndLog(client, {
      guildId,
      action: "automatic spam timeout",
      targetUserId: userId,
      moderatorUserId: client.user?.id ?? "system",
      reason: `${settings.spamThreshold} messages in ${settings.spamWindowSeconds} seconds`,
      durationSeconds: SPAM_TIMEOUT_MS / 1000,
    });
    logger.info({ guildId, userId }, "Automatic spam timeout applied");
  } catch (error) {
    logger.error({ err: error, guildId, userId }, "Could not apply automatic spam timeout");
  }
}

async function main(): Promise<void> {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    throw new Error(
      "DISCORD_BOT_TOKEN is missing. Add the bot token in Replit Secrets.",
    );
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    try {
      await readyClient.application.commands.set(commandData);
      logger.info(
        {
          bot: readyClient.user.tag,
          applicationId: readyClient.application.id,
          servers: readyClient.guilds.cache.size,
        },
        "Discord moderation bot is ready and commands are registered",
      );
    } catch (error) {
      logger.error({ err: error }, "Could not register Discord slash commands");
      process.exitCode = 1;
      client.destroy();
      await pool.end();
    }
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    void handleCommand(client, interaction).catch(async (error: unknown) => {
      const message =
        error instanceof Error ? error.message : "The command could not be completed.";
      logger.error(
        { err: error, command: interaction.commandName },
        "Discord command failed",
      );
      await replyPrivately(interaction, message).catch((replyError: unknown) => {
        logger.error({ err: replyError }, "Could not send command error response");
      });
    });
  });

  client.on(Events.MessageCreate, (message) => {
    void handleMessage(client, message).catch((error: unknown) => {
      logger.error(
        { err: error, guildId: message.guildId, userId: message.author.id },
        "Anti-spam message handler failed",
      );
    });
  });

  client.on(Events.Error, (error) => {
    logger.error({ err: error }, "Discord client error");
  });

  const stop = async () => {
    client.destroy();
    await pool.end();
    logger.info("Discord moderation bot stopped");
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());

  await client.login(token);
}

void main().catch(async (error: unknown) => {
  logger.fatal({ err: error }, "Discord moderation bot failed to start");
  await pool.end().catch(() => undefined);
  process.exitCode = 1;
});
