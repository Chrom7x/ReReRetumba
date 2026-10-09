// Descarga el binario de yt-dlp para este sistema en bin/ (se ejecuta solo tras `npm install`).
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const windows = process.platform === 'win32';
const asset = windows ? 'yt-dlp.exe' : process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
const dir = fileURLToPath(new URL('../bin/', import.meta.url));
const target = dir + (windows ? 'yt-dlp.exe' : 'yt-dlp');

if (existsSync(target)) {
  console.log('yt-dlp ya existe, se omite la descarga.');
  process.exit(0);
}

mkdirSync(dir, { recursive: true });
const res = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`);
if (!res.ok) throw new Error(`No se pudo descargar yt-dlp (${res.status})`);
writeFileSync(target, Buffer.from(await res.arrayBuffer()));
if (!windows) chmodSync(target, 0o755);
console.log(`yt-dlp descargado en ${target}`);
