import 'dotenv/config';
import { Client, EmbedBuilder, GatewayIntentBits } from 'discord.js';
import ffmpegPath from 'ffmpeg-static';
import { destroyQueue, enqueue, findLocalFile, getQueue, listLocalFiles, resolveTrack, setFade, shuffle, skip } from './music.js';
import { getSpotifyTracks, parseSpotifyUrl } from './spotify.js';

process.env.FFMPEG_PATH ??= ffmpegPath;

const PREFIX = process.env.PREFIX || '!';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privilegiado: actívalo en el portal de desarrolladores
  ],
});

const infoEmbed = new EmbedBuilder()
  .setTitle('🎵 Cómo usar el bot de música')
  .setDescription(`Escribe los comandos en el chat empezando con \`${PREFIX}\`. Para usar \`${PREFIX}play\` debes estar **dentro de un canal de voz**.`)
  .addFields(
    {
      name: '▶️ Reproducir',
      value: [
        `\`${PREFIX}play <nombre o enlace>\` — reproduce o agrega a la cola. Acepta un nombre, un enlace de YouTube, un enlace de **Spotify** (canción, álbum o playlist pública), un enlace de un **reel de Instagram** (público) o un **archivo .mp3** de la carpeta \`musica/\` (mira cuáles hay con \`${PREFIX}archivos\`).`,
        `Agrega \`--aleatorio\` al final para poner en orden aleatorio una playlist o un álbum. Ejemplo: \`${PREFIX}play <enlace de Spotify> --aleatorio\``,
      ].join('\n'),
    },
    {
      name: '🎛️ Control',
      value: [
        `\`${PREFIX}pause\` — pausa la música.`,
        `\`${PREFIX}resume\` — la reanuda.`,
        `\`${PREFIX}skip\` — salta la canción actual (con un fundido corto).`,
        `\`${PREFIX}stop\` — detiene todo, vacía la cola y el bot sale del canal.`,
      ].join('\n'),
    },
    {
      name: '📋 Cola',
      value: [
        `\`${PREFIX}queue\` — muestra la canción actual y las próximas 10, con su número.`,
        `\`${PREFIX}remove <número>\` — quita de la cola la canción con ese número (míralo en \`${PREFIX}queue\`) antes de que suene.`,
        `\`${PREFIX}shuffle\` — pone en orden aleatorio lo que ya está en cola.`,
      ].join('\n'),
    },
    {
      name: '🎚️ Transiciones',
      value: `\`${PREFIX}mix <0-15>\` — duración en segundos de la transición (crossfade) entre canciones. \`0\` la desactiva. Por defecto: 6.`,
    },
    {
      name: 'ℹ️ Ten en cuenta',
      value: [
        `• \`${PREFIX}remove\` no alcanza la canción que ya se está preparando, justo antes de que empiece. En ese caso usa \`${PREFIX}skip\` cuando suene.`,
        '• Las playlists de Spotify deben ser públicas y se leen hasta unas 100 canciones.',
        '• El audio viene de YouTube, así que la versión puede variar respecto a Spotify.',
      ].join('\n'),
    },
  );

client.once('clientReady', (c) => console.log(`Conectado como ${c.user.tag} (prefijo: ${PREFIX})`));

// Alias -> nombre de comando
const ALIASES = { p: 'play', s: 'skip', q: 'queue', files: 'archivos', help: 'info', ayuda: 'info' };
const COMMANDS = new Set(['play', 'skip', 'pause', 'resume', 'queue', 'remove', 'shuffle', 'mix', 'archivos', 'info', 'stop']);

// Para no llenar el chat: se borra el comando del usuario y las respuestas del bot a los pocos segundos.
const REPLY_TTL_MS = 10_000;
const scheduleDelete = (msg, ms = REPLY_TTL_MS) => setTimeout(() => msg.delete().catch(() => {}), ms);

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guildId || !message.content.startsWith(PREFIX)) return;

  const [rawName, ...rest] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const name = rawName.toLowerCase();
  const command = ALIASES[name] ?? name;
  if (!COMMANDS.has(command)) return; // no tocar mensajes de otros bots que usen el mismo prefijo

  const args = rest.join(' ').trim();
  const queue = getQueue(message.guildId);

  // Requiere el permiso "Gestionar mensajes"; sin él el comando simplemente se queda en el chat.
  message.delete().catch(() => {});

  // Se envía al canal (no como respuesta) porque el mensaje original ya se borró.
  const send = (payload) => message.channel.send({ ...payload, allowedMentions: { parse: [] } });
  const reply = async (content, ttl = REPLY_TTL_MS) => {
    const sent = await send({ content });
    scheduleDelete(sent, ttl);
    return sent;
  };

  try {
    switch (command) {
      case 'play': {
        if (!message.member.voice.channel) return reply('Entra primero a un canal de voz.');
        const mix = /(^|\s)--aleatorio\b/i.test(args);
        const input = args.replace(/(^|\s)--aleatorio\b/gi, ' ').trim();
        if (!input) return reply(`Dime qué reproducir. Ejemplo: \`${PREFIX}play nombre de la canción\``);

        // El mensaje de estado se borra al terminar, pase lo que pase.
        const status = await send({ content: '🔎 Buscando...' });
        const done = async (content) => {
          await status.edit(content).catch(() => {});
          scheduleDelete(status);
        };
        const spotify = parseSpotifyUrl(input);
        const local = spotify ? null : findLocalFile(input);

        let tracks;
        try {
          if (spotify) {
            tracks = await getSpotifyTracks(spotify);
            if (!tracks.length) return done('Esa lista de Spotify está vacía.');
            if (mix) shuffle(tracks);
          } else if (local) {
            tracks = [local];
          } else {
            const track = await resolveTrack(input);
            if (!track) return done('No encontré nada.');
            tracks = [track];
          }

          const started = await enqueue(message, tracks);
          const label = tracks.length > 1 ? `**${tracks.length} canciones**${mix ? ' (orden aleatorio 🔀)' : ''}` : `**${tracks[0].title}**`;
          return done(started ? `▶️ Reproduciendo ${label}` : `➕ En cola: ${label}`);
        } catch (err) {
          console.error(err);
          return done('Ocurrió un error al reproducir.');
        }
      }
      case 'skip':
        if (!queue?.current) return reply('No hay nada sonando.');
        skip(queue);
        return reply('⏭️ Saltada.');
      case 'pause':
        if (!queue) return reply('No hay nada sonando.');
        queue.player.pause();
        return reply('⏸️ Pausado.');
      case 'resume':
        if (!queue) return reply('No hay nada sonando.');
        queue.player.unpause();
        return reply('▶️ Reanudado.');
      case 'queue': {
        if (!queue?.current) return reply('La cola está vacía.');
        const lines = queue.tracks.slice(0, 10).map((t, i) => `${i + 1}. ${t.title}`);
        const more = queue.tracks.length > 10 ? `\n…y ${queue.tracks.length - 10} más` : '';
        return reply(`**Ahora:** ${queue.current.title}\n${lines.join('\n') || '_(nada más en cola)_'}${more}`, 30_000);
      }
      case 'remove': {
        const pos = Number.parseInt(args, 10);
        if (!queue?.tracks.length) return reply('La cola está vacía.');
        if (!Number.isInteger(pos) || pos < 1) return reply(`Dime el número de la canción. Ejemplo: \`${PREFIX}remove 3\` (míralo en \`${PREFIX}queue\`).`);
        if (pos > queue.tracks.length) return reply(`Solo hay ${queue.tracks.length} canciones en cola.`);
        const [removed] = queue.tracks.splice(pos - 1, 1);
        return reply(`🗑️ Quitada de la cola: **${removed.title}**`);
      }
      case 'shuffle':
        if (!queue?.tracks.length) return reply('No hay canciones en cola para mezclar.');
        shuffle(queue.tracks);
        return reply(`🔀 Puestas en orden aleatorio ${queue.tracks.length} canciones.`);
      case 'mix': {
        const seconds = Number.parseInt(args, 10);
        if (!Number.isInteger(seconds) || seconds < 0 || seconds > 15) return reply(`Dime los segundos, de 0 a 15. Ejemplo: \`${PREFIX}mix 6\``);
        setFade(message.guildId, seconds);
        return reply(seconds ? `🎚️ Transición de ${seconds}s entre canciones (aplica desde la próxima canción).` : '🎚️ Transiciones desactivadas.');
      }
      case 'archivos': {
        const files = listLocalFiles();
        return reply(files.length ? `📁 Archivos en \`musica/\`:\n${files.map((f) => `• ${f}`).join('\n')}`.slice(0, 1900) : 'No hay archivos en la carpeta `musica/`.', 30_000);
      }
      case 'info': {
        const sent = await send({ embeds: [infoEmbed] });
        scheduleDelete(sent, 90_000);
        return;
      }
      case 'stop':
        if (!queue) return reply('No hay nada sonando.');
        destroyQueue(message.guildId, 'comando !stop');
        return reply('⏹️ Detenido.');
    }
  } catch (err) {
    console.error(err);
    reply('Ocurrió un error al ejecutar el comando.').catch(() => {});
  }
});

// Un error suelto no debe tumbar el bot (Railway lo reiniciaría y saldría del canal de voz).
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));

if (!process.env.DISCORD_TOKEN) {
  console.error('Falta DISCORD_TOKEN en .env');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);
