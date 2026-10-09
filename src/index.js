import 'dotenv/config';
import { Client, GatewayIntentBits, MessageFlags } from 'discord.js';
import { AudioPlayerStatus } from '@discordjs/voice';
import ffmpegPath from 'ffmpeg-static';
import { destroyQueue, enqueue, getQueue, resolveTrack, setFade, shuffle, skip } from './music.js';
import { getSpotifyTracks, parseSpotifyUrl } from './spotify.js';

process.env.FFMPEG_PATH ??= ffmpegPath;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

client.once('clientReady', (c) => console.log(`Conectado como ${c.user.tag}`));

client.on('interactionCreate', async (interaction) => {
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
