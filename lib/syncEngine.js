const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const opgg = require('./opggClient');
const ddragon = require('./ddragonClient');
const {
  DATA_ROOT,
  SEASONS_DIR,
  CACHE_DIR,
  CONFIG_FILE,
  TOURNAMENT_FILE,
  ROADTO_FILE
} = require('./dataPaths');

const LANES = ['top', 'jungle', 'mid', 'adc', 'support'];

const DEFAULT_CONFIG = {
  activeSeason: null,
  myPool: [],
  defaultRoles: ['mid'],
  lcuEnabled: true,
  lcuLockfilePath: '',
  autoFocusMyChampTab: true,
  riotAccount: null,
  overlayAutoInGame: true,
  overlayDemo: false,
  overlayLocked: true,
  overlayScale: 1.0,
  overlayOpacity: 0.68,
  overlayX: null,
  overlayY: null,
  discord: {
    enabled: true,
    bridgeUrl: 'https://lol-advisor.ngelx360.workers.dev',
    botToken: '',
    channelId: '1569830216757411911',
    roadToChannelId: '1569855142528950282',
    webhookUrl: '',
    adminOnly: true,
    adminIds: '382962894075199488'
  }
};

let activeSeasonMemory = null;
let activeSeasonMtimeMs = 0;
let syncInProgress = false;

function ensureDirs() {
  for (const dir of [DATA_ROOT, SEASONS_DIR, CACHE_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function loadConfig() {
  ensureDirs();
  let parsed = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
    } catch {
      parsed = {};
    }
  }
  const merged = {
    ...DEFAULT_CONFIG,
    ...parsed,
    discord: {
      ...DEFAULT_CONFIG.discord,
      ...(parsed.discord || {})
    }
  };
  if (!merged.discord.bridgeUrl && !merged.discord.botToken) {
    merged.discord.bridgeUrl = DEFAULT_CONFIG.discord.bridgeUrl;
  }
  if (!parsed.discord || (!parsed.discord.bridgeUrl && !parsed.discord.botToken)) {
    merged.discord.enabled = true;
  }
  if (!merged.discord.adminIds) {
    merged.discord.adminIds = DEFAULT_CONFIG.discord.adminIds;
  }
  return merged;
}

function saveConfig(patch) {
  const current = loadConfig();
  const next = { ...current, ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/**
 * Extract compact build, runes, spells, and skill mastery from OP.GG matchup guide payload.
 * @param {any} data
 */
function extractCompactBuild(data) {
  if (!data) return null;

  const toArr = (v) => (Array.isArray(v) ? v : v ? [v] : []);

  const pickBest = (val) => {
    const arr = toArr(val);
    if (!arr.length) return null;
    // OP.GG orders by popularity/performance; keep top 2 options
    return arr.slice(0, 2).map((x) => ({
      ids: x.ids || [],
      names: x.ids_names || [],
      play: x.play || 0,
      win: x.win || 0,
      pickRate: x.pick_rate || 0
    }));
  };

  const runes = toArr(data.runes)
    .slice(0, 2)
    .map((r) => ({
      id: r.id,
      primaryPageId: r.primary_page_id,
      primaryPageName: r.primary_page_name,
      primaryRuneIds: r.primary_rune_ids || [],
      primaryRuneNames: r.primary_rune_names || [],
      secondaryPageId: r.secondary_page_id,
      secondaryPageName: r.secondary_page_name,
      secondaryRuneIds: r.secondary_rune_ids || [],
      secondaryRuneNames: r.secondary_rune_names || [],
      statModIds: r.stat_mod_ids || [],
      play: r.play || 0,
      win: r.win || 0,
      pickRate: r.pick_rate || 0
    }));

  const smArr = toArr(data.skill_masteries);
  const skArr = toArr(data.skills);
  const skillMasteries = smArr.length
    ? {
        priority: smArr[0].ids || [],
        play: smArr[0].play || 0,
        win: smArr[0].win || 0,
        pickRate: smArr[0].pick_rate || 0,
        order: smArr[0].builds?.[0]?.order || skArr[0]?.order || []
      }
    : skArr.length
    ? {
        priority: [],
        play: skArr[0].play || 0,
        win: skArr[0].win || 0,
        pickRate: skArr[0].pick_rate || 0,
        order: skArr[0].order || []
      }
    : null;

  const gameLengths = Array.isArray(data.game_lengths)
    ? data.game_lengths.map((g) => ({
        length: g.game_length,
        rate: g.rate
      }))
    : [];

  return {
    summonerSpells: pickBest(data.summoner_spells) || [],
    starterItems: pickBest(data.starter_items) || [],
    boots: pickBest(data.boots) || [],
    coreItems: pickBest(data.core_items) || [],
    situationalItems: toArr(data.last_items)
      .slice(0, 6)
      .map((x) => ({
        ids: x.ids || [],
        names: x.ids_names || [],
        play: x.play || 0,
        win: x.win || 0,
        pickRate: x.pick_rate || 0
      })),
    runes,
    skillMastery: skillMasteries,
    gameLengths
  };
}

/**
 * Run promises with bounded concurrency.
 */
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIdx = 0;

  async function runner() {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runner());
  await Promise.all(workers);
  return results;
}

function listSavedSeasons() {
  ensureDirs();
  const files = fs.readdirSync(SEASONS_DIR).filter((f) => f.endsWith('.json'));
  const summaries = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SEASONS_DIR, file), 'utf8'));
      summaries.push({
        patch: data.patch,
        ddVersion: data.ddVersion,
        updatedAt: data.updatedAt,
        championsCount: Object.keys(data.champions || {}).length,
        laneEntriesCount: data.laneEntriesCount || 0,
        matchupsCount: data.matchupsCount || 0,
        patchHistory: data.patchHistory || []
      });
    } catch {
      // Ignore malformed file
    }
  }
  return summaries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function getActiveSeasonData() {
  const cfg = loadConfig();
  const saved = listSavedSeasons();
  const targetPatch = cfg.activeSeason && saved.some((s) => s.patch === cfg.activeSeason)
    ? cfg.activeSeason
    : saved[0]?.patch;

  if (!targetPatch) return null;
  const filePath = path.join(SEASONS_DIR, `${targetPatch}.json`);
  if (!fs.existsSync(filePath)) return null;

  const stat = fs.statSync(filePath);
  if (activeSeasonMemory && activeSeasonMemory.patch === targetPatch && activeSeasonMtimeMs === stat.mtimeMs) {
    return activeSeasonMemory;
  }

  activeSeasonMemory = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  activeSeasonMtimeMs = stat.mtimeMs;
  if (cfg.activeSeason !== targetPatch) {
    saveConfig({ activeSeason: targetPatch });
  }
  return activeSeasonMemory;
}

function switchActiveSeason(patch) {
  const safePatch = path.basename(String(patch || ''));
  const filePath = path.join(SEASONS_DIR, `${safePatch}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Season/Parche ${safePatch} no encontrado`);
  }
  activeSeasonMemory = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  activeSeasonMtimeMs = fs.statSync(filePath).mtimeMs;
  saveConfig({ activeSeason: safePatch });
  return activeSeasonMemory;
}

function isSyncRunning() {
  return syncInProgress;
}

/**
 * Full database update from OP.GG MCP + Riot Data Dragon.
 * Fetches champion metadata, all 5 lane meta tier lists, and full matchup matrices + builds/runes.
 * @param {{ onProgress?: (evt: any) => void }} options
 */
async function syncSeasonFromOpgg({ onProgress } = {}) {
  if (syncInProgress) {
    throw new Error('Ya hay una actualización de base de datos en curso.');
  }
  syncInProgress = true;
  ensureDirs();

  const emit = (stage, percent, message, extra = {}) => {
    if (onProgress) onProgress({ stage, percent, message, ...extra });
  };

  try {
    emit('ddragon', 5, 'Descargando recursos oficiales de Riot Data Dragon (iconos, runas, ítems)...');
    const ddAssets = await ddragon.loadDataDragonAssets(true);

    emit('champions', 12, 'Obteniendo lista oficial de campeones desde OP.GG...');
    const opggChamps = await opgg.listChampions('en_US');
    const opggByEnName = new Map();
    const opggById = new Map();

    for (const c of opggChamps) {
      const id = Number(c.champion_id);
      const slug = opgg.toOpggChampionParam(c.name);
      const dd = ddAssets.championsById[id];
      const record = {
        id,
        key: c.key,
        enName: c.name,
        name: dd?.name || c.name,
        opggSlug: slug,
        iconUrl: dd?.iconUrl || '',
        splashUrl: dd?.splashUrl || '',
        tags: dd?.tags || []
      };
      opggByEnName.set(c.name.toLowerCase(), record);
      opggById.set(id, record);
    }

    emit('meta', 20, 'Descargando Tier List y Win Rates de las 5 líneas en OP.GG...');
    const rawMeta = await opgg.listAllLaneMeta('en_US');

    const lanes = { top: {}, jungle: {}, mid: {}, adc: {}, support: {} };
    const tasks = [];

    for (const lane of LANES) {
      const entries = Array.isArray(rawMeta[lane]) ? rawMeta[lane] : [];
      for (const entry of entries) {
        const champName = String(entry.champion || '');
        const champ = opggByEnName.get(champName.toLowerCase());
        if (!champ) continue;

        const play = Number(entry.play) || 0;
        const win = Number(entry.win) || 0;
        const exactWr = play > 0 ? win / play : Number(entry.win_rate) || 0;

        lanes[lane][champ.id] = {
          championId: champ.id,
          play,
          win,
          winRate: exactWr,
          pickRate: Number(entry.pick_rate) || 0,
          roleRate: Number(entry.role_rate) || 0,
          banRate: Number(entry.ban_rate) || 0,
          kda: Number(entry.kda) || 0,
          tier: Number(entry.tier) || 5,
          rank: Number(entry.rank) || 999,
          rankPrev: entry.rank_prev ?? null,
          rankPrevPatch: entry.rank_prev_patch ?? null,
          counters: {},
          build: null,
          trendWin: []
        };

        tasks.push({ lane, champ });
      }
    }

    emit('matchups', 25, `Descargando matriz de counters, builds y runas (${tasks.length} campeones/líneas)...`, {
      completed: 0,
      total: tasks.length
    });

    let detectedPatch = null;
    let patchHistory = [];
    let completed = 0;
    let matchupsCount = 0;

    await mapWithConcurrency(tasks, 8, async ({ lane, champ }) => {
      try {
        const [guideRes, analysisRes] = await Promise.allSettled([
          opgg.getLaneMatchupGuide(champ.opggSlug, champ.opggSlug, lane, 'es_ES'),
          opgg.getChampionAnalysisBuild(champ.opggSlug, lane, 'es_ES')
        ]);

        const target = lanes[lane][champ.id];
        const data = guideRes.status === 'fulfilled' ? guideRes.value?.data : null;
        const analysis = analysisRes.status === 'fulfilled' ? analysisRes.value : null;

        if (data) {
          // Capture OP.GG exact patch version & patch history
          if (Array.isArray(data.trends?.win) && data.trends.win.length) {
            if (!detectedPatch) {
              detectedPatch = String(data.trends.win[0].version || '');
              patchHistory = data.trends.win.map((w) => w.version).filter(Boolean);
            }
            target.trendWin = data.trends.win.slice(0, 6).map((w) => ({
              version: w.version,
              rate: w.rate,
              rank: w.rank
            }));
          }

          const posStats = data.summary?.positions?.find(
            (p) => String(p.name || '').toLowerCase() === lane
          )?.stats;
          if (posStats && posStats.win_rate) {
            target.winRate = Number(posStats.win_rate);
          }

          if (Array.isArray(data.counters)) {
            for (const c of data.counters) {
              const oppId = Number(c.champion_id);
              const cPlay = Number(c.play) || 0;
              const cWin = Number(c.win) || 0;
              if (oppId && cPlay > 0) {
                target.counters[oppId] = { play: cPlay, win: cWin };
                matchupsCount++;
              }
            }
          }
        } else if (analysis) {
          for (const c of [...(analysis.strong_counters || []), ...(analysis.weak_counters || [])]) {
            const oppId = Number(c.champion_id);
            const cPlay = Number(c.play) || 0;
            const cWin = Number(c.win) || 0;
            if (oppId && cPlay > 0 && !target.counters[oppId]) {
              target.counters[oppId] = { play: cPlay, win: cWin };
              matchupsCount++;
            }
          }
        }

        const analysisBuild = extractCompactBuild(analysis);
        const guideBuild = extractCompactBuild(data);
        if (analysisBuild) {
          analysisBuild.gameLengths = guideBuild?.gameLengths || [];
          target.build = analysisBuild;
        } else {
          target.build = guideBuild;
        }
      } catch (err) {
        console.warn(`Sync warning for ${champ.opggSlug} (${lane}):`, err.message);
      } finally {
        completed++;
        if (completed % 10 === 0 || completed === tasks.length) {
          const pct = 25 + Math.round((completed / Math.max(1, tasks.length)) * 70);
          emit('matchups', pct, `Sincronizando counters y builds: ${completed}/${tasks.length}...`, {
            completed,
            total: tasks.length
          });
        }
      }
    });

    const patchLabel = detectedPatch || ddAssets.version.split('.').slice(0, 2).join('.');
    const championsMap = {};
    for (const [id, rec] of opggById.entries()) {
      championsMap[id] = rec;
    }

    const seasonPayload = {
      patch: patchLabel,
      ddVersion: ddAssets.version,
      source: 'OP.GG Official MCP + Riot Data Dragon',
      updatedAt: new Date().toISOString(),
      laneEntriesCount: tasks.length,
      matchupsCount,
      patchHistory,
      champions: championsMap,
      lanes
    };

    const outPath = path.join(SEASONS_DIR, `${patchLabel}.json`);
    fs.writeFileSync(outPath, JSON.stringify(seasonPayload), 'utf8');
    activeSeasonMemory = seasonPayload;
    saveConfig({ activeSeason: patchLabel });

    emit('done', 100, `Base de datos actualizada correctamente (Parche ${patchLabel} • ${matchupsCount} matchups).`, {
      patch: patchLabel,
      matchupsCount,
      laneEntriesCount: tasks.length
    });

    return seasonPayload;
  } finally {
    syncInProgress = false;
  }
}

function getCacheFile(patch, key) {
  const dir = path.join(CACHE_DIR, String(patch || 'latest'));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${key}.json`);
}

/**
 * Fetch & cache exact head-to-head matchup guide from OP.GG (includes 1v1 solo kill advantage,
 * lane advantage, opponent tips, and matchup-specific runes & build).
 */
async function getMatchupDetailCached(seasonData, myChampId, oppChampId, position) {
  const patch = seasonData.patch;
  const myChamp = seasonData.champions[myChampId];
  const oppChamp = seasonData.champions[oppChampId];
  if (!myChamp || !oppChamp) return null;

  const cacheFile = getCacheFile(patch, `matchup_${position}_${myChampId}_${oppChampId}`);
  if (fs.existsSync(cacheFile)) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
      // Refetch if invalid
    }
  }

  let d = null;
  try {
    const res = await opgg.getLaneMatchupGuide(myChamp.opggSlug, oppChamp.opggSlug, position, 'es_ES');
    d = res?.data || null;
  } catch {
    d = await opgg.getChampionAnalysisBuild(myChamp.opggSlug, position, 'es_ES');
  }
  if (!d) return null;

  const counterRow = Array.isArray(d.counters)
    ? d.counters.find((c) => Number(c.champion_id) === Number(oppChampId))
    : null;

  const myEnLower = myChamp.enName.toLowerCase();
  const oppEnLower = oppChamp.enName.toLowerCase();
  const soloKillAdvRaw = String(d.lane_solo_kill_advantage_champion || '');
  const laneAdvRaw = String(d.lane_advantage_champion || '');

  const parseAdv = (val) => {
    const low = val.toLowerCase();
    if (!low || low === 'even') return 'even';
    if (low === myEnLower) return 'me';
    if (low === oppEnLower) return 'enemy';
    return 'even';
  };

  const detail = {
    myChampId: Number(myChampId),
    oppChampId: Number(oppChampId),
    position,
    soloKillAdvantage: parseAdv(soloKillAdvRaw),
    soloKillAdvantageName: soloKillAdvRaw || 'EVEN',
    laneAdvantage: parseAdv(laneAdvRaw),
    laneAdvantageName: laneAdvRaw || 'EVEN',
    tip: d.opponent_champion_tip || '',
    play: counterRow?.play || 0,
    win: counterRow?.win || 0,
    winRate: counterRow?.play > 0 ? counterRow.win / counterRow.play : null,
    build: extractCompactBuild(d),
    cachedAt: new Date().toISOString()
  };

  fs.writeFileSync(cacheFile, JSON.stringify(detail), 'utf8');
  return detail;
}

/**
 * Fetch & cache OP.GG synergies for a locked ally champion paired with myRole.
 */
async function getAllySynergiesCached(seasonData, allyChampId, allyRole, myRole) {
  const patch = seasonData.patch;
  const ally = seasonData.champions[allyChampId];
  if (!ally || !allyRole || !myRole || allyRole === myRole) return [];

  const cacheFile = getCacheFile(patch, `syn_${allyRole}_${myRole}_${allyChampId}`);
  if (fs.existsSync(cacheFile)) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
      // Refetch if invalid
    }
  }

  const list = await opgg.getChampionSynergies(ally.opggSlug, allyRole, myRole, 'es_ES');
  const normalized = (list || []).map((s) => {
    const play = Number(s.play) || 0;
    const win = Number(s.win) || 0;
    return {
      allyId: Number(allyChampId),
      allyRole,
      partnerId: Number(s.synergy_champion_id),
      partnerName: s.synergy_champion_name,
      play,
      win,
      winRate: play > 0 ? win / play : Number(s.win_rate) || 0,
      tier: s.synergy_tier_data?.tier ?? 3,
      rank: s.synergy_tier_data?.rank ?? 99
    };
  });

  fs.writeFileSync(cacheFile, JSON.stringify(normalized), 'utf8');
  return normalized;
}

/**
 * Enrich top candidate picks with live 1v1 matchup guide flags (soloKillAdvantage, laneAdvantage)
 * using bounded concurrency and persistent disk cache.
 */
async function enrich1v1Matchups(seasonData, candidateIds, oppChampId, position) {
  const results = {};
  await mapWithConcurrency(candidateIds, 8, async (candId) => {
    try {
      const detail = await getMatchupDetailCached(seasonData, candId, oppChampId, position);
      if (detail) {
        results[candId] = detail;
      }
    } catch {
      // Ignore individual lookup errors
    }
  });
  return results;
}

/**
 * Ensure full global optimal build & runes are present for (championId, position),
 * fetching & caching lol_get_champion_analysis if the stored season entry lacks runes/items.
 */
async function getOrFetchChampionBuild(seasonData, championId, position) {
  if (!seasonData || !championId) return null;
  const champ = seasonData.champions?.[championId];
  if (!champ) return null;

  const laneEntry = seasonData.lanes?.[position]?.[championId];
  if (laneEntry?.build?.runes?.length && laneEntry?.build?.coreItems?.length) {
    return laneEntry.build;
  }

  const cacheFile = getCacheFile(seasonData.patch, `analysis_${position}_${championId}`);
  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached?.runes?.length) {
        if (laneEntry) {
          cached.gameLengths = laneEntry.build?.gameLengths || cached.gameLengths || [];
          laneEntry.build = cached;
        }
        return cached;
      }
    } catch {
      // Refetch if invalid
    }
  }

  const analysis = await opgg.getChampionAnalysisBuild(champ.opggSlug, position, 'es_ES');
  const build = extractCompactBuild(analysis);
  if (build) {
    build.gameLengths = laneEntry?.build?.gameLengths || [];
    if (laneEntry) laneEntry.build = build;
    fs.writeFileSync(cacheFile, JSON.stringify(build), 'utf8');
  }
  return build;
}

function loadLocalTournament() {
  ensureDirs();
  if (!fs.existsSync(TOURNAMENT_FILE)) {
    return { active: false, size: 8, openedAt: null, openedBy: '', teams: [], results: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(TOURNAMENT_FILE, 'utf8'));
  } catch {
    return { active: false, size: 8, openedAt: null, openedBy: '', teams: [], results: [] };
  }
}

function saveLocalTournament(data) {
  ensureDirs();
  fs.writeFileSync(TOURNAMENT_FILE, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

function loadLocalRoadTo() {
  ensureDirs();
  if (!fs.existsSync(ROADTO_FILE)) {
    return { active: false, title: '', openedAt: null, openedBy: '', participants: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(ROADTO_FILE, 'utf8'));
  } catch {
    return { active: false, title: '', openedAt: null, openedBy: '', participants: [] };
  }
}

function saveLocalRoadTo(data) {
  ensureDirs();
  fs.writeFileSync(ROADTO_FILE, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

const ANNOUNCEMENT_FILE = path.join(DATA_ROOT, 'announcement.json');

function loadLocalAnnouncement() {
  ensureDirs();
  if (!fs.existsSync(ANNOUNCEMENT_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(ANNOUNCEMENT_FILE, 'utf8'));
    return raw && raw.text ? raw : null;
  } catch {
    return null;
  }
}

function saveLocalAnnouncement(data) {
  ensureDirs();
  if (!data || !data.text) {
    if (fs.existsSync(ANNOUNCEMENT_FILE)) fs.unlinkSync(ANNOUNCEMENT_FILE);
    return null;
  }
  fs.writeFileSync(ANNOUNCEMENT_FILE, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

function getClientOwnerKey() {
  const cfg = loadConfig();
  if (cfg.clientOwnerKey && typeof cfg.clientOwnerKey === 'string') {
    return cfg.clientOwnerKey;
  }
  const generated = crypto.randomBytes(6).toString('hex');
  saveConfig({ clientOwnerKey: generated });
  return generated;
}

module.exports = {
  LANES,
  loadConfig,
  saveConfig,
  getClientOwnerKey,
  loadLocalTournament,
  saveLocalTournament,
  loadLocalRoadTo,
  saveLocalRoadTo,
  loadLocalAnnouncement,
  saveLocalAnnouncement,
  listSavedSeasons,
  getActiveSeasonData,
  switchActiveSeason,
  isSyncRunning,
  syncSeasonFromOpgg,
  getOrFetchChampionBuild,
  getMatchupDetailCached,
  getAllySynergiesCached,
  enrich1v1Matchups
};
