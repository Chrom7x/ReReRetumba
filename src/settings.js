// Configuración por servidor, guardada en DATA_DIR/settings.json (en Railway, un volumen en /data
// para que sobreviva a los reinicios; en local, la carpeta data/ del proyecto).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url));
const FILE = join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  fade: 6, // segundos de transición entre canciones
  controlChannelId: null, // canal del panel de control (!setup)
  controlMessageId: null, // mensaje fijo del panel dentro de ese canal
};

let all = {};
try {
  all = JSON.parse(readFileSync(FILE, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') console.error('[settings] no se pudo leer, se empieza vacío:', err.message);
}

// Escritura atómica: si el proceso muere a mitad, queda el archivo anterior intacto.
function save() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2));
    renameSync(tmp, FILE);
  } catch (err) {
    console.error('[settings] no se pudo guardar:', err.message);
  }
}

export function getSettings(guildId) {
  return { ...DEFAULTS, ...all[guildId] };
}

export function updateSettings(guildId, patch) {
  all[guildId] = { ...all[guildId], ...patch };
  save();
  return getSettings(guildId);
}

// Servidores que tienen un panel de control configurado.
export function guildsWithPanel() {
  return Object.entries(all)
    .filter(([, s]) => s.controlChannelId)
    .map(([guildId]) => guildId);
}
