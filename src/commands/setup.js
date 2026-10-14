// !setup: crea el canal de control con un reproductor fijo. !setup quitar: lo desactiva.
import { ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { PREFIX } from '../config.js';
import { getQueue } from '../music.js';
import { ensurePanelMessage, panelChannel, refreshNowPlaying } from '../nowplaying.js';
import { getSettings, updateSettings } from '../settings.js';

const BOT_NEEDS = [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory, P.ManageMessages];
// Para que el canal sea solo de peticiones: sin hilos, adjuntos ni reacciones.
const EVERYONE_DENY = [P.CreatePublicThreads, P.CreatePrivateThreads, P.AttachFiles, P.AddReactions];

// io: { reply(level, text, ttl?) }
export async function handleSetup(message, args, io) {
  const { guild, member } = message;
  if (!member.permissions.has(P.ManageGuild)) {
    return io.reply('warn', 'Solo quien pueda **Gestionar el servidor** puede configurar el panel de control.');
  }
  const current = panelChannel(guild);

  if (/^(quitar|off|remove|borrar)$/i.test(args)) {
    if (!current) return io.reply('info', 'Este servidor no tiene panel de control.');
    const { controlMessageId } = getSettings(guild.id);
    if (controlMessageId) await current.messages.delete(controlMessageId).catch(() => {});
    updateSettings(guild.id, { controlChannelId: null, controlMessageId: null });
    const queue = getQueue(guild.id);
    if (queue) refreshNowPlaying(queue); // el reproductor vuelve al chat
    return io.reply('success', `Panel desactivado. Puedes borrar ${current} cuando quieras; la música vuelve a mostrarse en el chat.`, 20_000);
  }

  if (current) {
    await ensurePanelMessage(guild);
    return io.reply('info', `El panel ya está en ${current}. Para quitarlo usa \`${PREFIX}setup quitar\`.`, 20_000);
  }

  const me = guild.members.me;
  if (!me.permissions.has(P.ManageChannels)) {
    return io.reply('warn', 'Necesito el permiso **Gestionar canales** para crear el canal del reproductor. Pide a un administrador que me lo dé.');
  }

  // Discord solo deja conceder o negar en un canal los permisos que el bot tiene en el servidor.
  const allow = BOT_NEEDS.filter((p) => me.permissions.has(p));
  const deny = EVERYONE_DENY.filter((p) => me.permissions.has(p));
  let channel;
  try {
    channel = await guild.channels.create({
      name: '🎶・reproductor',
      type: ChannelType.GuildText,
      topic: 'Escribe el nombre o el enlace de una canción para reproducirla. Los mensajes se borran solos.',
      rateLimitPerUser: 3,
      parent: message.channel.parentId ?? undefined,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny },
        { id: me.id, allow },
      ],
      reason: `Panel del reproductor creado por ${message.author.tag}`,
    });
  } catch (err) {
    console.error('[setup] no se pudo crear el canal:', err.message);
    return io.reply('error', 'No pude crear el canal. Revisa que tenga los permisos **Gestionar canales** y **Gestionar roles**.');
  }

  updateSettings(guild.id, { controlChannelId: channel.id, controlMessageId: null });
  await ensurePanelMessage(guild);
  const queue = getQueue(guild.id);
  if (queue) refreshNowPlaying(queue); // si ya sonaba algo, pasa al panel

  const canClean = channel.permissionsFor(me).has(P.ManageMessages);
  return io.reply(
    'success',
    `Listo: el reproductor vive en ${channel}. Escribe ahí el nombre de una canción para probarlo.` +
      (canClean ? '' : '\n⚠️ Me falta **Gestionar mensajes**, así que no podré borrar lo que escriban en ese canal.'),
    30_000,
  );
}
