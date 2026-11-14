const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const { spawn, exec } = require('child_process');

const ddragon = require('./lib/ddragonClient');
const opgg = require('./lib/opggClient');
const syncEngine = require('./lib/syncEngine');
const lcuWatcher = require('./lib/lcuWatcher');
const recommender = require('./lib/recommender');
const soloDuoAnalyzer = require('./lib/soloDuoAnalyzer');
const liveOverlay = require('./lib/liveOverlay');
const tournamentEngine = require('./lib/tournamentEngine');
const roadToEngine = require('./lib/roadToEngine');
const discordClient = require('./lib/discordTournamentClient');
const tacticalAnalyzer = require('./lib/tacticalAnalyzer');

const PORT = Number(process.env.PORT || 3848);
const APP_BUILD = '2.2.2';
const PUBLIC_DIR = path.join(__dirname, 'public');
const OVERLAY_EXE = path.join(__dirname, 'LoL Overlay.exe');
const REMOTE_VERSION_URL = 'https://raw.githubusercontent.com/ngelx360/lol-advisor/main/version.json';

function isNewerVersion(remote, current) {
  if (!remote || !current) return false;
  const rParts = String(remote).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const cParts = String(current).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(rParts.length, cParts.length);
  for (let i = 0; i < len; i++) {
    const r = rParts[i] || 0;
    const c = cParts[i] || 0;
    if (r > c) return true;
    if (r < c) return false;
  }
  return false;
}

function fetchJsonUrl(url, timeoutMs = 4500) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'LoLAdvisor-Updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJsonUrl(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Timeout al consultar actualización'));
    });
  });
}

function downloadBinaryFile(url, destPath, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'LoLAdvisor-Updater' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(destPath, () => {});
        return downloadBinaryFile(res.headers.location, destPath, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        return reject(new Error(`HTTP ${res.statusCode} al descargar actualización`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', (err) => {
      file.close();
      fs.unlink(destPath, () => {});
      reject(err);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      file.close();
      fs.unlink(destPath, () => {});
      reject(new Error('Timeout al descargar paquete'));
    });
  });
}

function extractUpdateZip(zipPath, targetDir) {
  return new Promise((resolve, reject) => {
    exec(`tar -xf "${zipPath}" -C "${targetDir}"`, (err) => {
      if (!err || fs.existsSync(path.join(targetDir, 'server.js'))) {
        return resolve();
      }
      exec(
        `powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${targetDir}' -Force"`,
        (err2) => {
          if (err2) return reject(err2);
          resolve();
        }
      );
    });
  });
}

let overlayProcess = null;
let autoOverlayTimer = null;
let autoTournamentTimer = null;
let torneoSyncBusy = false;
let lastLiveInGame = false;
let consecutiveGameMisses = 0;
let manualOverlayPinned = false;

function isOverlayRunning() {
  return Boolean(overlayProcess && !overlayProcess.killed && overlayProcess.exitCode === null);
}

function startOverlayProcess() {
  if (isOverlayRunning()) return true;
  if (!fs.existsSync(OVERLAY_EXE)) {
    throw new Error('No se encontró LoL Overlay.exe en la carpeta del proyecto.');
  }
  overlayProcess = spawn(OVERLAY_EXE, [], {
    cwd: __dirname,
    detached: false,
    stdio: 'ignore',
    windowsHide: false
  });
  overlayProcess.on('exit', () => {
    overlayProcess = null;
  });
  return true;
}

function stopOverlayProcess() {
  if (overlayProcess && !overlayProcess.killed) {
    try {
      overlayProcess.kill();
    } catch {
      // Ignore
    }
  }
  overlayProcess = null;
}

async function tickAutoOverlay() {
  try {
    const cfg = syncEngine.loadConfig();
    if (cfg.overlayDemo) {
      consecutiveGameMisses = 0;
      if (!isOverlayRunning()) startOverlayProcess();
      return;
    }

    if (cfg.overlayAutoInGame === false) {
      lastLiveInGame = false;
      return;
    }

    const active = await liveOverlay.isLiveGameActive();
    lastLiveInGame = active;

    if (active) {
      consecutiveGameMisses = 0;
      if (!isOverlayRunning()) {
        startOverlayProcess();
      }
    } else {
      consecutiveGameMisses++;
      if (consecutiveGameMisses >= 2 && isOverlayRunning() && !manualOverlayPinned) {
        stopOverlayProcess();
      }
    }
  } catch {
    // Non-fatal auto watcher error
  }
}

function startAutoOverlayWatcher() {
  if (autoOverlayTimer) return;
  tickAutoOverlay();
  autoOverlayTimer = setInterval(tickAutoOverlay, 2500);
}

function stopAutoOverlayWatcher() {
  if (autoOverlayTimer) {
    clearInterval(autoOverlayTimer);
    autoOverlayTimer = null;
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// Active SSE listeners for live Season DB sync progress
const sseClients = new Set();
let lastSyncEvent = null;

function broadcastSyncEvent(evt) {
  lastSyncEvent = evt;
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {
      sseClients.delete(res);
    }
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(reqPath, res) {
  const cleanPath = reqPath === '/' ? '/index.html' : reqPath;
  const resolved = path.resolve(PUBLIC_DIR, `.${cleanPath}`);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const ext = path.extname(resolved).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(resolved).pipe(res);
}

/**
 * Resolve item, rune, tree, and summoner spell metadata onto a compact build object.
 */
function hydrateBuild(build, ddAssets) {
  if (!build || !ddAssets) return null;

  const hydrateItemGroups = (groups) =>
    (groups || []).map((g) => ({
      ...g,
      winRate: g.play > 0 ? g.win / g.play : 0,
      items: (g.ids || []).map((id, idx) => {
        const meta = ddAssets.itemsById[String(id)];
        return {
          id,
          name: meta?.name || g.names?.[idx] || `Item ${id}`,
          plaintext: meta?.plaintext || '',
          gold: meta?.gold || 0,
          iconUrl: meta?.iconUrl || ''
        };
      })
    }));

  const hydrateSpells = (groups) =>
    (groups || []).map((g) => ({
      ...g,
      winRate: g.play > 0 ? g.win / g.play : 0,
      spells: (g.ids || []).map((id, idx) => {
        const meta = ddAssets.summonersById[String(id)];
        return {
          id,
          name: meta?.name || g.names?.[idx] || `Spell ${id}`,
          iconUrl: meta?.iconUrl || ''
        };
      })
    }));

  const hydrateRunes = (runes) =>
    (runes || []).map((r) => {
      const pTree = ddAssets.runeTreesById[String(r.primaryPageId)];
      const sTree = ddAssets.runeTreesById[String(r.secondaryPageId)];
      return {
        ...r,
        winRate: r.play > 0 ? r.win / r.play : 0,
        primaryTree: {
          id: r.primaryPageId,
          name: pTree?.name || r.primaryPageName || '',
          iconUrl: pTree?.iconUrl || ''
        },
        primaryRunes: (r.primaryRuneIds || []).map((id, idx) => {
          const meta = ddAssets.runesById[String(id)];
          return {
            id,
            name: meta?.name || r.primaryRuneNames?.[idx] || `Runa ${id}`,
            iconUrl: meta?.iconUrl || '',
            isKeystone: idx === 0
          };
        }),
        secondaryTree: {
          id: r.secondaryPageId,
          name: sTree?.name || r.secondaryPageName || '',
          iconUrl: sTree?.iconUrl || ''
        },
        secondaryRunes: (r.secondaryRuneIds || []).map((id, idx) => {
          const meta = ddAssets.runesById[String(id)];
          return {
            id,
            name: meta?.name || r.secondaryRuneNames?.[idx] || `Runa ${id}`,
            iconUrl: meta?.iconUrl || ''
          };
        }),
        statShards: (r.statModIds || []).map((id) => {
          const shard = ddAssets.statShardsById[String(id)];
          return (
            shard || {
              id,
              name: `Fragmento ${id}`,
              short: String(id),
              iconUrl: ''
            }
          );
        })
      };
    });

  return {
    summonerSpells: hydrateSpells(build.summonerSpells),
    starterItems: hydrateItemGroups(build.starterItems),
    boots: hydrateItemGroups(build.boots),
    coreItems: hydrateItemGroups(build.coreItems),
    situationalItems: hydrateItemGroups(build.situationalItems),
    runes: hydrateRunes(build.runes),
    skillMastery: build.skillMastery || null,
    gameLengths: build.gameLengths || []
  };
}

async function handleApi(req, res, urlObj) {
  const pathname = urlObj.pathname;

  if (req.method === 'GET' && (pathname === '/api/health' || pathname === '/health')) {
    return sendJson(res, 200, { ok: true, appBuild: APP_BUILD });
  }

  if (req.method === 'GET' && pathname === '/api/update/check') {
    try {
      const remote = await fetchJsonUrl(REMOTE_VERSION_URL);
      const remoteVer = String(remote?.version || '').trim();
      const available = isNewerVersion(remoteVer, APP_BUILD);
      return sendJson(res, 200, {
        currentVersion: APP_BUILD,
        remoteVersion: remoteVer || APP_BUILD,
        updateAvailable: available,
        title: remote?.title || `LoL Advisor v${remoteVer}`,
        changelog: remote?.changelog || '',
        patch: remote?.patch || '',
        zipUrl: remote?.zipUrl || '',
        installerUrl: remote?.installerUrl || 'https://github.com/ngelx360/lol-advisor/releases/latest'
      });
    } catch (err) {
      return sendJson(res, 200, {
        currentVersion: APP_BUILD,
        remoteVersion: APP_BUILD,
        updateAvailable: false,
        error: err.message
      });
    }
  }

  if (req.method === 'POST' && pathname === '/api/update/apply') {
    const body = await readRequestBody(req).catch(() => ({}));
    let zipUrl = body.zipUrl;
    if (!zipUrl) {
      const remote = await fetchJsonUrl(REMOTE_VERSION_URL).catch(() => null);
      zipUrl = remote?.zipUrl || 'https://raw.githubusercontent.com/ngelx360/lol-advisor/main/update.zip';
    }
    const tempZip = path.join(os.tmpdir(), `lol_advisor_update_${Date.now()}.zip`);
    try {
      await downloadBinaryFile(zipUrl, tempZip);
      await extractUpdateZip(tempZip, __dirname);
      try { fs.unlinkSync(tempZip); } catch {}
      return sendJson(res, 200, { ok: true, message: 'Actualización aplicada con éxito' });
    } catch (err) {
      try { if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip); } catch {}
      return sendJson(res, 500, { error: `Error al aplicar actualización: ${err.message}` });
    }
  }

  if (req.method === 'GET' && pathname === '/api/bootstrap') {
    const config = syncEngine.loadConfig();
    const seasons = syncEngine.listSavedSeasons();
    const activeSeason = syncEngine.getActiveSeasonData();
    let ddAssets = null;
    try {
      ddAssets = await ddragon.loadDataDragonAssets(false);
    } catch {
      ddAssets = null;
    }

    const championsList = activeSeason?.champions
      ? Object.values(activeSeason.champions).sort((a, b) => a.name.localeCompare(b.name))
      : ddAssets?.championsById
      ? Object.values(ddAssets.championsById).sort((a, b) => a.name.localeCompare(b.name))
      : [];

    const laneChampionIds = {};
    if (activeSeason?.lanes) {
      for (const lane of syncEngine.LANES) {
        laneChampionIds[lane] = Object.keys(activeSeason.lanes[lane] || {}).map(Number);
      }
    }

    const publicConfig = {
      ...config,
      discord: {
        enabled: Boolean(config.discord?.enabled),
        bridgeConfigured: Boolean(config.discord?.bridgeUrl),
        channelId: config.discord?.channelId || '',
        roadToChannelId: config.discord?.roadToChannelId || '',
        adminOnly: config.discord?.adminOnly !== false
      }
    };
    delete publicConfig.clientOwnerKey;

    return sendJson(res, 200, {
      appBuild: APP_BUILD,
      config: publicConfig,
      seasons,
      syncInProgress: syncEngine.isSyncRunning(),
      activeSeason: activeSeason
        ? {
            patch: activeSeason.patch,
            ddVersion: activeSeason.ddVersion,
            source: activeSeason.source,
            updatedAt: activeSeason.updatedAt,
            laneEntriesCount: activeSeason.laneEntriesCount,
            matchupsCount: activeSeason.matchupsCount,
            patchHistory: activeSeason.patchHistory || []
          }
        : null,
      champions: championsList,
      laneChampionIds,
      ddVersion: ddAssets?.version || null
    });
  }

  if (req.method === 'GET' && pathname === '/api/lcu') {
    const config = syncEngine.loadConfig();
    const activeSeason = syncEngine.getActiveSeasonData();
    const state = await lcuWatcher.readLcuChampSelectState({
      enabled: config.lcuEnabled,
      customLockfilePath: config.lcuLockfilePath,
      seasonData: activeSeason
    });
    if (state.currentSummoner?.profileIconId) {
      const ddVer = activeSeason?.ddVersion || '16.22.1';
      state.currentSummoner.profileIconUrl = `https://ddragon.leagueoflegends.com/cdn/${ddVer}/img/profileicon/${state.currentSummoner.profileIconId}.png`;
    }
    return sendJson(res, 200, state);
  }

  if (req.method === 'POST' && pathname === '/api/infer-enemies') {
    const body = await readRequestBody(req);
    const activeSeason = syncEngine.getActiveSeasonData();
    const inferred = lcuWatcher.inferEnemyRoles(body.enemyIds || [], activeSeason);
    return sendJson(res, 200, { inferred });
  }

  if (req.method === 'POST' && pathname === '/api/recommendations') {
    const body = await readRequestBody(req);
    const config = syncEngine.loadConfig();
    const activeSeason = syncEngine.getActiveSeasonData();
    if (!activeSeason) {
      return sendJson(res, 200, {
        needsSync: true,
        mode: 'patch_wr',
        isFirstPickOrBlind: true,
        candidates: [],
        topCounters: [],
        allySynergiesSummary: []
      });
    }

    const result = await recommender.getRecommendations({
      seasonData: activeSeason,
      myRole: body.myRole || config.defaultRoles?.[0] || 'mid',
      enemyLanerId: body.enemyLanerId ? Number(body.enemyLanerId) : null,
      allies: body.allies || [],
      enemies: body.enemies || [],
      bans: body.bans || [],
      myChampionId: body.myChampionId ? Number(body.myChampionId) : null,
      myPool: config.myPool || [],
      onlyPool: Boolean(body.onlyPool),
      minSample: Number(body.minSample || 40),
      mode: body.mode || 'auto',
      enrich1v1: body.enrich1v1 !== false
    });

    return sendJson(res, 200, result);
  }

  if (req.method === 'GET' && pathname === '/api/champion-build') {
    const championId = Number(urlObj.searchParams.get('championId'));
    const role = urlObj.searchParams.get('role') || 'mid';
    const opponentId = urlObj.searchParams.get('opponentId')
      ? Number(urlObj.searchParams.get('opponentId'))
      : null;

    const activeSeason = syncEngine.getActiveSeasonData();
    if (!activeSeason || !championId) {
      return sendJson(res, 404, { error: 'Campeón o season no disponible' });
    }

    const ddAssets = await ddragon.loadDataDragonAssets(false);
    const champ = activeSeason.champions[championId];
    if (!champ) {
      return sendJson(res, 404, { error: 'Campeón no encontrado' });
    }

    // Determine best lane entry if requested role lacks data
    let activeRole = role;
    let laneEntry = activeSeason.lanes?.[activeRole]?.[championId];
    if (!laneEntry) {
      for (const l of syncEngine.LANES) {
        if (activeSeason.lanes?.[l]?.[championId]) {
          activeRole = l;
          laneEntry = activeSeason.lanes[l][championId];
          break;
        }
      }
    }

    let matchupDetail = null;
    if (opponentId && activeRole) {
      try {
        matchupDetail = await syncEngine.getMatchupDetailCached(
          activeSeason,
          championId,
          opponentId,
          activeRole
        );
      } catch {
        matchupDetail = null;
      }
    }

    // Ensure general season optimal build & runes exist (fixes mirror-matchup empty runes)
    let generalBuild = laneEntry?.build || null;
    if (!generalBuild?.runes?.length || !generalBuild?.coreItems?.length) {
      try {
        generalBuild = await syncEngine.getOrFetchChampionBuild(activeSeason, championId, activeRole);
      } catch {
        generalBuild = laneEntry?.build || null;
      }
    }

    const rawBuild =
      matchupDetail?.build?.runes?.length && matchupDetail?.build?.coreItems?.length
        ? matchupDetail.build
        : generalBuild || matchupDetail?.build;
    const hydratedBuild = hydrateBuild(rawBuild, ddAssets);

    // Top counters & easiest matchups in this lane from Season DB
    const countersList = [];
    if (laneEntry?.counters) {
      for (const [oppStr, stats] of Object.entries(laneEntry.counters)) {
        const oid = Number(oppStr);
        if (!stats || stats.play < 30 || oid === championId) continue;
        const oppMeta = activeSeason.champions[oid];
        if (!oppMeta) continue;
        countersList.push({
          championId: oid,
          name: oppMeta.name,
          iconUrl: oppMeta.iconUrl,
          play: stats.play,
          win: stats.win,
          winRate: stats.win / stats.play
        });
      }
    }
    const hardMatchups = [...countersList].sort((a, b) => a.winRate - b.winRate).slice(0, 5);
    const goodMatchups = [...countersList].sort((a, b) => b.winRate - a.winRate).slice(0, 5);

    const opponentMeta = opponentId ? activeSeason.champions[opponentId] || null : null;

    let allies = null;
    let enemies = null;
    if (urlObj.searchParams.get('allies')) {
      try { allies = JSON.parse(urlObj.searchParams.get('allies')); } catch {}
    }
    if (urlObj.searchParams.get('enemies')) {
      try { enemies = JSON.parse(urlObj.searchParams.get('enemies')); } catch {}
    }

    const config = syncEngine.loadConfig();
    const mySummonerName = config.riotAccount ? `${config.riotAccount.gameName}#${config.riotAccount.tagLine}` : '';
    const region = config?.region || config?.riotAccount?.region || 'LAN';

    if (!allies || !allies.length) {
      try {
        const liveState = await liveOverlay.getLiveOverlayState();
        if (liveState?.inGame && liveState.allies?.length) {
          allies = liveState.allies;
          if (!enemies || !enemies.length) enemies = liveState.enemies;
        } else {
          const lcuState = await lcuWatcher.readLcuChampSelectState({
            enabled: config.lcuEnabled,
            customLockfilePath: config.lcuLockfilePath,
            seasonData: activeSeason
          });
          if (lcuState?.inChampSelect && lcuState.allies?.length) {
            allies = lcuState.allies;
            if (!enemies || !enemies.length) enemies = lcuState.inferredEnemies;
          }
        }
      } catch {}
    }

    let teamBriefing = null;
    try {
      teamBriefing = await tacticalAnalyzer.analyzeTeamBriefing({
        seasonData: activeSeason,
        myRole: activeRole,
        myChampionId: championId,
        allies: allies || [],
        enemies: enemies || (opponentId ? [{ championId: opponentId, role: activeRole }] : []),
        mySummonerName,
        region
      });
    } catch {
      teamBriefing = null;
    }

    return sendJson(res, 200, {
      patch: activeSeason.patch,
      champion: champ,
      role: activeRole,
      stats: laneEntry
        ? {
            winRate: laneEntry.winRate,
            pickRate: laneEntry.pickRate,
            banRate: laneEntry.banRate,
            kda: laneEntry.kda,
            tier: laneEntry.tier,
            tierLabel: recommender.TIER_LABELS[laneEntry.tier] || 'C',
            rank: laneEntry.rank,
            play: laneEntry.play,
            trendWin: laneEntry.trendWin || []
          }
        : null,
      matchup: opponentMeta
        ? {
            opponent: opponentMeta,
            isSpecificBuild: Boolean(matchupDetail?.build),
            soloKillAdvantage: matchupDetail?.soloKillAdvantage || 'even',
            laneAdvantage: matchupDetail?.laneAdvantage || 'even',
            tip: matchupDetail?.tip || '',
            play: matchupDetail?.play || laneEntry?.counters?.[opponentId]?.play || 0,
            win: matchupDetail?.win || laneEntry?.counters?.[opponentId]?.win || 0,
            winRate:
              matchupDetail?.winRate ??
              (laneEntry?.counters?.[opponentId]?.play
                ? laneEntry.counters[opponentId].win / laneEntry.counters[opponentId].play
                : null)
          }
        : null,
      build: hydratedBuild,
      hardMatchups,
      goodMatchups,
      teamBriefing
    });
  }

  if ((req.method === 'GET' || req.method === 'POST') && pathname === '/api/team-tactical-briefing') {
    const activeSeason = syncEngine.getActiveSeasonData();
    if (!activeSeason) {
      return sendJson(res, 404, { error: 'Temporada no disponible' });
    }

    let body = {};
    if (req.method === 'POST') {
      body = await readRequestBody(req).catch(() => ({}));
    }

    let myRole = body.myRole || urlObj.searchParams.get('myRole') || null;
    let myChampionId = Number(body.myChampionId || urlObj.searchParams.get('myChampionId')) || null;
    let allies = Array.isArray(body.allies) ? body.allies : null;
    let enemies = Array.isArray(body.enemies) ? body.enemies : null;

    if (!allies && urlObj.searchParams.get('allies')) {
      try { allies = JSON.parse(urlObj.searchParams.get('allies')); } catch {}
    }
    if (!enemies && urlObj.searchParams.get('enemies')) {
      try { enemies = JSON.parse(urlObj.searchParams.get('enemies')); } catch {}
    }

    // Auto-detect from active live game or LCU if missing
    let liveState = null;
    try {
      liveState = await liveOverlay.getLiveOverlayState();
    } catch {}

    let lcuState = null;
    if (!liveState?.inGame) {
      try {
        const config = syncEngine.loadConfig();
        lcuState = await lcuWatcher.readLcuChampSelectState({
          enabled: config.lcuEnabled,
          customLockfilePath: config.lcuLockfilePath,
          seasonData: activeSeason
        });
      } catch {}
    }

    if (liveState?.inGame) {
      if (!myRole) myRole = liveState.role;
      if (!myChampionId && liveState.myChampion?.id) myChampionId = liveState.myChampion.id;
      if ((!allies || !allies.length) && liveState.allies?.length) allies = liveState.allies;
      if ((!enemies || !enemies.length) && liveState.enemies?.length) enemies = liveState.enemies;
    } else if (lcuState?.inChampSelect) {
      if (!myRole) myRole = lcuState.myRole;
      if (!myChampionId && lcuState.myChampionId) myChampionId = lcuState.myChampionId;
      if ((!allies || !allies.length) && lcuState.allies?.length) allies = lcuState.allies;
      if ((!enemies || !enemies.length) && lcuState.inferredEnemies?.length) enemies = lcuState.inferredEnemies;
    }

    const config = syncEngine.loadConfig();
    const mySummonerName =
      body.mySummonerName ||
      urlObj.searchParams.get('mySummonerName') ||
      (config.riotAccount ? `${config.riotAccount.gameName}#${config.riotAccount.tagLine}` : '');
    const region =
      body.region || urlObj.searchParams.get('region') || config?.region || config?.riotAccount?.region || 'LAN';

    const briefing = await tacticalAnalyzer.analyzeTeamBriefing({
      seasonData: activeSeason,
      myRole: myRole || 'mid',
      myChampionId,
      allies: allies || [],
      enemies: enemies || [],
      mySummonerName,
      region
    });

    return sendJson(res, 200, {
      ...briefing,
      inGame: Boolean(liveState?.inGame),
      inChampSelect: Boolean(lcuState?.inChampSelect),
      gameTimeLabel: liveState?.gameTimeLabel || null,
      myRole: myRole || 'mid',
      myChampionId
    });
  }

  if (req.method === 'GET' && pathname === '/api/sync/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    sseClients.add(res);
    if (lastSyncEvent) {
      res.write(`data: ${JSON.stringify(lastSyncEvent)}\n\n`);
    }
    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/sync/start') {
    if (syncEngine.isSyncRunning()) {
      return sendJson(res, 409, { error: 'Actualización ya en progreso' });
    }
    broadcastSyncEvent({ stage: 'starting', percent: 1, message: 'Iniciando actualización desde OP.GG...' });

    syncEngine
      .syncSeasonFromOpgg({
        onProgress: (evt) => broadcastSyncEvent(evt)
      })
      .catch((err) => {
        broadcastSyncEvent({
          stage: 'error',
          percent: 0,
          message: `Error al actualizar: ${err.message}`
        });
      });

    return sendJson(res, 202, { started: true });
  }

  if (req.method === 'POST' && pathname === '/api/seasons/switch') {
    const body = await readRequestBody(req);
    const loaded = syncEngine.switchActiveSeason(body.patch);
    return sendJson(res, 200, {
      ok: true,
      patch: loaded.patch
    });
  }

  if (req.method === 'POST' && pathname === '/api/soloduo-analysis') {
    const body = await readRequestBody(req);
    const gameName = String(body.gameName || '').trim();
    const tagLine = String(body.tagLine || '').trim();
    const region = String(body.region || 'LAN').trim().toUpperCase();
    if (!gameName || !tagLine) {
      return sendJson(res, 400, { error: 'Ingresa tu Riot ID completo (Nombre#TAG)' });
    }
    const activeSeason = syncEngine.getActiveSeasonData();
    const analysis = await soloDuoAnalyzer.analyzeSoloDuoHistory({
      gameName,
      tagLine,
      region,
      seasonData: activeSeason
    });
    syncEngine.saveConfig({
      riotAccount: {
        gameName: analysis.summoner.gameName,
        tagLine: analysis.summoner.tagLine,
        region: analysis.summoner.region
      }
    });
    return sendJson(res, 200, analysis);
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    const cfg = syncEngine.loadConfig();
    return sendJson(res, 200, { config: cfg });
  }

  if (req.method === 'GET' && pathname === '/api/overlay/config') {
    const cfg = syncEngine.loadConfig();
    return sendJson(res, 200, {
      overlayAutoInGame: cfg.overlayAutoInGame !== false,
      overlayDemo: Boolean(cfg.overlayDemo),
      overlayLocked: cfg.overlayLocked !== false,
      overlayScale: cfg.overlayScale ?? 1.0,
      overlayOpacity: cfg.overlayOpacity ?? 0.68,
      overlayX: cfg.overlayX ?? null,
      overlayY: cfg.overlayY ?? null
    });
  }

  if (req.method === 'POST' && pathname === '/api/config') {
    const body = await readRequestBody(req);
    const allowed = {};
    if (Array.isArray(body.myPool)) allowed.myPool = body.myPool.map(Number);
    if (Array.isArray(body.defaultRoles)) allowed.defaultRoles = body.defaultRoles;
    if (typeof body.lcuEnabled === 'boolean') allowed.lcuEnabled = body.lcuEnabled;
    if (typeof body.lcuLockfilePath === 'string') allowed.lcuLockfilePath = body.lcuLockfilePath;
    if (typeof body.autoFocusMyChampTab === 'boolean') {
      allowed.autoFocusMyChampTab = body.autoFocusMyChampTab;
    }
    if (typeof body.overlayAutoInGame === 'boolean') allowed.overlayAutoInGame = body.overlayAutoInGame;
    if (typeof body.overlayDemo === 'boolean') allowed.overlayDemo = body.overlayDemo;
    if (typeof body.overlayLocked === 'boolean') allowed.overlayLocked = body.overlayLocked;
    if (typeof body.overlayScale === 'number' && !Number.isNaN(body.overlayScale)) {
      allowed.overlayScale = Math.min(1.45, Math.max(0.75, Number(body.overlayScale.toFixed(2))));
    }
    if (typeof body.overlayOpacity === 'number' && !Number.isNaN(body.overlayOpacity)) {
      allowed.overlayOpacity = Math.min(0.95, Math.max(0.30, Number(body.overlayOpacity.toFixed(2))));
    }
    if (typeof body.overlayX === 'number' && !Number.isNaN(body.overlayX)) allowed.overlayX = Math.round(body.overlayX);
    if (typeof body.overlayY === 'number' && !Number.isNaN(body.overlayY)) allowed.overlayY = Math.round(body.overlayY);
    if (body.overlayResetPos === true) {
      allowed.overlayX = null;
      allowed.overlayY = null;
    }
    if (body.riotAccount && typeof body.riotAccount === 'object') {
      allowed.riotAccount = {
        gameName: String(body.riotAccount.gameName || ''),
        tagLine: String(body.riotAccount.tagLine || ''),
        region: String(body.riotAccount.region || 'LAN')
      };
    }
    const updated = syncEngine.saveConfig(allowed);

    if (updated.overlayDemo) {
      try {
        startOverlayProcess();
      } catch {}
    } else if (typeof body.overlayDemo === 'boolean' && !body.overlayDemo && !lastLiveInGame && !manualOverlayPinned) {
      stopOverlayProcess();
    } else if (typeof body.overlayAutoInGame === 'boolean' && !body.overlayAutoInGame && !manualOverlayPinned) {
      stopOverlayProcess();
    }

    return sendJson(res, 200, { config: updated });
  }

  if (req.method === 'POST' && pathname === '/api/lcu/import-runes') {
    const body = await readRequestBody(req);
    const config = syncEngine.loadConfig();
    const resLcu = await lcuWatcher.importRunesToLcu({
      customLockfilePath: config.lcuLockfilePath,
      pageName: body.pageName || 'LoL Advisor',
      primaryStyleId: body.primaryStyleId,
      subStyleId: body.subStyleId,
      selectedPerkIds: body.selectedPerkIds
    });
    return sendJson(res, 200, resLcu);
  }

  if (req.method === 'GET' && pathname === '/api/live-overlay') {
    const demo = urlObj.searchParams.get('demo') === '1';
    const data = await liveOverlay.getLiveOverlayState({ demo });
    const cfg = syncEngine.loadConfig();
    data.overlayConfig = {
      overlayAutoInGame: cfg.overlayAutoInGame !== false,
      overlayDemo: Boolean(cfg.overlayDemo),
      overlayLocked: cfg.overlayLocked !== false,
      overlayScale: cfg.overlayScale ?? 1.0,
      overlayOpacity: cfg.overlayOpacity ?? 0.68,
      overlayX: cfg.overlayX ?? null,
      overlayY: cfg.overlayY ?? null
    };
    return sendJson(res, 200, data);
  }

  if (req.method === 'GET' && pathname.startsWith('/api/item-icon/')) {
    const idMatch = /^\/api\/item-icon\/(\d+)\.png$/.exec(pathname);
    if (!idMatch) {
      res.writeHead(404);
      return res.end();
    }
    const buf = await liveOverlay.getCachedItemIconBuffer(Number(idMatch[1]));
    if (!buf) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    return res.end(buf);
  }

  if (req.method === 'GET' && pathname === '/api/overlay/status') {
    const cfg = syncEngine.loadConfig();
    return sendJson(res, 200, {
      running: isOverlayRunning(),
      autoInGame: cfg.overlayAutoInGame !== false,
      demo: Boolean(cfg.overlayDemo),
      inGame: lastLiveInGame,
      manualPinned: manualOverlayPinned
    });
  }

  if (req.method === 'POST' && pathname === '/api/overlay/start') {
    manualOverlayPinned = true;
    startOverlayProcess();
    return sendJson(res, 200, { running: isOverlayRunning(), manualPinned: true });
  }

  if (req.method === 'POST' && pathname === '/api/overlay/stop') {
    manualOverlayPinned = false;
    stopOverlayProcess();
    return sendJson(res, 200, { running: false, manualPinned: false });
  }

  // ==================== TORNEO BLITZ (DISCORD + DOUBLE ELIMINATION) ====================
  let lastPublishedLobbySig = '';
  let lastPublishedLobbyAt = 0;
  const reportedAutoGameIds = new Set();
  const autoPostingGameIds = new Set();
  const opggVerifiedSummoners = new Map();
  const OPGG_VERIFY_TTL_MS = 30 * 60 * 1000;

  async function verifyPlayersExistOnOpgg(players, region) {
    const cleanRegion = opgg.normalizeOpggRegion(region || 'LAN');
    const canonicalPlayers = [];
    const invalidPlayers = [];

    const checks = await Promise.all(
      players.map(async (rawPlayer) => {
        const clean = String(rawPlayer || '').trim().replace(/\s*#\s*/g, '#');
        const hashIdx = clean.lastIndexOf('#');
        if (hashIdx <= 0 || hashIdx >= clean.length - 1) {
          return { ok: false, raw: rawPlayer, reason: 'formato (usa Nombre#TAG)' };
        }
        const gameName = clean.slice(0, hashIdx).trim();
        const tagLine = clean.slice(hashIdx + 1).trim();
        const cacheKey = `${cleanRegion}:${gameName.toLowerCase()}#${tagLine.toLowerCase()}`;
        const cached = opggVerifiedSummoners.get(cacheKey);
        if (cached && Date.now() - cached.at < OPGG_VERIFY_TTL_MS) {
          return { ok: true, canonical: cached.canonical };
        }
        try {
          const prof = await opgg.getSummonerProfile(gameName, tagLine, cleanRegion);
          if (!prof || !prof.game_name) {
            return { ok: false, raw: clean, reason: `no encontrado en OP.GG (${cleanRegion})` };
          }
          const canonical = `${prof.game_name}#${prof.tagline || tagLine}`;
          opggVerifiedSummoners.set(cacheKey, { at: Date.now(), canonical });
          return { ok: true, canonical };
        } catch {
          return { ok: false, raw: clean, reason: `no existe en OP.GG (${cleanRegion})` };
        }
      })
    );

    for (const c of checks) {
      if (c.ok) canonicalPlayers.push(c.canonical);
      else invalidPlayers.push(`${c.raw} (${c.reason})`);
    }

    if (invalidPlayers.length) {
      throw new Error(
        `No se pudo registrar el equipo. Verifica en OP.GG (${cleanRegion}): ${invalidPlayers.join(' · ')}`
      );
    }
    return canonicalPlayers;
  }

  function isDiscordChanReady(dc, chanId) {
    return Boolean(dc?.enabled && discordClient.hasDiscordTransport(dc) && chanId);
  }

  function dcTransportOpts(dc) {
    return { bridgeUrl: dc?.bridgeUrl || '', botToken: dc?.botToken || '' };
  }

  function postDiscordChat(dc, channelId, content) {
    return discordClient.sendChannelMessage({
      bridgeUrl: dc?.bridgeUrl || '',
      botToken: dc?.botToken || '',
      channelId,
      webhookUrl: dc?.webhookUrl || '',
      content
    });
  }

  async function resolveAllowedDiscordAdmins(dc) {
    const manual = String(dc.adminIds || '')
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s));
    let ownerId = '';
    if (discordClient.hasDiscordTransport(dc) && dc.channelId) {
      try {
        const ctx = await discordClient.fetchChannelAdminContext(dcTransportOpts(dc), dc.channelId);
        ownerId = ctx.ownerId || '';
      } catch {
        ownerId = '';
      }
    }
    const allowed = [...new Set([ownerId, ...manual].filter(Boolean))];
    return { ownerId, allowed };
  }

  function buildTeamRostersMap(teams, inLobbyPlayers) {
    const map = {};
    for (const t of teams || []) {
      map[t.name] = (t.players || []).map((p) => ({
        name: p,
        inLobby: tournamentEngine.isPlayerInList(p, inLobbyPlayers)
      }));
    }
    return map;
  }

  async function enrichAndSyncTournamentSnapshot(snap, cfg, dc) {
    if (!snap.active) {
      lastPublishedLobbySig = '';
      return {
        ...snap,
        inLobbyPlayers: [],
        activeLobbyMatchId: null,
        teamRosters: {},
        lcuLobbyStatus: { connected: false, inCustomLobby: false, inCustomGame: false, detectedCount: 0 }
      };
    }

    let lcuState = {
      connected: false,
      inCustomLobby: false,
      inCustomGame: false,
      isLobbyLeader: false,
      lobbyPlayers: [],
      recentCustomGames: []
    };
    try {
      lcuState = await lcuWatcher.readLcuCustomLobbyAndHistory({
        enabled: cfg.lcuEnabled !== false,
        customLockfilePath: cfg.lcuLockfilePath || ''
      });
    } catch {
      // Non-fatal
    }

    const discordLobbyPlayers = Array.isArray(snap.lobbyPresence?.players) ? snap.lobbyPresence.players : [];
    const localLobbyAnalysis = tournamentEngine.matchLobbyAndCustomGames({
      bracket: snap.bracket,
      teams: snap.teams,
      openedAt: snap.openedAt,
      lobbyPlayers: lcuState.lobbyPlayers || [],
      customGames: lcuState.recentCustomGames || [],
      reportedGameIds: [...(snap.reportedGameIds || []), ...reportedAutoGameIds]
    });

    // 1. Auto-sync live Custom Lobby players to Discord via !SALA (1 person in lobby is enough!)
    const localMatched = localLobbyAnalysis.matchedTournamentLobbyPlayers || [];
    const localSigList = localMatched.map((s) => s.toLowerCase()).sort().join(',');
    const discordSigList = discordLobbyPlayers.map((s) => s.toLowerCase()).sort().join(',');

    if (isDiscordChanReady(dc, dc.channelId)) {
      const now = Date.now();
      const discordSalaAge = snap.lobbyPresence?.updatedAt
        ? now - new Date(snap.lobbyPresence.updatedAt).getTime()
        : Number.MAX_SAFE_INTEGER;

      if (
        localMatched.length > 0 &&
        localSigList !== discordSigList &&
        localSigList !== lastPublishedLobbySig &&
        now - lastPublishedLobbyAt > 4500 &&
        (lcuState.isLobbyLeader || discordSalaAge > 7000)
      ) {
        lastPublishedLobbySig = localSigList;
        lastPublishedLobbyAt = now;
        try {
          const matchTag = localLobbyAnalysis.activeLobbyMatchId || 'SALA';
          await postDiscordChat(dc, dc.channelId, `!SALA ${matchTag} | ${localMatched.join(', ')}`);
        } catch {
          // Non-fatal; local lobby indicator still works
        }
      } else if (
        lastPublishedLobbySig &&
        !lcuState.inCustomLobby &&
        !lcuState.inCustomGame &&
        discordLobbyPlayers.length > 0 &&
        now - lastPublishedLobbyAt > 4500
      ) {
        lastPublishedLobbySig = '';
        lastPublishedLobbyAt = now;
        try {
          await postDiscordChat(dc, dc.channelId, '!SALA CLEAR');
        } catch {
          // Non-fatal
        }
      }
    }

    // 2. Auto-detect finished Custom Game in LoL Match History & post !BOTGANADOR
    const det = localLobbyAnalysis.detectedResult;
    if (det && !reportedAutoGameIds.has(det.gameId) && !autoPostingGameIds.has(det.gameId)) {
      autoPostingGameIds.add(det.gameId);
      try {
        if (isDiscordChanReady(dc, dc.channelId)) {
          await postDiscordChat(dc, dc.channelId, `!BOTGANADOR ${det.matchId} ${det.winnerName} | game:${det.gameId}`);
          if (Array.isArray(det.playerStats) && det.playerStats.length) {
            await postDiscordChat(
              dc,
              dc.channelId,
              tournamentEngine.encodeCompactMatchStats(
                det.matchId,
                det.gameId,
                det.gameDuration || 0,
                det.playerStats
              )
            );
          }
        } else {
          const local = syncEngine.loadLocalTournament();
          if (local.active) {
            local.results = [...(local.results || []), { matchId: det.matchId, winnerName: det.winnerName, atMs: Date.now() }];
            local.reportedGameIds = [...new Set([...(local.reportedGameIds || []), det.gameId])];
            if (Array.isArray(det.playerStats) && det.playerStats.length) {
              local.matchStats = [
                ...(local.matchStats || []),
                {
                  matchId: det.matchId,
                  gameId: det.gameId,
                  durationSec: det.gameDuration || 0,
                  players: det.playerStats,
                  at: new Date().toISOString()
                }
              ];
            }
            syncEngine.saveLocalTournament(local);
          }
        }
        reportedAutoGameIds.add(det.gameId);
        tournamentEngine.applyMatchResult(snap.bracket, det.matchId, det.winnerName);
        if (Array.isArray(det.playerStats) && det.playerStats.length) {
          snap.matchStats = [
            ...(snap.matchStats || []),
            {
              matchId: det.matchId,
              gameId: det.gameId,
              durationSec: det.gameDuration || 0,
              players: det.playerStats
            }
          ];
        }
      } catch {
        // Non-fatal
      } finally {
        autoPostingGameIds.delete(det.gameId);
      }
    }

    // Merge Discord !SALA + local LCU lobby players so UI always stays fresh green/red
    const mergedLobbyMap = new Map();
    for (const p of [...discordLobbyPlayers, ...localMatched]) {
      const k = tournamentEngine.normalizePlayerTag(p);
      if (k && !mergedLobbyMap.has(k)) mergedLobbyMap.set(k, p);
    }
    const mergedLobbyPlayers = [...mergedLobbyMap.values()];
    const mergedAnalysis = tournamentEngine.matchLobbyAndCustomGames({
      bracket: snap.bracket,
      teams: snap.teams,
      openedAt: snap.openedAt,
      lobbyPlayers: mergedLobbyPlayers
    });

    const myOwnerKey = syncEngine.getClientOwnerKey();
    const teamCanDropMap = new Map();
    const sanitizedTeams = (snap.teams || []).map((t) => {
      const { ownerKey, ...rest } = t;
      const canDrop = Boolean(ownerKey && String(ownerKey).toLowerCase() === String(myOwnerKey).toLowerCase());
      teamCanDropMap.set(String(t.name || '').toLowerCase(), canDrop);
      return { ...rest, canDrop };
    });

    if (snap.bracket?.matches) {
      const roomsMap = snap.roomsByMatchId || {};
      for (const m of Object.values(snap.bracket.matches)) {
        const rm = roomsMap[m.id];
        if (rm) {
          m.roomName = rm.roomName || '';
          m.roomPass = rm.roomPass || '';
        }
        const canCapEdit = Boolean(
          teamCanDropMap.get(String(m.teamA || '').toLowerCase()) ||
          teamCanDropMap.get(String(m.teamB || '').toLowerCase())
        );
        m.canEditRoom = Boolean(
          !m.winner &&
          m.teamA &&
          m.teamB &&
          (snap.source !== 'discord' || !snap.adminOnly || canCapEdit)
        );
      }
    }

    const mvpLeaderboard = tournamentEngine.computeTournamentMvpLeaderboard({
      matchStats: snap.matchStats || [],
      teams: sanitizedTeams
    });

    return {
      ...snap,
      teams: sanitizedTeams,
      mvpLeaderboard,
      inLobbyPlayers: mergedLobbyPlayers,
      activeLobbyMatchId: mergedAnalysis.activeLobbyMatchId || snap.lobbyPresence?.matchId || null,
      teamRosters: buildTeamRostersMap(sanitizedTeams, mergedLobbyPlayers),
      lcuLobbyStatus: {
        connected: lcuState.connected,
        inCustomLobby: lcuState.inCustomLobby,
        inCustomGame: lcuState.inCustomGame,
        detectedCount: mergedLobbyPlayers.length
      }
    };
  }

  async function getTournamentStateSnapshot() {
    const cfg = syncEngine.loadConfig();
    const dc = cfg.discord || {};
    if (isDiscordChanReady(dc, dc.channelId)) {
      const adminOnly = dc.adminOnly !== false;
      const [{ ownerId, allowed }, msgs] = await Promise.all([
        resolveAllowedDiscordAdmins(dc),
        discordClient.fetchChannelMessages(dcTransportOpts(dc), dc.channelId, 100)
      ]);
      const parsed = tournamentEngine.parseDiscordMessagesToTournament(msgs, {
        adminOnly,
        allowedAdminIds: allowed
      });
      return enrichAndSyncTournamentSnapshot(
        {
          source: 'discord',
          discordConfigured: true,
          adminOnly,
          ownerId,
          allowedAdminIds: allowed,
          ...parsed
        },
        cfg,
        dc
      );
    }
    const local = syncEngine.loadLocalTournament();
    const localAnnouncement = syncEngine.loadLocalAnnouncement();
    const hasDiscordCfg = Boolean(discordClient.hasDiscordTransport(dc) && dc.channelId);
    if (!local.active) {
      return enrichAndSyncTournamentSnapshot(
        {
          source: 'local',
          discordConfigured: hasDiscordCfg,
          adminOnly: dc.adminOnly !== false,
          ownerId: '',
          allowedAdminIds: [],
          active: false,
          size: 8,
          openedAt: null,
          openedBy: '',
          teams: [],
          drawn: false,
          started: false,
          startedAt: null,
          paused: false,
          pauseIntervals: [],
          bracket: null,
          roomsByMatchId: {},
          matchStats: [],
          announcement: localAnnouncement,
          lobbyPresence: { matchId: null, players: [], updatedAt: null },
          reportedGameIds: []
        },
        cfg,
        dc
      );
    }
    const bracket = tournamentEngine.buildBracketWithTimers({
      teams: local.teams || [],
      size: local.size || 8,
      drawn: Boolean(local.drawn),
      drawOrder: local.drawOrder || null,
      started: Boolean(local.started),
      startedAtMs: local.startedAtMs || null,
      results: local.results || []
    });
    return enrichAndSyncTournamentSnapshot(
      {
        source: 'local',
        discordConfigured: hasDiscordCfg,
        adminOnly: dc.adminOnly !== false,
        ownerId: '',
        allowedAdminIds: [],
        active: true,
        size: local.size || 8,
        openedAt: local.openedAt,
        openedBy: local.openedBy || 'Local',
        teams: local.teams || [],
        drawn: Boolean(local.drawn),
        started: Boolean(local.started),
        startedAt: local.startedAt || null,
        paused: Boolean(local.paused),
        pauseIntervals: local.pauseIntervals || [],
        bracket,
        roomsByMatchId: local.roomsByMatchId || {},
        matchStats: local.matchStats || [],
        announcement: localAnnouncement,
        lobbyPresence: { matchId: null, players: [], updatedAt: null },
        reportedGameIds: local.reportedGameIds || []
      },
      cfg,
      dc
    );
  }

  if (req.method === 'GET' && pathname === '/api/tournament/state') {
    const snap = await getTournamentStateSnapshot();
    return sendJson(res, 200, snap);
  }

  if (req.method === 'POST' && pathname === '/api/tournament/config') {
    return sendJson(res, 403, { error: 'Los ajustes de Discord están bloqueados.' });
  }

  if (req.method === 'POST' && pathname === '/api/tournament/test-discord') {
    const body = await readRequestBody(req);
    const dc = syncEngine.loadConfig().discord || {};
    const info = await discordClient.testDiscordConnection({
      bridgeUrl: body.bridgeUrl || dc.bridgeUrl,
      botToken: body.botToken || dc.botToken,
      channelId: body.channelId || dc.channelId
    });
    return sendJson(res, 200, info);
  }

  if (req.method === 'POST' && pathname === '/api/tournament/open') {
    const body = await readRequestBody(req);
    const size = [2, 4, 8, 16].includes(Number(body.size)) ? Number(body.size) : 8;
    const dc = syncEngine.loadConfig().discord || {};
    if (isDiscordChanReady(dc, dc.channelId)) {
      if (dc.adminOnly !== false) {
        return sendJson(res, 403, {
          error: `Modo Solo Admin activo: solo el Admin puede abrir torneos escribiendo !TORNEO ON ${size} directamente en el chat de Discord.`
        });
      }
      await postDiscordChat(dc, dc.channelId, `!TORNEO ON ${size}`);
    } else {
      syncEngine.saveLocalTournament({
        active: true,
        size,
        openedAt: new Date().toISOString(),
        openedBy: 'Local',
        teams: [],
        drawn: false,
        drawOrder: null,
        started: false,
        startedAt: null,
        startedAtMs: null,
        paused: false,
        pauseIntervals: [],
        roomsByMatchId: {},
        matchStats: [],
        results: [],
        reportedGameIds: []
      });
    }
    return sendJson(res, 200, await getTournamentStateSnapshot());
  }

  if (req.method === 'POST' && pathname === '/api/tournament/close') {
    const dc = syncEngine.loadConfig().discord || {};
    if (isDiscordChanReady(dc, dc.channelId)) {
      if (dc.adminOnly !== false) {
        return sendJson(res, 403, {
          error: 'Modo Solo Admin activo: solo el Admin puede borrar el torneo escribiendo !TORNEO OFF directamente en el chat de Discord.'
        });
      }
      await postDiscordChat(dc, dc.channelId, '!TORNEO OFF');
    } else {
      syncEngine.saveLocalTournament({
        active: false,
        size: 8,
        openedAt: null,
        openedBy: '',
        teams: [],
        drawn: false,
        drawOrder: null,
        started: false,
        startedAt: null,
        startedAtMs: null,
        paused: false,
        pauseIntervals: [],
        roomsByMatchId: {},
        matchStats: [],
        results: [],
        reportedGameIds: []
      });
    }
    return sendJson(res, 200, await getTournamentStateSnapshot());
  }

  if (req.method === 'POST' && pathname === '/api/tournament/register') {
    const body = await readRequestBody(req);
    const rawName = String(body.teamName || '').trim().replace(/[|,\n]+/g, ' ').replace(/\s+/g, '_');
    const rawPlayers = (Array.isArray(body.players) ? body.players : [])
      .map((p) => String(p || '').trim())
      .filter(Boolean)
      .slice(0, 5);

    if (!rawName) {
      return sendJson(res, 400, { error: 'Ingresa el nombre del equipo.' });
    }
    if (/^(TORNEO|GANADOR|WIN|BOTGANADOR|BOTSTATS|BAJA|SALA|CLAVE|SALACODE|SALAINFO|AVISO|ANUNCIO|SORTEO|INICIAR|PAUSA|PAUSAR|REANUDAR)$/i.test(rawName)) {
      return sendJson(res, 400, { error: 'Usa otro nombre de equipo (reservado para comandos).' });
    }
    if (!rawPlayers.length) {
      return sendJson(res, 400, { error: 'Ingresa al menos 1 Riot ID (Nombre#TAG).' });
    }

    const cfg = syncEngine.loadConfig();
    const region = body.region || cfg.riotAccount?.region || 'LAN';
    let players = rawPlayers;
    try {
      players = await verifyPlayersExistOnOpgg(rawPlayers, region);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const myOwnerKey = syncEngine.getClientOwnerKey();
    const dc = cfg.discord || {};
    if (isDiscordChanReady(dc, dc.channelId)) {
      const snapCheck = await getTournamentStateSnapshot();
      if (!snapCheck.active) {
        return sendJson(res, 400, { error: 'No hay un torneo abierto actualmente.' });
      }
      const existing = (snapCheck.teams || []).find((t) => t.name.toLowerCase() === rawName.toLowerCase());
      if (existing && !existing.canDrop) {
        return sendJson(res, 403, { error: `El equipo "${rawName}" ya fue registrado por otro jugador.` });
      }
      await postDiscordChat(dc, dc.channelId, `!${rawName} ${players.join(', ')} | reg:${myOwnerKey}`);
    } else {
      const local = syncEngine.loadLocalTournament();
      if (!local.active) {
        return sendJson(res, 400, { error: 'No hay un torneo abierto actualmente.' });
      }
      const teams = local.teams || [];
      const idx = teams.findIndex((t) => t.name.toLowerCase() === rawName.toLowerCase());
      if (idx >= 0 && teams[idx].ownerKey && teams[idx].ownerKey !== myOwnerKey) {
        return sendJson(res, 403, { error: `El equipo "${rawName}" ya fue registrado por otro jugador.` });
      }
      const rec = {
        name: rawName,
        players,
        ownerKey: myOwnerKey,
        registeredBy: 'Local',
        registeredAt: new Date().toISOString()
      };
      if (idx >= 0) teams[idx] = rec;
      else if (teams.length < (local.size || 8)) teams.push(rec);
      else return sendJson(res, 400, { error: `El torneo ya alcanzó el límite de ${local.size} equipos.` });
      local.teams = teams;
      syncEngine.saveLocalTournament(local);
    }
    return sendJson(res, 200, await getTournamentStateSnapshot());
  }

  if (req.method === 'POST' && pathname === '/api/tournament/drop') {
    const body = await readRequestBody(req);
    const teamName = String(body.teamName || '').trim();
    if (!teamName) {
      return sendJson(res, 400, { error: 'Ingresa el nombre del equipo a dar de baja.' });
    }
    const snap = await getTournamentStateSnapshot();
    if (!snap.active) {
      return sendJson(res, 400, { error: 'No hay torneo abierto actualmente.' });
    }
    const existing = (snap.teams || []).find((t) => t.name.toLowerCase() === teamName.toLowerCase());
    if (!existing) {
      return sendJson(res, 404, { error: 'Equipo no encontrado.' });
    }
    if (!existing.canDrop) {
      return sendJson(res, 403, { error: 'Solo quien registró este equipo puede darlo de baja.' });
    }

    const myOwnerKey = syncEngine.getClientOwnerKey();
    const dc = syncEngine.loadConfig().discord || {};
    if (isDiscordChanReady(dc, dc.channelId)) {
      await postDiscordChat(dc, dc.channelId, `!BAJA ${existing.name} | by:${myOwnerKey}`);
    } else {
      const local = syncEngine.loadLocalTournament();
      local.teams = (local.teams || []).filter((t) => t.name.toLowerCase() !== existing.name.toLowerCase());
      syncEngine.saveLocalTournament(local);
    }
    return sendJson(res, 200, await getTournamentStateSnapshot());
  }

  if (req.method === 'POST' && pathname === '/api/tournament/draw') {
    const snap = await getTournamentStateSnapshot();
    if (!snap.active) {
      return sendJson(res, 400, { error: 'No hay torneo abierto.' });
    }
    if ((snap.teams || []).length < snap.size) {
      return sendJson(res, 400, {
        error: `Faltan equipos por registrar (${snap.teams.length}/${snap.size}) antes de realizar el sorteo.`
      });
    }

    const order = Array.from({ length: snap.teams.length }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    const dc = syncEngine.loadConfig().discord || {};
    if (isDiscordChanReady(dc, dc.channelId)) {
      if (snap.drawn && dc.adminOnly !== false) {
        return sendJson(res, 403, {
          error: 'El sorteo ya fue realizado. Solo el Admin puede volver a sortear escribiendo !SORTEO en Discord.'
        });
      }
      await postDiscordChat(dc, dc.channelId, `!SORTEO ${order.join(',')}`);
    } else {
      const local = syncEngine.loadLocalTournament();
      local.drawOrder = order;
      local.drawn = true;
      syncEngine.saveLocalTournament(local);
    }
    return sendJson(res, 200, await getTournamentStateSnapshot());
  }

  async function runTournamentAdminAction(res, { discordCmd, adminHint, applyLocal }) {
    const dc = syncEngine.loadConfig().discord || {};
    if (isDiscordChanReady(dc, dc.channelId)) {
      if (dc.adminOnly !== false) {
        return sendJson(res, 403, {
          error: `Modo Solo Admin activo: solo el Admin puede hacerlo escribiendo ${adminHint} directamente en el chat de Discord.`
        });
      }
      await postDiscordChat(dc, dc.channelId, discordCmd);
    } else {
      const local = syncEngine.loadLocalTournament();
      if (!local.active) return sendJson(res, 400, { error: 'No hay torneo activo.' });
      const errMsg = applyLocal(local);
      if (errMsg) return sendJson(res, 400, { error: errMsg });
      syncEngine.saveLocalTournament(local);
    }
    return sendJson(res, 200, await getTournamentStateSnapshot());
  }

  if (req.method === 'POST' && pathname === '/api/tournament/winner') {
    const body = await readRequestBody(req);
    const matchId = String(body.matchId || '').trim().toUpperCase();
    const winnerName = String(body.winnerName || '').trim();
    if (!matchId || !winnerName) {
      return sendJson(res, 400, { error: 'Falta matchId o winnerName.' });
    }
    return runTournamentAdminAction(res, {
      discordCmd: `!GANADOR ${matchId} ${winnerName}`,
      adminHint: `!GANADOR ${matchId} ${winnerName}`,
      applyLocal: (local) => {
        local.results = [...(local.results || []), { matchId, winnerName, atMs: Date.now() }];
      }
    });
  }

  if (req.method === 'POST' && pathname === '/api/tournament/resize') {
    const body = await readRequestBody(req);
    const size = Number(body.size);
    if (![2, 4, 8, 16].includes(size)) {
      return sendJson(res, 400, { error: 'Los cupos permitidos son 2, 4, 8 o 16.' });
    }
    return runTournamentAdminAction(res, {
      discordCmd: `!TORNEO ${size}`,
      adminHint: `!TORNEO ${size}`,
      applyLocal: (local) => {
        local.size = size;
        if (local.drawn && Array.isArray(local.drawOrder)) {
          local.drawOrder = local.drawOrder.filter((idx) => idx < Math.min((local.teams || []).length, size));
        }
      }
    });
  }

  if (req.method === 'POST' && pathname === '/api/tournament/start') {
    return runTournamentAdminAction(res, {
      discordCmd: '!TORNEO INICIAR',
      adminHint: '!TORNEO INICIAR',
      applyLocal: (local) => {
        const now = Date.now();
        local.started = true;
        local.startedAt = new Date(now).toISOString();
        local.startedAtMs = now;
        local.paused = false;
        if (!local.drawn) {
          const cap = Math.min((local.teams || []).length, local.size || 8);
          local.drawOrder = Array.from({ length: cap }, (_, i) => i);
          local.drawn = true;
        }
      }
    });
  }

  if (req.method === 'POST' && pathname === '/api/tournament/pause') {
    return runTournamentAdminAction(res, {
      discordCmd: '!TORNEO PAUSA',
      adminHint: '!TORNEO PAUSA',
      applyLocal: (local) => {
        if (!local.started) return 'El torneo aún no ha iniciado.';
        if (!local.paused) {
          local.paused = true;
          local.pauseIntervals = [...(local.pauseIntervals || []), { startMs: Date.now(), endMs: null }];
        }
      }
    });
  }

  if (req.method === 'POST' && pathname === '/api/tournament/resume') {
    return runTournamentAdminAction(res, {
      discordCmd: '!TORNEO REANUDAR',
      adminHint: '!TORNEO REANUDAR',
      applyLocal: (local) => {
        if (local.paused) {
          local.paused = false;
          const intervals = [...(local.pauseIntervals || [])];
          const last = intervals[intervals.length - 1];
          if (last && last.endMs == null) {
            intervals[intervals.length - 1] = { ...last, endMs: Date.now() };
          }
          local.pauseIntervals = intervals;
        }
      }
    });
  }

  if (req.method === 'POST' && pathname === '/api/tournament/room') {
    const body = await readRequestBody(req);
    const matchId = String(body.matchId || '').trim().toUpperCase();
    const clear = Boolean(body.clear);
    const roomName = String(body.roomName || '').replace(/[|\n\r]+/g, ' ').trim();
    const roomPass = String(body.roomPass || '').replace(/[|\n\r]+/g, ' ').trim();
    if (!matchId) return sendJson(res, 400, { error: 'Falta matchId.' });
    if (!clear && !roomName) {
      return sendJson(res, 400, { error: 'Ingresa el nombre de la sala.' });
    }

    const snap = await getTournamentStateSnapshot();
    if (!snap.active || !snap.bracket?.matches?.[matchId]) {
      return sendJson(res, 404, { error: 'Cruce no encontrado.' });
    }
    const match = snap.bracket.matches[matchId];
    if (!match.canEditRoom) {
      return sendJson(res, 403, { error: 'Solo los capitanes de esta partida o el Admin pueden fijar la sala y contraseña.' });
    }

    const myOwnerKey = syncEngine.getClientOwnerKey();
    const dc = syncEngine.loadConfig().discord || {};
    if (isDiscordChanReady(dc, dc.channelId)) {
      const content = clear
        ? `!CLAVE ${matchId} | CLEAR | by:${myOwnerKey}`
        : `!CLAVE ${matchId} | ${roomName} | ${roomPass || 'Sin clave'} | by:${myOwnerKey}`;
      await postDiscordChat(dc, dc.channelId, content);
    } else {
      const local = syncEngine.loadLocalTournament();
      local.roomsByMatchId = local.roomsByMatchId || {};
      if (clear) {
        delete local.roomsByMatchId[matchId];
      } else {
        local.roomsByMatchId[matchId] = { matchId, roomName, roomPass: roomPass || 'Sin clave', updatedAt: new Date().toISOString() };
      }
      syncEngine.saveLocalTournament(local);
    }
    return sendJson(res, 200, await getTournamentStateSnapshot());
  }

  if (req.method === 'POST' && pathname === '/api/announcement') {
    const body = await readRequestBody(req);
    const text = String(body.text || '').trim();
    const dc = syncEngine.loadConfig().discord || {};
    if (isDiscordChanReady(dc, dc.channelId)) {
      if (dc.adminOnly !== false) {
        return sendJson(res, 403, {
          error: 'Modo Solo Admin activo: publica avisos escribiendo !AVISO <mensaje> (o !AVISO OFF) directamente en Discord.'
        });
      }
      await postDiscordChat(dc, dc.channelId, text ? `!AVISO ${text}` : '!AVISO OFF');
    } else {
      syncEngine.saveLocalAnnouncement(
        text ? { text, at: new Date().toISOString(), atMs: Date.now(), by: 'NGELX' } : null
      );
    }
    return sendJson(res, 200, { announcement: text ? { text, at: new Date().toISOString(), by: 'NGELX' } : null });
  }

  // ==================== ROAD TO LADDER (DISCORD + OP.GG SEASONS) ====================
  const roadToProfileCache = new Map();
  const ROADTO_CACHE_TTL_MS = 2 * 60 * 1000;

  async function fetchRoadToProfileCached(riotId, region, forceRefresh = false) {
    const clean = String(riotId || '').trim().replace(/\s*#\s*/g, '#');
    const hashIdx = clean.lastIndexOf('#');
    if (hashIdx <= 0 || hashIdx >= clean.length - 1) {
      throw new Error(`Formato inválido en "${riotId}". Usa Nombre#TAG.`);
    }
    const gameName = clean.slice(0, hashIdx).trim();
    const tagLine = clean.slice(hashIdx + 1).trim();
    const normRegion = opgg.normalizeOpggRegion(region || 'LAN');
    const key = `${normRegion}:${gameName.toLowerCase()}#${tagLine.toLowerCase()}`;
    const cached = roadToProfileCache.get(key);
    if (!forceRefresh && cached && Date.now() - cached.at < ROADTO_CACHE_TTL_MS) {
      return { profile: cached.profile, matches: cached.matches || [] };
    }
    const [profile, matches] = await Promise.all([
      opgg.getSummonerProfileWithHistory(gameName, tagLine, normRegion),
      opgg.listSummonerMatches(gameName, tagLine, normRegion, 10).catch(() => [])
    ]);
    if (!profile || !profile.game_name) {
      throw new Error(`Cuenta no encontrada en OP.GG (${normRegion}): ${clean}`);
    }
    roadToProfileCache.set(key, { at: Date.now(), profile, matches: Array.isArray(matches) ? matches : [] });
    return { profile, matches: Array.isArray(matches) ? matches : [] };
  }

  async function resolveRoadToChannelId(dc) {
    const explicit = discordClient.normalizeChannelId(dc.roadToChannelId || '');
    if (explicit) return explicit;
    if (!discordClient.hasDiscordTransport(dc) || !dc.channelId) return '';
    try {
      const ctx = await discordClient.fetchChannelAdminContext(dcTransportOpts(dc), dc.channelId);
      if (ctx.guildId && dc.botToken) {
        return await discordClient.findGuildChannelByName(dc.botToken, ctx.guildId, 'road-to');
      }
    } catch {
      // Non-fatal
    }
    return '';
  }

  async function getRoadToStateSnapshot(forceRefresh = false) {
    const cfg = syncEngine.loadConfig();
    const dc = cfg.discord || {};
    const adminOnly = dc.adminOnly !== false;
    const roadToChan = dc.enabled && discordClient.hasDiscordTransport(dc) ? await resolveRoadToChannelId(dc) : '';

    let rawState;
    let source = 'local';
    if (isDiscordChanReady(dc, roadToChan)) {
      source = 'discord';
      const [{ allowed }, msgs] = await Promise.all([
        resolveAllowedDiscordAdmins(dc),
        discordClient.fetchChannelMessages(dcTransportOpts(dc), roadToChan, 100)
      ]);
      rawState = roadToEngine.parseDiscordMessagesToRoadTo(msgs, {
        adminOnly,
        allowedAdminIds: allowed
      });
    } else {
      rawState = syncEngine.loadLocalRoadTo();
    }

    const myOwnerKey = syncEngine.getClientOwnerKey();
    const enriched = [];
    if (rawState.active && Array.isArray(rawState.participants) && rawState.participants.length) {
      const results = await Promise.all(
        rawState.participants.map(async (p) => {
          const canDrop = Boolean(p.ownerKey && String(p.ownerKey).toLowerCase() === String(myOwnerKey).toLowerCase());
          try {
            const { profile: prof, matches } = await fetchRoadToProfileCached(p.riotId, p.region || 'LAN', forceRefresh);
            const analysis = roadToEngine.analyzeSummonerRoadToPlacement(prof, p.categoryId || null, matches, {
              jumpsCount: p.jumpsCount || 0
            });
            return {
              ...analysis,
              region: opgg.normalizeOpggRegion(p.region || 'LAN'),
              registeredAt: p.registeredAt || null,
              canDrop
            };
          } catch {
            const fallbackCat = roadToEngine.ROAD_CATEGORIES.find((c) => c.id === p.categoryId) || roadToEngine.ROAD_CATEGORIES[0];
            return {
              riotId: p.riotId,
              region: opgg.normalizeOpggRegion(p.region || 'LAN'),
              profileIcon: '',
              currentRankLabel: 'Verificando OP.GG...',
              previousSummary: p.peakLabel || 'Sin historial',
              categoryId: fallbackCat.id,
              categoryName: fallbackCat.name,
              targetLabel: fallbackCat.targetLabel,
              progressPct: 0,
              rankScore: 0,
              wins: 0,
              losses: 0,
              winRate: 0,
              reachedCap: false,
              canJump: false,
              nextCategoryId: fallbackCat.nextId,
              nextCategoryName: fallbackCat.nextName,
              streak: { type: null, count: 0 },
              jumpsCount: p.jumpsCount || 0,
              badges: roadToEngine.buildRoadToBadges({ categoryId: fallbackCat.id, jumpsCount: p.jumpsCount || 0 }),
              canDrop
            };
          }
        })
      );
      enriched.push(...results);
    }

    const leaderboardByCategory = {};
    for (const cat of roadToEngine.ROAD_CATEGORIES) {
      const sorted = enriched
        .filter((e) => e.categoryId === cat.id)
        .sort((a, b) => (b.rankScore - a.rankScore) || (b.winRate - a.winRate));
      sorted.forEach((p, idx) => {
        p.badges = roadToEngine.buildRoadToBadges({
          categoryId: p.categoryId,
          reachedCap: p.reachedCap,
          winRate: p.winRate,
          wins: p.wins,
          losses: p.losses,
          streak: p.streak,
          jumpsCount: p.jumpsCount || 0,
          rankPos: idx === 0 && sorted.length > 0 ? 1 : idx + 1
        });
      });
      leaderboardByCategory[cat.id] = sorted;
    }

    return {
      source,
      roadToChannelId: roadToChan,
      discordConfigured: Boolean(discordClient.hasDiscordTransport(dc) && roadToChan),
      adminOnly,
      active: Boolean(rawState.active),
      title: rawState.title || '',
      openedAt: rawState.openedAt || null,
      openedBy: rawState.openedBy || '',
      announcement: source === 'discord' ? (rawState.announcement || null) : syncEngine.loadLocalAnnouncement(),
      categories: roadToEngine.ROAD_CATEGORIES,
      leaderboardByCategory,
      participants: enriched
    };
  }

  if (req.method === 'GET' && pathname === '/api/roadto/state') {
    const force = urlObj.searchParams.get('refresh') === '1';
    return sendJson(res, 200, await getRoadToStateSnapshot(force));
  }

  if (req.method === 'POST' && pathname === '/api/roadto/open') {
    const body = await readRequestBody(req);
    const title = String(body.title || '').trim();
    const dc = syncEngine.loadConfig().discord || {};
    const roadToChan = dc.enabled && discordClient.hasDiscordTransport(dc) ? await resolveRoadToChannelId(dc) : '';
    if (isDiscordChanReady(dc, roadToChan)) {
      if (dc.adminOnly !== false) {
        return sendJson(res, 403, {
          error: 'Modo Solo Admin activo: abre Road To escribiendo !ROADTO ON directamente en tu canal #road-to de Discord.'
        });
      }
      await postDiscordChat(dc, roadToChan, title ? `!ROADTO ON ${title}` : '!ROADTO ON');
    } else {
      syncEngine.saveLocalRoadTo({
        active: true,
        title,
        openedAt: new Date().toISOString(),
        openedBy: 'Local',
        participants: []
      });
    }
    return sendJson(res, 200, await getRoadToStateSnapshot());
  }

  if (req.method === 'POST' && pathname === '/api/roadto/close') {
    const dc = syncEngine.loadConfig().discord || {};
    const roadToChan = dc.enabled && discordClient.hasDiscordTransport(dc) ? await resolveRoadToChannelId(dc) : '';
    if (isDiscordChanReady(dc, roadToChan)) {
      if (dc.adminOnly !== false) {
        return sendJson(res, 403, {
          error: 'Modo Solo Admin activo: cierra Road To escribiendo !ROADTO OFF en tu canal #road-to de Discord.'
        });
      }
      await postDiscordChat(dc, roadToChan, '!ROADTO OFF');
    } else {
      syncEngine.saveLocalRoadTo({ active: false, title: '', openedAt: null, openedBy: '', participants: [] });
    }
    return sendJson(res, 200, await getRoadToStateSnapshot());
  }

  if (req.method === 'POST' && pathname === '/api/roadto/register') {
    const body = await readRequestBody(req);
    const cfg = syncEngine.loadConfig();
    const region = opgg.normalizeOpggRegion(body.region || cfg.riotAccount?.region || 'LAN');
    const rawRiotId = String(body.riotId || '').trim();
    if (!rawRiotId) {
      return sendJson(res, 400, { error: 'Ingresa tu Riot ID (Nombre#TAG).' });
    }

    let analysis;
    try {
      const { profile: prof, matches } = await fetchRoadToProfileCached(rawRiotId, region, true);
      analysis = roadToEngine.analyzeSummonerRoadToPlacement(prof, null, matches);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }

    const myOwnerKey = syncEngine.getClientOwnerKey();
    const dc = cfg.discord || {};
    const roadToChan = dc.enabled && discordClient.hasDiscordTransport(dc) ? await resolveRoadToChannelId(dc) : '';
    if (isDiscordChanReady(dc, roadToChan)) {
      const snapCheck = await getRoadToStateSnapshot();
      if (!snapCheck.active) {
        return sendJson(res, 400, { error: 'No hay un evento Road To abierto en Discord actualmente.' });
      }
      const existing = (snapCheck.participants || []).find((p) => p.riotId.toLowerCase() === analysis.riotId.toLowerCase());
      if (existing && !existing.canDrop) {
        return sendJson(res, 403, { error: `La cuenta "${analysis.riotId}" ya fue registrada por otro jugador.` });
      }
      await postDiscordChat(
        dc,
        roadToChan,
        `!RTREG ${analysis.riotId} | ${region} | ${analysis.categoryId} | ${analysis.referencePeakLabel} | reg:${myOwnerKey}`
      );
    } else {
      const local = syncEngine.loadLocalRoadTo();
      if (!local.active) {
        return sendJson(res, 400, { error: 'No hay un evento Road To abierto actualmente.' });
      }
      const list = local.participants || [];
      const idx = list.findIndex((p) => p.riotId.toLowerCase() === analysis.riotId.toLowerCase());
      if (idx >= 0 && list[idx].ownerKey && list[idx].ownerKey !== myOwnerKey) {
        return sendJson(res, 403, { error: `La cuenta "${analysis.riotId}" ya fue registrada por otro jugador.` });
      }
      const rec = {
        riotId: analysis.riotId,
        region,
        categoryId: idx >= 0 ? roadToEngine.higherCategoryId(list[idx].categoryId, analysis.categoryId) : analysis.categoryId,
        peakLabel: analysis.referencePeakLabel,
        ownerKey: myOwnerKey,
        registeredAt: new Date().toISOString()
      };
      if (idx >= 0) list[idx] = rec;
      else list.push(rec);
      local.participants = list;
      syncEngine.saveLocalRoadTo(local);
    }

    const updatedSnap = await getRoadToStateSnapshot();
    return sendJson(res, 200, { ...updatedSnap, registeredPlacement: analysis });
  }

  if (req.method === 'POST' && pathname === '/api/roadto/jump') {
    const body = await readRequestBody(req);
    const riotId = String(body.riotId || '').trim();
    if (!riotId) return sendJson(res, 400, { error: 'Falta riotId.' });

    const snap = await getRoadToStateSnapshot();
    if (!snap.active) return sendJson(res, 400, { error: 'No hay evento Road To activo.' });
    const entry = (snap.participants || []).find((p) => p.riotId.toLowerCase() === riotId.toLowerCase());
    if (!entry) return sendJson(res, 404, { error: 'Jugador no encontrado en el Road To.' });

    const { profile: prof, matches } = await fetchRoadToProfileCached(entry.riotId, entry.region || 'LAN', true);
    const refreshed = roadToEngine.analyzeSummonerRoadToPlacement(prof, entry.categoryId, matches, {
      jumpsCount: entry.jumpsCount || 0
    });
    if (!refreshed.canJump || !refreshed.nextCategoryId) {
      return sendJson(res, 400, {
        error: `${entry.riotId} todavía no alcanza el tope de ${refreshed.categoryName} (${refreshed.targetLabel}). Actual: ${refreshed.currentRankLabel}.`
      });
    }

    const dc = syncEngine.loadConfig().discord || {};
    const roadToChan = dc.enabled && discordClient.hasDiscordTransport(dc) ? await resolveRoadToChannelId(dc) : '';
    if (isDiscordChanReady(dc, roadToChan)) {
      await postDiscordChat(dc, roadToChan, `!RTSALTO ${refreshed.riotId} | ${refreshed.nextCategoryId}`);
    } else {
      const local = syncEngine.loadLocalRoadTo();
      const idx = (local.participants || []).findIndex((p) => p.riotId.toLowerCase() === entry.riotId.toLowerCase());
      if (idx >= 0) {
        local.participants[idx].categoryId = refreshed.nextCategoryId;
        local.participants[idx].jumpsCount = (local.participants[idx].jumpsCount || 0) + 1;
        syncEngine.saveLocalRoadTo(local);
      }
    }
    return sendJson(res, 200, await getRoadToStateSnapshot());
  }

  if (req.method === 'POST' && pathname === '/api/roadto/drop') {
    const body = await readRequestBody(req);
    const riotId = String(body.riotId || '').trim();
    if (!riotId) return sendJson(res, 400, { error: 'Falta riotId.' });

    const snap = await getRoadToStateSnapshot();
    if (!snap.active) return sendJson(res, 400, { error: 'No hay evento Road To activo.' });
    const entry = (snap.participants || []).find((p) => p.riotId.toLowerCase() === riotId.toLowerCase());
    if (!entry) return sendJson(res, 404, { error: 'Jugador no encontrado en Road To.' });
    if (!entry.canDrop) {
      return sendJson(res, 403, { error: 'Solo quien registró esta cuenta puede darla de baja.' });
    }

    const myOwnerKey = syncEngine.getClientOwnerKey();
    const dc = syncEngine.loadConfig().discord || {};
    const roadToChan = dc.enabled && discordClient.hasDiscordTransport(dc) ? await resolveRoadToChannelId(dc) : '';
    if (isDiscordChanReady(dc, roadToChan)) {
      await postDiscordChat(dc, roadToChan, `!RTBAJA ${entry.riotId} | by:${myOwnerKey}`);
    } else {
      const local = syncEngine.loadLocalRoadTo();
      local.participants = (local.participants || []).filter((p) => p.riotId.toLowerCase() !== entry.riotId.toLowerCase());
      syncEngine.saveLocalRoadTo(local);
    }
    return sendJson(res, 200, await getRoadToStateSnapshot());
  }

  if (req.method === 'POST' && pathname === '/api/shutdown') {
    stopAutoOverlayWatcher();
    if (autoTournamentTimer) {
      clearInterval(autoTournamentTimer);
      autoTournamentTimer = null;
    }
    stopOverlayProcess();
    sendJson(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 100);
    return;
  }

  return sendJson(res, 404, { error: 'Endpoint not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (urlObj.pathname.startsWith('/api/')) {
      await handleApi(req, res, urlObj);
    } else {
      serveStatic(urlObj.pathname, res);
    }
  } catch (err) {
    console.error('Server error:', err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: err.message || 'Internal Server Error' });
    }
  }
});

if (require.main === module) {
  process.on('uncaughtException', (err) => {
    console.error('Uncaught server exception:', err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`LoL Ranked Advisor ya está corriendo en http://127.0.0.1:${PORT}`);
      process.exit(0);
    }
    throw err;
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`LoL Ranked Advisor escuchando en http://127.0.0.1:${PORT}`);
    startAutoOverlayWatcher();
    autoTournamentTimer = setInterval(async () => {
      if (torneoSyncBusy) return;
      const dc = syncEngine.loadConfig().discord || {};
      if (!isDiscordChanReady(dc, dc.channelId)) return;
      torneoSyncBusy = true;
      try {
        await getTournamentStateSnapshot();
      } catch {
        // Non-fatal background sync error
      } finally {
        torneoSyncBusy = false;
      }
    }, 6500);
  });
  process.on('SIGINT', () => {
    stopAutoOverlayWatcher();
    if (autoTournamentTimer) clearInterval(autoTournamentTimer);
    stopOverlayProcess();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stopAutoOverlayWatcher();
    if (autoTournamentTimer) clearInterval(autoTournamentTimer);
    stopOverlayProcess();
    process.exit(0);
  });
}

module.exports = { server, hydrateBuild };
