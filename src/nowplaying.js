// Un único mensaje "Sonando ahora" por servidor: al cambiar de canción se borra el anterior y se
// publica uno nuevo (queda al final del chat); entre medias solo se edita la barra de progreso.
import { nowPlayingPayload } from './ui.js';

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

function render(queue, np) {
  return nowPlayingPayload({
    track: np.track,
    elapsedSec: np.elapsedSec,
    paused: queue.paused,
    next: queue.loop === 'track' ? np.track : queue.tracks[0],
    queued: queue.tracks.length,
    loop: queue.loop,
    fade: queue.getFade(),
    hasHistory: queue.history.length > 0,
  });
}

async function tick(queue, force = false) {
  if (queue.npBusy || !queue.textChannel) return;
  queue.npBusy = true;
  try {
    const np = nowPlaying(queue);
    if (!np) return;
    if (np.track !== queue.npTrack || !queue.npMessage) {
      queue.npTrack = np.track;
      const old = queue.npMessage;
      queue.npMessage = null;
      old?.delete().catch(() => {});
      queue.npMessage = await queue.textChannel.send(render(queue, np));
      queue.npEditedAt = Date.now();
    } else if (force || (!queue.paused && Date.now() - queue.npEditedAt >= EDIT_EVERY_MS)) {
      await queue.npMessage.edit(render(queue, np));
      queue.npEditedAt = Date.now();
    }
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

// Vuelve a publicar el mensaje al final del chat.
export function repostNowPlaying(queue) {
  queue.npTrack = null;
  return tick(queue);
}

export function clearNowPlaying(queue) {
  clearInterval(queue.npTimer);
  queue.npTimer = null;
  queue.npTrack = null;
  queue.npMessage?.delete().catch(() => {});
  queue.npMessage = null;
}
