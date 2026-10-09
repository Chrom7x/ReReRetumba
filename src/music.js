import { execFile, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import ffmpegPath from 'ffmpeg-static';

const YTDLP = fileURLToPath(new URL('../bin/yt-dlp.exe', import.meta.url));
const execFileAsync = promisify(execFile);

const BYTES_PER_SEC = 48000 * 2 * 2; // PCM s16le, 48 kHz, estéreo
const SKIP_FADE_SECONDS = 2;
const DEFAULT_FADE_SECONDS = 6;

const queues = new Map();
const fadeByGuild = new Map();

export const getFade = (guildId) => fadeByGuild.get(guildId) ?? DEFAULT_FADE_SECONDS;
export const setFade = (guildId, seconds) => fadeByGuild.set(guildId, seconds);

export function getQueue(guildId) {
  return queues.get(guildId);
}

// URL de YouTube o texto de búsqueda -> { title, url } (o null si no hay resultados).
export async function resolveTrack(query) {
  const target = /^https?:\/\//.test(query) ? query : `ytsearch1:${query}`;
  try {
    const { stdout } = await execFileAsync(
      YTDLP,
      [target, '--print', '%(title)s\t%(webpage_url)s', '--no-playlist', '--skip-download', '--js-runtimes', 'node'],
      { timeout: 30_000 },
    );
    const [title, url] = stdout.trim().split('\n')[0]?.split('\t') ?? [];
    return url ? { title, url } : null;
  } catch {
    return null;
  }
}

// ---- Archivos locales (carpeta musica/) ------------------------------------

const LOCAL_DIR = fileURLToPath(new URL('../musica/', import.meta.url));
const AUDIO_EXT = /\.(mp3|wav|flac|m4a|ogg|opus|aac)$/i;

export function listLocalFiles() {
  try {
    return readdirSync(LOCAL_DIR).filter((f) => AUDIO_EXT.test(f));
  } catch {
    return [];
  }
}

// Busca por nombre (con o sin extensión, sin distinguir mayúsculas). Solo dentro de musica/.
export function findLocalFile(name) {
  const wanted = name.trim().toLowerCase();
  const file = listLocalFiles().find((f) => f.toLowerCase() === wanted || f.replace(AUDIO_EXT, '').toLowerCase() === wanted);
  return file ? { title: file.replace(AUDIO_EXT, ''), file: join(LOCAL_DIR, file) } : null;
}

// Fisher-Yates
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---- Decodificación y mezcla de audio -------------------------------------

// Lector de PCM alineado a frames de 4 bytes (2 canales x 16 bits) sobre un proceso ffmpeg.
class PcmReader {
  // `track.file` = archivo local (ffmpeg lo lee directo); si no, el audio llega por yt-dlp desde `track.url`.
  constructor(track) {
    this.skipped = false;
    this.ytdlp = track.file
      ? null
      : spawn(YTDLP, ['-f', 'bestaudio/best', '--no-playlist', '--js-runtimes', 'node', '-q', '-o', '-', track.url], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
    this.ff = spawn(
      ffmpegPath,
      ['-loglevel', 'error', '-i', track.file ?? 'pipe:0', '-af', 'silenceremove=start_periods=1:start_threshold=-50dB', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
      { stdio: [track.file ? 'ignore' : 'pipe', 'pipe', 'ignore'] },
    );
    if (this.ytdlp) {
      this.ytdlp.stdout.pipe(this.ff.stdin);
      this.ff.stdin.on('error', () => {});
      this.ytdlp.on('error', () => this.ff.kill());
    }
    this.iter = this.ff.stdout[Symbol.asyncIterator]();
    this.rest = null;
    this.carry = Buffer.alloc(0);
    this.done = false;
  }

  async chunk() {
    if (this.rest) {
      const r = this.rest;
      this.rest = null;
      return r;
    }
    while (!this.done) {
      let res;
      try {
        res = await this.iter.next();
      } catch {
        res = { done: true };
      }
      if (res.done) {
        this.done = true;
        break;
      }
      const buf = this.carry.length ? Buffer.concat([this.carry, res.value]) : res.value;
      const usable = buf.length - (buf.length % 4);
      this.carry = buf.subarray(usable);
      if (usable) return buf.subarray(0, usable);
    }
    return null;
  }

  // Lee hasta n bytes (menos si el audio termina antes).
  async read(n) {
    let buf = Buffer.alloc(0);
    while (buf.length < n) {
      const c = await this.chunk();
      if (!c) break;
      buf = buf.length ? Buffer.concat([buf, c]) : c;
    }
    if (buf.length > n) {
      this.rest = buf.subarray(n);
      buf = buf.subarray(0, n);
    }
    return buf;
  }

  close() {
    this.ytdlp?.kill();
    this.ff.kill();
  }
}

// Fundido de potencia constante: `a` baja mientras `b` sube. El resultado mide lo mismo que `a`.
function crossfade(a, b) {
  const out = Buffer.allocUnsafe(a.length);
  const frames = a.length / 4;
  for (let i = 0; i < frames; i++) {
    const t = (i + 0.5) / frames;
    const ga = Math.cos((t * Math.PI) / 2);
    const gb = Math.sin((t * Math.PI) / 2);
    for (let ch = 0; ch < 2; ch++) {
      const o = i * 4 + ch * 2;
      const sa = a.readInt16LE(o);
      const sb = o + 1 < b.length ? b.readInt16LE(o) : 0;
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sa * ga + sb * gb))), o);
    }
  }
  return out;
}

async function nextReader(queue) {
  while (queue.tracks.length) {
    const track = queue.tracks.shift();
    try {
      // Las pistas de Spotify llegan solo con "query"; se buscan en YouTube al reproducirse.
      if (!track.file && !track.url) {
        const found = await resolveTrack(track.query);
        if (!found) throw new Error('sin resultados en YouTube');
        track.url = found.url;
      }
      queue.current = track;
      return new PcmReader(track);
    } catch (err) {
      console.error('No se pudo reproducir', track.title, err.message);
    }
  }
  return null;
}

// Una sola secuencia continua de PCM: al final de cada canción se mezcla con el inicio de la siguiente.
// Se retiene la cola de cada canción (hold) hasta saber si hay otra con la que fundirla.
export async function* mixTracks(queue) {
  let reader = await nextReader(queue);
  while (reader) {
    queue.reader = reader;
    const fade = Math.floor((getFade(queue.guildId) * BYTES_PER_SEC) / 4) * 4;
    let hold = Buffer.alloc(0);
    let c;
    while ((c = await reader.chunk())) {
      hold = hold.length ? Buffer.concat([hold, c]) : c;
      if (hold.length > fade) {
        yield hold.subarray(0, hold.length - fade);
        hold = hold.subarray(hold.length - fade);
      }
    }
    if (reader.skipped) hold = hold.subarray(0, Math.min(hold.length, SKIP_FADE_SECONDS * BYTES_PER_SEC));

    const next = await nextReader(queue);
    if (!next) {
      if (hold.length) yield hold;
      return;
    }
    queue.reader = next;
    const head = await next.read(hold.length);
    if (hold.length) yield crossfade(hold, head);
    reader = next;
  }
}

function startStream(queue) {
  queue.streaming = true;
  const pcm = Readable.from(mixTracks(queue), { objectMode: false });
  queue.player.play(createAudioResource(pcm, { inputType: StreamType.Raw }));
}

// ---- Cola y conexión de voz ------------------------------------------------

export async function enqueue(interaction, newTracks) {
  const channel = interaction.member.voice.channel;
  const guildId = interaction.guildId;
  let queue = queues.get(guildId);

  if (!queue) {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    connection.subscribe(player);

    queue = { guildId, connection, player, tracks: [], current: null, reader: null, streaming: false };
    queues.set(guildId, queue);
    const q = queue;

    player.on(AudioPlayerStatus.Idle, () => {
      if (queues.get(guildId) !== q) return;
      q.streaming = false;
      q.current = null;
      if (q.tracks.length) startStream(q);
      else destroyQueue(guildId);
    });
    player.on('error', (err) => console.error('Error del reproductor:', err.message));
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        destroyQueue(guildId);
      }
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  }

  queue.tracks.push(...newTracks);
  if (!queue.streaming) {
    startStream(queue);
    return true; // empezó a sonar de inmediato
  }
  return false; // quedó en cola
}

export function skip(queue) {
  if (!queue.reader) return;
  queue.reader.skipped = true;
  queue.reader.close();
}

export function destroyQueue(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return;
  queues.delete(guildId);
  queue.tracks.length = 0;
  queue.reader?.close();
  queue.player.stop(true);
  queue.connection.destroy();
}
