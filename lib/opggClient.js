/**
 * Client for OP.GG's official MCP server (https://mcp-api.op.gg/mcp).
 * Handles JSON-RPC session management, retries, and parsing of both
 * raw JSON and OP.GG's compact class-constructor response format.
 */

const OPGG_MCP_URL = 'https://mcp-api.op.gg/mcp';

let cachedSessionId = null;
let initPromise = null;
let rpcCounter = 1;

/**
 * Initialize or reuse an MCP session with OP.GG.
 * @param {boolean} forceRefresh
 * @returns {Promise<string>}
 */
async function ensureSession(forceRefresh = false) {
  if (cachedSessionId && !forceRefresh) {
    return cachedSessionId;
  }
  if (initPromise && !forceRefresh) {
    return initPromise;
  }

  initPromise = (async () => {
    const res = await fetch(OPGG_MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: rpcCounter++,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'lol-ranked-advisor', version: '1.0.0' }
        }
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
      throw new Error(`OP.GG MCP initialize failed: HTTP ${res.status}`);
    }

    const sid = res.headers.get('mcp-session-id');
    if (!sid) {
      throw new Error('OP.GG MCP did not return mcp-session-id header');
    }

    // Complete MCP handshake notification (best effort)
    try {
      await fetch(OPGG_MCP_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sid
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        signal: AbortSignal.timeout(8000)
      });
    } catch {
      // Non-fatal if notification fails
    }

    cachedSessionId = sid;
    return sid;
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

/**
 * Parse OP.GG's compact class-constructor text response into plain JS objects.
 * Format:
 *   class Root: field1,field2
 *   class Child: a,b
 *
 *   Root(Child(1,"x"),[...])
 * @param {string} rawText
 */
function parseOpggResponseText(rawText) {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  // Fast path: raw JSON (used by lol_get_lane_matchup_guide)
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }

  const lines = trimmed.split(/\r?\n/);
  const schemas = new Map();
  let bodyStartIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      bodyStartIdx = i + 1;
      break;
    }
    const match = /^class\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (match) {
      const fields = match[2]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      schemas.set(match[1], fields);
      bodyStartIdx = i + 1;
    } else {
      bodyStartIdx = i;
      break;
    }
  }

  const expr = lines.slice(bodyStartIdx).join('\n').trim();
  if (!expr) return null;

  let pos = 0;
  const len = expr.length;

  function skipWs() {
    while (pos < len && /\s/.test(expr[pos])) pos++;
  }

  function parseString() {
    pos++; // skip opening "
    let out = '';
    while (pos < len) {
      const ch = expr[pos];
      if (ch === '\\') {
        pos++;
        const next = expr[pos];
        if (next === 'n') out += '\n';
        else if (next === 'r') out += '\r';
        else if (next === 't') out += '\t';
        else if (next !== undefined) out += next;
        pos++;
      } else if (ch === '"') {
        pos++;
        return out;
      } else {
        out += ch;
        pos++;
      }
    }
    throw new Error('Unterminated string in OP.GG response');
  }

  function parseArray() {
    pos++; // skip [
    const arr = [];
    skipWs();
    if (expr[pos] === ']') {
      pos++;
      return arr;
    }
    while (pos < len) {
      arr.push(parseValue());
      skipWs();
      if (expr[pos] === ',') {
        pos++;
        skipWs();
      } else if (expr[pos] === ']') {
        pos++;
        return arr;
      } else {
        throw new Error(`Expected ',' or ']' at pos ${pos} near ${expr.slice(pos, pos + 20)}`);
      }
    }
    return arr;
  }

  function parseIdentifierOrLiteral() {
    const start = pos;
    while (pos < len && /[A-Za-z0-9_.\-+]/.test(expr[pos])) pos++;
    const token = expr.slice(start, pos);
    skipWs();

    // Constructor call ClassName(...)
    if (expr[pos] === '(') {
      pos++; // skip (
      const args = [];
      skipWs();
      if (expr[pos] !== ')') {
        while (pos < len) {
          args.push(parseValue());
          skipWs();
          if (expr[pos] === ',') {
            pos++;
            skipWs();
          } else if (expr[pos] === ')') {
            break;
          } else {
            throw new Error(`Expected ',' or ')' in ${token}(...) at pos ${pos}`);
          }
        }
      }
      if (expr[pos] === ')') pos++;

      const fields = schemas.get(token);
      if (!fields) {
        return { _type: token, _args: args };
      }
      const obj = {};
      for (let i = 0; i < fields.length; i++) {
        obj[fields[i]] = i < args.length ? args[i] : null;
      }
      return obj;
    }

    if (token === 'true' || token === 'True') return true;
    if (token === 'false' || token === 'False') return false;
    if (token === 'null' || token === 'None') return null;
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(token)) return Number(token);
    return token;
  }

  function parseValue() {
    skipWs();
    const ch = expr[pos];
    if (ch === '"') return parseString();
    if (ch === '[') return parseArray();
    return parseIdentifierOrLiteral();
  }

  return parseValue();
}

/**
 * Call an OP.GG MCP tool with automatic session recovery and retries.
 * @param {string} name
 * @param {Record<string, any>} args
 * @param {number} retries
 */
async function callTool(name, args, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const sid = await ensureSession(attempt > 0);
      const res = await fetch(OPGG_MCP_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-session-id': sid
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: rpcCounter++,
          method: 'tools/call',
          params: { name, arguments: args }
        }),
        signal: AbortSignal.timeout(20000)
      });

      if (res.status === 400 || res.status === 404) {
        cachedSessionId = null;
        throw new Error(`Session invalidated (HTTP ${res.status})`);
      }
      if (!res.ok) {
        throw new Error(`OP.GG MCP HTTP ${res.status}`);
      }

      const payload = await res.json();
      if (payload.error) {
        throw new Error(payload.error.message || JSON.stringify(payload.error));
      }

      const text = payload.result?.content?.[0]?.text;
      if (!text) {
        throw new Error(`Empty response from OP.GG tool ${name}`);
      }
      return parseOpggResponseText(text);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

/**
 * Convert a champion English display name into OP.GG's UPPER_SNAKE_CASE parameter format.
 * Verified across all 173 champions (e.g., "Nunu & Willump" -> "NUNU_&_WILLUMP", "Kai'Sa" -> "KAISA").
 * @param {string} englishName
 * @returns {string}
 */
function toOpggChampionParam(englishName) {
  const clean = String(englishName || '').trim();
  if (/^nunu\b/i.test(clean)) return 'NUNU';
  return clean
    .toUpperCase()
    .replace(/['.]/g, '')
    .replace(/\s*&\s*/g, '_&_')
    .replace(/\s+/g, '_');
}

/**
 * Fetch the full champion list (id, key, localized name).
 * @param {string} lang
 */
async function listChampions(lang = 'en_US') {
  const parsed = await callTool('lol_list_champions', {
    lang,
    desired_output_fields: ['data.champions[].{champion_id,key,name}']
  });
  const list = parsed?.data?.champions || [];
  // Filter out special event/mode variants (e.g., Jade_* id >= 10000)
  return list.filter((c) => c && Number(c.champion_id) > 0 && Number(c.champion_id) < 10000);
}

/**
 * Fetch lane meta tier list across all 5 lanes (top, mid, jungle, adc, support).
 * @param {string} lang
 */
async function listAllLaneMeta(lang = 'es_ES') {
  const parsed = await callTool('lol_list_lane_meta_champions', {
    position: 'all',
    lang,
    desired_output_fields: [
      'data.positions.top[].{champion,play,win,win_rate,pick_rate,role_rate,ban_rate,kda,tier,rank,rank_prev,rank_prev_patch}',
      'data.positions.jungle[].{champion,play,win,win_rate,pick_rate,role_rate,ban_rate,kda,tier,rank,rank_prev,rank_prev_patch}',
      'data.positions.mid[].{champion,play,win,win_rate,pick_rate,role_rate,ban_rate,kda,tier,rank,rank_prev,rank_prev_patch}',
      'data.positions.adc[].{champion,play,win,win_rate,pick_rate,role_rate,ban_rate,kda,tier,rank,rank_prev,rank_prev_patch}',
      'data.positions.support[].{champion,play,win,win_rate,pick_rate,role_rate,ban_rate,kda,tier,rank,rank_prev,rank_prev_patch}'
    ]
  });
  return parsed?.data?.positions || {};
}

/**
 * Fetch full lane matchup guide (returns raw JSON with all ~50+ counters,
 * matchup-specific runes, core items, boots, spells, skill order, 1v1 flags, and patch trends).
 * @param {string} myChampionSlug
 * @param {string} opponentChampionSlug
 * @param {'top'|'jungle'|'mid'|'adc'|'support'} position
 * @param {string} lang
 */
async function getLaneMatchupGuide(myChampionSlug, opponentChampionSlug, position, lang = 'es_ES') {
  return callTool('lol_get_lane_matchup_guide', {
    position,
    my_champion: myChampionSlug,
    opponent_champion: opponentChampionSlug || myChampionSlug,
    lang
  });
}

/**
 * Fetch top synergy partners for a champion in a given ally role.
 * @param {string} championSlug
 * @param {'top'|'jungle'|'mid'|'adc'|'support'} myPosition
 * @param {'top'|'jungle'|'mid'|'adc'|'support'} synergyPosition
 * @param {string} lang
 */
async function getChampionSynergies(championSlug, myPosition, synergyPosition, lang = 'es_ES') {
  const parsed = await callTool('lol_get_champion_synergies', {
    champion: championSlug,
    my_position: myPosition,
    synergy_position: synergyPosition,
    lang,
    desired_output_fields: [
      'champion',
      'data.synergies[].{champion_id,champion_name,play,score,synergy_champion_id,synergy_champion_name,synergy_position,win,win_rate}',
      'data.synergies[].synergy_tier_data.{rank,tier}'
    ]
  });
  return parsed?.data?.synergies || [];
}

/**
 * Fallback build & summary lookup using lol_get_champion_analysis when lol_get_lane_matchup_guide
 * does not support a specific champion slug (e.g., Nunu & Willump).
 */
async function getChampionAnalysisBuild(championSlug, position, lang = 'es_ES') {
  const parsed = await callTool('lol_get_champion_analysis', {
    game_mode: 'ranked',
    champion: championSlug,
    position,
    lang,
    desired_output_fields: [
      'data.summoner_spells.{ids[],ids_names[],pick_rate,play,win}',
      'data.starter_items.{ids[],ids_names[],pick_rate,play,win}',
      'data.boots.{ids[],ids_names[],pick_rate,play,win}',
      'data.core_items.{ids[],ids_names[],pick_rate,play,win}',
      'data.last_items[].{ids[],ids_names[],pick_rate,play,win}',
      'data.runes.{id,pick_rate,play,primary_page_id,primary_page_name,primary_rune_ids[],primary_rune_names[],secondary_page_id,secondary_page_name,secondary_rune_ids[],secondary_rune_names[],stat_mod_ids[],win}',
      'data.skill_masteries.{ids[],pick_rate,play,win}',
      'data.skill_masteries.builds[].{order[],pick_rate,play,win}',
      'data.skills.{order[],pick_rate,play,win}',
      'data.strong_counters[].{champion_id,champion_name,play,win}',
      'data.weak_counters[].{champion_id,champion_name,play,win}'
    ]
  });
  return parsed?.data || null;
}

const PLATFORM_TO_OPGG_REGION = {
  LA1: 'LAN',
  LAN: 'LAN',
  LA2: 'LAS',
  LAS: 'LAS',
  NA1: 'NA',
  NA: 'NA',
  EUW1: 'EUW',
  EUW: 'EUW',
  EUN1: 'EUNE',
  EUNE: 'EUNE',
  BR1: 'BR',
  BR: 'BR',
  KR: 'KR',
  JP1: 'JP',
  JP: 'JP',
  OC1: 'OCE',
  OCE: 'OCE',
  TR1: 'TR',
  TR: 'TR',
  RU: 'RU',
  TW2: 'TW',
  TW: 'TW',
  SG2: 'SG',
  SG: 'SG',
  VN2: 'VN',
  VN: 'VN',
  PH2: 'PH',
  PH: 'PH',
  TH2: 'TH',
  TH: 'TH',
  ME1: 'ME',
  ME: 'ME'
};

function normalizeOpggRegion(region) {
  const key = String(region || 'LAN').trim().toUpperCase();
  return PLATFORM_TO_OPGG_REGION[key] || key;
}

/**
 * Fetch summoner Solo/Duo rank, level, and season ranked champion stats from OP.GG.
 */
async function getSummonerProfile(gameName, tagLine, region) {
  const parsed = await callTool('lol_get_summoner_profile', {
    game_name: String(gameName || '').trim(),
    tag_line: String(tagLine || '').trim(),
    region: normalizeOpggRegion(region),
    lang: 'es_ES',
    desired_output_fields: [
      'data.summoner.{game_name,tagline,region,level,profile_image_url}',
      'data.summoner.league_stats[].{game_type,win,lose}',
      'data.summoner.league_stats[].tier_info.{tier,division,lp,tier_image_url}',
      'data.summoner.ranked_most_champions.my_champion_stats[].{champion_name,game_second,play,win,lose}',
      'data.summoner.ranked_most_champions.my_champion_stats[].basic.{kill,death,assist,kill_participation,damage_to_champion,cs,vision_score,op_score,lane_lead}',
      'data.summoner.ranked_most_champions.my_champion_stats[].extend.{lane_cs_10_minute,jungle_cs_10_minute,lane_advantage_7_minute}'
    ]
  });
  return parsed?.data?.summoner || null;
}

/**
 * Fetch recent match history for a summoner (up to 20 matches).
 */
async function listSummonerMatches(gameName, tagLine, region, limit = 20) {
  const parsed = await callTool('lol_list_summoner_matches', {
    game_name: String(gameName || '').trim(),
    tag_line: String(tagLine || '').trim(),
    region: normalizeOpggRegion(region),
    lang: 'es_ES',
    limit: Math.min(20, Math.max(5, Number(limit) || 20)),
    desired_output_fields: [
      'data.game_history[].{id,created_at,game_length_second,game_type}',
      'data.game_history[].teams[].{key}',
      'data.game_history[].teams[].game_stat.{champion_kill,is_win,dragon_kill,baron_kill,tower_kill}',
      'data.game_history[].participants[].{champion_id,champion_name,position,team_key}',
      'data.game_history[].participants[].summoner.{game_name,tagline}',
      'data.game_history[].participants[].stats.{kill,death,assist,champion_level,minion_kill,neutral_minion_kill,vision_wards_bought_in_game,ward_place,gold_earned,total_damage_dealt_to_champions,op_score,op_score_rank,result}'
    ]
  });
  return parsed?.data?.game_history || [];
}

/**
 * Fetch full 10-player match detail so we can compare the player's CS, level, gold, and damage
 * directly against their same-lane opponent.
 */
async function getSummonerGameDetail(region, gameId, createdAt, focusRiotId) {
  const parsed = await callTool('lol_get_summoner_game_detail', {
    region: normalizeOpggRegion(region),
    game_id: gameId,
    created_at: createdAt,
    focus_riot_id: focusRiotId,
    lang: 'es_ES',
    desired_output_fields: [
      'data.game_detail.{id,game_length_second,game_type}',
      'data.game_detail.teams[].{key}',
      'data.game_detail.teams[].game_stat.{champion_kill,is_win}',
      'data.game_detail.teams[].participants[].{champion_id,champion_name,is_target,position,team_key}',
      'data.game_detail.teams[].participants[].stats.{kill,death,assist,champion_level,minion_kill,neutral_minion_kill,vision_wards_bought_in_game,ward_place,gold_earned,total_damage_dealt_to_champions,op_score,op_score_rank,result}'
    ]
  });
  return parsed?.data?.game_detail || null;
}

/**
 * Fetch summoner profile including previous seasons, season peaks, and live Challenger/GM thresholds.
 */
async function getSummonerProfileWithHistory(gameName, tagLine, region) {
  const parsed = await callTool('lol_get_summoner_profile', {
    game_name: String(gameName || '').trim(),
    tag_line: String(tagLine || '').trim(),
    region: normalizeOpggRegion(region),
    lang: 'es_ES',
    desired_output_fields: [
      'data.summoner.{game_name,tagline,region,level,profile_image_url}',
      'data.summoner.previous_seasons[].{season_id,tier_info.{tier,division,lp}}',
      'data.summoner.previous_season_tiers[].{season_id,rank_entries[].{game_type,rank_info.{tier,division,lp},high_rank_info.{tier,division,lp}}}',
      'data.summoner.current_season_high_tiers[].{game_type,high_rank_info.{tier,division,lp}}',
      'data.summoner.league_stats[].{game_type,win,lose,tier_info.{tier,division,lp,tier_image_url},high_leagues[].{key,lp_threshold}}'
    ]
  });
  return parsed?.data?.summoner || null;
}

module.exports = {
  OPGG_MCP_URL,
  parseOpggResponseText,
  toOpggChampionParam,
  normalizeOpggRegion,
  listChampions,
  listAllLaneMeta,
  getLaneMatchupGuide,
  getChampionAnalysisBuild,
  getChampionSynergies,
  getSummonerProfile,
  getSummonerProfileWithHistory,
  listSummonerMatches,
  getSummonerGameDetail
};
