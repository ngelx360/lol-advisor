/**
 * Cloudflare Worker — Puente seguro entre LoL Ranked Advisor y Discord.
 *
 * VARIABLES DE ENTORNO / SECRETS EN CLOUDFLARE:
 *   - DISCORD_BOT_TOKEN  (Secret: el token privado de tu Bot de Discord)
 *   - TORNEO_CHANNEL_ID  (Variable/Secret: por defecto "1569830216757411911")
 *   - ROADTO_CHANNEL_ID  (Variable/Secret: por defecto "1569855142528950282")
 */

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const DEFAULT_TORNEO_CHANNEL = '1569830216757411911';
const DEFAULT_ROADTO_CHANNEL = '1569855142528950282';

const memoryActive = new Map();
const memoryDau = new Map();

function cleanMemoryActive(now) {
  for (const [k, t] of memoryActive.entries()) {
    if (now - t > 600000) memoryActive.delete(k); // 10 min TTL
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS
    }
  });
}

function getAllowedChannels(env) {
  const torneoId = String(env?.TORNEO_CHANNEL_ID || DEFAULT_TORNEO_CHANNEL).trim();
  const roadToId = String(env?.ROADTO_CHANNEL_ID || DEFAULT_ROADTO_CHANNEL).trim();
  return new Set([torneoId, roadToId].filter(Boolean));
}

function sanitizeOutgoingCommand(content, channelId, env) {
  const clean = String(content || '')
    .replace(/@everyone/gi, '@ everyone')
    .replace(/@here/gi, '@ here')
    .trim();

  if (!clean || clean.length > 1800) {
    return { ok: false, error: 'Comando vacío o demasiado largo.' };
  }
  if (!clean.startsWith('!')) {
    return { ok: false, error: 'Solo se permiten comandos que empiecen con !' };
  }

  // Bloquear SIEMPRE comandos exclusivos de Admin desde clientes externos
  if (/^!(?:TORNEO|ROAD\s*TO|GANADOR|WIN|AVISO|ANUNCIO|INICIAR|PAUSA|PAUSAR|REANUDAR)(?:\b|\s|$)/i.test(clean)) {
    return { ok: false, error: 'Los comandos de Admin solo pueden enviarse directamente desde Discord.' };
  }

  const roadToId = String(env?.ROADTO_CHANNEL_ID || DEFAULT_ROADTO_CHANNEL).trim();
  if (channelId === roadToId) {
    if (!/^!(?:RTREG|RTSALTO|RTBAJA)\s+/i.test(clean)) {
      return { ok: false, error: 'Comando no permitido en #road-to.' };
    }
  }

  return { ok: true, content: clean };
}

async function discordRequest(path, env, init = {}) {
  const token = String(env?.DISCORD_BOT_TOKEN || '').trim();
  if (!token) {
    throw new Error('Falta configurar el Secret DISCORD_BOT_TOKEN en Cloudflare.');
  }
  return fetch(`${DISCORD_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'LoLRankedAdvisor-Bridge (1.0)',
      ...(init.headers || {})
    }
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const allowed = getAllowedChannels(env);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return jsonResponse({
        ok: true,
        service: 'lol-advisor-discord-bridge',
        botConfigured: Boolean(String(env?.DISCORD_BOT_TOKEN || '').trim()),
        channelsCount: allowed.size
      });
    }

    // Telemetry: Heartbeat Ping
    if (request.method === 'POST' && (url.pathname === '/api/telemetry/ping' || url.pathname === '/ping')) {
      const body = await request.json().catch(() => ({}));
      const clientId = String(body.clientId || '').slice(0, 64);
      const version = String(body.version || 'unknown').slice(0, 16);
      const region = String(body.region || 'LAN').slice(0, 8).toUpperCase();
      const now = Date.now();

      cleanMemoryActive(now);
      if (clientId) {
        memoryActive.set(clientId, now);
        const dayStr = new Date(now).toISOString().slice(0, 10);
        memoryDau.set(`${dayStr}:${clientId}`, now);
      }

      let onlineCount = Math.max(1, memoryActive.size);

      if (env?.TELEMETRY_KV && clientId) {
        try {
          const key = `active:${clientId}`;
          await env.TELEMETRY_KV.put(key, JSON.stringify({ version, region, t: now }), { expirationTtl: 600 });
          const today = new Date(now).toISOString().slice(0, 10);
          const dayKey = `dau:${today}:${clientId}`;
          await env.TELEMETRY_KV.put(dayKey, '1', { expirationTtl: 172800 });

          const activeList = await env.TELEMETRY_KV.list({ prefix: 'active:', limit: 1000 });
          if (activeList?.keys?.length) {
            onlineCount = Math.max(1, activeList.keys.length);
          }
        } catch {
          // fallback to memory count
        }
      }

      return jsonResponse({
        ok: true,
        onlineNow: onlineCount,
        serverTime: now
      });
    }

    // Telemetry: Statistics Query
    if (request.method === 'GET' && (url.pathname === '/api/telemetry/stats' || url.pathname === '/telemetry/stats')) {
      const now = Date.now();
      cleanMemoryActive(now);
      let onlineNow = Math.max(1, memoryActive.size);
      let todayDau = Math.max(onlineNow, memoryDau.size);

      if (env?.TELEMETRY_KV) {
        try {
          const activeList = await env.TELEMETRY_KV.list({ prefix: 'active:', limit: 1000 });
          if (activeList?.keys?.length) onlineNow = Math.max(1, activeList.keys.length);

          const today = new Date().toISOString().slice(0, 10);
          const dayList = await env.TELEMETRY_KV.list({ prefix: `dau:${today}:`, limit: 1000 });
          if (dayList?.keys?.length) todayDau = Math.max(onlineNow, dayList.keys.length);
        } catch {}
      }

      return jsonResponse({
        ok: true,
        onlineNow,
        todayDau,
        kvConfigured: Boolean(env?.TELEMETRY_KV)
      });
    }

    try {
      if (request.method === 'GET' && url.pathname === '/messages') {
        const channelId = String(url.searchParams.get('channelId') || '').trim();
        if (!allowed.has(channelId)) {
          return jsonResponse({ error: 'Canal no autorizado en este puente.' }, 403);
        }
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 100)));
        const res = await discordRequest(`/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}`, env);
        if (!res.ok) {
          return jsonResponse({ error: `Discord API HTTP ${res.status}` }, res.status);
        }
        const raw = await res.json();
        const compact = Array.isArray(raw)
          ? raw.map((m) => ({
              id: m.id,
              timestamp: m.timestamp,
              content: m.content || '',
              author: {
                id: m.author?.id || '',
                username: m.author?.username || '',
                global_name: m.author?.global_name || '',
                bot: Boolean(m.author?.bot)
              }
            }))
          : [];
        return jsonResponse(compact);
      }

      if (request.method === 'GET' && url.pathname === '/context') {
        const channelId = String(url.searchParams.get('channelId') || '').trim();
        if (!allowed.has(channelId)) {
          return jsonResponse({ error: 'Canal no autorizado en este puente.' }, 403);
        }
        const chRes = await discordRequest(`/channels/${encodeURIComponent(channelId)}`, env);
        if (!chRes.ok) {
          return jsonResponse({ error: `Discord API HTTP ${chRes.status}` }, chRes.status);
        }
        const ch = await chRes.json();
        let guildName = '';
        let ownerId = '';
        if (ch.guild_id) {
          const gRes = await discordRequest(`/guilds/${encodeURIComponent(ch.guild_id)}`, env);
          if (gRes.ok) {
            const g = await gRes.json();
            guildName = g.name || '';
            ownerId = g.owner_id ? String(g.owner_id) : '';
          }
        }
        return jsonResponse({
          channelName: ch.name || channelId,
          guildId: ch.guild_id || '',
          guildName,
          ownerId
        });
      }

      if (request.method === 'POST' && url.pathname === '/send') {
        const body = await request.json().catch(() => ({}));
        const channelId = String(body.channelId || '').trim();
        if (!allowed.has(channelId)) {
          return jsonResponse({ error: 'Canal no autorizado en este puente.' }, 403);
        }
        const check = sanitizeOutgoingCommand(body.content, channelId, env);
        if (!check.ok) {
          return jsonResponse({ error: check.error }, 403);
        }
        const res = await discordRequest(`/channels/${encodeURIComponent(channelId)}/messages`, env, {
          method: 'POST',
          body: JSON.stringify({ content: check.content })
        });
        if (!res.ok) {
          return jsonResponse({ error: `Discord API HTTP ${res.status}` }, res.status);
        }
        return jsonResponse({ ok: true, sentVia: 'bridge' });
      }

      return jsonResponse({ error: 'Ruta no encontrada.' }, 404);
    } catch (err) {
      return jsonResponse({ error: err?.message || 'Error interno en el puente.' }, 500);
    }
  }
};
