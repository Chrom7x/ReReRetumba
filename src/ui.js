// Todo lo visual del bot: paleta, avisos, barra de progreso y el mensaje "Sonando ahora".
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';

export const COLORS = {
  play: 0x2ecc71, // reproducción
  info: 0x3498db, // información
  warn: 0xf1c40f, // advertencias
  error: 0xe74c3c, // errores
  muted: 0x95a5a6, // en pausa / finalizado
};

const NOTICE_ICONS = { success: '✅', info: 'ℹ️', warn: '⚠️', error: '❌' };
const NOTICE_COLORS = { success: COLORS.play, info: COLORS.info, warn: COLORS.warn, error: COLORS.error };

export const LOOP_LABELS = { off: 'No', track: 'Canción', queue: 'Cola' };

export const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// Aviso corto con el color de su nivel: success | info | warn | error.
export function notice(level, text) {
  return new EmbedBuilder().setColor(NOTICE_COLORS[level]).setDescription(`${NOTICE_ICONS[level]} ${text}`);
}

export function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export function progressBar(elapsed, total, size = 14) {
  if (!total) return '🔴 ▬▬▬▬▬▬▬▬▬▬▬▬▬▬';
  const pos = Math.min(size - 1, Math.round((elapsed / total) * (size - 1)));
  return `[${'▬'.repeat(pos)}🔘${'▬'.repeat(size - 1 - pos)}]`;
}

// Enlace solo si es http(s); los archivos locales no tienen.
const linkOf = (track) => (/^https?:\/\//.test(track.url ?? '') ? track.url : null);

export function trackLine(track) {
  const name = truncate(track.title, 70);
  const link = linkOf(track);
  const duration = track.duration ? ` \`${formatTime(track.duration)}\`` : '';
  return `${link ? `[${name}](${link})` : name}${track.author ? ` — ${truncate(track.author, 40)}` : ''}${duration}`;
}

// state: { track, elapsedSec, paused, next, queued, loop, fade, hasHistory }
export function nowPlayingPayload(state) {
  const { track } = state;
  const embed = new EmbedBuilder()
    .setColor(state.paused ? COLORS.muted : COLORS.play)
    .setAuthor({ name: state.paused ? '⏸️  En pausa' : '🎶  Sonando ahora' })
    .setTitle(truncate(track.title, 256))
    .setDescription(
      `${progressBar(state.elapsedSec, track.duration)}  \`${formatTime(state.elapsedSec)} / ${track.duration ? formatTime(track.duration) : '--:--'}\``,
    )
    .addFields(
      { name: 'Artista', value: truncate(track.author ?? 'Desconocido', 100), inline: true },
      { name: 'Pedida por', value: track.requester ? `<@${track.requester.id}>` : '—', inline: true },
      { name: 'Siguiente', value: state.next ? truncate(state.next.title, 100) : 'Nada en cola', inline: true },
    )
    .setFooter({
      text: `${state.queued} en cola  ·  Bucle: ${LOOP_LABELS[state.loop]}  ·  Transición: ${state.fade ? `${state.fade}s` : 'no'}`,
    });
  const link = linkOf(track);
  if (link) embed.setURL(link);
  if (track.thumbnail) embed.setThumbnail(track.thumbnail);

  return { embeds: [embed], components: controlRows(state), allowedMentions: { parse: [] } };
}

function controlRows(state) {
  const btn = (id, emoji, label, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(`np:${id}`).setEmoji(emoji).setLabel(label).setStyle(style);
  return [
    new ActionRowBuilder().addComponents(
      btn('prev', '⏮️', 'Anterior').setDisabled(!state.hasHistory),
      btn('toggle', state.paused ? '▶️' : '⏸️', state.paused ? 'Reanudar' : 'Pausa', ButtonStyle.Primary),
      btn('skip', '⏭️', 'Saltar'),
      btn('shuffle', '🔀', 'Aleatorio').setDisabled(state.queued < 2),
      btn('loop', '🔁', `Bucle: ${LOOP_LABELS[state.loop]}`, state.loop === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success),
    ),
    new ActionRowBuilder().addComponents(btn('queue', '📋', 'Ver cola'), btn('stop', '⏹️', 'Detener', ButtonStyle.Danger)),
  ];
}

export function queueEmbed({ current, elapsedSec, tracks }) {
  const lines = tracks.slice(0, 10).map((t, i) => `\`${i + 1}.\` ${trackLine(t)}`);
  const more = tracks.length > 10 ? `\n…y **${tracks.length - 10}** más` : '';
  const totalSec = tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('📋 Cola de reproducción')
    .setDescription(
      `**Ahora:** ${current ? `${trackLine(current)}\n\`${formatTime(elapsedSec)}\` transcurrido` : 'nada'}\n\n${lines.join('\n') || '_No hay más canciones en cola._'}${more}`,
    )
    .setFooter({ text: `${tracks.length} en cola${totalSec ? `  ·  ~${formatTime(totalSec)} en total` : ''}` });
}
