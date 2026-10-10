import { execFile, spawn } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { PermissionFlagsBits } from 'discord.js';
import ffmpegPath from 'ffmpeg-static';
import { clearNowPlaying, refreshNowPlaying, startNowPlaying } from './nowplaying.js';
import { notice } from './ui.js';

const YTDLP = fileURLToPath(new URL(process.platform === 'win32' ? '../bin/yt-dlp.exe' : '../bin/yt-dlp', import.meta.url));
const execFileAsync = promisify(execFile);

// Opcional: cookies de YouTube (archivo cookies.txt en base64) para servidores cuya IP YouTube bloquea.
let cookieArgs = [];
if (process.env.YT_COOKIES_B64) {
  const cookiesFile = join(tmpdir(), 'yt-cookies.txt');
  writeFileSync(cookiesFile, Buffer.from(process.env.YT_COOKIES_B64, 'base64'));
  cookieArgs = ['--cookies', cookiesFile];
}

const BYTES_PER_SEC = 48000 * 2 * 2; // PCM s16le, 48 kHz, estéreo
const SKIP_FADE_SECONDS = 2;
const DEFAULT_FADE_SECONDS = 6;
const PREFETCH_LEAD_SECONDS = 30; // cuánto antes de acabar una canción se empieza a cargar la siguiente
const IDLE_LEAVE_MS = 5 * 60 * 1000; // espera en el canal tras terminar la cola
const EMPTY_CHANNEL_LEAVE_MS = 2 * 60 * 1000; // espera si todos salen del canal de voz
const HISTORY_LIMIT = 50;
const NOTICE_TTL_MS = 20_000;

export const LOOP_MODES = ['off', 'track', 'queue'];

const queues = new Map();
const fadeByGuild = new Map();

export const getFade = (guildId) => fadeByGuild.get(guildId) ?? DEFAULT_FADE_SECONDS;
export const setFade = (guildId, seconds) => fadeByGuild.set(guildId, seconds);

export function getQueue(guildId) {
  return queues.get(guildId);
}

// Aviso en el canal de texto donde se pidió la música; se borra solo para no llenar el chat.
function notify(queue, level, text) {
  queue.textChannel
    ?.send({ embeds: [notice(level, text)], allowedMentions: { parse: [] } })
    .then((msg) => setTimeout(() => msg.delete().catch(() => {}), NOTICE_TTL_MS))
    .catch(() => {});
}

// ---- Búsqueda --------------------------------------------------------------

const known = (v) => (v && v !== 'NA' ? v : null);

// URL o texto de búsqueda -> { title, url, duration, thumbnail, author } (o null si no hay resultados).
export async function resolveTrack(query) {
  const target = /^https?:\/\//.test(query) ? query : `ytsearch1:${query}`;
  try {
    const { stdout } = await execFileAsync(
      YTDLP,
      [
        target,
        '--print',
        '%(title)s\t%(webpage_url)s\t%(duration)s\t%(thumbnail)s\t%(uploader)s',
        '--no-playlist',
        '--skip-download',
        '--js-runtimes',
        'node',
        ...cookieArgs,
      ],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const [title, url, duration, thumbnail, author] = stdout.trim().split('\n')[0]?.split('\t') ?? [];
    return url ? { title, url, duration: Number(duration) || null, thumbnail: known(thumbnail), author: known(author) } : null;
  } catch (err) {
    console.error(`yt-dlp falló buscando "${query}":`, String(err.stderr || err.message).trim().slice(-600));
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
  return file ? { title: file.replace(AUDIO_EXT, ''), file: join(LOCAL_DIR, file), author: 'Archivo local' } : null;
}

// ffmpeg sin salida termina con error, pero imprime la duración en stderr.
async function probeDuration(file) {
  try {
    await execFileAsync(ffmpegPath, ['-hide_banner', '-i', file], { timeout: 10_000 });
  } catch (err) {
    const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(String(err.stderr));
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return null;
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
    this.track = track;
    this.errText = ''; // últimas líneas de error de yt-dlp/ffmpeg, para diagnosticar fallos
    const keepErr = (d) => (this.errText = (this.errText + d).slice(-800));
    this.ytdlp = track.file
      ? null
      : spawn(YTDLP, ['-f', 'bestaudio/best', '--no-playlist', '--js-runtimes', 'node', ...cookieArgs, '-q', '-o', '-', track.url], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
    this.ytdlp?.stderr.on('data', keepErr);
    this.ytdlp?.on('error', (e) => keepErr(`no se pudo ejecutar yt-dlp: ${e.message}`));
    this.ff = spawn(
      ffmpegPath,
      ['-loglevel', 'error', '-i', track.file ?? 'pipe:0', '-af', 'silenceremove=start_periods=1:start_threshold=-50dB', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'],
      { stdio: [track.file ? 'ignore' : 'pipe', 'pipe', 'pipe'] },
    );
    this.ff.stderr.on('data', keepErr);
    this.ff.on('error', (e) => keepErr(`no se pudo ejecutar ffmpeg: ${e.message}`));
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

  // Devuelve audio ya leído para que el próximo chunk()/read() lo entregue primero.
  unread(buf) {
    if (!buf.length) return;
    this.rest = this.rest ? Buffer.concat([buf, this.rest]) : buf;
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

// ---- Selección y apertura de pistas -----------------------------------------

class TrackError extends Error {
  constructor(kind, detail = '') {
    super(kind);
    this.kind = kind; // notfound | blocked | age | unavailable
    this.detail = detail;
  }
}

const FAIL_TEXT = {
  notfound: (t) => `No encontré **${t}** en YouTube, así que la salté.`,
  blocked: (t) => `YouTube está limitando al bot y no pude reproducir **${t}**. La salté; si se repite, avisa a quien administra el bot.`,
  age: (t) => `**${t}** tiene restricción de edad en YouTube y no se puede reproducir. La salté.`,
  unavailable: (t) => `**${t}** no está disponible (puede ser privada o estar bloqueada en tu región). La salté.`,
};

function classifyFailure(errText) {
  if (/not a bot|429|Too Many Requests|rate.limit/i.test(errText)) return 'blocked';
  if (/age|inappropriate for some users/i.test(errText)) return 'age';
  return 'unavailable';
}

// Resuelve la pista si hace falta y comprueba que de verdad llega audio antes de darla por buena.
async function openTrack(track) {
  if (!track.file && !track.url) {
    const found = await resolveTrack(track.query);
    if (!found) throw new TrackError('notfound');
    track.url = found.url;
    track.duration = found.duration ?? track.duration; // la del audio de YouTube, que es el que suena
    track.thumbnail ??= found.thumbnail;
    track.author ??= found.author;
  }
  if (track.file && !track.duration) track.duration = await probeDuration(track.file);

  const reader = new PcmReader(track);
  const first = await reader.chunk();
  if (!first) {
    reader.close();
    throw new TrackError(classifyFailure(reader.errText), reader.errText);
  }
  reader.unread(first);
  return reader;
}

// Qué toca después. La pista NO sale de la cola hasta que empieza a sonar, así que !remove,
// !shuffle, "Anterior" o el bucle pueden cambiar la siguiente aunque ya se esté cargando.
function peekNext(queue) {
  if (queue.loop === 'track' && queue.current && !queue.breakLoopOnce) return queue.current;
  return queue.tracks[0] ?? null;
}

// Abre la siguiente pista que funcione; las que fallan se quitan de la cola avisando en el chat.
async function openNext(queue) {
  for (;;) {
    const track = peekNext(queue);
    if (!track || queue.destroyed) return null;
    try {
      return { track, reader: await openTrack(track) };
    } catch (err) {
      const kind = err.kind ?? 'unavailable';
      console.error(`[pista] falló "${track.title}" (${kind}):`, String(err.detail || err.message).trim().slice(-400));
      notify(queue, 'warn', FAIL_TEXT[kind](track.title));
      if (queue.tracks[0] === track) queue.tracks.shift();
      else if (queue.current === track) queue.breakLoopOnce = true; // la canción en bucle dejó de funcionar
    }
  }
}

// Abre la siguiente pista y lee de antemano el inicio que se necesita para fundirla con la actual.
// Si esto se hiciera al terminar la actual, el arranque de yt-dlp dejaría al reproductor sin audio
// unos segundos y Discord lo detendría.
async function prepareNext(queue, bytes) {
  const opened = await openNext(queue);
  if (!opened) return null;
  queue.pending = opened.reader;
  return { ...opened, head: await opened.reader.read(bytes) };
}

// La pista empieza a sonar en `atBytes` del flujo continuo.
function startTrack(queue, { track, reader }, atBytes) {
  if (queue.current && !queue.noHistoryOnce) {
    queue.history.push(queue.current);
    if (queue.history.length > HISTORY_LIMIT) queue.history.shift();
  }
  queue.noHistoryOnce = false;
  queue.breakLoopOnce = false;
  if (queue.tracks[0] === track) queue.tracks.shift();
  if (queue.loop === 'queue') queue.tracks.push(track); // vuelve al final de la cola
  queue.pending = null;
  queue.reader = reader;
  queue.current = track;
  queue.timeline.push({ track, startMs: (atBytes / BYTES_PER_SEC) * 1000 });
  if (queue.timeline.length > 4) queue.timeline.shift();
}

// Una sola secuencia continua de PCM: al final de cada canción se mezcla con el inicio de la siguiente.
// Se retiene la cola de cada canción (hold) hasta saber si hay otra con la que fundirla.
export async function* mixTracks(queue) {
  let emitted = 0;
  const first = await openNext(queue);
  if (!first) return;
  startTrack(queue, first, 0);
  let reader = first.reader;

  while (reader) {
    const fade = Math.floor((getFade(queue.guildId) * BYTES_PER_SEC) / 4) * 4;
    // Cuándo empezar a preparar la siguiente (sin duración conocida: a los 20 s de audio).
    const prefetchAt = (reader.track.duration ? Math.max(0, reader.track.duration - PREFETCH_LEAD_SECONDS) : 20) * BYTES_PER_SEC;
    let prefetch = null;
    let hold = Buffer.alloc(0);
    let got = 0;
    let c;
    while ((c = await reader.chunk())) {
      got += c.length;
      if (!prefetch && got >= prefetchAt) prefetch = prepareNext(queue, fade);
      hold = hold.length ? Buffer.concat([hold, c]) : c;
      if (hold.length > fade) {
        const out = hold.subarray(0, hold.length - fade);
        hold = hold.subarray(hold.length - fade);
        emitted += out.length;
        yield out;
      }
    }
    if (!reader.skipped && reader.errText && /ERROR/.test(reader.errText)) {
      console.error(`[pista] "${reader.track.title}" se cortó:`, reader.errText.trim().slice(-400));
    }
    if (reader.skipped) hold = hold.subarray(0, Math.min(hold.length, SKIP_FADE_SECONDS * BYTES_PER_SEC));

    let upcoming = prefetch ? await prefetch : null;
    // La cola pudo cambiar mientras se cargaba (remove, shuffle, anterior, bucle): si ya no toca esa, se descarta.
    if (upcoming && peekNext(queue) !== upcoming.track) {
      upcoming.reader.close();
      upcoming = null;
    }
    upcoming ??= await prepareNext(queue, fade);
    if (!upcoming) {
      if (hold.length) yield hold;
      return;
    }

    upcoming.reader.unread(upcoming.head.subarray(hold.length)); // lo que sobre del inicio suena tras el fundido
    startTrack(queue, upcoming, emitted);
    if (hold.length) {
      const mixed = crossfade(hold, upcoming.head.subarray(0, hold.length));
      emitted += mixed.length;
      yield mixed;
    }
    reader = upcoming.reader;
  }
}

function startStream(queue) {
  queue.streaming = true;
  queue.timeline = [];
  const pcm = Readable.from(mixTracks(queue), { objectMode: false });
  queue.resource = createAudioResource(pcm, { inputType: StreamType.Raw });
  queue.player.play(queue.resource);
  startNowPlaying(queue);
}

// ---- Permisos y conexión de voz ---------------------------------------------

// Devuelve un mensaje explicando por qué no se puede reproducir para este usuario, o null si todo está bien.
export function voiceProblem(member) {
  const channel = member.voice.channel;
  if (!channel) return 'Necesitas estar en un canal de voz para escuchar música.';

  const queue = queues.get(channel.guild.id);
  const botChannelId = queue?.connection.joinConfig.channelId;
  if (botChannelId && botChannelId !== channel.id) return `Ya estoy poniendo música en <#${botChannelId}>. Únete a ese canal para pedir canciones.`;

  const perms = channel.permissionsFor(channel.guild.members.me);
  const missing = [
    [PermissionFlagsBits.ViewChannel, 'ver el canal'],
    [PermissionFlagsBits.Connect, 'conectarme'],
    [PermissionFlagsBits.Speak, 'hablar'],
  ]
    .filter(([flag]) => !perms?.has(flag))
    .map(([, name]) => name);
  if (missing.length) return `No tengo permiso para ${missing.join(', ')} en **${channel.name}**. Pide a un administrador que me lo dé.`;
  if (!botChannelId && channel.full && !perms.has(PermissionFlagsBits.MoveMembers)) return `**${channel.name}** está lleno, no puedo entrar.`;
  return null;
}

// Es del mismo canal de voz que el bot (para controlar la música).
export function inBotChannel(queue, member) {
  return member.voice.channelId === queue.connection.joinConfig.channelId;
}

export async function enqueue(message, newTracks) {
  const channel = message.member.voice.channel;
  const guildId = message.guildId;
  let queue = queues.get(guildId);

  if (!queue) {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });
    // maxMissedFrames: por defecto el reproductor se detiene tras 5 frames (100 ms) sin audio; se tolera hasta 10 s.
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 500 } });
    connection.subscribe(player);

    queue = {
      guildId,
      connection,
      player,
      tracks: [],
      history: [],
      timeline: [],
      current: null,
      reader: null,
      pending: null,
      resource: null,
      streaming: false,
      paused: false,
      loop: 'off',
      getFade: () => getFade(guildId),
    };
    queues.set(guildId, queue);
    const q = queue;

    player.on(AudioPlayerStatus.Idle, () => {
      if (queues.get(guildId) !== q) return;
      q.streaming = false;
      q.current = null;
      if (q.tracks.length) return startStream(q);
      clearNowPlaying(q);
      q.idleTimer = setTimeout(
        () => destroyQueue(guildId, 'inactividad (cola vacía)', 'Terminó la música y no pidieron más, así que salí del canal. ¡Hasta la próxima! 👋'),
        IDLE_LEAVE_MS,
      );
    });
    player.on('error', (err) => console.error('Error del reproductor:', err.message));
    player.on('stateChange', (o, n) => console.log(`[voz] reproductor: ${o.status} -> ${n.status}`));
    connection.on('stateChange', (o, n) => console.log(`[voz] conexión: ${o.status} -> ${n.status}`));
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        destroyQueue(guildId, 'desconectado del canal de voz');
      }
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      destroyQueue(guildId, 'no se pudo establecer la conexión de voz en 20 s');
      throw err;
    }
  }

  clearTimeout(queue.idleTimer);
  queue.textChannel = message.channel; // donde se publican el reproductor y los avisos
  queue.tracks.push(...newTracks);
  if (!queue.streaming) {
    startStream(queue);
    return { started: true, position: 0 };
  }
  refreshNowPlaying(queue);
  return { started: false, position: queue.tracks.length - newTracks.length + 1 };
}

// ---- Controles --------------------------------------------------------------

export function skip(queue) {
  if (!queue.reader) return false;
  queue.breakLoopOnce = true; // con bucle de canción, saltar pasa a la siguiente
  queue.reader.skipped = true;
  queue.reader.close();
  return true;
}

// Vuelve a la canción anterior; la actual queda la primera en la cola.
export function previous(queue) {
  const prev = queue.history.pop();
  if (!prev) return null;
  const current = queue.current;
  if (queue.loop === 'queue') {
    // En bucle de cola ambas ya están al final: se quitan para no duplicarlas.
    for (const t of [current, prev]) {
      const i = queue.tracks.lastIndexOf(t);
      if (i !== -1) queue.tracks.splice(i, 1);
    }
  }
  if (current) queue.tracks.unshift(current);
  queue.tracks.unshift(prev);
  queue.noHistoryOnce = true;
  skip(queue);
  return prev;
}

export function togglePause(queue) {
  queue.autoPaused = false;
  if (queue.paused) queue.player.unpause();
  else queue.player.pause();
  queue.paused = !queue.paused;
  refreshNowPlaying(queue);
  return queue.paused;
}

export function setLoop(queue, mode) {
  const next = mode ?? LOOP_MODES[(LOOP_MODES.indexOf(queue.loop) + 1) % LOOP_MODES.length];
  // Al activar bucle de cola, la canción actual también entra en la vuelta.
  if (next === 'queue' && queue.loop !== 'queue' && queue.current) queue.tracks.push(queue.current);
  if (queue.loop === 'queue' && next !== 'queue' && queue.current) {
    const i = queue.tracks.lastIndexOf(queue.current);
    if (i !== -1) queue.tracks.splice(i, 1);
  }
  queue.loop = next;
  refreshNowPlaying(queue);
  return next;
}

// ---- Canal de voz vacío -----------------------------------------------------

// Si todos salen del canal, pausa y se va a los 2 minutos; si alguien vuelve, sigue sonando.
export function checkVoiceChannel(guild) {
  const queue = queues.get(guild.id);
  if (!queue) return;
  const channel = guild.channels.cache.get(queue.connection.joinConfig.channelId);
  const listeners = channel?.members.filter((m) => !m.user.bot).size ?? 0;

  if (listeners === 0 && !queue.emptyTimer) {
    if (!queue.paused && queue.streaming) {
      queue.player.pause();
      queue.paused = true;
      queue.autoPaused = true;
      refreshNowPlaying(queue);
    }
    queue.emptyTimer = setTimeout(
      () => destroyQueue(guild.id, 'canal de voz vacío', 'Me quedé solo en el canal de voz, así que me desconecté. ¡Hasta la próxima! 👋'),
      EMPTY_CHANNEL_LEAVE_MS,
    );
  } else if (listeners > 0 && queue.emptyTimer) {
    clearTimeout(queue.emptyTimer);
    queue.emptyTimer = null;
    if (queue.autoPaused) {
      queue.player.unpause();
      queue.paused = false;
      queue.autoPaused = false;
      refreshNowPlaying(queue);
    }
  }
}

export function destroyQueue(guildId, reason = 'sin motivo indicado', userMessage = null) {
  const queue = queues.get(guildId);
  if (!queue) return;
  console.log(`[voz] el bot sale del canal: ${reason}`);
  if (userMessage) notify(queue, 'info', userMessage);
  queue.destroyed = true;
  queues.delete(guildId);
  clearTimeout(queue.idleTimer);
  clearTimeout(queue.emptyTimer);
  clearNowPlaying(queue);
  queue.tracks.length = 0;
  queue.reader?.close();
  queue.pending?.close();
  queue.player.stop(true);
  queue.connection.destroy();
}
