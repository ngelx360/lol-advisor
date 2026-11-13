const DISCORD_API_BASE = 'https://discord.com/api/v10';
const channelMetaCache = new Map();
const META_CACHE_TTL_MS = 5 * 60 * 1000;

function discordHeaders(botToken) {
  return {
    Authorization: `Bot ${String(botToken || '').trim()}`,
    'Content-Type': 'application/json',
    'User-Agent': 'LoLRankedAdvisor-TorneoBlitz (1.0)'
  };
}

/**
 * Accept a raw snowflake Channel ID, `<#id>`, or a full Discord channel URL
 * (`https://discord.com/channels/<guildId>/<channelId>`).
 */
function normalizeChannelId(raw) {
  const s = String(raw || '').trim();
  const urlMatch = /discord(?:app)?\.com\/channels\/\d+\/(\d+)/i.exec(s);
  if (urlMatch) return urlMatch[1];
  const mentionMatch = /^<#(\d+)>$/.exec(s);
  if (mentionMatch) return mentionMatch[1];
  return s;
}

async function discordFetch(url, options) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
  } catch (err) {
    throw new Error(`No se pudo conectar con Discord (discord.com): ${err?.message || 'Error de red'}`);
  }
}

function normalizeBridgeUrl(raw) {
  return String(raw || '').trim().replace(/\/+$/, '');
}

function hasDiscordTransport(dc = {}) {
  return Boolean(normalizeBridgeUrl(dc?.bridgeUrl) || String(dc?.botToken || '').trim());
}

function resolveTransportArgs(botTokenOrOpts) {
  if (botTokenOrOpts && typeof botTokenOrOpts === 'object') {
    return {
      bridgeUrl: normalizeBridgeUrl(botTokenOrOpts.bridgeUrl),
      botToken: String(botTokenOrOpts.botToken || '').trim()
    };
  }
  return {
    bridgeUrl: '',
    botToken: String(botTokenOrOpts || '').trim()
  };
}

/**
 * Fetch up to 100 recent messages from the configured Discord tournament channel
 * via either Cloudflare Bridge URL (zero token on client) or direct Bot Token.
 */
async function fetchChannelMessages(botTokenOrOpts, channelId, limit = 100) {
  const { bridgeUrl, botToken } = resolveTransportArgs(botTokenOrOpts);
  const chan = normalizeChannelId(channelId);
  if ((!bridgeUrl && !botToken) || !chan) {
    throw new Error('Falta configurar el puente Discord (bridgeUrl) o Bot Token y Channel ID.');
  }

  if (bridgeUrl) {
    const res = await discordFetch(
      `${bridgeUrl}/messages?channelId=${encodeURIComponent(chan)}&limit=${limit}`,
      { method: 'GET' }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error del puente Discord (HTTP ${res.status}).`);
    return Array.isArray(data) ? data : [];
  }

  const res = await discordFetch(`${DISCORD_API_BASE}/channels/${encodeURIComponent(chan)}/messages?limit=${limit}`, {
    method: 'GET',
    headers: discordHeaders(botToken)
  });

  if (res.status === 401) throw new Error('Bot Token de Discord inválido o revocado.');
  if (res.status === 403) throw new Error('El Bot no tiene permiso de "Ver canal" o "Leer historial de mensajes" en ese canal.');
  if (res.status === 404) throw new Error('Channel ID no encontrado. Verifica el ID del canal.');
  if (!res.ok) throw new Error(`Error de Discord API (HTTP ${res.status}).`);

  const messages = await res.json();
  return Array.isArray(messages) ? messages : [];
}

/**
 * Post a command or team registration message into the Discord tournament channel
 * via Cloudflare Bridge URL, Webhook URL, or direct Bot Token.
 */
async function sendChannelMessage({ bridgeUrl, botToken, channelId, webhookUrl, content }) {
  const text = String(content || '').trim();
  if (!text) throw new Error('Mensaje vacío.');

  const bridge = normalizeBridgeUrl(bridgeUrl);
  const chan = normalizeChannelId(channelId);
  if (bridge) {
    if (!chan) throw new Error('Falta Channel ID para enviar mediante el puente.');
    const res = await discordFetch(`${bridge}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: chan, content: text })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Error al enviar al puente Discord (HTTP ${res.status}).`);
    }
    return { sentVia: 'bridge' };
  }

  const hook = String(webhookUrl || '').trim();
  if (hook) {
    const res = await discordFetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, username: 'Torneo Blitz' })
    });
    if (!res.ok) {
      throw new Error(`Error al enviar al Webhook de Discord (HTTP ${res.status}).`);
    }
    return { sentVia: 'webhook' };
  }

  const token = String(botToken || '').trim();
  if (!token || !chan) {
    throw new Error('Falta configurar Bot Token y Channel ID (o puente URL) para enviar al chat.');
  }

  const res = await discordFetch(`${DISCORD_API_BASE}/channels/${encodeURIComponent(chan)}/messages`, {
    method: 'POST',
    headers: discordHeaders(token),
    body: JSON.stringify({ content: text })
  });

  if (res.status === 401) throw new Error('Bot Token de Discord inválido.');
  if (res.status === 403) throw new Error('El Bot no tiene permiso de "Enviar mensajes" en ese canal.');
  if (!res.ok) throw new Error(`Error al publicar en Discord (HTTP ${res.status}).`);

  return { sentVia: 'bot' };
}

/**
 * Fetch channel metadata + server owner ID (cached 5 min) for Admin-only enforcement.
 */
async function fetchChannelAdminContext(botTokenOrOpts, channelId) {
  const { bridgeUrl, botToken } = resolveTransportArgs(botTokenOrOpts);
  const chan = normalizeChannelId(channelId);
  if ((!bridgeUrl && !botToken) || !chan) return { channelName: '', guildId: '', guildName: '', ownerId: '' };

  const cached = channelMetaCache.get(chan);
  if (cached && Date.now() - cached.fetchedAt < META_CACHE_TTL_MS) {
    return cached.value;
  }

  if (bridgeUrl) {
    try {
      const res = await discordFetch(`${bridgeUrl}/context?channelId=${encodeURIComponent(chan)}`, { method: 'GET' });
      if (res.ok) {
        const value = await res.json();
        channelMetaCache.set(chan, { fetchedAt: Date.now(), value });
        return value;
      }
    } catch {
      // Non-fatal
    }
    return { channelName: chan, guildId: '', guildName: '', ownerId: '' };
  }

  const chRes = await discordFetch(`${DISCORD_API_BASE}/channels/${encodeURIComponent(chan)}`, {
    method: 'GET',
    headers: discordHeaders(botToken)
  });
  if (!chRes.ok) {
    return { channelName: '', guildId: '', guildName: '', ownerId: '' };
  }
  const chInfo = await chRes.json();
  const guildId = chInfo.guild_id || '';
  let guildName = '';
  let ownerId = '';

  if (guildId) {
    try {
      const gRes = await discordFetch(`${DISCORD_API_BASE}/guilds/${encodeURIComponent(guildId)}`, {
        method: 'GET',
        headers: discordHeaders(botToken)
      });
      if (gRes.ok) {
        const gInfo = await gRes.json();
        guildName = gInfo.name || '';
        ownerId = gInfo.owner_id ? String(gInfo.owner_id) : '';
      }
    } catch {
      // Non-fatal; adminIds can still be configured manually
    }
  }

  const value = {
    channelName: chInfo.name || chan,
    guildId,
    guildName,
    ownerId
  };
  channelMetaCache.set(chan, { fetchedAt: Date.now(), value });
  return value;
}

const guildChannelsCache = new Map();

/**
 * Find a text channel in the same guild by name (e.g. `road-to`) when roadToChannelId is left blank.
 */
async function findGuildChannelByName(botToken, guildId, targetName = 'road-to') {
  const token = String(botToken || '').trim();
  const gid = String(guildId || '').trim();
  if (!token || !gid) return '';

  const cacheKey = `${gid}:${targetName.toLowerCase()}`;
  const cached = guildChannelsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < META_CACHE_TTL_MS) {
    return cached.id;
  }

  try {
    const res = await discordFetch(`${DISCORD_API_BASE}/guilds/${encodeURIComponent(gid)}/channels`, {
      method: 'GET',
      headers: discordHeaders(token)
    });
    if (!res.ok) return '';
    const channels = await res.json();
    const normTarget = targetName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = Array.isArray(channels)
      ? channels.find((c) => {
          if (c.type !== 0 && c.type !== 5) return false;
          const normName = String(c.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          return normName === normTarget || normName.includes(normTarget);
        })
      : null;
    const id = match?.id ? String(match.id) : '';
    guildChannelsCache.set(cacheKey, { fetchedAt: Date.now(), id });
    return id;
  } catch {
    return '';
  }
}

/**
 * Verify Discord channel connectivity and Message Content Intent status.
 */
async function testDiscordConnection({ bridgeUrl, botToken, channelId }) {
  const bridge = normalizeBridgeUrl(bridgeUrl);
  const token = String(botToken || '').trim();
  const chan = normalizeChannelId(channelId);
  if (bridge && chan) {
    const meta = await fetchChannelAdminContext({ bridgeUrl: bridge }, chan);
    const msgs = await fetchChannelMessages({ bridgeUrl: bridge }, chan, 15);
    return {
      ok: true,
      channelName: meta.channelName || chan,
      guildId: meta.guildId || '',
      guildName: meta.guildName || '',
      ownerId: meta.ownerId || '',
      messageCount: msgs.length,
      intentWarning: false
    };
  }
  if (!token || !chan) {
    throw new Error('Ingresa tanto el Bot Token como el Channel ID.');
  }

  const chRes = await discordFetch(`${DISCORD_API_BASE}/channels/${encodeURIComponent(chan)}`, {
    method: 'GET',
    headers: discordHeaders(token)
  });

  if (chRes.status === 401) throw new Error('Bot Token inválido.');
  if (chRes.status === 403) throw new Error('Sin permisos en el canal.');
  if (chRes.status === 404) {
    try {
      const gRes = await discordFetch(`${DISCORD_API_BASE}/users/@me/guilds`, {
        method: 'GET',
        headers: discordHeaders(token)
      });
      if (gRes.ok) {
        const guilds = await gRes.json();
        const matchedGuild = Array.isArray(guilds) ? guilds.find((g) => g.id === chan) : null;
        if (matchedGuild) {
          throw new Error(
            `Ese ID pertenece al servidor "${matchedGuild.name}", no a un canal. Haz clic derecho sobre un canal de texto (#canal) y elige "Copiar ID del canal".`
          );
        }
      }
    } catch (inner) {
      if (inner.message && inner.message.includes('pertenece al servidor')) throw inner;
    }
    throw new Error('Channel ID no existe o el Bot no ha sido invitado a ese servidor.');
  }
  if (!chRes.ok) throw new Error(`Error Discord HTTP ${chRes.status}.`);

  const chInfo = await chRes.json();
  channelMetaCache.delete(chan);
  const meta = await fetchChannelAdminContext(token, chan);
  const msgs = await fetchChannelMessages(token, chan, 15);
  const nonBotWithText = msgs.some((m) => !m.author?.bot && String(m.content || '').trim().length > 0);
  const hasNonBotEmpty = msgs.some((m) => !m.author?.bot && !String(m.content || '').trim());

  return {
    ok: true,
    channelName: chInfo.name || chan,
    guildId: meta.guildId || chInfo.guild_id || '',
    guildName: meta.guildName || '',
    ownerId: meta.ownerId || '',
    messageCount: msgs.length,
    intentWarning: hasNonBotEmpty && !nonBotWithText
  };
}

module.exports = {
  normalizeChannelId,
  normalizeBridgeUrl,
  hasDiscordTransport,
  fetchChannelAdminContext,
  findGuildChannelByName,
  fetchChannelMessages,
  sendChannelMessage,
  testDiscordConnection
};
