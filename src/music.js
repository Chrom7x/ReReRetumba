import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import play from 'play-dl';

const queues = new Map();

export function getQueue(guildId) {
  return queues.get(guildId);
}

export async function resolveTrack(query) {
  if (play.yt_validate(query) === 'video') {
    const info = await play.video_info(query);
    return { title: info.video_details.title, url: info.video_details.url };
  }
  const [result] = await play.search(query, { limit: 1, source: { youtube: 'video' } });
  if (!result) return null;
  return { title: result.title, url: result.url };
}

// Fisher-Yates
export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export async function enqueue(interaction, newTracks) {
  const channel = interaction.member.voice.channel;
  let queue = queues.get(interaction.guildId);

  if (!queue) {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    connection.subscribe(player);

    queue = { connection, player, tracks: [], current: null };
    queues.set(interaction.guildId, queue);

    player.on(AudioPlayerStatus.Idle, () => playNext(interaction.guildId));
    player.on('error', (err) => {
      console.error('Error del reproductor:', err.message);
      playNext(interaction.guildId);
    });
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        destroyQueue(interaction.guildId);
      }
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  }

  queue.tracks.push(...newTracks);
  if (queue.player.state.status === AudioPlayerStatus.Idle && !queue.current) {
    await playNext(interaction.guildId);
    return true; // empezó a sonar de inmediato
  }
  return false; // quedó en cola
}

async function playNext(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return;

  const next = queue.tracks.shift();
  if (!next) {
    queue.current = null;
    return destroyQueue(guildId);
  }

  queue.current = next;
  try {
    // Las pistas de Spotify llegan solo con "query"; se buscan en YouTube al reproducirse.
    if (!next.url) {
      const found = await resolveTrack(next.query);
      if (!found) throw new Error('sin resultados en YouTube');
      next.url = found.url;
    }
    const stream = await play.stream(next.url);
    queue.player.play(createAudioResource(stream.stream, { inputType: stream.type }));
  } catch (err) {
    console.error('No se pudo reproducir', next.title, err.message);
    return playNext(guildId);
  }
}

export function destroyQueue(guildId) {
  const queue = queues.get(guildId);
  if (!queue) return;
  queue.tracks.length = 0;
  queue.player.stop(true);
  queue.connection.destroy();
  queues.delete(guildId);
}
