import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type Client as DiscordClient,
  type Message,
} from "discord.js";
import pino from "pino";
import { commandData } from "./discord-bot/commands";
import {
  getGuildSettings,
  getTicketById,
  getTicketSettings,
  findOpenTicketForUser,
  pool,
  saveCase,
  saveLogChannel,
  saveSpamSettings,
  saveTicketCategory,
  saveTicketSupportRole,
  createTicket,
  closeTicket,
  reopenTicket,
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
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  content: string,
): Promise<void> {
  if (interaction.replied || interaction.deferred) {
    await interaction.editReply({ content });
    return;
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

function ticketPanelRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("ticket:open")
      .setLabel("فتح")
      .setStyle(ButtonStyle.Primary),
  );
}

function ticketActionRow(ticketId: number, reopen = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`ticket:${reopen ? "reopen" : "close"}:${ticketId}`)
      .setLabel(reopen ? "Reopen ticket" : "Close ticket")
      .setStyle(reopen ? ButtonStyle.Success : ButtonStyle.Danger),
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

function ticketChannelName(username: string): string {
  const safeName = username
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `ticket-${safeName || "member"}`;
}

async function postTicketPanel(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = requireGuild(interaction);
  requirePermission(interaction, PermissionFlagsBits.ManageGuild, "Manage Server");
  const settings = await getTicketSettings(guild.id);

  if (!settings.supportRoleId) {
    throw new Error("Set a support role first with /ticket-config support-role.");
  }

  const supportRole = await guild.roles.fetch(settings.supportRoleId);
  if (!supportRole) {
    throw new Error("The configured support role no longer exists. Set it again.");
  }

  const channel = interaction.channel;
  if (
    !channel ||
    !("send" in channel) ||
    typeof channel.send !== "function"
  ) {
    throw new Error("Use /ticket-panel in a server text channel.");
  }

  const panel = new EmbedBuilder()
    .setColor(0x5865f2)
    .setDescription("اهلاً وسهلاً لطلب اضغط على زر فتح");

  await channel.send({ embeds: [panel], components: [ticketPanelRow()] });
  await replyPrivately(interaction, "Ticket panel posted.");
}

async function openTicket(
  client: DiscordClient,
  interaction: ButtonInteraction,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) throw new Error("Tickets can only be opened inside a server.");

  const settings = await getTicketSettings(guild.id);
  if (!settings.supportRoleId) {
    throw new Error("The server has not configured a support role yet.");
  }

  const supportRole = await guild.roles.fetch(settings.supportRoleId);
  if (!supportRole || supportRole.id === guild.id) {
    throw new Error("The configured support role is missing or invalid.");
  }

  const existing = await findOpenTicketForUser(guild.id, interaction.user.id);
  if (existing) {
    const existingChannel = await guild.channels.fetch(existing.channelId);
    if (existingChannel) {
      await replyPrivately(
        interaction,
        `You already have an open ticket: <#${existing.channelId}>.`,
      );
      return;
    }
    await closeTicket(existing.id, null);
  }

  const botMember =
    guild.members.me ??
    (client.user ? await guild.members.fetch(client.user.id) : null);
  if (!botMember?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error("The bot needs Manage Channels permission to create tickets.");
  }

  let parentId: string | undefined;
  if (settings.categoryId) {
    const category = await guild.channels.fetch(settings.categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) {
      throw new Error(
        "The configured ticket category is missing. Set it again with /ticket-config category.",
      );
    }
    parentId = category.id;
  }

  const channel = await guild.channels.create({
    name: ticketChannelName(interaction.user.username),
    type: ChannelType.GuildText,
    parent: parentId,
    topic: `Private support ticket for ${interaction.user.id}`,
    reason: `Support ticket opened by ${interaction.user.tag}`,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: interaction.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      },
      {
        id: supportRole.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
        ],
      },
      {
        id: botMember.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
        ],
      },
    ],
  });

  let ticketId: number;
  try {
    ticketId = await createTicket({
      guildId: guild.id,
      channelId: channel.id,
      openerUserId: interaction.user.id,
      supportRoleId: supportRole.id,
    });
  } catch (error) {
    await channel.delete("Ticket record could not be saved").catch((deleteError: unknown) => {
      logger.error(
        { err: deleteError, guildId: guild.id, channelId: channel.id },
        "Could not clean up an unrecorded ticket channel",
      );
    });

    if (isUniqueViolation(error)) {
      const racedTicket = await findOpenTicketForUser(guild.id, interaction.user.id);
      if (racedTicket) {
        await replyPrivately(
          interaction,
          `You already have an open ticket: <#${racedTicket.channelId}>.`,
        );
        return;
      }
    }
    throw error;
  }

  try {
    await channel.send({
      content:
        `Welcome <@${interaction.user.id}>. <@&${supportRole.id}> will help you here. ` +
        "Describe your request below. Use the button when the ticket is resolved.",
      components: [ticketActionRow(ticketId)],
      allowedMentions: { users: [interaction.user.id], roles: [supportRole.id] },
    });
  } catch (error) {
    await closeTicket(ticketId, null);
    await channel.delete("Ticket setup failed").catch((deleteError: unknown) => {
      logger.error(
        { err: deleteError, guildId: guild.id, channelId: channel.id },
        "Could not clean up an uninitialized ticket channel",
      );
    });
    throw error;
  }

  await replyPrivately(interaction, `Your private ticket is ready: <#${channel.id}>.`);
}

async function handleTicketButton(
  client: DiscordClient,
  interaction: ButtonInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const [, action, rawTicketId] = interaction.customId.split(":");
  if (action === "open") {
    await openTicket(client, interaction);
    return;
  }

  const ticketId = Number(rawTicketId);
  if (!Number.isSafeInteger(ticketId) || ticketId < 1) {
    throw new Error("This ticket button is invalid.");
  }

  const guild = interaction.guild;
  if (!guild) throw new Error("This ticket action must be used in a server.");

  const ticket = await getTicketById(guild.id, ticketId);
  if (!ticket) throw new Error("This ticket could not be found.");

  const member = await guild.members.fetch(interaction.user.id);
  const canManage = member.permissions.has(PermissionFlagsBits.ManageChannels);
  const isSupport = member.roles.cache.has(ticket.supportRoleId);
  const isOpener = member.id === ticket.openerUserId;
  if (!canManage && !isSupport && !isOpener) {
    throw new Error("Only the ticket owner and support team can do this.");
  }

  const channel = await guild.channels.fetch(ticket.channelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error("The ticket channel no longer exists.");
  }

  if (action === "close") {
    if (ticket.status !== "open") {
      await replyPrivately(interaction, `Ticket #${ticket.id} is already closed.`);
      return;
    }

    const closed = await closeTicket(ticket.id, interaction.user.id);
    if (!closed) {
      await replyPrivately(interaction, `Ticket #${ticket.id} is already closed.`);
      return;
    }

    try {
      await channel.permissionOverwrites.edit(ticket.openerUserId, {
        SendMessages: false,
        AttachFiles: false,
        AddReactions: false,
      });
      await channel.permissionOverwrites.edit(ticket.supportRoleId, {
        SendMessages: false,
        AttachFiles: false,
        AddReactions: false,
      });
      await channel.setName(`closed-ticket-${ticket.id}`);
      await channel.send({
        content: `Ticket #${ticket.id} was closed by <@${interaction.user.id}>. The channel is archived; use the button to reopen it.`,
        components: [ticketActionRow(ticket.id, true)],
        allowedMentions: { users: [interaction.user.id] },
      });
    } catch (error) {
      await Promise.all([
        channel.permissionOverwrites
          .edit(ticket.openerUserId, {
            SendMessages: true,
            AttachFiles: true,
            AddReactions: true,
          })
          .catch((restoreError: unknown) =>
            logger.error(
              { err: restoreError, ticketId: ticket.id },
              "Could not restore ticket owner permissions after a failed close",
            ),
          ),
        channel.permissionOverwrites
          .edit(ticket.supportRoleId, {
            SendMessages: true,
            AttachFiles: true,
            AddReactions: true,
          })
          .catch((restoreError: unknown) =>
            logger.error(
              { err: restoreError, ticketId: ticket.id },
              "Could not restore support role permissions after a failed close",
            ),
          ),
        channel.setName(ticketChannelName(ticket.openerUserId)).catch(
          (restoreError: unknown) =>
            logger.error(
              { err: restoreError, ticketId: ticket.id },
              "Could not restore ticket channel name after a failed close",
            ),
        ),
        reopenTicket(ticket.id).catch((restoreError: unknown) =>
          logger.error(
            { err: restoreError, ticketId: ticket.id },
            "Could not restore ticket state after a failed close",
          ),
        ),
      ]);
      throw new Error(
        "The ticket could not be archived. Check the bot's Manage Channels and channel permissions.",
      );
    }

    await replyPrivately(interaction, `Ticket #${ticket.id} is closed and archived.`);
    return;
  }

  if (action === "reopen") {
    if (ticket.status !== "closed") {
      await replyPrivately(interaction, `Ticket #${ticket.id} is already open.`);
      return;
    }

    const otherOpenTicket = await findOpenTicketForUser(
      guild.id,
      ticket.openerUserId,
    );
    if (otherOpenTicket && otherOpenTicket.id !== ticket.id) {
      throw new Error(
        `This member already has another open ticket: <#${otherOpenTicket.channelId}>.`,
      );
    }

    await channel.permissionOverwrites.edit(ticket.openerUserId, {
      SendMessages: true,
      AttachFiles: true,
      AddReactions: true,
    });
    await channel.permissionOverwrites.edit(ticket.supportRoleId, {
      SendMessages: true,
      AttachFiles: true,
      AddReactions: true,
    });

    const reopened = await reopenTicket(ticket.id);
    if (!reopened) {
      await channel.permissionOverwrites.edit(ticket.openerUserId, {
        SendMessages: false,
        AttachFiles: false,
        AddReactions: false,
      });
      await channel.permissionOverwrites.edit(ticket.supportRoleId, {
        SendMessages: false,
        AttachFiles: false,
        AddReactions: false,
      });
      throw new Error("This ticket could not be reopened.");
    }

    await channel.setName(ticketChannelName(ticket.openerUserId));
    await channel.send({
      content: `Ticket #${ticket.id} was reopened by <@${interaction.user.id}>.`,
      components: [ticketActionRow(ticket.id)],
      allowedMentions: { users: [interaction.user.id] },
    });
    await replyPrivately(interaction, `Ticket #${ticket.id} is open again.`);
    return;
  }

  throw new Error("This ticket action is not recognized.");
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

    case "ticket-config": {
      requirePermission(interaction, PermissionFlagsBits.ManageGuild, "Manage Server");
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === "support-role") {
        const role = interaction.options.getRole("role", true);
        if (role.id === guild.id) {
          throw new Error("Choose a support team role, not @everyone.");
        }
        await saveTicketSupportRole(guild.id, role.id);
        await replyPrivately(interaction, `Ticket support role set to <@&${role.id}>.`);
        return;
      }

      if (subcommand === "category") {
        const category = interaction.options.getChannel("category");
        await saveTicketCategory(guild.id, category?.id ?? null);
        await replyPrivately(
          interaction,
          category
            ? `New tickets will be created in <#${category.id}>.`
            : "The ticket category was cleared. New tickets will be created outside a category.",
        );
        return;
      }

      const settings = await getTicketSettings(guild.id);
      await replyPrivately(
        interaction,
        `Support role: ${settings.supportRoleId ? `<@&${settings.supportRoleId}>` : "not set"} · ` +
          `Category: ${settings.categoryId ? `<#${settings.categoryId}>` : "not set"}`,
      );
      return;
    }

    case "ticket-panel": {
      await postTicketPanel(interaction);
      return;
    }

    default:
      throw new Error("This command is not recognized.");
  }
}

async function handleMessage(client: DiscordClient, message: Message): Promise<void> {
  if (message.author.bot) return;

  if (message.content.startsWith("$hello")) {
    await message.reply("Hello!");
  }

  if (!message.guild) return;

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
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
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
    if (interaction.isChatInputCommand()) {
      void handleCommand(client, interaction).catch(async (error: unknown) => {
        const message =
          error instanceof Error
            ? error.message
            : "The command could not be completed.";
        logger.error(
          { err: error, command: interaction.commandName },
          "Discord command failed",
        );
        await replyPrivately(interaction, message).catch((replyError: unknown) => {
          logger.error({ err: replyError }, "Could not send command error response");
        });
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("ticket:")) {
      void handleTicketButton(client, interaction).catch(
        async (error: unknown) => {
          const message =
            error instanceof Error
              ? error.message
              : "The ticket action could not be completed.";
          logger.error(
            { err: error, customId: interaction.customId },
            "Ticket button failed",
          );
          await replyPrivately(interaction, message).catch(
            (replyError: unknown) => {
              logger.error(
                { err: replyError },
                "Could not send ticket error response",
              );
            },
          );
        },
      );
    }
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
