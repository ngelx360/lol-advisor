const fs = require('fs');
const path = require('path');
const https = require('https');
const ddragon = require('./ddragonClient');
const syncEngine = require('./syncEngine');
const lcuWatcher = require('./lcuWatcher');
const { ICON_CACHE_DIR } = require('./dataPaths');

const LANE_CS_TARGETS = {
  top: 7.0,
  mid: 7.2,
  adc: 7.5,
  jungle: 6.0,
  support: 1.2
};

// Empirical Summoner's Rift XP curve milestones: [gameMinutes, expectedLevel]
const XP_CURVES = {
  solo: [
    [0, 1], [1.7, 2], [2.7, 3], [3.7, 4], [4.8, 5], [5.9, 6],
    [7.2, 7], [8.6, 8], [10.0, 9], [11.5, 10], [13.2, 11], [15.0, 12],
    [17.0, 13], [19.2, 14], [21.5, 15], [24.0, 16], [26.8, 17], [30.0, 18]
  ],
  jungle: [
    [0, 1], [2.0, 2], [3.0, 3], [4.0, 4], [5.2, 5], [6.5, 6],
    [8.0, 7], [9.5, 8], [11.0, 9], [12.7, 10], [14.5, 11], [16.5, 12],
    [18.8, 13], [21.2, 14], [23.8, 15], [26.5, 16], [29.5, 17], [33.0, 18]
  ],
  duo: [
    [0, 1], [1.9, 2], [3.2, 3], [4.5, 4], [5.8, 5], [7.2, 6],
    [8.8, 7], [10.4, 8], [12.2, 9], [14.0, 10], [16.0, 11], [18.2, 12],
    [20.5, 13], [23.0, 14], [25.8, 15], [28.5, 16], [31.5, 17], [35.0, 18]
  ]
};

const HEALERS_SET = new Set([
  'Aatrox', 'Soraka', 'Yuumi', 'Sylas', 'Vladimir', 'Swain', 'Briar',
  'Warwick', 'DrMundo', 'Fiora', 'Irelia', 'Illaoi', 'Mundo', 'Zac', 'RedKayn', 'Kayn', 'Sona', 'Nami', 'Milio'
]);

const AP_HEAVY_TAGS = new Set(['Mage']);
const TANK_TAGS = new Set(['Tank']);

const IGNORE_GOLD_EVENTS = new Set([
  'ChampionKill',
  'TurretKilled',
  'InhibKilled',
  'DragonKill',
  'HeraldKill',
  'BaronKill',
  'FirstBlood'
]);

function createCsTracker() {
  return {
    gameKey: '',
    lastGameTime: 0,
    lastGold: 0,
    lastBaseCs: 0,
    lastItemsSig: '',
    lastEventCount: 0,
    intraCs: 0
  };
}

const liveCsTracker = createCsTracker();

/**
 * Riot's Live Client Data API rounds scores.creepScore to multiples of 10.
 * Between 10-CS checkpoints, detect real-time minion/monster kills from activePlayer.currentGold
 * (subtracting passive 2.04g/s and ignoring shop/kill/objective ticks) and snap to Riot's
 * exact score at every multiple of 10 so drift never accumulates.
 */
function trackExactCs(tracker, { gameKey, gameTimeSec, baseCs, currentGold, itemsSig, events }) {
  const safeBase = Math.max(0, Number(baseCs) || 0);
  const safeGold = Number(currentGold) || 0;
  const evList = Array.isArray(events) ? events : [];

  if (tracker.gameKey !== gameKey || gameTimeSec < tracker.lastGameTime - 5) {
    tracker.gameKey = gameKey;
    tracker.lastGameTime = gameTimeSec;
    tracker.lastGold = safeGold;
    tracker.lastBaseCs = safeBase;
    tracker.lastItemsSig = itemsSig || '';
    tracker.lastEventCount = evList.length;
    tracker.intraCs = 0;
    return safeBase;
  }

  if (safeBase !== tracker.lastBaseCs) {
    tracker.lastBaseCs = safeBase;
    tracker.intraCs = 0;
    tracker.lastGameTime = gameTimeSec;
    tracker.lastGold = safeGold;
    tracker.lastItemsSig = itemsSig || '';
    tracker.lastEventCount = evList.length;
    return safeBase;
  }

  const dt = Math.max(0, gameTimeSec - tracker.lastGameTime);
  const newEvents = evList.slice(tracker.lastEventCount);
  const hasObjectiveOrKill = newEvents.some((ev) => IGNORE_GOLD_EVENTS.has(ev?.EventName));
  const shopChanged = (itemsSig || '') !== tracker.lastItemsSig || safeGold < tracker.lastGold - 1;

  if (!shopChanged && !hasObjectiveOrKill && dt > 0 && gameTimeSec >= 90) {
    const passiveGold = gameTimeSec >= 110 ? 2.04 * dt : 0;
    const earned = safeGold - tracker.lastGold - passiveGold;
    if (earned >= 8 && earned <= 115) {
      const gained = earned < 27 ? 1 : earned < 48 ? 2 : 3;
      tracker.intraCs = Math.min(9, tracker.intraCs + gained);
    }
  }

  tracker.lastGameTime = gameTimeSec;
  tracker.lastGold = safeGold;
  tracker.lastItemsSig = itemsSig || '';
  tracker.lastEventCount = evList.length;
  return safeBase + tracker.intraCs;
}

function ensureIconCacheDir() {
  if (!fs.existsSync(ICON_CACHE_DIR)) {
    fs.mkdirSync(ICON_CACHE_DIR, { recursive: true });
  }
}

/**
 * Fetch live game JSON from Riot's official Live Client Data API (127.0.0.1:2999).
 */
function fetchLiveGameData() {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port: 2999,
        path: '/liveclientdata/allgamedata',
        method: 'GET',
        rejectUnauthorized: false,
        timeout: 900
      },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`Live API HTTP ${res.statusCode}`));
          }
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Live API timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

function interpolateExpectedLevel(minutes, role) {
  const curve =
    role === 'jungle'
      ? XP_CURVES.jungle
      : role === 'adc' || role === 'support'
      ? XP_CURVES.duo
      : XP_CURVES.solo;

  if (minutes <= curve[0][0]) return 1;
  for (let i = 1; i < curve.length; i++) {
    const [t1, l1] = curve[i];
    const [t0, l0] = curve[i - 1];
    if (minutes <= t1) {
      const ratio = (minutes - t0) / Math.max(0.01, t1 - t0);
      return Number((l0 + ratio * (l1 - l0)).toFixed(1));
    }
  }
  return 18;
}

function normKey(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveChampionFromLivePlayer(player, seasonData) {
  if (!player || !seasonData?.champions) return null;
  const rawKey = normKey(
    String(player.rawChampionName || '').replace(/^Game_Character_Displayname_/i, '')
  );
  const displayKey = normKey(player.championName || '');

  for (const c of Object.values(seasonData.champions)) {
    const ck = normKey(c.key);
    const ek = normKey(c.enName);
    const nk = normKey(c.name);
    if (rawKey && (ck === rawKey || ek === rawKey || nk === rawKey)) {
      return c;
    }
  }
  for (const c of Object.values(seasonData.champions)) {
    const ck = normKey(c.key);
    const ek = normKey(c.enName);
    const nk = normKey(c.name);
    if (displayKey && (nk === displayKey || ek === displayKey || ck === displayKey)) {
      return c;
    }
  }
  return null;
}

function findPrimaryLaneForChampion(champId, seasonData) {
  if (!champId || !seasonData?.lanes) return null;
  let bestLane = null;
  let bestPlay = -1;
  for (const lane of syncEngine.LANES) {
    const entry = seasonData.lanes[lane]?.[champId];
    if (entry && entry.build && (entry.play || 0) > bestPlay) {
      bestPlay = entry.play || 0;
      bestLane = lane;
    }
  }
  return bestLane;
}

function buildEnemyCounterNote(enemiesChamps, oppChamp, matchupTip) {
  const notes = [];
  const enemyKeys = enemiesChamps.map((c) => c?.key || '');
  const healers = enemyKeys.filter((k) => HEALERS_SET.has(k));
  const mages = enemiesChamps.filter((c) => c?.tags?.includes('Mage')).length;
  const tanks = enemiesChamps.filter((c) => c?.tags?.includes('Tank')).length;
  const assassins = enemiesChamps.filter((c) => c?.tags?.includes('Assassin')).length;

  if (healers.length >= 2) {
    notes.push('Mucho heal enemigo: prioriza Cortacuras (Orbe del olvido / Verdugo / Zarzas)');
  }
  if (mages >= 3) {
    notes.push('Composición muy AP: considera Resistencia Mágica temprana');
  } else if (assassins >= 2) {
    notes.push('Varios asesinos: prioriza Zhonya / Armadura / Ángel Guardián');
  }
  if (tanks >= 2) {
    notes.push('2+ Tanques rivales: prioriza % Penetración / Liandry / Dominik');
  }

  if (notes.length) return notes[0];
  if (matchupTip) return matchupTip;
  if (oppChamp) return `Build optimizada OP.GG contra ${oppChamp.name}`;
  return 'Sigue el orden de compra recomendado del parche';
}

function formatBuyOrder(build, ddAssets, ownedIdsSet, currentGold) {
  if (!build) return { steps: [], nextItem: null };
  const steps = [];
  const seenIds = new Set();

  const addItem = (id, stageLabel) => {
    const numId = Number(id);
    if (!numId || seenIds.has(numId)) return;
    // Skip consumable potions from main sequence if starter is already added
    if (numId === 2003 && steps.length > 0) return;
    seenIds.add(numId);
    const meta = ddAssets?.itemsById?.[String(numId)];
    const price = meta?.gold || 0;
    const owned = ownedIdsSet.has(numId);
    steps.push({
      id: numId,
      stage: stageLabel,
      name: meta?.name || `Objeto ${numId}`,
      price,
      iconUrl: meta?.iconUrl || '',
      owned
    });
  };

  // 1. Starter
  const starter = build.starterItems?.[0]?.ids?.[0];
  if (starter) addItem(starter, 'Ini');

  // 2. Boots
  const boots = build.boots?.[0]?.ids?.[0];
  if (boots) addItem(boots, 'Bota');

  // 3. Core 3 items in order
  const coreIds = build.coreItems?.[0]?.ids || [];
  coreIds.slice(0, 3).forEach((id, idx) => addItem(id, `${idx + 1}º`));

  // 4. First non-duplicate situational 4th/5th item
  for (const sit of build.situationalItems || []) {
    const sid = sit?.ids?.[0];
    if (sid && !seenIds.has(Number(sid))) {
      addItem(sid, `${Math.max(4, steps.length - 1)}º`);
      if (steps.length >= 6) break;
    }
  }

  // Next unowned non-starter item (or first unowned)
  const nextItem =
    steps.find((s) => !s.owned && s.stage !== 'Ini') ||
    steps.find((s) => !s.owned) ||
    null;

  if (nextItem) {
    nextItem.goldNeeded = Math.max(0, (nextItem.price || 0) - Math.floor(currentGold || 0));
  }

  return { steps: steps.slice(0, 6), nextItem };
}

/**
 * Compute live in-game overlay telemetry (CS/min target, XP/Level target, ordered buy path).
 * Supports demo=true when user wants to preview the overlay outside of an active match.
 */
async function getLiveOverlayState({ demo = false } = {}) {
  const seasonData = syncEngine.getActiveSeasonData();
  const ddAssets = await ddragon.loadDataDragonAssets(false);

  if (demo) {
    const myChamp = seasonData?.champions?.[103] || Object.values(seasonData?.champions || {})[0];
    const oppChamp = seasonData?.champions?.[238] || Object.values(seasonData?.champions || {})[1];
    let matchupDetail = null;
    if (myChamp && oppChamp) {
      try {
        matchupDetail = await syncEngine.getMatchupDetailCached(seasonData, myChamp.id, oppChamp.id, 'mid');
      } catch {
        matchupDetail = null;
      }
    }
    const build = matchupDetail?.build || seasonData?.lanes?.mid?.[myChamp?.id]?.build;
    const ownedIds = new Set([1056, 3020, 3118]);
    const { steps, nextItem } = formatBuyOrder(build, ddAssets, ownedIds, 1180);
    return {
      inGame: true,
      isDemo: true,
      gameTimeSec: 845,
      gameTimeLabel: '14:05',
      role: 'mid',
      myChampion: myChamp ? { id: myChamp.id, name: myChamp.name } : { id: 103, name: 'Ahri' },
      opponentChampion: oppChamp ? { id: oppChamp.id, name: oppChamp.name } : { id: 238, name: 'Zed' },
      cs: {
        current: 96,
        perMin: 6.8,
        targetPerMin: 7.2,
        targetTotal: 91,
        diff: 5,
        status: 'ahead'
      },
      xp: {
        currentLevel: 10,
        expectedLevel: 11.4,
        expectedLevelRounded: 11,
        opponentLevel: 10,
        levelDiffVsOpp: 0,
        status: 'warn'
      },
      currentGold: 1180,
      buyOrder: steps,
      nextItem,
      counterNote: buildEnemyCounterNote([oppChamp], oppChamp, matchupDetail?.tip || '')
    };
  }

  let live;
  try {
    live = await fetchLiveGameData();
  } catch {
    return {
      inGame: false,
      isDemo: false,
      statusMessage: 'Esperando partida activa de League of Legends...'
    };
  }

  const gameTimeSec = Math.max(0, Math.floor(Number(live?.gameData?.gameTime) || 0));
  const mins = Math.floor(gameTimeSec / 60);
  const secs = gameTimeSec % 60;
  const gameTimeLabel = `${mins}:${String(secs).padStart(2, '0')}`;
  const minutesFloat = Math.max(0.1, gameTimeSec / 60);

  const ap = live?.activePlayer || {};
  const allPlayers = Array.isArray(live?.allPlayers) ? live.allPlayers : [];

  const myPlayer =
    allPlayers.find(
      (p) =>
        (ap.riotId && p.riotId && p.riotId.toLowerCase() === ap.riotId.toLowerCase()) ||
        (ap.riotIdGameName && p.riotIdGameName && p.riotIdGameName.toLowerCase() === ap.riotIdGameName.toLowerCase()) ||
        (ap.summonerName && (p.summonerName === ap.summonerName || p.riotId === ap.summonerName))
    ) || allPlayers[0];

  if (!myPlayer) {
    return { inGame: false, isDemo: false, statusMessage: 'Partida detectada sin datos de jugador' };
  }

  const myChamp = resolveChampionFromLivePlayer(myPlayer, seasonData);
  const explicitPos = lcuWatcher.normalizeLcuPosition(myPlayer.position);
  const myRole = explicitPos || (myChamp ? findPrimaryLaneForChampion(myChamp.id, seasonData) : null) || 'mid';
  const enemyPlayers = allPlayers.filter((p) => p.team && p.team !== myPlayer.team);

  // Direct lane opponent by position, or fallback via OP.GG roleRate
  let oppPlayer = enemyPlayers.find(
    (p) => lcuWatcher.normalizeLcuPosition(p.position) === myRole
  );
  const enemiesChamps = enemyPlayers
    .map((p) => ({ player: p, champ: resolveChampionFromLivePlayer(p, seasonData) }))
    .filter((x) => x.champ);

  if (!oppPlayer && enemiesChamps.length && seasonData) {
    const inferred = lcuWatcher.inferEnemyRoles(
      enemiesChamps.map((x) => x.champ.id),
      seasonData
    );
    const match = inferred.find((e) => e.inferredRole === myRole);
    if (match) {
      oppPlayer = enemiesChamps.find((x) => x.champ.id === match.championId)?.player || null;
    }
  }

  const oppChamp = oppPlayer ? resolveChampionFromLivePlayer(oppPlayer, seasonData) : null;

  // Exact CS calculation: Riot reports scores.creepScore in multiples of 10,
  // so track individual last-hits via currentGold between 10-CS checkpoints
  const rawBaseCs = Number(myPlayer.scores?.creepScore) || 0;
  const currentGold = Number(ap.currentGold) || 0;
  const itemsSig = (myPlayer.items || []).map((it) => `${it.itemID}:${it.count || 1}`).join(',');
  const gameKey = `${myPlayer.riotId || myPlayer.summonerName || ''}|${myChamp?.id || myPlayer.championName || ''}`;
  const currentCs = trackExactCs(liveCsTracker, {
    gameKey,
    gameTimeSec,
    baseCs: rawBaseCs,
    currentGold,
    itemsSig,
    events: live?.events?.Events || []
  });
  const csPerMin = minutesFloat >= 1.5 ? Number((currentCs / minutesFloat).toFixed(1)) : 0;
  const targetPerMin = LANE_CS_TARGETS[myRole] ?? 7.0;
  const effectiveFarmMins = Math.max(0, minutesFloat - 1.5);
  const targetTotal = Math.round(effectiveFarmMins * targetPerMin);
  const csDiff = currentCs - targetTotal;
  const csRatio = targetTotal > 0 ? currentCs / targetTotal : 1;
  const csStatus =
    minutesFloat < 2.0 ? 'ahead' : csRatio >= 0.92 ? 'ahead' : csRatio >= 0.76 ? 'warn' : 'behind';

  // XP / Level calculation
  const currentLevel = Number(ap.level || myPlayer.level) || 1;
  const expectedLevel = interpolateExpectedLevel(minutesFloat, myRole);
  const expectedLevelRounded = Math.max(1, Math.min(18, Math.round(expectedLevel)));
  const oppLevel = oppPlayer ? Number(oppPlayer.level) || null : null;
  const levelDiffVsOpp = oppLevel !== null ? currentLevel - oppLevel : null;
  const xpDelta = currentLevel - expectedLevel;
  const xpStatus =
    xpDelta >= -0.4 && (levelDiffVsOpp === null || levelDiffVsOpp >= 0)
      ? 'ahead'
      : xpDelta >= -1.1
      ? 'warn'
      : 'behind';

  // Build lookup: matchup-specific -> current role -> champion's main role -> live OP.GG fallback
  let matchupDetail = null;
  if (myChamp && oppChamp && seasonData) {
    try {
      matchupDetail = await syncEngine.getMatchupDetailCached(
        seasonData,
        myChamp.id,
        oppChamp.id,
        myRole
      );
    } catch {
      matchupDetail = null;
    }
  }

  const fallbackLane = myChamp ? findPrimaryLaneForChampion(myChamp.id, seasonData) : null;
  let build =
    (matchupDetail?.build?.coreItems?.length ? matchupDetail.build : null) ||
    (seasonData?.lanes?.[myRole]?.[myChamp?.id]?.build?.coreItems?.length
      ? seasonData.lanes[myRole][myChamp.id].build
      : null) ||
    (fallbackLane && seasonData?.lanes?.[fallbackLane]?.[myChamp?.id]?.build?.coreItems?.length
      ? seasonData.lanes[fallbackLane][myChamp.id].build
      : null) ||
    null;

  if (!build && myChamp && seasonData) {
    try {
      build = await syncEngine.getOrFetchChampionBuild(
        seasonData,
        myChamp.id,
        fallbackLane || myRole
      );
    } catch {
      build = null;
    }
  }

  const ownedIdsSet = new Set(
    (myPlayer.items || []).map((it) => Number(it.itemID)).filter((id) => id > 0)
  );
  const { steps, nextItem } = formatBuyOrder(build, ddAssets, ownedIdsSet, currentGold);

  return {
    inGame: true,
    isDemo: false,
    gameTimeSec,
    gameTimeLabel,
    role: myRole,
    myChampion: myChamp
      ? { id: myChamp.id, name: myChamp.name }
      : { id: 0, name: myPlayer.championName || 'Campeón' },
    opponentChampion: oppChamp
      ? { id: oppChamp.id, name: oppChamp.name }
      : oppPlayer
      ? { id: 0, name: oppPlayer.championName }
      : null,
    cs: {
      current: currentCs,
      perMin: csPerMin,
      targetPerMin,
      targetTotal,
      diff: csDiff,
      status: csStatus
    },
    xp: {
      currentLevel,
      expectedLevel,
      expectedLevelRounded,
      opponentLevel: oppLevel,
      levelDiffVsOpp,
      status: xpStatus
    },
    currentGold: Math.floor(currentGold),
    buyOrder: steps,
    nextItem,
    counterNote: buildEnemyCounterNote(
      enemiesChamps.map((x) => x.champ),
      oppChamp,
      matchupDetail?.tip || ''
    )
  };
}

/**
 * Download/cache Data Dragon PNG item icon locally so the native WinForms overlay
 * can load crisp item icons directly without browser overhead.
 */
async function getCachedItemIconBuffer(itemId) {
  ensureIconCacheDir();
  const safeId = Number(itemId);
  if (!safeId) return null;
  const filePath = path.join(ICON_CACHE_DIR, `${safeId}.png`);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath);
  }
  const ddAssets = await ddragon.loadDataDragonAssets(false);
  const url = ddAssets?.itemsById?.[String(safeId)]?.iconUrl;
  if (!url) return null;

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filePath, buf);
  return buf;
}

/**
 * Fast check whether a League of Legends match is currently active (Live Client Data API on port 2999).
 */
function isLiveGameActive() {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port: 2999,
        path: '/liveclientdata/gamestats',
        method: 'GET',
        rejectUnauthorized: false,
        timeout: 650
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

module.exports = {
  isLiveGameActive,
  createCsTracker,
  trackExactCs,
  interpolateExpectedLevel,
  resolveChampionFromLivePlayer,
  findPrimaryLaneForChampion,
  formatBuyOrder,
  getLiveOverlayState,
  getCachedItemIconBuffer
};
