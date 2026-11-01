import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

export const commandData = [
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Record a warning for a server member.")
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((option) =>
      option.setName("user").setDescription("Member to warn").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why this warning is being issued")
        .setMaxLength(300)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Temporarily prevent a member from sending messages.")
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("Member to timeout")
        .setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("minutes")
        .setDescription("Timeout length in minutes")
        .setMinValue(1)
        .setMaxValue(40320)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why this timeout is being issued")
        .setMaxLength(300)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Remove a member from the server.")
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption((option) =>
      option.setName("user").setDescription("Member to kick").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Why this member is being removed")
        .setMaxLength(300)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Delete recent messages in this channel.")
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("Number of recent messages to delete")
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("mod-config")
    .setDescription("Configure this server's moderation bot.")
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("spam")
        .setDescription("Set the automatic spam timeout rule.")
        .addBooleanOption((option) =>
          option
            .setName("enabled")
            .setDescription("Turn automatic spam timeouts on or off")
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName("threshold")
            .setDescription("Messages within the time window")
            .setMinValue(3)
            .setMaxValue(20)
            .setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName("window_seconds")
            .setDescription("Time window in seconds")
            .setMinValue(2)
            .setMaxValue(60)
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("log-channel")
        .setDescription("Choose where moderation actions are logged.")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Text channel for moderation logs")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("show")
        .setDescription("Show this server's current moderation settings."),
    ),
  new SlashCommandBuilder()
    .setName("ticket-config")
    .setDescription("Configure this server's support tickets.")
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("support-role")
        .setDescription("Choose which role can view and answer tickets.")
        .addRoleOption((option) =>
          option
            .setName("role")
            .setDescription("Support team role")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("category")
        .setDescription("Choose a category for new tickets, or clear it.")
        .addChannelOption((option) =>
          option
            .setName("category")
            .setDescription("Category for new ticket channels")
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(false),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("show")
        .setDescription("Show the ticket support role and category."),
    ),
  new SlashCommandBuilder()
    .setName("ticket-panel")
    .setDescription("Post a button panel for opening support tickets.")
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((command) => command.toJSON());
