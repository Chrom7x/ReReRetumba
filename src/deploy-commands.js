import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commands } from './commands.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Faltan DISCORD_TOKEN o CLIENT_ID en .env');
  process.exit(1);
}

const rest = new REST().setToken(DISCORD_TOKEN);
// Con GUILD_ID los comandos aparecen al instante; sin él son globales (tardan hasta 1h).
const route = GUILD_ID
  ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
  : Routes.applicationCommands(CLIENT_ID);

await rest.put(route, { body: commands });
console.log(`Registrados ${commands.length} comandos ${GUILD_ID ? 'en el servidor' : 'globales'}.`);
