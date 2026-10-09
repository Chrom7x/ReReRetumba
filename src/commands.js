import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Reproduce una canción (URL de YouTube o texto de búsqueda)')
    .addStringOption((o) => o.setName('cancion').setDescription('URL (YouTube/Spotify) o búsqueda').setRequired(true))
    .addBooleanOption((o) => o.setName('aleatorio').setDescription('Orden aleatorio si es una playlist/álbum')),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Quita una canción de la cola antes de que suene')
    .addIntegerOption((o) =>
      o.setName('posicion').setDescription('Número en /queue (o elige de la lista)').setMinValue(1).setAutocomplete(true).setRequired(true),
    ),
  new SlashCommandBuilder().setName('shuffle').setDescription('Pone en orden aleatorio las canciones en cola'),
  new SlashCommandBuilder()
    .setName('mix')
    .setDescription('Transición entre canciones (crossfade). 0 = desactivada')
    .addIntegerOption((o) => o.setName('segundos').setDescription('Duración de la transición (0-15)').setMinValue(0).setMaxValue(15).setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('Salta la canción actual'),
  new SlashCommandBuilder().setName('pause').setDescription('Pausa la reproducción'),
  new SlashCommandBuilder().setName('resume').setDescription('Reanuda la reproducción'),
  new SlashCommandBuilder().setName('queue').setDescription('Muestra la cola'),
  new SlashCommandBuilder().setName('stop').setDescription('Detiene la música y limpia la cola'),
].map((c) => c.toJSON());
