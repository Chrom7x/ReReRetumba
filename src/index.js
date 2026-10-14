import 'dotenv/config';
import { Client, EmbedBuilder, GatewayIntentBits, MessageFlags, PermissionFlagsBits } from 'discord.js';
import ffmpegPath from 'ffmpeg-static';
import { handlePlay } from './commands/play.js';
import { handleSetup } from './commands/setup.js';
import { PREFIX } from './config.js';
import {
  checkVoiceChannel,
  destroyQueue,
  getQueue,
  inBotChannel,
  listLocalFiles,
  previous,
  setFade,
  setLoop,
  shuffle,
  skip,
  togglePause,
} from './music.js';
import { nowPlaying, panelChannel, refreshNowPlaying, repostNowPlaying, showIdlePanel } from './nowplaying.js';
import { getSettings, guildsWithPanel, updateSettings } from './settings.js';
import { COLORS, LOOP_LABELS, notice, queueEmbed } from './ui.js';

process.env.FFMPEG_PATH ??= ffmpegPath;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privilegiado: actívalo en el portal de desarrolladores
  ],
});

const infoEmbed = new EmbedBuilder()
  .setColor(COLORS.info)
  .setTitle('🎵 Cómo usar el bot de música')
  .setDescription(
    `Escribe los comandos empezando con \`${PREFIX}\`. Para pedir música debes estar **en un canal de voz**. ` +
      'Mientras suena algo, el mensaje **Sonando ahora** tiene botones para controlarlo todo sin escribir.',
  )
  .addFields(
    {
      name: '▶️ Reproducir',
      value: [
        `\`${PREFIX}play <nombre o enlace>\` (\`${PREFIX}p\`) — reproduce o agrega a la cola. Acepta nombres, enlaces de YouTube, **Spotify** (canción, álbum o playlist pública), **reels de Instagram** o un **archivo** de \`musica/\` (\`${PREFIX}archivos\`).`,
        `Agrega \`--aleatorio\` al final para mezclar una playlist o un álbum.`,
      ].join('\n'),
    },
    {
      name: '🎛️ Control',
      value: [
        `\`${PREFIX}pause\` / \`${PREFIX}resume\` — pausa o reanuda.`,
        `\`${PREFIX}skip\` (\`${PREFIX}s\`) — salta la canción actual.`,
        `\`${PREFIX}back\` — vuelve a la canción anterior.`,
        `\`${PREFIX}loop [no|cancion|cola]\` — repetir canción o cola (sin opción va rotando).`,
        `\`${PREFIX}stop\` — detiene todo y el bot sale del canal.`,
      ].join('\n'),
    },
    {
      name: '📋 Cola',
      value: [
        `\`${PREFIX}queue\` (\`${PREFIX}q\`) — muestra la cola.`,
        `\`${PREFIX}np\` — vuelve a mostrar el reproductor al final del chat.`,
        `\`${PREFIX}remove <número>\` — quita una canción de la cola.`,
        `\`${PREFIX}shuffle\` — pone la cola en orden aleatorio.`,
      ].join('\n'),
    },
    { name: '🎚️ Transiciones', value: `\`${PREFIX}mix <0-15>\` — segundos de transición entre canciones. \`0\` la desactiva. Por defecto: 6.` },
    {
      name: '⚙️ Panel de control (administradores)',
      value: [
        `\`${PREFIX}setup\` — crea el canal **#🎶・reproductor**: un reproductor fijo donde basta con escribir el nombre de una canción.`,
        `\`${PREFIX}setup quitar\` — lo desactiva y la música vuelve a mostrarse en el chat.`,
      ].join('\n'),
    },
    {
      name: 'ℹ️ Ten en cuenta',
      value: [
        '• Las playlists de Spotify deben ser públicas y se leen hasta unas 100 canciones.',
        '• El audio viene de YouTube, así que la versión puede variar respecto a Spotify.',
        '• Si todos salen del canal de voz, la música se pausa y el bot se va a los 2 minutos.',
      ].join('\n'),
    },
  );

client.once('clientReady', async (c) => {
  console.log(`Conectado como ${c.user.tag} (prefijo: ${PREFIX}) en ${c.guilds.cache.size} servidor(es)`);
  // Tras un reinicio no suena nada: cada panel vuelve al estado de espera (y se recrea si lo borraron).
  for (const guildId of guildsWithPanel()) {
    const guild = c.guilds.cache.get(guildId);
    if (!guild) continue;
    if (!panelChannel(guild)) {
      console.log(`[panel] el canal del panel ya no existe en ${guild.name}; se quita la configuración`);
      updateSettings(guildId, { controlChannelId: null, controlMessageId: null });
      continue;
    }
    await showIdlePanel(guild);
  }
});

// Si borran el canal del panel, se vuelve al modo chat.
client.on('channelDelete', (channel) => {
  if (!channel.guild || getSettings(channel.guild.id).controlChannelId !== channel.id) return;
  updateSettings(channel.guild.id, { controlChannelId: null, controlMessageId: null });
  const queue = getQueue(channel.guild.id);
  if (queue) refreshNowPlaying(queue);
});

// Si borran el mensaje del panel, se vuelve a publicar.
client.on('messageDelete', (msg) => {
  if (!msg.guildId || getSettings(msg.guildId).controlMessageId !== msg.id) return;
  updateSettings(msg.guildId, { controlMessageId: null });
  const queue = getQueue(msg.guildId);
  if (queue) refreshNowPlaying(queue);
  else if (msg.guild) showIdlePanel(msg.guild);
});

// Alias -> nombre de comando
const ALIASES = {
  p: 'play',
  s: 'skip',
  q: 'queue',
  files: 'archivos',
  help: 'info',
  ayuda: 'info',
  previous: 'back',
  prev: 'back',
  anterior: 'back',
  nowplaying: 'np',
  repeat: 'loop',
  bucle: 'loop',
};
const COMMANDS = new Set(['play', 'skip', 'back', 'pause', 'resume', 'queue', 'np', 'remove', 'shuffle', 'loop', 'mix', 'archivos', 'info', 'stop', 'setup']);
// Comandos que exigen estar en el canal de voz del bot.
const NEEDS_SAME_CHANNEL = new Set(['skip', 'back', 'pause', 'resume', 'remove', 'shuffle', 'loop', 'stop']);
const LOOP_ARGS = { no: 'off', off: 'off', cancion: 'track', canción: 'track', track: 'track', cola: 'queue', queue: 'queue' };

// Para no llenar el chat: se borra el comando del usuario y las respuestas del bot a los pocos segundos.
const REPLY_TTL_MS = 10_000;
const scheduleDelete = (msg, ms = REPLY_TTL_MS) => setTimeout(() => msg.delete().catch(() => {}), ms);

// Respuestas que se borran solas. Se envían al canal (no como respuesta) porque el mensaje original se borra.
function responder(channel) {
  const send = (payload) => channel.send({ ...payload, allowedMentions: { parse: [] } });
  const reply = async (level, text, ttl = REPLY_TTL_MS) => {
    const sent = await send({ embeds: [notice(level, text)] });
    scheduleDelete(sent, ttl);
    return sent;
  };
  return { send, reply, scheduleDelete };
}

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guildId) return;
  const isCommand = message.content.startsWith(PREFIX);
  const inPanel = panelChannel(message.guild)?.id === message.channelId;

  // En el canal de control, todo lo que no sea un comando es una canción pedida.
  if (inPanel && !isCommand) {
    message.delete().catch(() => {});
    const text = message.content.trim();
    if (!text) return;
    console.log(`[panel] ${message.author.tag}: ${text.slice(0, 120)}`);
    return handlePlay(message, text, responder(message.channel)).catch((err) => console.error('[panel] error:', err));
  }
  if (!isCommand) return;

  const [rawName, ...rest] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = ALIASES[rawName.toLowerCase()] ?? rawName.toLowerCase();
  const { send, reply } = responder(message.channel);
  if (!COMMANDS.has(command)) {
    // Fuera del panel no se tocan mensajes de otros bots que usen el mismo prefijo; dentro, se mantiene limpio.
    if (inPanel) {
      message.delete().catch(() => {});
      reply('info', `Ese comando no existe. Mira todos con \`${PREFIX}info\`.`).catch(() => {});
    }
    return;
  }
  console.log(`[cmd] ${message.author.tag}: ${message.content.slice(0, 120)}`);

  const args = rest.join(' ').trim();
  const queue = getQueue(message.guildId);

  // Requiere el permiso "Gestionar mensajes"; sin él el comando simplemente se queda en el chat.
  message.delete().catch(() => {});

  // Sin "Insertar enlaces" Discord no muestra los embeds y el bot parecería mudo.
  if (!message.channel.permissionsFor(message.guild.members.me)?.has(PermissionFlagsBits.EmbedLinks)) {
    send({ content: '⚠️ Necesito el permiso **Insertar enlaces** en este canal para mostrar el reproductor. Pide a un administrador que me lo dé.' })
      .then((m) => scheduleDelete(m, 20_000))
      .catch(() => {});
    return;
  }

  if (NEEDS_SAME_CHANNEL.has(command)) {
    if (!queue) return reply('info', 'No hay música sonando ahora mismo.');
    if (!inBotChannel(queue, message.member)) return reply('warn', 'Tienes que estar en el mismo canal de voz que el bot para controlar la música.');
  }

  try {
    switch (command) {
      case 'play':
        return handlePlay(message, args, { send, reply, scheduleDelete });
      case 'setup':
        return handleSetup(message, args, { reply });
      case 'skip':
        if (!queue.current) return reply('info', 'No hay ninguna canción sonando.');
        skip(queue);
        return reply('success', 'Canción saltada ⏭️');
      case 'back': {
        const prev = previous(queue);
        return prev ? reply('success', `Volviendo a **${prev.title}** ⏮️`) : reply('info', 'No hay ninguna canción anterior.');
      }
      case 'pause':
        if (queue.paused) return reply('info', 'La música ya está en pausa.');
        togglePause(queue);
        return reply('success', 'Música en pausa ⏸️');
      case 'resume':
        if (!queue.paused) return reply('info', 'La música ya está sonando.');
        togglePause(queue);
        return reply('success', 'Música reanudada ▶️');
      case 'queue': {
        if (!queue?.current) return reply('info', 'La cola está vacía.');
        const np = nowPlaying(queue);
        const sent = await send({ embeds: [queueEmbed({ current: np?.track, elapsedSec: np?.elapsedSec ?? 0, tracks: queue.tracks })] });
        scheduleDelete(sent, 45_000);
        return;
      }
      case 'np':
        if (!queue?.current) return reply('info', 'No hay ninguna canción sonando.');
        return repostNowPlaying(queue);
      case 'remove': {
        const pos = Number.parseInt(args, 10);
        if (!queue.tracks.length) return reply('info', 'No hay canciones en cola.');
        if (!Number.isInteger(pos) || pos < 1) return reply('info', `Dime el número de la canción. Ejemplo: \`${PREFIX}remove 3\` (míralo en \`${PREFIX}queue\`).`);
        if (pos > queue.tracks.length) return reply('warn', `Solo hay **${queue.tracks.length}** canciones en cola.`);
        const [removed] = queue.tracks.splice(pos - 1, 1);
        refreshNowPlaying(queue);
        return reply('success', `Quitada de la cola: **${removed.title}**`);
      }
      case 'shuffle':
        if (queue.tracks.length < 2) return reply('info', 'Hacen falta al menos 2 canciones en cola para mezclarlas.');
        shuffle(queue.tracks);
        refreshNowPlaying(queue);
        return reply('success', `Cola mezclada: **${queue.tracks.length}** canciones en orden aleatorio 🔀`);
      case 'loop': {
        const wanted = args ? LOOP_ARGS[args.toLowerCase()] : undefined;
        if (args && !wanted) return reply('info', `Opciones: \`${PREFIX}loop no\`, \`${PREFIX}loop cancion\` o \`${PREFIX}loop cola\`.`);
        const mode = setLoop(queue, wanted);
        return reply('success', `Bucle: **${LOOP_LABELS[mode]}** 🔁`);
      }
      case 'mix': {
        const seconds = Number.parseInt(args, 10);
        if (!Number.isInteger(seconds) || seconds < 0 || seconds > 15) return reply('info', `Dime los segundos, de 0 a 15. Ejemplo: \`${PREFIX}mix 6\``);
        setFade(message.guildId, seconds);
        if (queue) refreshNowPlaying(queue);
        return reply('success', seconds ? `Transición de **${seconds}s** entre canciones (desde la próxima) 🎚️` : 'Transiciones desactivadas 🎚️');
      }
      case 'archivos': {
        const files = listLocalFiles();
        return reply('info', files.length ? `Archivos en \`musica/\`:\n${files.map((f) => `• ${f}`).join('\n')}`.slice(0, 3900) : 'No hay archivos en la carpeta `musica/`.', 30_000);
      }
      case 'info': {
        const sent = await send({ embeds: [infoEmbed] });
        scheduleDelete(sent, 90_000);
        return;
      }
      case 'stop':
        destroyQueue(message.guildId, `comando ${PREFIX}stop`);
        return reply('success', 'Música detenida. ¡Hasta la próxima! 👋');
    }
  } catch (err) {
    console.error(`[cmd] error en ${command}:`, err);
    reply('error', 'Algo salió mal al ejecutar ese comando. Inténtalo de nuevo.').catch(() => {});
  }
});

// Botones del reproductor: responden en privado (solo los ve quien pulsa).
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() || !interaction.customId.startsWith('np:')) return;
  const action = interaction.customId.slice(3);
  const say = (level, text) => interaction.reply({ embeds: [notice(level, text)], flags: MessageFlags.Ephemeral }).catch(() => {});

  const queue = getQueue(interaction.guildId);
  if (!queue) {
    interaction.message.delete().catch(() => {}); // reproductor viejo que quedó en el chat
    return say('info', 'Ya no hay música sonando.');
  }
  if (action !== 'queue' && !inBotChannel(queue, interaction.member)) {
    return say('warn', 'Tienes que estar en el mismo canal de voz que el bot para controlar la música.');
  }

  try {
    switch (action) {
      case 'prev': {
        const prev = previous(queue);
        return say(prev ? 'success' : 'info', prev ? `Volviendo a **${prev.title}** ⏮️` : 'No hay ninguna canción anterior.');
      }
      case 'toggle':
        return say('success', togglePause(queue) ? 'Música en pausa ⏸️' : 'Música reanudada ▶️');
      case 'skip':
        return skip(queue) ? say('success', 'Canción saltada ⏭️') : say('info', 'No hay ninguna canción sonando.');
      case 'shuffle':
        if (queue.tracks.length < 2) return say('info', 'Hacen falta al menos 2 canciones en cola para mezclarlas.');
        shuffle(queue.tracks);
        refreshNowPlaying(queue);
        return say('success', `Cola mezclada: **${queue.tracks.length}** canciones en orden aleatorio 🔀`);
      case 'loop':
        return say('success', `Bucle: **${LOOP_LABELS[setLoop(queue)]}** 🔁`);
      case 'queue': {
        const np = nowPlaying(queue);
        return interaction
          .reply({ embeds: [queueEmbed({ current: np?.track, elapsedSec: np?.elapsedSec ?? 0, tracks: queue.tracks })], flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
      case 'stop':
        destroyQueue(interaction.guildId, `botón detener (${interaction.user.tag})`);
        return say('success', 'Música detenida. ¡Hasta la próxima! 👋');
    }
  } catch (err) {
    console.error(`[boton] error en ${action}:`, err);
    say('error', 'Algo salió mal. Inténtalo de nuevo.');
  }
});

// Pausa y sale si el canal de voz se queda vacío; reanuda si alguien vuelve.
client.on('voiceStateUpdate', (oldState, newState) => checkVoiceChannel(newState.guild ?? oldState.guild));

// Railway envía SIGTERM al reemplazar el contenedor en cada despliegue: se sale de los canales de voz y
// se dejan los paneles en espera antes de terminar (sin esto npm lo registra como "command failed").
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[bot] ${signal} recibido: apagando con orden`);
  setTimeout(() => process.exit(0), 5_000).unref(); // por si Discord no responde
  for (const guildId of client.guilds.cache.keys()) destroyQueue(guildId, 'reinicio del bot');
  const panels = guildsWithPanel().map((id) => client.guilds.cache.get(id)).filter(Boolean);
  await Promise.allSettled(panels.map((guild) => showIdlePanel(guild)));
  await client.destroy();
  process.exit(0);
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

// Un error suelto no debe tumbar el bot (Railway lo reiniciaría y saldría del canal de voz).
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));

if (!process.env.DISCORD_TOKEN) {
  console.error('Falta DISCORD_TOKEN en .env');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);

