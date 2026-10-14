// El mensaje "Sonando ahora", en uno de dos modos:
// - Chat: un único mensaje en el canal donde se pidió la música; al cambiar de canción se borra y
//   se publica de nuevo (queda al final del chat).
// - Panel (si el servidor hizo !setup): un mensaje fijo en el canal de control que solo se edita;
//   cuando no suena nada vuelve al estado de espera.
import { PREFIX } from './config.js';
import { getSettings, updateSettings } from './settings.js';
import { idlePanelPayload, nowPlayingPayload } from './ui.js';

const TICK_MS = 5_000;
const EDIT_EVERY_MS = 15_000;
const UNKNOWN_MESSAGE = 10008; // código de Discord: el mensaje ya no existe

// La pista que se OYE ahora (la mezcla va unos segundos por delante de lo que suena).
export function nowPlaying(queue) {
  const ms = queue.resource?.playbackDuration ?? 0;
  let entry = null;
  for (const e of queue.timeline ?? []) if (e.startMs <= ms) entry = e;
  entry ??= queue.timeline?.[0];
  return entry ? { track: entry.track, elapsedSec: Math.max(0, (ms - entry.startMs) / 1000) } : null;
}

// ---- Panel de control ---------------------------------------------------------

export function panelChannel(guild) {
  const id = getSettings(guild.id).controlChannelId;
  return id ? (guild.channels.cache.get(id) ?? null) : null;
}

// Mensaje fijo del panel; si alguien lo borró, se vuelve a crear.
export async function ensurePanelMessage(guild) {
  const channel = panelChannel(guild);
  if (!channel) return null;
  const { controlMessageId } = getSettings(guild.id);
  if (controlMessageId) {
    const existing = await channel.messages.fetch(controlMessageId).catch(() => null);
    if (existing) return existing;
  }
  const msg = await channel.send(idlePanelPayload(guild.client.user, PREFIX));
  updateSettings(guild.id, { controlMessageId: msg.id });
  return msg;
}

export async function showIdlePanel(guild) {
  const msg = await ensurePanelMessage(guild).catch((err) => console.error('[panel]', err.message));
  await msg?.edit(idlePanelPayload(guild.client.user, PREFIX)).catch(() => {});
}

// ---- Actualización periódica ----------------------------------------------------

function render(queue, np, withUpcoming) {
  return nowPlayingPayload({
    track: np.track,
    elapsedSec: np.elapsedSec,
    paused: queue.paused,
    next: queue.loop === 'track' ? np.track : queue.tracks[0],
    queued: queue.tracks.length,
    loop: queue.loop,
    fade: queue.getFade(),
    hasHistory: queue.history.length > 0,
    upcoming: withUpcoming ? queue.tracks : undefined,
  });
}

async function tickPanel(queue, np, force) {
  queue.npMessage ??= await ensurePanelMessage(queue.guild);
  if (!queue.npMessage) return;
  const changed = np.track !== queue.npTrack;
  if (changed || force || (!queue.paused && Date.now() - queue.npEditedAt >= EDIT_EVERY_MS)) {
    await queue.npMessage.edit(render(queue, np, true));
    queue.npTrack = np.track;
    queue.npEditedAt = Date.now();
  }
}

async function tickChat(queue, np, force) {
  if (!queue.textChannel) return;
  if (np.track !== queue.npTrack || !queue.npMessage) {
    queue.npTrack = np.track;
    const old = queue.npMessage;
    queue.npMessage = null;
    old?.delete().catch(() => {});
    queue.npMessage = await queue.textChannel.send(render(queue, np, false));
    queue.npEditedAt = Date.now();
  } else if (force || (!queue.paused && Date.now() - queue.npEditedAt >= EDIT_EVERY_MS)) {
    await queue.npMessage.edit(render(queue, np, false));
    queue.npEditedAt = Date.now();
  }
}

async function tick(queue, force = false) {
  if (queue.npBusy) return;
  queue.npBusy = true;
  try {
    const np = nowPlaying(queue);
    if (!np) return;
    const usePanel = Boolean(queue.guild && panelChannel(queue.guild));
    if (usePanel !== queue.npPanelMode) {
      // Se activó o quitó el panel mientras sonaba: se suelta el mensaje del modo anterior.
      if (!queue.npPanelMode) queue.npMessage?.delete().catch(() => {});
      queue.npMessage = null;
      queue.npTrack = null;
      queue.npPanelMode = usePanel;
    }
    await (usePanel ? tickPanel(queue, np, force) : tickChat(queue, np, force));
  } catch (err) {
    if (err.code === UNKNOWN_MESSAGE) queue.npMessage = null; // alguien lo borró: se vuelve a publicar
    else console.error('[np] no se pudo actualizar:', err.message);
  } finally {
    queue.npBusy = false;
  }
}

export function startNowPlaying(queue) {
  if (queue.npTimer) return;
  queue.npTimer = setInterval(() => tick(queue), TICK_MS);
  setTimeout(() => tick(queue), 1_500); // primera publicación en cuanto empieza a sonar
}

// Refleja al instante un cambio (pausa, bucle, cola...).
export function refreshNowPlaying(queue) {
  return tick(queue, true);
}

// Vuelve a publicar el reproductor al final del chat (en el panel basta con actualizarlo).
export function repostNowPlaying(queue) {
  if (!queue.npPanelMode) queue.npTrack = null;
  return tick(queue, true);
}

export function clearNowPlaying(queue) {
  clearInterval(queue.npTimer);
  queue.npTimer = null;
  queue.npTrack = null;
  if (queue.npPanelMode && queue.guild) showIdlePanel(queue.guild);
  else queue.npMessage?.delete().catch(() => {});
  queue.npMessage = null;
}
