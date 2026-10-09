import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Reproduce una canción (URL de YouTube o texto de búsqueda)')
    .addStringOption((o) => o.setName('cancion').setDescription('URL o búsqueda').setRequired(true)),
  new SlashCommandBuilder().setName('skip').setDescription('Salta la canción actual'),
  new SlashCommandBuilder().setName('pause').setDescription('Pausa la reproducción'),
  new SlashCommandBuilder().setName('resume').setDescription('Reanuda la reproducción'),
  new SlashCommandBuilder().setName('queue').setDescription('Muestra la cola'),
  new SlashCommandBuilder().setName('stop').setDescription('Detiene la música y limpia la cola'),
].map((c) => c.toJSON());
