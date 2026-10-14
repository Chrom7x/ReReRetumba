// Pedir música: lo usan el comando !play y los mensajes escritos en el canal de control.
import { PREFIX } from '../config.js';
import { enqueue, findLocalFile, resolveTrack, shuffle, voiceProblem } from '../music.js';
import { getSpotifyTracks, parseSpotifyUrl } from '../spotify.js';
import { notice, trackLine } from '../ui.js';

const SHUFFLE_FLAG = /(^|\s)--aleatorio\b/i;

// io: { send(payload) -> Promise<Message>, reply(level, text), scheduleDelete(msg) }
export async function handlePlay(message, text, io) {
  const problem = voiceProblem(message.member);
  if (problem) return io.reply('warn', problem);
  const mix = SHUFFLE_FLAG.test(text);
  const input = text.replace(new RegExp(SHUFFLE_FLAG.source, 'gi'), ' ').trim();
  if (!input) return io.reply('info', `Dime qué quieres escuchar. Ejemplo: \`${PREFIX}play Bad Bunny Monaco\``);

  // Mensaje de "buscando" que se convierte en el resultado y luego se borra.
  const status = await io.send({ embeds: [notice('info', `🔎 Buscando **${input.slice(0, 80)}**…`)] });
  const done = async (level, msg) => {
    await status.edit({ embeds: [notice(level, msg)] }).catch(() => {});
    io.scheduleDelete(status);
  };

  const spotify = parseSpotifyUrl(input);
  const local = spotify ? null : findLocalFile(input);
  let tracks;
  if (spotify) {
    try {
      tracks = await getSpotifyTracks(spotify);
    } catch (err) {
      console.error('[spotify]', err.message);
      return done('error', 'No pude leer ese enlace de Spotify. Si es una playlist, asegúrate de que sea **pública**.');
    }
    if (!tracks.length) return done('warn', 'Esa lista de Spotify está vacía.');
    if (mix) shuffle(tracks);
  } else if (local) {
    tracks = [local];
  } else {
    const track = await resolveTrack(input);
    if (!track) {
      return done(
        'warn',
        /^https?:\/\//.test(input)
          ? 'No pude abrir ese enlace. Puede ser privado, haber sido borrado o requerir iniciar sesión.'
          : `No encontré nada con **${input.slice(0, 80)}**. Prueba con otro nombre o pega un enlace.`,
      );
    }
    tracks = [track];
  }

  const requester = { id: message.author.id, tag: message.author.tag };
  for (const t of tracks) t.requester = requester;

  let result;
  try {
    result = await enqueue(message, tracks);
  } catch (err) {
    console.error('[voz] no se pudo conectar:', err.message);
    return done('error', 'No pude conectarme al canal de voz. Inténtalo de nuevo en unos segundos.');
  }
  if (tracks.length > 1) return done('success', `Añadí **${tracks.length} canciones** a la cola${mix ? ' en orden aleatorio 🔀' : ''}.`);
  return done(
    'success',
    result.started ? `Empezando con ${trackLine(tracks[0])}` : `Añadida a la cola en la posición **${result.position}**: ${trackLine(tracks[0])}`,
  );
}
