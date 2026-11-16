const fs = require('fs');
const https = require('https');

const DEFAULT_LOCKFILE_PATHS = [
  'C:\\Riot Games\\League of Legends\\lockfile',
  'D:\\Riot Games\\League of Legends\\lockfile',
  'E:\\Riot Games\\League of Legends\\lockfile'
];

const LANES = ['top', 'jungle', 'mid', 'adc', 'support'];

/**
 * Normalize Riot LCU position string into our internal lane key.
 * @param {string} pos
 * @returns {'top'|'jungle'|'mid'|'adc'|'support'|null}
 */
function normalizeLcuPosition(pos) {
  const p = String(pos || '').trim().toLowerCase();
  if (p === 'top') return 'top';
  if (p === 'jungle') return 'jungle';
  if (p === 'middle' || p === 'mid') return 'mid';
  if (p === 'bottom' || p === 'adc' || p === 'bot') return 'adc';
  if (p === 'utility' || p === 'support' || p === 'sup') return 'support';
  return null;
}

/**
 * Infer likely lane roles for enemy champions using OP.GG's roleRate & pickRate.
 * Uses optimal 1-to-1 assignment across the 5 Summoner's Rift positions so
 * blind-pick / unpicked lanes remain null instead of misassigning junglers/supports to Mid.
 * @param {number[]} enemyChampIds
 * @param {any} seasonData
 * @returns {Array<{ championId: number, inferredRole: string|null, confidence: number }>}
 */
function inferEnemyRoles(enemyChampIds, seasonData) {
  const ids = (enemyChampIds || []).filter((id) => Number(id) > 0).map(Number);
  if (!ids.length) return [];
  if (!seasonData?.lanes) {
    return ids.map((id) => ({ championId: id, inferredRole: null, confidence: 0 }));
  }

  // Score each (enemyIdx, lane) pair based on OP.GG roleRate & pickRate
  const scoreMatrix = ids.map((id) => {
    const scores = {};
    for (const lane of LANES) {
      const entry = seasonData.lanes[lane]?.[id];
      if (!entry) {
        scores[lane] = 0;
      } else {
        // Weight roleRate heavily, tiebreak by pickRate
        scores[lane] = (entry.roleRate || 0.2) * 100 + (entry.pickRate || 0) * 10;
      }
    }
    return scores;
  });

  // Backtracking search over up to 5 enemies x 5 lanes (max 120 permutations -> instant)
  let bestScore = -1;
  let bestAssign = new Array(ids.length).fill(null);

  function search(idx, usedLanes, currentAssign, currentScore) {
    if (idx === ids.length) {
      if (currentScore > bestScore) {
        bestScore = currentScore;
        bestAssign = [...currentAssign];
      }
      return;
    }

    let triedAny = false;
    for (const lane of LANES) {
      if (usedLanes.has(lane)) continue;
      const s = scoreMatrix[idx][lane];
      if (s <= 0) continue;
      triedAny = true;
      usedLanes.add(lane);
      currentAssign[idx] = lane;
      search(idx + 1, usedLanes, currentAssign, currentScore + s);
      usedLanes.delete(lane);
    }

    // Also allow unassigned if champion has no meta data in remaining lanes
    if (!triedAny) {
      currentAssign[idx] = null;
      search(idx + 1, usedLanes, currentAssign, currentScore);
    }
  }

  search(0, new Set(), new Array(ids.length).fill(null), 0);

  return ids.map((id, idx) => {
    const lane = bestAssign[idx];
    const roleRate = lane ? seasonData.lanes[lane]?.[id]?.roleRate || 0 : 0;
    return {
      championId: id,
      inferredRole: lane,
      confidence: Number(roleRate.toFixed(2))
    };
  });
}

function findLockfilePath(customPath) {
  const candidates = [];
  if (customPath && String(customPath).trim()) {
    candidates.push(String(customPath).trim());
  }
  candidates.push(...DEFAULT_LOCKFILE_PATHS);

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return p;
      }
    } catch {
      // Ignore permission or path errors
    }
  }
  return null;
}

function parseLockfile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  const parts = raw.split(':');
  if (parts.length < 5) return null;
  return {
    processName: parts[0],
    pid: Number(parts[1]),
    port: Number(parts[2]),
    password: parts[3],
    protocol: parts[4] || 'https'
  };
}

function lcuRequest(lock, method, endpoint, bodyObj = null) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`riot:${lock.password}`).toString('base64');
    const payload = bodyObj !== null ? JSON.stringify(bodyObj) : null;
    const headers = {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json'
    };
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(
      {
        hostname: '127.0.0.1',
        port: lock.port,
        path: endpoint,
        method,
        rejectUnauthorized: false,
        headers,
        timeout: 2200
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          if (body && body.trim()) {
            try {
              parsed = JSON.parse(body);
            } catch {
              parsed = body;
            }
          }
          resolve({ status: res.statusCode, data: parsed });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('LCU request timeout'));
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function lcuGet(lock, endpoint) {
  return lcuRequest(lock, 'GET', endpoint);
}

const LCU_TIER_ES = {
  IRON: 'Hierro',
  BRONZE: 'Bronce',
  SILVER: 'Plata',
  GOLD: 'Oro',
  PLATINUM: 'Platino',
  EMERALD: 'Esmeralda',
  DIAMOND: 'Diamante',
  MASTER: 'Master',
  GRANDMASTER: 'Grandmaster',
  CHALLENGER: 'Challenger'
};

function formatLcuSoloRank(soloQueue) {
  if (!soloQueue || !soloQueue.tier || String(soloQueue.tier).toUpperCase() === 'NONE') {
    return { tier: 'UNRANKED', division: '', lp: 0, wins: 0, losses: 0, label: 'Sin rango' };
  }
  const tier = String(soloQueue.tier).toUpperCase();
  const esTier = LCU_TIER_ES[tier] || tier;
  const division = String(soloQueue.division || '').toUpperCase();
  const lp = Number(soloQueue.leaguePoints || 0);
  const wins = Number(soloQueue.wins || 0);
  const losses = Number(soloQueue.losses || 0);
  const isApex = tier === 'MASTER' || tier === 'GRANDMASTER' || tier === 'CHALLENGER';
  const label = isApex
    ? `${esTier} · ${lp} LP`
    : `${esTier} ${division && division !== 'NA' ? division : ''} · ${lp} LP`.replace(/\s+/g, ' ').trim();
  return { tier, division, lp, wins, losses, label };
}

let cachedLcuSummoner = null;
let cachedLcuLockKey = '';
let cachedRankedAt = 0;

async function readCurrentSummoner(lock) {
  const key = `${lock.pid}:${lock.port}`;
  const now = Date.now();
  if (cachedLcuSummoner && cachedLcuLockKey === key && now - cachedRankedAt < 20000) {
    return cachedLcuSummoner;
  }
  try {
    const [sumRes, regRes, platRes, rankRes] = await Promise.all([
      cachedLcuSummoner && cachedLcuLockKey === key
        ? Promise.resolve({ status: 200, data: cachedLcuSummoner })
        : lcuGet(lock, '/lol-summoner/v1/current-summoner'),
      cachedLcuSummoner && cachedLcuLockKey === key
        ? Promise.resolve({ status: 200, data: { region: cachedLcuSummoner.region } })
        : lcuGet(lock, '/riotclient/region-locale').catch(() => ({ status: 0, data: null })),
      cachedLcuSummoner && cachedLcuLockKey === key
        ? Promise.resolve({ status: 200, data: cachedLcuSummoner.region })
        : lcuGet(lock, '/lol-platform-config/v1/namespaces/LoginDataPacket/platformId').catch(() => ({ status: 0, data: null })),
      lcuGet(lock, '/lol-ranked/v1/current-ranked-stats').catch(() => ({ status: 0, data: null }))
    ]);
    const gameName = sumRes.data?.gameName || sumRes.data?.displayName || '';
    const tagLine = sumRes.data?.tagLine || '';
    const rawRegion = regRes.data?.region || (typeof platRes.data === 'string' ? platRes.data : '');
    const soloQueue = rankRes.data?.queueMap?.RANKED_SOLO_5x5 || null;
    const soloRank = soloQueue ? formatLcuSoloRank(soloQueue) : (cachedLcuSummoner?.soloRank || formatLcuSoloRank(null));
    if (sumRes.status === 200 && gameName) {
      cachedLcuSummoner = {
        gameName,
        tagLine,
        region: rawRegion,
        profileIconId: Number(sumRes.data?.profileIconId || cachedLcuSummoner?.profileIconId || 29),
        summonerLevel: Number(sumRes.data?.summonerLevel || cachedLcuSummoner?.summonerLevel || 0),
        soloRank
      };
      cachedLcuLockKey = key;
      cachedRankedAt = now;
      return cachedLcuSummoner;
    }
  } catch {
    // Non-fatal
  }
  return cachedLcuSummoner || null;
}

/**
 * Poll the local League of Legends client (read-only) for active Champion Select state.
 * @param {{ enabled?: boolean, customLockfilePath?: string, seasonData?: any }} opts
 */
/**
 * Accurately determines if the current gameflow and/or champ select session is ARAM.
 * Explicitly excludes Summoner's Rift queues (Ranked Flex, Solo/Duo, Normal Draft, Blind, Clash)
 * and sessions where players have assigned lane positions.
 */
function detectAramFromLcu({ gameflow = null, session = null } = {}) {
  const gfQueueId = Number(gameflow?.gameData?.queue?.id || gameflow?.queue?.id || 0);
  const gfGameMode = String(gameflow?.gameData?.queue?.gameMode || gameflow?.gameData?.gameMode || '').toUpperCase();
  const gfMapId = Number(gameflow?.gameData?.map?.id || gameflow?.map?.id || 0);

  // Classic Summoner's Rift queues:
  // 400: Normal Draft, 420: Ranked Solo/Duo, 430: Normal Blind, 440: Ranked Flex, 490: Quickplay, 700/701: Clash, 830-850: Co-op vs AI
  const CLASSIC_SR_QUEUES = [400, 420, 430, 440, 490, 700, 701, 830, 840, 850];
  const isDefiniteClassicSr =
    CLASSIC_SR_QUEUES.includes(gfQueueId) ||
    gfGameMode === 'CLASSIC' ||
    gfMapId === 11;

  const isAramFromGf =
    !isDefiniteClassicSr &&
    (gfGameMode === 'ARAM' ||
      gfQueueId === 450 ||
      gfQueueId === 100 ||
      gfQueueId === 720 ||
      gfMapId === 12);

  if (!session) {
    return isAramFromGf;
  }

  const myTeam = Array.isArray(session.myTeam) ? session.myTeam : [];
  const hasAssignedLanes = myTeam.some((p) => {
    const pos = String(p?.assignedPosition || '').trim().toUpperCase();
    return ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'].includes(pos);
  });

  const isAramSession = Boolean(session.benchEnabled === true && !hasAssignedLanes);
  return Boolean(!isDefiniteClassicSr && !hasAssignedLanes && (isAramFromGf || isAramSession));
}

async function readLcuChampSelectState({ enabled = true, customLockfilePath = '', seasonData = null } = {}) {
  if (!enabled) {
    return {
      enabled: false,
      connected: false,
      inChampSelect: false,
      statusMessage: 'Detección LCU desactivada (Modo Manual)'
    };
  }

  const lockPath = findLockfilePath(customLockfilePath);
  if (!lockPath) {
    return {
      enabled: true,
      connected: false,
      inChampSelect: false,
      statusMessage: 'Esperando cliente de League of Legends...'
    };
  }

  let lock;
  try {
    lock = parseLockfile(lockPath);
  } catch {
    return {
      enabled: true,
      connected: false,
      inChampSelect: false,
      statusMessage: 'No se pudo leer lockfile de LoL'
    };
  }

  if (!lock || !lock.port || !lock.password) {
    return {
      enabled: true,
      connected: false,
      inChampSelect: false,
      statusMessage: 'Lockfile inválido'
    };
  }

  try {
    const [sessionRes, currentSummoner, gameflowRes] = await Promise.all([
      lcuGet(lock, '/lol-champ-select/v1/session'),
      readCurrentSummoner(lock),
      lcuGet(lock, '/lol-gameflow/v1/session').catch(() => ({ status: 0, data: null }))
    ]);

    const gf = gameflowRes?.data || null;
    const gfQueueId = Number(gf?.gameData?.queue?.id || gf?.queue?.id || 0);
    const gfGameMode = String(gf?.gameData?.queue?.gameMode || gf?.gameData?.gameMode || '').toUpperCase();
    const gfMapId = Number(gf?.gameData?.map?.id || gf?.map?.id || 0);
    const gfPhase = String(gf?.phase || '');

    const isAramFromGf = detectAramFromLcu({ gameflow: gf, session: null });

    if (sessionRes.status === 404 || !sessionRes.data) {
      return {
        enabled: true,
        connected: true,
        inChampSelect: false,
        lockfilePath: lockPath,
        currentSummoner,
        isAram: isAramFromGf,
        gameMode: isAramFromGf ? 'ARAM' : (gfGameMode || 'CLASSIC'),
        gameflowPhase: gfPhase || null,
        statusMessage: isAramFromGf
          ? 'Cliente LoL conectado • ARAM en curso o lobby ❄️'
          : 'Cliente LoL conectado • Fuera de Champ Select'
      };
    }

    if (sessionRes.status !== 200) {
      return {
        enabled: true,
        connected: true,
        inChampSelect: false,
        lockfilePath: lockPath,
        currentSummoner,
        isAram: isAramFromGf,
        gameMode: isAramFromGf ? 'ARAM' : (gfGameMode || 'CLASSIC'),
        gameflowPhase: gfPhase || null,
        statusMessage: `Cliente LoL conectado (HTTP ${sessionRes.status})`
      };
    }

    const s = sessionRes.data;
    const localCellId = s.localPlayerCellId;
    const myTeam = Array.isArray(s.myTeam) ? s.myTeam : [];
    const theirTeam = Array.isArray(s.theirTeam) ? s.theirTeam : [];

    const isAram = detectAramFromLcu({ gameflow: gf, session: s });

    // Also inspect completed/in-progress actions to distinguish locked vs hovered picks accurately
    const lockedByActorCell = new Set();
    for (const round of s.actions || []) {
      for (const act of round || []) {
        if (act.type === 'pick' && act.completed && act.championId > 0) {
          lockedByActorCell.add(act.actorCellId);
        }
      }
    }

    let me = myTeam.find((p) => p.cellId === localCellId) || null;
    const myRole = isAram ? 'ARAM' : normalizeLcuPosition(me?.assignedPosition);
    const myChampionId = me ? (me.championId > 0 ? me.championId : me.championPickIntent > 0 ? me.championPickIntent : null) : null;
    const myChampionLocked = Boolean(me && (me.championId > 0 || isAram));

    const allies = myTeam
      .filter((p) => p.cellId !== localCellId)
      .map((p) => {
        const cid = p.championId > 0 ? p.championId : p.championPickIntent > 0 ? p.championPickIntent : null;
        const tag = formatPlayerRiotTag(p);
        return cid
          ? {
              championId: cid,
              role: isAram ? 'ARAM' : normalizeLcuPosition(p.assignedPosition),
              locked: p.championId > 0,
              summonerName: tag || p.displayName || p.gameName || ''
            }
          : null;
      })
      .filter(Boolean);

    const rawEnemyIds = isAram
      ? []
      : theirTeam
          .map((p) => (p.championId > 0 ? p.championId : p.championPickIntent > 0 ? p.championPickIntent : 0))
          .filter((id) => id > 0);

    const inferredEnemies = isAram ? [] : inferEnemyRoles(rawEnemyIds, seasonData);
    const enemyLanerMatch = !isAram && myRole
      ? inferredEnemies.find((e) => e.inferredRole === myRole) || null
      : null;

    const bans = [];
    if (!isAram) {
      if (s.bans) {
        for (const b of [...(s.bans.myTeamBans || []), ...(s.bans.theirTeamBans || [])]) {
          if (b > 0) bans.push(b);
        }
      }
      for (const round of s.actions || []) {
        for (const act of round || []) {
          if (act.type === 'ban' && act.completed && act.championId > 0 && !bans.includes(act.championId)) {
            bans.push(act.championId);
          }
        }
      }
    }

    return {
      enabled: true,
      connected: true,
      inChampSelect: true,
      lockfilePath: lockPath,
      phase: s.timer?.phase || 'BAN_PICK',
      isAram,
      gameMode: isAram ? 'ARAM' : (gfGameMode || 'CLASSIC'),
      benchChampions: isAram && Array.isArray(s.benchChampions) ? s.benchChampions : [],
      myRole,
      myChampionId,
      myChampionLocked,
      allies,
      enemies: inferredEnemies,
      enemyLanerId: isAram ? null : (enemyLanerMatch ? enemyLanerMatch.championId : null),
      isFirstPickOrBlind: isAram ? false : Boolean(myRole && !enemyLanerMatch),
      bans,
      currentSummoner,
      statusMessage: isAram
        ? 'Cliente LoL conectado • Selección ARAM (Abismo de los Lamentos) ❄️'
        : 'En Champ Select (Sincronizado en vivo)'
    };
  } catch {
    return {
      enabled: true,
      connected: false,
      inChampSelect: false,
      statusMessage: 'Cliente LoL cerrado o reiniciando'
    };
  }
}

/**
 * Import a rune page directly into the open League of Legends client via LCU (/lol-perks/v1/pages).
 */
async function importRunesToLcu({
  customLockfilePath = '',
  pageName = 'LoL Advisor',
  primaryStyleId,
  subStyleId,
  selectedPerkIds
}) {
  const lockPath = findLockfilePath(customLockfilePath);
  if (!lockPath) {
    throw new Error('Cliente de League of Legends no detectado. Ábrelo para poder pegar runas.');
  }
  const lock = parseLockfile(lockPath);
  if (!lock || !lock.port || !lock.password) {
    throw new Error('No se pudo leer la sesión del cliente de LoL.');
  }

  const pId = Number(primaryStyleId);
  const sId = Number(subStyleId);
  const perks = (selectedPerkIds || []).map(Number).filter((x) => x > 0);
  const defaultShards = [5008, 5008, 5001];
  while (perks.length >= 6 && perks.length < 9) {
    perks.push(defaultShards[perks.length - 6]);
  }
  if (!pId || !sId || perks.length < 9) {
    throw new Error('La página de runas está incompleta.');
  }

  const pagesRes = await lcuGet(lock, '/lol-perks/v1/pages');
  if (pagesRes.status !== 200 || !Array.isArray(pagesRes.data)) {
    throw new Error('El cliente de LoL no devolvió las páginas de runas.');
  }

  const editablePages = pagesRes.data.filter((p) => p && p.isEditable);
  const targetPage =
    editablePages.find((p) => String(p.name || '').startsWith('LoL Advisor')) ||
    editablePages.find((p) => p.current) ||
    editablePages[0] ||
    null;

  const newPagePayload = {
    name: String(pageName || 'LoL Advisor').slice(0, 24),
    primaryStyleId: pId,
    subStyleId: sId,
    selectedPerkIds: perks.slice(0, 9),
    current: true
  };

  if (targetPage) {
    // Delete and recreate (cleanest way to force active selection inside Champ Select)
    const delRes = await lcuRequest(lock, 'DELETE', `/lol-perks/v1/pages/${targetPage.id}`);
    if (delRes.status >= 200 && delRes.status < 300) {
      const postRes = await lcuRequest(lock, 'POST', '/lol-perks/v1/pages', newPagePayload);
      if (postRes.status >= 200 && postRes.status < 300) {
        return { ok: true, pageName: newPagePayload.name, pageId: postRes.data?.id };
      }
    }

    // Fallback: PUT directly onto targetPage
    const putRes = await lcuRequest(lock, 'PUT', `/lol-perks/v1/pages/${targetPage.id}`, {
      ...targetPage,
      ...newPagePayload
    });
    if (putRes.status >= 200 && putRes.status < 300) {
      await lcuRequest(lock, 'PUT', '/lol-perks/v1/currentpage', targetPage.id);
      return { ok: true, pageName: newPagePayload.name, pageId: targetPage.id };
    }
    throw new Error(`No se pudo actualizar la página de runas (HTTP ${putRes.status}).`);
  }

  // No editable pages found, try creating a new page if user has spare slot
  const createRes = await lcuRequest(lock, 'POST', '/lol-perks/v1/pages', newPagePayload);
  if (createRes.status >= 200 && createRes.status < 300) {
    return { ok: true, pageName: newPagePayload.name, pageId: createRes.data?.id };
  }
  throw new Error('No tienes páginas de runas editables libres en LoL (borra o desbloquea una).');
}

const puuidTagCache = new Map();
const customGameDetailCache = new Map();

function formatPlayerRiotTag(p) {
  if (!p) return '';
  const gn = String(p.gameName || p.riotIdGameName || '').trim();
  const tl = String(p.tagLine || p.riotIdTagLine || '').trim();
  if (gn && tl) return `${gn}#${tl}`;
  if (p.riotId && String(p.riotId).trim()) return String(p.riotId).trim();
  if (gn) return gn;
  const sn = String(p.summonerName || p.displayName || p.summonerInternalName || '').trim();
  return sn;
}

async function resolveLobbyEntryTag(lock, entry) {
  if (!entry || entry.isBot) return '';
  const direct = formatPlayerRiotTag(entry);
  if (direct && direct.includes('#')) return direct;

  const cacheKey = entry.puuid || (entry.summonerId > 0 ? String(entry.summonerId) : '');
  if (cacheKey && puuidTagCache.has(cacheKey)) {
    return puuidTagCache.get(cacheKey);
  }

  let resolved = direct;
  try {
    if (entry.puuid) {
      const r = await lcuGet(lock, `/lol-summoner/v2/summoners/puuid/${encodeURIComponent(entry.puuid)}`);
      if (r.status === 200 && r.data) {
        const tag = formatPlayerRiotTag(r.data);
        if (tag) resolved = tag;
      }
    } else if (entry.summonerId > 0) {
      const r = await lcuGet(lock, `/lol-summoner/v1/summoners/${entry.summonerId}`);
      if (r.status === 200 && r.data) {
        const tag = formatPlayerRiotTag(r.data);
        if (tag) resolved = tag;
      }
    }
  } catch {
    // Non-fatal; fallback to direct name
  }

  if (cacheKey && resolved) {
    puuidTagCache.set(cacheKey, resolved);
  }
  return resolved || '';
}

function readLiveClientPlayerTags() {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port: 2999,
        path: '/liveclientdata/playerlist',
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
          if (res.statusCode !== 200) return resolve([]);
          try {
            const arr = JSON.parse(body);
            if (!Array.isArray(arr)) return resolve([]);
            const names = arr
              .filter((p) => !p.isBot)
              .map((p) => formatPlayerRiotTag(p))
              .filter(Boolean);
            resolve(names);
          } catch {
            resolve([]);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
    req.on('error', () => resolve([]));
    req.end();
  });
}

function extractCustomGameRecord(gd) {
  if (!gd || !Array.isArray(gd.participants) || !gd.participants.length) return null;
  const eog = String(gd.endOfGameResult || '').trim();
  const team100Obj = (gd.teams || []).find((t) => Number(t.teamId) === 100);
  const team200Obj = (gd.teams || []).find((t) => Number(t.teamId) === 200);
  const parts100 = gd.participants.filter((p) => Number(p.teamId) === 100);
  const parts200 = gd.participants.filter((p) => Number(p.teamId) === 200);

  const team100Win = team100Obj ? team100Obj.win === 'Win' : parts100.some((p) => p.stats?.win === true);
  const team200Win = team200Obj ? team200Obj.win === 'Win' : parts200.some((p) => p.stats?.win === true);

  // Ignore aborted custom games (e.g. Abort_TooFewPlayers where both teams Fail)
  if (eog && eog !== 'GameComplete') return null;
  if (team100Win === team200Win) return null;

  const idByParticipantId = new Map();
  for (const ident of gd.participantIdentities || []) {
    if (ident?.participantId != null) {
      idByParticipantId.set(ident.participantId, formatPlayerRiotTag(ident.player));
    }
  }

  const mapSide = (parts) =>
    parts
      .map((p) => idByParticipantId.get(p.participantId) || formatPlayerRiotTag(p))
      .filter(Boolean);

  const playerStats = gd.participants
    .map((p) => {
      const st = p.stats || {};
      const riotId = idByParticipantId.get(p.participantId) || formatPlayerRiotTag(p);
      if (!riotId) return null;
      return {
        riotId,
        teamId: Number(p.teamId),
        win: Number(p.teamId) === 100 ? team100Win : team200Win,
        championId: Number(p.championId || 0),
        kills: Number(st.kills || 0),
        deaths: Number(st.deaths || 0),
        assists: Number(st.assists || 0),
        cs: Number(st.totalMinionsKilled || 0) + Number(st.neutralMinionsKilled || 0),
        damage: Number(st.totalDamageDealtToChampions || 0),
        gold: Number(st.goldEarned || 0)
      };
    })
    .filter(Boolean);

  return {
    gameId: Number(gd.gameId),
    gameCreationDate: gd.gameCreationDate || '',
    gameCreationMs: Number(gd.gameCreation || new Date(gd.gameCreationDate || 0).getTime() || 0),
    gameDuration: Number(gd.gameDuration || 0),
    team100Win,
    team200Win,
    team100Players: mapSide(parts100),
    team200Players: mapSide(parts200),
    playerStats
  };
}

/**
 * Read active Custom Game Lobby players + recent completed Custom Games from local LoL LCU.
 */
async function readLcuCustomLobbyAndHistory({ enabled = true, customLockfilePath = '' } = {}) {
  const empty = {
    connected: false,
    inCustomLobby: false,
    inCustomGame: false,
    isLobbyLeader: false,
    lobbyPlayers: [],
    currentSummoner: null,
    recentCustomGames: []
  };
  if (!enabled) return empty;

  const lockPath = findLockfilePath(customLockfilePath);
  if (!lockPath) return empty;

  let lock;
  try {
    lock = parseLockfile(lockPath);
  } catch {
    return empty;
  }
  if (!lock || !lock.port || !lock.password) return empty;

  try {
    const [lobbyRes, flowRes, mhRes, currentSummoner] = await Promise.all([
      lcuGet(lock, '/lol-lobby/v2/lobby').catch(() => ({ status: 0, data: null })),
      lcuGet(lock, '/lol-gameflow/v1/session').catch(() => ({ status: 0, data: null })),
      lcuGet(lock, '/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=8').catch(() => ({
        status: 0,
        data: null
      })),
      readCurrentSummoner(lock)
    ]);

    const seenTags = new Map();
    const addPlayerTag = (tag) => {
      const clean = String(tag || '').trim();
      if (!clean) return;
      const key = clean.toLowerCase();
      if (!seenTags.has(key)) seenTags.set(key, clean);
    };

    let inCustomLobby = false;
    let inCustomGame = false;
    let isLobbyLeader = false;

    if (lobbyRes.status === 200 && lobbyRes.data) {
      const lb = lobbyRes.data;
      const gc = lb.gameConfig || {};
      const isCustom =
        Boolean(gc.isCustom) ||
        Array.isArray(gc.customTeam100) ||
        Array.isArray(gc.customTeam200);

      if (isCustom) {
        inCustomLobby = true;
        const rawEntries = [
          ...(Array.isArray(lb.members) ? lb.members : []),
          ...(Array.isArray(gc.customTeam100) ? gc.customTeam100 : []),
          ...(Array.isArray(gc.customTeam200) ? gc.customTeam200 : []),
          ...(Array.isArray(gc.customSpectators) ? gc.customSpectators : [])
        ];
        const resolved = await Promise.all(rawEntries.map((entry) => resolveLobbyEntryTag(lock, entry)));
        for (const tag of resolved) addPlayerTag(tag);

        isLobbyLeader = Boolean(
          lb.localMember?.isLeader ||
            (Array.isArray(lb.members) &&
              lb.members.some(
                (m) =>
                  m.isLeader &&
                  currentSummoner?.gameName &&
                  String(m.gameName || m.summonerName || '').toLowerCase() ===
                    String(currentSummoner.gameName || '').toLowerCase()
              ))
        );
      }
    }

    // If game already launched from Custom Lobby into InProgress / ChampSelect, check Live Client API too
    const phase = String(flowRes.data?.phase || '');
    const flowIsCustom = Boolean(flowRes.data?.gameData?.isCustomGame);
    if ((phase === 'InProgress' || flowIsCustom) && (flowIsCustom || inCustomLobby || seenTags.size === 0)) {
      const liveNames = await readLiveClientPlayerTags();
      if (liveNames.length && (flowIsCustom || phase === 'InProgress')) {
        inCustomGame = true;
        for (const n of liveNames) addPlayerTag(n);
      }
    }

    // Parse up to 5 recent finished CUSTOM_GAME matches
    const rawGames = Array.isArray(mhRes.data?.games?.games) ? mhRes.data.games.games : [];
    const customHeaders = rawGames
      .filter((g) => String(g.gameType || '').toUpperCase() === 'CUSTOM_GAME' || Number(g.queueId) === 3100)
      .slice(0, 5);

    const recentCustomGames = [];
    for (const g of customHeaders) {
      const gid = Number(g.gameId);
      if (!gid) continue;
      if (customGameDetailCache.has(gid)) {
        const cached = customGameDetailCache.get(gid);
        if (cached) recentCustomGames.push(cached);
        continue;
      }
      try {
        const detRes = await lcuGet(lock, `/lol-match-history/v1/games/${gid}`);
        if (detRes.status === 200 && detRes.data) {
          const rec = extractCustomGameRecord(detRes.data);
          customGameDetailCache.set(gid, rec);
          if (rec) recentCustomGames.push(rec);
        }
      } catch {
        // Non-fatal
      }
    }

    return {
      connected: true,
      inCustomLobby,
      inCustomGame,
      isLobbyLeader,
      lobbyPlayers: [...seenTags.values()],
      currentSummoner,
      recentCustomGames
    };
  } catch {
    return empty;
  }
}

module.exports = {
  detectAramFromLcu,
  normalizeLcuPosition,
  inferEnemyRoles,
  readLcuChampSelectState,
  readLcuCustomLobbyAndHistory,
  importRunesToLcu
};
