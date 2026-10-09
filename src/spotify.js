const URL_RE = /open\.spotify\.com\/(?:intl-[a-z]+\/)?(playlist|album|track)\/([A-Za-z0-9]+)/;

let cached = { token: null, expires: 0 };

export function parseSpotifyUrl(text) {
  const m = URL_RE.exec(text);
  return m ? { type: m[1], id: m[2] } : null;
}

async function getToken() {
  if (cached.token && Date.now() < cached.expires) return cached.token;

  const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } = process.env;
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error('Faltan SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET en .env');
  }
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Spotify rechazó las credenciales (${res.status})`);
  const data = await res.json();
  cached = { token: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return cached.token;
}

async function api(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await getToken()}` } });
  if (!res.ok) throw new Error(`Spotify respondió ${res.status} (¿la playlist es privada?)`);
  return res.json();
}

const toTrack = (t) => (t?.name ? { query: `${t.name} ${t.artists?.map((a) => a.name).join(' ') ?? ''}`.trim(), title: `${t.name} - ${t.artists?.[0]?.name ?? ''}` } : null);

// Spotify cerró /playlists/{id}/tracks a apps sin usuario logueado (403/401), así que las
// playlists públicas se leen de la página embed, que no requiere login (máx. ~100 pistas).
async function getPlaylistFromEmbed(id) {
  const res = await fetch(`https://open.spotify.com/embed/playlist/${id}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Spotify respondió ${res.status} (¿la playlist es privada?)`);
  const m = /<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s.exec(await res.text());
  const list = m && JSON.parse(m[1]).props?.pageProps?.state?.data?.entity?.trackList;
  if (!list) throw new Error('No pude leer la playlist (¿es privada?)');
  return list.map((t) => ({ query: `${t.title} ${t.subtitle}`.trim(), title: `${t.title} - ${t.subtitle}` }));
}

// Devuelve [{ title, query }] sin resolver a YouTube todavía (se resuelve al reproducir).
export async function getSpotifyTracks({ type, id }) {
  if (type === 'playlist') return getPlaylistFromEmbed(id);
  if (type === 'track') {
    return [toTrack(await api(`https://api.spotify.com/v1/tracks/${id}`))].filter(Boolean);
  }
  let url = `https://api.spotify.com/v1/albums/${id}/tracks?limit=50`;
  const tracks = [];
  while (url) {
    const page = await api(url);
    for (const item of page.items) tracks.push(toTrack(item));
    url = page.next;
  }
  return tracks.filter(Boolean);
}
