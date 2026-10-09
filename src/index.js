import 'dotenv/config';
import { Client, EmbedBuilder, GatewayIntentBits, MessageFlags } from 'discord.js';
import { AudioPlayerStatus } from '@discordjs/voice';
import ffmpegPath from 'ffmpeg-static';
import { destroyQueue, enqueue, getQueue, resolveTrack, setFade, shuffle, skip } from './music.js';
import { getSpotifyTracks, parseSpotifyUrl } from './spotify.js';

process.env.FFMPEG_PATH ??= ffmpegPath;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

const infoEmbed = new EmbedBuilder()
  .setTitle('🎵 Cómo usar el bot de música')
  .setDescription('Escribe `/` en el chat y elige un comando. Para usar `/play` debes estar **dentro de un canal de voz**.')
  .addFields(
    {
      name: '▶️ Reproducir',
      value: [
        '`/play cancion:<nombre o enlace>` — reproduce o agrega a la cola. Acepta un nombre, un enlace de YouTube o un enlace de **Spotify** (canción, álbum o playlist pública).',
        'Opción `aleatorio:True` — pone en orden aleatorio una playlist o un álbum.',
      ].join('\n'),
    },
    {
      name: '🎛️ Control',
      value: [
        '`/pause` — pausa la música.',
        '`/resume` — la reanuda.',
        '`/skip` — salta la canción actual (con un fundido corto).',
        '`/stop` — detiene todo, vacía la cola y el bot sale del canal.',
      ].join('\n'),
    },
    {
      name: '📋 Cola',
      value: [
        '`/queue` — muestra la canción actual y las próximas 10.',
        '`/remove posicion:<número>` — quita una canción de la cola antes de que suene. Elige de la lista que aparece o escribe parte del nombre.',
        '`/shuffle` — pone en orden aleatorio lo que ya está en cola.',
      ].join('\n'),
    },
    {
      name: '🎚️ Transiciones',
      value: '`/mix segundos:<0-15>` — duración de la transición (crossfade) entre canciones. `0` la desactiva. Por defecto: 6.',
    },
    {
      name: 'ℹ️ Ten en cuenta',
      value: [
        '• `/remove` no alcanza la canción que ya se está preparando, justo antes de que empiece. En ese caso usa `/skip` cuando suene.',
        '• Las playlists de Spotify deben ser públicas y se leen hasta unas 100 canciones.',
        '• El audio viene de YouTube, así que la versión puede variar respecto a Spotify.',
      ].join('\n'),
    },
  );

client.once('clientReady', (c) => console.log(`Conectado como ${c.user.tag}`));

client.on('interactionCreate', async (interaction) => {
  // Sugerencias para /remove: las canciones en cola, filtradas por lo que se vaya escribiendo.
  if (interaction.isAutocomplete() && interaction.commandName === 'remove') {
    const typed = interaction.options.getFocused().toLowerCase();
    const tracks = getQueue(interaction.guildId)?.tracks ?? [];
    const choices = tracks
      .map((t, i) => ({ name: `${i + 1}. ${t.title}`.slice(0, 100), value: i + 1 }))
      .filter((c) => c.name.toLowerCase().includes(typed))
      .slice(0, 25);
    return interaction.respond(choices);
  }

  if (!interaction.isChatInputCommand() || !interaction.guildId) return;
  const queue = getQueue(interaction.guildId);
  const reply = (content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

  switch (interaction.commandName) {
    case 'play': {
      if (!interaction.member.voice.channel) return reply('Entra primero a un canal de voz.');
      await interaction.deferReply();
      try {
        const input = interaction.options.getString('cancion', true);
        const mix = interaction.options.getBoolean('aleatorio') ?? false;
        const spotify = parseSpotifyUrl(input);

        let tracks;
        if (spotify) {
          tracks = await getSpotifyTracks(spotify);
          if (!tracks.length) return interaction.editReply('Esa lista de Spotify está vacía.');
          if (mix) shuffle(tracks);
        } else {
          const track = await resolveTrack(input);
          if (!track) return interaction.editReply('No encontré nada.');
          tracks = [track];
        }

        const started = await enqueue(interaction, tracks);
        const label = tracks.length > 1 ? `**${tracks.length} canciones**${mix ? ' (orden aleatorio 🔀)' : ''}` : `**${tracks[0].title}**`;
        return interaction.editReply(started ? `▶️ Reproduciendo ${label}` : `➕ En cola: ${label}`);
      } catch (err) {
        console.error(err);
        return interaction.editReply('Ocurrió un error al reproducir.');
      }
    }
    case 'skip':
      if (!queue?.current) return reply('No hay nada sonando.');
      skip(queue);
      return reply('⏭️ Saltada.');
    case 'mix': {
      const seconds = interaction.options.getInteger('segundos', true);
      setFade(interaction.guildId, seconds);
      return reply(seconds ? `🎚️ Transición de ${seconds}s entre canciones (aplica desde la próxima canción).` : '🎚️ Transiciones desactivadas.');
    }
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
      return reply(`**Ahora:** ${queue.current.title}\n${lines.join('\n') || '_(nada más en cola)_'}`);
    }
    case 'info':
      return interaction.reply({ embeds: [infoEmbed] });
    case 'remove': {
      const pos = interaction.options.getInteger('posicion', true);
      if (!queue?.tracks.length) return reply('La cola está vacía.');
      if (pos > queue.tracks.length) return reply(`Solo hay ${queue.tracks.length} canciones en cola.`);
      const [removed] = queue.tracks.splice(pos - 1, 1);
      return reply(`🗑️ Quitada de la cola: **${removed.title}**`);
    }
    case 'shuffle':
      if (!queue?.tracks.length) return reply('No hay canciones en cola para mezclar.');
      shuffle(queue.tracks);
      return reply(`🔀 Mezcladas ${queue.tracks.length} canciones.`);
    case 'stop':
      if (!queue) return reply('No hay nada sonando.');
      destroyQueue(interaction.guildId);
      return reply('⏹️ Detenido.');
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error('Falta DISCORD_TOKEN en .env');
  process.exit(1);
}
client.login(process.env.DISCORD_TOKEN);
