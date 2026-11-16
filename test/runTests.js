const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const opgg = require('../lib/opggClient');
const lcu = require('../lib/lcuWatcher');
const syncEngine = require('../lib/syncEngine');
const liveOverlay = require('../lib/liveOverlay');
const ddragon = require('../lib/ddragonClient');
const tournamentEngine = require('../lib/tournamentEngine');
const roadToEngine = require('../lib/roadToEngine');
const discordClient = require('../lib/discordTournamentClient');
const { server } = require('../server');

async function runUnitTests() {
  // 1. TOON parser unit test
  const sample = `class Root: data
class Data: positions
class Positions: top,mid
class Top: champion,play,win,win_rate

Root(Data(Positions([Top("Ahri",100,52,0.52)],[Top("Kha'Zix",200,98,0.49)])))`;

  const parsed = opgg.parseOpggResponseText(sample);
  assert.strictEqual(parsed.data.positions.top[0].champion, 'Ahri');
  assert.strictEqual(parsed.data.positions.top[0].win, 52);
  assert.strictEqual(parsed.data.positions.mid[0].champion, "Kha'Zix");

  // 2. Champion param formatting
  assert.strictEqual(opgg.toOpggChampionParam("Kai'Sa"), 'KAISA');
  assert.strictEqual(opgg.toOpggChampionParam('Dr. Mundo'), 'DR_MUNDO');
  assert.strictEqual(opgg.toOpggChampionParam('Nunu & Willump'), 'NUNU');
  assert.strictEqual(opgg.toOpggChampionParam('Lee Sin'), 'LEE_SIN');

  // 3. LCU position normalization
  assert.strictEqual(lcu.normalizeLcuPosition('MIDDLE'), 'mid');
  assert.strictEqual(lcu.normalizeLcuPosition('BOTTOM'), 'adc');
  assert.strictEqual(lcu.normalizeLcuPosition('UTILITY'), 'support');
  assert.strictEqual(lcu.normalizeLcuPosition('TOP'), 'top');
  assert.strictEqual(lcu.normalizeLcuPosition('JUNGLE'), 'jungle');
  assert.strictEqual(lcu.normalizeLcuPosition(''), null);

  // 4. LCU Game Mode Detection (Ranked Flex vs ARAM)
  const flexSession = {
    benchEnabled: false,
    benchChampions: [],
    myTeam: [
      { cellId: 0, assignedPosition: 'MIDDLE' },
      { cellId: 1, assignedPosition: 'TOP' },
      { cellId: 2, assignedPosition: 'JUNGLE' },
      { cellId: 3, assignedPosition: 'BOTTOM' },
      { cellId: 4, assignedPosition: 'UTILITY' }
    ]
  };
  const flexGf = { gameData: { queue: { id: 440 }, gameMode: 'CLASSIC', map: { id: 11 } } };
  assert.strictEqual(
    lcu.detectAramFromLcu({ gameflow: flexGf, session: flexSession }),
    false,
    'Ranked Flex MUST NOT be detected as ARAM'
  );

  const soloGf = { gameData: { queue: { id: 420 }, gameMode: 'CLASSIC', map: { id: 11 } } };
  assert.strictEqual(
    lcu.detectAramFromLcu({ gameflow: soloGf, session: flexSession }),
    false,
    'Ranked Solo/Duo MUST NOT be detected as ARAM'
  );

  const draftGf = { gameData: { queue: { id: 400 }, gameMode: 'CLASSIC', map: { id: 11 } } };
  assert.strictEqual(
    lcu.detectAramFromLcu({ gameflow: draftGf, session: flexSession }),
    false,
    'Normal Draft MUST NOT be detected as ARAM'
  );

  const blindSession = { benchEnabled: false, benchChampions: [], myTeam: [{ cellId: 0, assignedPosition: '' }] };
  const blindGf = { gameData: { queue: { id: 430 }, gameMode: 'CLASSIC', map: { id: 11 } } };
  assert.strictEqual(
    lcu.detectAramFromLcu({ gameflow: blindGf, session: blindSession }),
    false,
    'Normal Blind Pick MUST NOT be detected as ARAM'
  );

  assert.strictEqual(
    lcu.detectAramFromLcu({ gameflow: null, session: flexSession }),
    false,
    'Session with assigned positions MUST NOT be detected as ARAM even if gameflow is null'
  );

  const aramSession = {
    benchEnabled: true,
    benchChampions: [{ championId: 103, isMine: false }],
    myTeam: [{ cellId: 0, assignedPosition: '' }]
  };
  const aramGf = { gameData: { queue: { id: 450 }, gameMode: 'ARAM', map: { id: 12 } } };
  assert.strictEqual(
    lcu.detectAramFromLcu({ gameflow: aramGf, session: aramSession }),
    true,
    'ARAM matchmade MUST be detected as ARAM'
  );

  const aramCustomGf = { gameData: { queue: { id: 0 }, gameMode: 'ARAM', map: { id: 12 } } };
  assert.strictEqual(
    lcu.detectAramFromLcu({ gameflow: aramCustomGf, session: aramSession }),
    true,
    'Custom ARAM game MUST be detected as ARAM'
  );

  console.log('[PASS] Unit tests (TOON parser, champion slug, LCU position normalization, Ranked Flex vs ARAM mode detection)');
}

async function ensureSeasonSynced() {
  let active = syncEngine.getActiveSeasonData();
  if (!active) {
    console.log('No local season snapshot yet — running live OP.GG MCP sync...');
    active = await syncEngine.syncSeasonFromOpgg({
      onProgress: (evt) => {
        if (evt.stage === 'done' || evt.percent % 25 === 0 || evt.stage === 'ddragon' || evt.stage === 'meta') {
          console.log(`  [Sync ${evt.percent}%] ${evt.message}`);
        }
      }
    });
  }
  assert(active && active.patch, 'Active season must have a patch');
  assert(Object.keys(active.champions).length >= 165, 'Must have all champions');
  assert(active.matchupsCount > 1000, 'Must have >1000 lane matchups cached');
  console.log(`[PASS] Season DB ready: Patch ${active.patch}, ${active.laneEntriesCount} lane entries, ${active.matchupsCount} matchups`);
  return active;
}

function testSmartEnemyInference(seasonData) {
  // Lee Sin (64) + Nautilus (111): enemy has NOT picked Mid yet
  const blindTest = lcu.inferEnemyRoles([64, 111], seasonData);
  const midHit = blindTest.find((e) => e.inferredRole === 'mid');
  assert.strictEqual(midHit, undefined, 'Lee Sin + Nautilus should NOT be assigned to Mid');

  // Lee Sin (64) + Zed (238): Zed should be inferred as Mid
  const midTest = lcu.inferEnemyRoles([64, 238], seasonData);
  const zedHit = midTest.find((e) => e.championId === 238);
  assert.strictEqual(zedHit.inferredRole, 'mid', 'Zed should be inferred as Mid');

  // Live champion resolution & primary lane fallback (e.g. Practice Tool / empty position)
  const jinx = liveOverlay.resolveChampionFromLivePlayer(
    { rawChampionName: 'game_character_displayname_Jinx', championName: 'Jinx' },
    seasonData
  );
  assert(jinx && jinx.id === 222, 'Must resolve Jinx from rawChampionName');
  assert.strictEqual(liveOverlay.findPrimaryLaneForChampion(jinx.id, seasonData), 'adc', 'Must infer Jinx ADC');

  const wukong = liveOverlay.resolveChampionFromLivePlayer(
    { rawChampionName: 'game_character_displayname_MonkeyKing', championName: 'Wukong' },
    seasonData
  );
  assert(wukong && wukong.id === 62, 'Must resolve MonkeyKing -> Wukong');

  // Exact 1-by-1 CS gold-delta tracker between Riot 10-CS checkpoints
  const tr = liveOverlay.createCsTracker();
  assert.strictEqual(
    liveOverlay.trackExactCs(tr, { gameKey: 'a|103', gameTimeSec: 120, baseCs: 0, currentGold: 500, itemsSig: '1056', events: [] }),
    0
  );
  // +21g melee + ~3g passive -> +1 CS (1)
  assert.strictEqual(
    liveOverlay.trackExactCs(tr, { gameKey: 'a|103', gameTimeSec: 121.5, baseCs: 0, currentGold: 524, itemsSig: '1056', events: [] }),
    1
  );
  // +14g caster + ~3g passive -> +1 CS (2)
  assert.strictEqual(
    liveOverlay.trackExactCs(tr, { gameKey: 'a|103', gameTimeSec: 123, baseCs: 0, currentGold: 541, itemsSig: '1056', events: [] }),
    2
  );
  // ChampionKill event +300g must NOT add CS
  assert.strictEqual(
    liveOverlay.trackExactCs(tr, {
      gameKey: 'a|103',
      gameTimeSec: 124.5,
      baseCs: 0,
      currentGold: 844,
      itemsSig: '1056',
      events: [{ EventName: 'ChampionKill' }]
    }),
    2
  );
  // When Riot crosses 10 CS checkpoint, snaps cleanly to 10
  assert.strictEqual(
    liveOverlay.trackExactCs(tr, {
      gameKey: 'a|103',
      gameTimeSec: 150,
      baseCs: 10,
      currentGold: 1050,
      itemsSig: '1056',
      events: [{ EventName: 'ChampionKill' }]
    }),
    10
  );
  console.log('[PASS] Smart enemy lane inference, live build fallback & 1-by-1 CS tracker');
}

async function runHttpIntegrationTests() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 0. Health check
    const health = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
    assert.strictEqual(health.ok, true);
    assert.strictEqual(health.appBuild, '2.2.7');

    // 0b. Cloud Auto-Update check
    const updateCheck = await fetch(`${baseUrl}/api/update/check`).then((r) => r.json());
    assert.strictEqual(typeof updateCheck.updateAvailable, 'boolean');
    assert.strictEqual(updateCheck.currentVersion, '2.2.7');

    // 1. Bootstrap
    const boot = await fetch(`${baseUrl}/api/bootstrap`).then((r) => r.json());
    assert(boot.activeSeason?.patch, 'Bootstrap must return activeSeason');
    assert(boot.champions.length >= 165, 'Bootstrap must return champions');
    assert(boot.telemetry && typeof boot.telemetry.onlineNow === 'number', 'Bootstrap must include telemetry');

    // 1b. Telemetry status endpoint & manual refresh
    const teleStatus = await fetch(`${baseUrl}/api/telemetry/status`).then((r) => r.json());
    assert(typeof teleStatus.onlineNow === 'number', 'Telemetry must return onlineNow');
    assert(teleStatus.clientId && teleStatus.clientId.length > 0, 'Telemetry must return anonymous clientId');
    const teleRefresh = await fetch(`${baseUrl}/api/telemetry/status?refresh=1`).then((r) => r.json());
    assert(typeof teleRefresh.onlineNow === 'number', 'Telemetry refresh must return onlineNow');

    // 2. Blind Pick / First Pick Mid (no enemyLanerId, patch_wr mode)
    const blindRecs = await fetch(`${baseUrl}/api/recommendations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ myRole: 'mid', enemyLanerId: null, mode: 'auto' })
    }).then((r) => r.json());
    assert.strictEqual(blindRecs.isFirstPickOrBlind, true);
    assert.strictEqual(blindRecs.mode, 'patch_wr');
    assert(blindRecs.candidates.length > 20, 'Should return >20 mid candidates');

    // 3. Vs Zed Mid (238): Mejor 1v1 en Línea
    const recs1v1 = await fetch(`${baseUrl}/api/recommendations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ myRole: 'mid', enemyLanerId: 238, mode: 'lane_1v1' })
    }).then((r) => r.json());
    assert.strictEqual(recs1v1.isFirstPickOrBlind, false);
    assert(recs1v1.candidates.some((c) => c.matchup?.soloKillAdvantage), 'Top candidates should have live 1v1 soloKillAdvantage');

    // 4. Vs Zed Mid (238): Mejor WR vs Rival (Season) + auto topCounters
    const recsCounter = await fetch(`${baseUrl}/api/recommendations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ myRole: 'mid', enemyLanerId: 238, mode: 'counter_wr', enrich1v1: false })
    }).then((r) => r.json());
    assert(recsCounter.candidates[0].matchup.winRate > 0.5, 'Top counter vs Zed should have >50% WR');
    assert(Array.isArray(recsCounter.topCounters) && recsCounter.topCounters.length >= 4, 'Should return dedicated topCounters list when enemyLanerId is set');
    assert(recsCounter.topCounters[0].winRateVsEnemy > 0.5, 'Top entry in topCounters vs Zed must have >50% WR');
    assert(!recsCounter.topCounters[0].lowSample, 'Top entry in topCounters must have healthy sample size');
    assert(recsCounter.topCounters[0].winRateVsEnemy >= recsCounter.topCounters[1].winRateVsEnemy, 'topCounters must be sorted descending');

    const recsAutoWithEnemy = await fetch(`${baseUrl}/api/recommendations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ myRole: 'mid', enemyLanerId: 238, mode: 'auto', enrich1v1: false })
    }).then((r) => r.json());
    assert.strictEqual(recsAutoWithEnemy.mode, 'counter_wr', 'Auto mode with enemyLanerId must prioritize counter_wr');

    // 5. Synergy with Lee Sin Jungle (64)
    const recsSyn = await fetch(`${baseUrl}/api/recommendations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        myRole: 'mid',
        allies: [{ championId: 64, role: 'jungle' }],
        mode: 'synergy',
        enrich1v1: false
      })
    }).then((r) => r.json());
    assert(recsSyn.candidates.some((c) => c.synergyAvgWr !== null), 'Should compute synergy WR with Lee Sin');

    // 5b. Solo Mi Pool mode (keeps candidates scoped to myPool, while still surfacing topCounters vs Zed)
    const prevPool = syncEngine.loadConfig().myPool || [];
    try {
      syncEngine.saveConfig({ myPool: [103, 99] }); // Ahri & Lux
      const recsPool = await fetch(`${baseUrl}/api/recommendations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ myRole: 'mid', enemyLanerId: 238, mode: 'my_pool', enrich1v1: false })
      }).then((r) => r.json());
      assert.strictEqual(recsPool.mode, 'my_pool');
      assert.strictEqual(recsPool.candidates.length, 2, 'Solo Mi Pool must return only the 2 pool champs');
      assert(recsPool.candidates.every((c) => [103, 99].includes(c.championId)));
      assert(recsPool.topCounters.length >= 4, 'topCounters vs enemyLanerId must remain populated in Solo Mi Pool mode');
    } finally {
      syncEngine.saveConfig({ myPool: prevPool });
    }

    // 6. Champion build & runes for Ahri (103) vs Zed (238)
    const build = await fetch(`${baseUrl}/api/champion-build?championId=103&role=mid&opponentId=238`).then((r) =>
      r.json()
    );
    assert.strictEqual(build.champion.id, 103);
    assert(build.build.runes.length > 0, 'Must have runes');
    assert(build.build.runes[0].primaryRunes[0].iconUrl.startsWith('https://'), 'Must have rune icon URLs');
    assert(build.build.coreItems.length > 0, 'Must have core items');
    assert(build.build.summonerSpells.length > 0, 'Must have summoner spells');
    assert(build.matchup.tip.length > 0, 'Must have OP.GG matchup tip');

    // 6b. Champion build & runes WITHOUT opponentId (Blind Pick / General Patch optimal runes)
    const ahriNoOpp = await fetch(`${baseUrl}/api/champion-build?championId=103&role=mid`).then((r) => r.json());
    assert(ahriNoOpp.build.runes.length > 0, 'Blind pick champion build MUST have runes');
    assert.strictEqual(ahriNoOpp.build.runes[0].primaryRunes.length, 4, 'Must have 4 primary runes');
    assert.strictEqual(ahriNoOpp.build.runes[0].secondaryRunes.length, 2, 'Must have 2 secondary runes');
    assert(ahriNoOpp.build.coreItems.length > 0, 'Blind pick champion build MUST have core items');

    // 6c. Champion build fallback for Nunu & Willump (20) in jungle
    const nunuBuild = await fetch(`${baseUrl}/api/champion-build?championId=20&role=jungle`).then((r) => r.json());
    assert.strictEqual(nunuBuild.champion.id, 20);
    assert(nunuBuild.build && nunuBuild.build.runes.length > 0, 'Nunu fallback must have runes');
    assert(nunuBuild.build.coreItems.length > 0, 'Nunu fallback must have core items');

    // 6d. Team Tactical Briefing endpoint & champion-build integration
    assert(build.teamBriefing, 'Champion build must include teamBriefing');
    const briefingRes = await fetch(`${baseUrl}/api/team-tactical-briefing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        myRole: 'mid',
        myChampionId: 103,
        allies: [
          { role: 'jungle', championId: 64 },
          { role: 'top', championId: 2 },
          { role: 'adc', championId: 222 },
          { role: 'support', championId: 412 }
        ],
        enemies: [
          { role: 'top', championId: 266 },
          { role: 'mid', championId: 238 }
        ]
      })
    }).then((r) => r.json());
    assert(briefingRes.compStrategy?.title, 'Briefing must have compStrategy title');
    assert.strictEqual(briefingRes.members.length, 5, 'Briefing must return all 5 roles');
    const jgCard = briefingRes.members.find((m) => m.role === 'jungle');
    assert(jgCard.archetype.includes('Ganker'), 'Lee Sin must be early ganker archetype');
    assert(jgCard.strongPointBadge, 'Card must include strongPointBadge');
    assert(jgCard.strongPointsSummary, 'Card must include strongPointsSummary');
    assert(jgCard.tacticalAdvice, 'Card must include tacticalAdvice');
    assert(jgCard.stats && typeof jgCard.stats.winRate === 'number', 'Card must include stats with winRate');
    assert(typeof jgCard.stats.csPerMin === 'number', 'Card must include stats with csPerMin');
    assert(typeof jgCard.stats.kpPct === 'number', 'Card must include stats with kpPct');
    const topCard = briefingRes.members.find((m) => m.role === 'top');
    assert.strictEqual(topCard.laneTendency?.status, 'loses', 'Olaf vs Aatrox top must detect loses status');

    // 6e. ARAM Mode Champion Build (No lane counters, no 1v1 matchup, no tactical briefing, complete build & runes)
    const aramBuild = await fetch(`${baseUrl}/api/champion-build?championId=103&isAram=true&opponentId=238`).then((r) =>
      r.json()
    );
    assert.strictEqual(aramBuild.isAram, true, 'ARAM build must be flagged isAram');
    assert.strictEqual(aramBuild.gameMode, 'ARAM');
    assert.strictEqual(aramBuild.role, 'ARAM');
    assert.strictEqual(aramBuild.matchup, null, 'ARAM build must NOT have 1v1 matchup block');
    assert.strictEqual(aramBuild.hardMatchups.length, 0, 'ARAM build must NOT have lane hard counters');
    assert.strictEqual(aramBuild.goodMatchups.length, 0, 'ARAM build must NOT have lane good matchups');
    assert.strictEqual(aramBuild.teamBriefing, null, 'ARAM build must NOT have lane-based tactical briefing');
    assert(aramBuild.build.runes.length > 0, 'ARAM build must have runes');
    assert(aramBuild.build.coreItems.length > 0, 'ARAM build must have core items');
    assert(aramBuild.build.boots.length > 0, 'ARAM build must have boots');
    assert(aramBuild.build.starterItems.length > 0, 'ARAM build must have starter items');

    // 7. Solo/Duo History & Coaching endpoint (SOLORANKED only)
    const prevCfg = syncEngine.loadConfig();
    try {
      const sd = await fetch(`${baseUrl}/api/soloduo-analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameName: 'Hide on bush', tagLine: 'KR1', region: 'KR' })
      }).then((r) => r.json());
      assert(sd.soloDuoCount > 0, 'Must analyze Solo/Duo matches');
      assert(sd.advice.some((a) => a.area.includes('Farmeo')), 'Must include CS coaching');
      assert(sd.advice.some((a) => a.area.includes('Visión')), 'Must include Vision coaching');
      assert(sd.advice.some((a) => a.area.includes('Kills')), 'Must include KP coaching');
      assert(sd.advice.some((a) => a.area.includes('Nivel')), 'Must include Level/XP coaching');
      assert(sd.matches[0].levelDiff !== null, 'Must compare level against direct lane opponent');
    } finally {
      syncEngine.saveConfig({ riotAccount: prevCfg.riotAccount || null });
    }

    // 8. Live Overlay telemetry & item icon caching
    const ov = await fetch(`${baseUrl}/api/live-overlay?demo=1`).then((r) => r.json());
    assert.strictEqual(ov.inGame, true);
    assert(ov.cs.targetPerMin >= 7, 'Demo mid must target >= 7 CS/min');
    assert(ov.xp.expectedLevel >= 10, 'Demo 14:05 min must expect >= level 10');
    assert(Array.isArray(ov.buyOrder) && ov.buyOrder.length >= 4, 'Must provide ordered buy sequence');
    assert(ov.nextItem && ov.nextItem.id > 0, 'Must identify next purchase item');
    const iconRes = await fetch(`${baseUrl}/api/item-icon/${ov.nextItem.id}.png`);
    assert.strictEqual(iconRes.status, 200, 'Must serve cached PNG item icon for overlay');

    // 8a2. Live Overlay in ARAM mode (Single lane 5v5, no direct opponent, custom CS target)
    const ovAram = await fetch(`${baseUrl}/api/live-overlay?demo=1&isAram=true`).then((r) => r.json());
    assert.strictEqual(ovAram.inGame, true);
    assert.strictEqual(ovAram.isAram, true);
    assert.strictEqual(ovAram.gameMode, 'ARAM');
    assert.strictEqual(ovAram.opponentChampion, null, 'ARAM overlay must NOT have opponentChampion');
    assert(ovAram.counterNote.includes('ARAM'), 'ARAM overlay must show ARAM counter note');
    assert.strictEqual(ovAram.cs.status, 'ahead');

    const ovSt = await fetch(`${baseUrl}/api/overlay/status`).then((r) => r.json());
    assert.strictEqual(typeof ovSt.running, 'boolean');
    assert.strictEqual(typeof ovSt.autoInGame, 'boolean');
    assert.strictEqual(typeof ovSt.inGame, 'boolean');

    // 8b. Overlay scale & opacity config validation
    const prevScale = syncEngine.loadConfig().overlayScale;
    const prevOp = syncEngine.loadConfig().overlayOpacity;
    try {
      const cfgRes = await fetch(`${baseUrl}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overlayScale: 0.9, overlayOpacity: 0.55 })
      }).then((r) => r.json());
      assert.strictEqual(cfgRes.config.overlayScale, 0.9);
      assert.strictEqual(cfgRes.config.overlayOpacity, 0.55);
    } finally {
      syncEngine.saveConfig({ overlayScale: prevScale ?? 1.0, overlayOpacity: prevOp ?? 0.68 });
    }

    // 8b2. UI markup & LCU profile/rank endpoint check
    const indexHtml = await fetch(`${baseUrl}/`).then((r) => r.text());
    assert(indexHtml.includes('id="lcuProfileBadge"'), 'Top bar must render LoL profile+rank badge');
    assert(indexHtml.includes('id="draftPoolCard"'), 'Draft & Picks must embed Mi Champion Pool card under Donations');
    const clientJs = await fetch(`${baseUrl}/app.js`).then((r) => r.text());
    new vm.Script(clientJs, { filename: 'public/app.js' });
    assert(clientJs.includes('match-timer-pill') && clientJs.includes('renderLcuProfileBadge'), 'Client JS must drive 30m timers and LCU profile badge');

    const lcuJson = await fetch(`${baseUrl}/api/lcu`).then((r) => r.json());
    assert.strictEqual(typeof lcuJson.connected, 'boolean', '/api/lcu must report connected flag');
    if (lcuJson.connected && lcuJson.currentSummoner?.profileIconId) {
      assert(lcuJson.currentSummoner.profileIconUrl?.includes('/img/profileicon/'), 'Connected summoner must expose Data Dragon icon URL');
    }

    // 8c. TORNEO BLITZ local lifecycle (open 8 -> resize to 2 keeping teams -> draw -> start -> pause -> resume -> winner -> close)
    const tournamentFile = path.join(__dirname, '..', 'data', 'tournament.json');
    const hadTournamentFile = fs.existsSync(tournamentFile);
    const prevTournamentRaw = hadTournamentFile ? fs.readFileSync(tournamentFile, 'utf8') : null;
    const prevDiscordCfg = syncEngine.loadConfig().discord;
    try {
      syncEngine.saveConfig({ discord: { ...(prevDiscordCfg || {}), enabled: false } });
      const openRes = await fetch(`${baseUrl}/api/tournament/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ size: 8 })
      }).then((r) => r.json());
      assert.strictEqual(openRes.active, true);
      assert.strictEqual(openRes.size, 8);
      assert.strictEqual(openRes.drawn, false);
      assert.strictEqual(openRes.source, 'local');

      // Verify OP.GG rejects non-existent Riot ID
      const badRegRes = await fetch(`${baseUrl}/api/tournament/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamName: 'FakeTeam', players: ['CuentaFalsa999999#ZZZ'], region: 'LAN' })
      });
      assert.strictEqual(badRegRes.status, 400, 'Non-existent OP.GG summoner must be rejected');
      const badRegJson = await badRegRes.json();
      assert(badRegJson.error.includes('OP.GG'), 'Rejection error must mention OP.GG verification');

      // Register T1 (1/8) and G2 (2/8), confirm Sorteo rejects until full
      const regT1 = await fetch(`${baseUrl}/api/tournament/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamName: 'T1', players: ['Hide on bush#KR1'], region: 'KR' })
      }).then((r) => r.json());
      assert(regT1.teams.some((t) => t.name === 'T1'), 'Verified KR team T1 must register');
      assert(Array.isArray(regT1.teamRosters?.T1), 'Snapshot must expose teamRosters for bracket UI');

      const earlyDrawRes = await fetch(`${baseUrl}/api/tournament/draw`, { method: 'POST', body: '{}' });
      assert.strictEqual(earlyDrawRes.status, 400, 'Sorteo must wait until all teams are registered');

      const regG2 = await fetch(`${baseUrl}/api/tournament/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamName: 'G2', players: ['Ngelx#T1f4e'], region: 'LAN' })
      }).then((r) => r.json());
      assert(regG2.teams.some((t) => t.name === 'G2'), 'Verified LAN team G2 must register');

      // Resize 8 -> 2 without losing registered teams
      const resizeRes = await fetch(`${baseUrl}/api/tournament/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ size: 2 })
      }).then((r) => r.json());
      assert.strictEqual(resizeRes.size, 2, 'Resize must change tournament slots to 2');
      assert.strictEqual(resizeRes.teams.length, 2, 'Resize must preserve already registered teams');

      const drawRes = await fetch(`${baseUrl}/api/tournament/draw`, { method: 'POST', body: '{}' }).then((r) => r.json());
      assert.strictEqual(drawRes.drawn, true, 'Sorteo must mark tournament as drawn');
      assert(drawRes.bracket.matches.GF1.teamA && drawRes.bracket.matches.GF1.teamB, '2-team Sorteo populates GF1');
      assert.strictEqual(drawRes.bracket.matches.GF1.canEditRoom, true, 'Match captains must be allowed to set room & password');

      // Test Room Name & Password + Global Announcement + MVP Stats Leaderboard in Local mode
      const roomRes = await fetch(`${baseUrl}/api/tournament/room`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId: 'GF1', roomName: 'FinalSala1', roomPass: '7777' })
      }).then((r) => r.json());
      assert.strictEqual(roomRes.bracket.matches.GF1.roomName, 'FinalSala1');
      assert.strictEqual(roomRes.bracket.matches.GF1.roomPass, '7777');

      const announcementFile = path.join(__dirname, '..', 'data', 'announcement.json');
      const hadAnnFile = fs.existsSync(announcementFile);
      const prevAnnRaw = hadAnnFile ? fs.readFileSync(announcementFile, 'utf8') : null;
      try {
        await fetch(`${baseUrl}/api/announcement`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'Hoy Torneo 9PM' })
        });
        const stateWithAviso = await fetch(`${baseUrl}/api/tournament/state`).then((r) => r.json());
        assert.strictEqual(stateWithAviso.announcement?.text, 'Hoy Torneo 9PM', 'Global announcement must propagate on state poll');
      } finally {
        if (hadAnnFile) fs.writeFileSync(announcementFile, prevAnnRaw, 'utf8');
        else if (fs.existsSync(announcementFile)) fs.unlinkSync(announcementFile);
      }

      const localWithStats = syncEngine.loadLocalTournament();
      localWithStats.matchStats = [
        {
          matchId: 'GF1',
          gameId: 55501,
          durationSec: 1620,
          players: [
            { riotId: 'Hide on bush#KR1', teamName: 'T1', championId: 103, win: true, kills: 12, deaths: 1, assists: 8, cs: 240, damage: 34000, gold: 16500 },
            { riotId: 'Ngelx#T1f4e', teamName: 'G2', championId: 238, win: false, kills: 3, deaths: 5, assists: 4, cs: 190, damage: 18000, gold: 11500 }
          ]
        }
      ];
      syncEngine.saveLocalTournament(localWithStats);
      const stateWithMvp = await fetch(`${baseUrl}/api/tournament/state`).then((r) => r.json());
      assert.strictEqual(stateWithMvp.mvpLeaderboard?.[0]?.riotId, 'Hide on bush#KR1', 'MVP table must rank top performer #1');

      const startRes = await fetch(`${baseUrl}/api/tournament/start`, { method: 'POST', body: '{}' }).then((r) => r.json());
      assert.strictEqual(startRes.started, true, 'Start must begin tournament');
      assert(startRes.bracket.matches.GF1.readyAtMs > 0, 'Start must trigger 30-min countdown timestamp on ready match');

      const pauseRes = await fetch(`${baseUrl}/api/tournament/pause`, { method: 'POST', body: '{}' }).then((r) => r.json());
      assert.strictEqual(pauseRes.paused, true, 'Pause must freeze tournament');

      const resumeRes = await fetch(`${baseUrl}/api/tournament/resume`, { method: 'POST', body: '{}' }).then((r) => r.json());
      assert.strictEqual(resumeRes.paused, false, 'Resume must unfreeze tournament');
      assert.strictEqual(resumeRes.pauseIntervals.length, 1, 'Resume must record closed pause interval');

      const win2Res = await fetch(`${baseUrl}/api/tournament/winner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId: 'GF1', winnerName: 'T1' })
      }).then((r) => r.json());
      assert.strictEqual(win2Res.bracket.champion, 'T1', '2-team winner must become Champion');

      const dropRes = await fetch(`${baseUrl}/api/tournament/drop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamName: 'G2' })
      }).then((r) => r.json());
      assert(!dropRes.teams.some((t) => t.name === 'G2'), 'Creator must be able to drop their own team');
      assert(dropRes.teams.every((t) => !('ownerKey' in t)), 'Snapshot must never leak raw ownerKey');
      assert.strictEqual(dropRes.teams.length, 1);

      // Simulate a team registered by ANOTHER player and verify drop & overwrite are blocked (403)
      const localWithOther = syncEngine.loadLocalTournament();
      localWithOther.teams.push({ name: 'OTHER', players: ['Faker#KR1'], ownerKey: 'other_user_999', registeredAt: new Date().toISOString() });
      syncEngine.saveLocalTournament(localWithOther);
      const stateWithOther = await fetch(`${baseUrl}/api/tournament/state`).then((r) => r.json());
      const otherEntry = stateWithOther.teams.find((t) => t.name === 'OTHER');
      assert.strictEqual(otherEntry?.canDrop, false, 'Another user team must expose canDrop: false');
      const blockDropOther = await fetch(`${baseUrl}/api/tournament/drop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamName: 'OTHER' })
      });
      assert.strictEqual(blockDropOther.status, 403, 'Dropping another player team must return HTTP 403');

      const closeRes = await fetch(`${baseUrl}/api/tournament/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }).then((r) => r.json());
      assert.strictEqual(closeRes.active, false);
    } finally {
      syncEngine.saveConfig({ discord: prevDiscordCfg || { enabled: false, botToken: '', channelId: '', roadToChannelId: '', webhookUrl: '' } });
      if (hadTournamentFile) {
        fs.writeFileSync(tournamentFile, prevTournamentRaw, 'utf8');
      } else if (fs.existsSync(tournamentFile)) {
        fs.unlinkSync(tournamentFile);
      }
    }

    // 8d. ROAD TO local lifecycle (open -> OP.GG season placement -> cap check -> drop -> close)
    const roadToFile = path.join(__dirname, '..', 'data', 'roadto.json');
    const hadRoadToFile = fs.existsSync(roadToFile);
    const prevRoadToRaw = hadRoadToFile ? fs.readFileSync(roadToFile, 'utf8') : null;
    try {
      syncEngine.saveConfig({ discord: { ...(prevDiscordCfg || {}), enabled: false } });
      const openRt = await fetch(`${baseUrl}/api/roadto/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Temporada Prueba' })
      }).then((r) => r.json());
      assert.strictEqual(openRt.active, true);
      assert.strictEqual(openRt.categories.length, 5);

      const badRt = await fetch(`${baseUrl}/api/roadto/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ riotId: 'CuentaFalsa999999#ZZZ', region: 'LAN' })
      });
      assert.strictEqual(badRt.status, 400, 'Non-existent Road To OP.GG account must reject');

      const regRt = await fetch(`${baseUrl}/api/roadto/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ riotId: 'Ngelx#T1f4e', region: 'LAN' })
      }).then((r) => r.json());
      assert.strictEqual(regRt.participants.length, 1);
      assert.strictEqual(regRt.registeredPlacement.categoryId, 'road_master', 'Diamond IV Ngelx must place into Road to Master');

      const earlyJump = await fetch(`${baseUrl}/api/roadto/jump`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ riotId: 'Ngelx#T1f4e' })
      });
      assert.strictEqual(earlyJump.status, 400, 'Cannot jump Road category before hitting cap');

      // Simulate another player's Road To account and confirm self-only drop enforcement (canDrop: false -> 403)
      const localRtOther = syncEngine.loadLocalRoadTo();
      localRtOther.participants.push({
        riotId: 'OtroJugador#LAN',
        region: 'LAN',
        categoryId: 'road_oro',
        peakLabel: 'Oro IV',
        ownerKey: 'other_rt_user_999',
        registeredAt: new Date().toISOString()
      });
      syncEngine.saveLocalRoadTo(localRtOther);
      const rtSnapOther = await fetch(`${baseUrl}/api/roadto/state`).then((r) => r.json());
      assert.strictEqual(rtSnapOther.participants.find((p) => p.riotId === 'OtroJugador#LAN')?.canDrop, false);
      const blockedDropRt = await fetch(`${baseUrl}/api/roadto/drop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ riotId: 'OtroJugador#LAN' })
      });
      assert.strictEqual(blockedDropRt.status, 403, 'Dropping another player from Road To must return HTTP 403');

      const dropRt = await fetch(`${baseUrl}/api/roadto/drop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ riotId: 'Ngelx#T1f4e' })
      }).then((r) => r.json());
      assert.strictEqual(dropRt.participants.length, 1, 'Self drop must only remove own Road To entry');

      const closeRt = await fetch(`${baseUrl}/api/roadto/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      }).then((r) => r.json());
      assert.strictEqual(closeRt.active, false);
    } finally {
      syncEngine.saveConfig({ discord: prevDiscordCfg || { enabled: false, botToken: '', channelId: '', roadToChannelId: '', webhookUrl: '' } });
      if (hadRoadToFile) {
        fs.writeFileSync(roadToFile, prevRoadToRaw, 'utf8');
      } else if (fs.existsSync(roadToFile)) {
        fs.unlinkSync(roadToFile);
      }
    }

    // 9. Static HTML, Hextech CSS, and Windows EXEs check
    const html = await fetch(`${baseUrl}/`).then((r) => r.text());
    assert(html.includes('LoL Advisor'), 'Root page must serve HTML');
    assert(html.includes('Historial Solo/Duo'), 'Root page must include Solo/Duo tab');
    assert(html.includes('TORNEO BLITZ'), 'Root page must include TORNEO BLITZ tab');
    assert(html.includes('Road To') && html.includes('view-roadto'), 'Root page must include Road To tab & view');
    assert(!html.includes('id="toggleDcPanelBtn"') && !html.includes('id="torneoDiscordPanel"') && !html.includes('id="dcBotToken"'), 'Discord settings gear & panel must be completely removed so nobody can edit them');
    assert(html.includes('Ejemplo#lan') && !html.includes('Ngelx#T1f4e'), 'Road To placeholder must use Ejemplo#lan instead of personal Riot ID');
    assert(!html.includes('Abrir 4 Eq') && !html.includes('closeTorneoBtn'), 'Banner must NOT have open/close size buttons');
    assert(html.includes('NO HAY TORNEO ABIERTO') && html.includes('drawTorneoBtn'), 'HTML must have glowing status & Sorteo controls');
    assert(html.includes('Verificar y registrar'), 'Register button must say Verificar y registrar');
    assert(html.includes('https://paypal.me/ADVISOR360') && html.includes('paypal-donate-btn') && html.includes('DONACIONES'), 'HTML must include top-right DONACIONES PayPal button');
    assert(html.includes('overlayToggleBtn') && html.includes('recomendaciones mientras juegas'), 'Root page must include Overlay toggle & caption');
    assert(html.includes('id="globalAvisoBanner"') && html.includes('id="torneoMvpBody"'), 'Root page must include global announcement banner and MVP table');
    assert(html.includes('id="enemyCountersStrip"'), 'Root page must include enemyCountersStrip');
    const bootJson = await fetch(`${baseUrl}/api/bootstrap`).then((r) => r.json());
    assert(!bootJson.config?.discord?.botToken && !bootJson.config?.discord?.webhookUrl && !bootJson.config?.clientOwnerKey, '/api/bootstrap must never expose botToken/webhookUrl/clientOwnerKey');
    const lockCfgRes = await fetch(`${baseUrl}/api/tournament/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":false}' });
    assert.strictEqual(lockCfgRes.status, 403, 'Discord config endpoint must stay locked');
    assert(html.includes('regRegionSelect') && html.includes('torneoRegMsg'), 'HTML must include OP.GG region selector');
    assert(html.includes('cfgOverlayScale') && html.includes('applyOverlayPosBtn'), 'HTML must include size and position controls');
    const appJs = await fetch(`${baseUrl}/app.js`).then((r) => r.text());
    assert(appJs.includes('Pegar Runas a LoL'), 'app.js must include Pegar Runas button');
    assert(appJs.includes('setTorneoMatchWinner'), 'app.js must include TORNEO BLITZ winner handler');
    assert(appJs.includes('Organizado por <strong>NGELX</strong>'), 'app.js must show Organizado por NGELX');
    assert(appJs.includes('jumpRoadToCategory') && appJs.includes('renderRoadToView'), 'app.js must include Road To controller');
    assert(appJs.includes('editTorneoRoom') && appJs.includes('renderTorneoMvpTable') && appJs.includes('syncGlobalAnnouncementBanner'), 'app.js must support match room codes, MVP leaderboard, and announcement banner');
    assert(appJs.includes('rt-badge-pill'), 'app.js must render Road To streak and category badges');
    assert(appJs.includes('renderEnemyCountersStrip') && appJs.includes('selectEnemyLaner'), 'app.js must render enemyCountersStrip when enemyLanerId is selected');
    assert(appJs.includes('dropTorneoTeam') && appJs.includes('renderRosterChipsHtml') && appJs.includes('team-name-glow'), 'app.js must include team drop, glow names, and green/red lobby chips');
    assert(appJs.includes("switchView('draft')"), 'app.js must auto-switch to draft on champ select');
    assert(appJs.includes('telemetryRefreshBtn') && appJs.includes('refreshTelemetry(true)'), 'app.js must support telemetry refresh button');
    assert(html.includes('id="telemetryRefreshBtn"'), 'HTML must include telemetryRefreshBtn in online pill');
    const css = await fetch(`${baseUrl}/styles.css`).then((r) => r.text());
    assert(css.includes('--hex: #3fd0d4') && css.includes('--brass: #b8975a'), 'CSS must use LOL VERSUS Hextech tokens');
    assert(css.includes('.lcu-profile-badge[data-tier="EMERALD"]'), 'CSS must color LCU badge by ranked division tier');
    assert(css.includes('.enemy-counters-strip') && css.includes('.counter-card'), 'CSS must style enemy counters strip and cards');
    assert(css.includes('.team-name-glow') && css.includes('.torneo-status-hero') && css.includes('.glow-white-heading'), 'CSS must style glowing team names, registration & status');
    assert(css.includes('.aram-mode-banner') && css.includes('.aram-banner-title'), 'CSS must style ARAM mode banner');
    assert(css.includes('.telemetry-refresh-btn'), 'CSS must style telemetry-refresh-btn');
    assert(fs.existsSync(path.join(__dirname, '..', 'LoL Advisor.exe')), 'LoL Advisor.exe must exist');
    assert(fs.existsSync(path.join(__dirname, '..', 'LoL Overlay.exe')), 'LoL Overlay.exe must exist');
    assert(fs.existsSync(path.join(__dirname, '..', 'Instalador LoL Advisor.exe')), 'Instalador LoL Advisor.exe must exist');

    console.log('[PASS] HTTP API integration tests (Bootstrap, Blind Pick, 1v1, Counter WR, Synergy, Build/Runes, Solo/Duo Coaching, Live Overlay, TORNEO BLITZ, Hextech UI, EXEs)');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function testTournamentEngine() {
  // Verify 2-team duel + 4, 8, and 16-team Double-Elimination brackets
  const b2 = tournamentEngine.generateDoubleElimBracket([{ name: 'A' }, { name: 'B' }], 2);
  assert.strictEqual(b2.size, 2);
  assert.strictEqual(b2.winnersRounds.length, 0);
  assert.strictEqual(b2.losersRounds.length, 0);
  assert.strictEqual(b2.matches.GF1.teamA, 'A');
  assert.strictEqual(b2.matches.GF1.teamB, 'B');

  for (const size of [4, 8, 16]) {
    const sampleTeams = Array.from({ length: size }, (_, i) => ({ name: `Team${i + 1}`, players: [] }));
    const bracket = tournamentEngine.generateDoubleElimBracket(sampleTeams, size);
    assert.strictEqual(bracket.size, size);
    assert.strictEqual(bracket.grandFinalId, 'GF1');
    assert(bracket.winnersRounds.length >= 2);
    assert(bracket.losersRounds.length >= 2);
  }

  // Verify Discord command parsing lifecycle: !TORNEO ON -> registrations -> !GANADOR -> !TORNEO OFF
  const openMessages = [
    { id: '1', timestamp: '2026-11-10T10:00:00Z', author: { username: 'Organizador' }, content: '!TORNEO ON 8' },
    { id: '2', timestamp: '2026-11-10T10:01:00Z', author: { username: 'Cap1' }, content: '!T1 Faker#KR1, Oner#KR1, Doran#KR1, Gumayusi#KR1, Keria#KR1' },
    { id: '3', timestamp: '2026-11-10T10:02:00Z', author: { username: 'Cap2' }, content: '!G2 BrokenBlade#EUW, SkewMond#EUW, Caps#EUW, HansSama#EUW, Labrov#EUW' },
    { id: '4', timestamp: '2026-11-10T10:03:00Z', author: { username: 'Cap3' }, content: '!FNC Oscarinin#EUW, Razork#EUW, Humanoid#EUW, Upset#EUW, Mikyx#EUW' },
    { id: '5', timestamp: '2026-11-10T10:04:00Z', author: { username: 'Cap4' }, content: '!C9 Thanatos#NA1, Blaber#NA1, Loki#NA1, Zven#NA1, Vulcan#NA1' },
    { id: '6', timestamp: '2026-11-10T10:05:00Z', author: { username: 'Organizador' }, content: '!GANADOR W1 T1' }
  ];
  const parsedOpen = tournamentEngine.parseDiscordMessagesToTournament(openMessages);
  assert.strictEqual(parsedOpen.active, true);
  assert.strictEqual(parsedOpen.size, 8);
  assert.strictEqual(parsedOpen.teams.length, 4);
  assert.strictEqual(parsedOpen.bracket.matches.W5.teamA, 'T1');

  const closedMessages = [
    ...openMessages,
    { id: '7', timestamp: '2026-11-10T10:06:00Z', author: { username: 'Organizador' }, content: '!TORNEO OFF' }
  ];
  const parsedClosed = tournamentEngine.parseDiscordMessagesToTournament(closedMessages);
  assert.strictEqual(parsedClosed.active, false);
  assert.strictEqual(parsedClosed.teams.length, 0);

  // Verify Admin-only Discord mode: non-admin/bots cannot open, close, drop others, or declare winners
  const adminOpts = { adminOnly: true, allowedAdminIds: ['382962894075199488'] };
  const ignoredOpen = tournamentEngine.parseDiscordMessagesToTournament(
    [
      { id: '1', timestamp: '2026-11-10T10:00:00Z', author: { id: '999', username: 'Random' }, content: '!TORNEO ON 4' },
      { id: '2', timestamp: '2026-11-10T10:00:10Z', author: { id: 'bot1', bot: true, username: 'Bot' }, content: '!TORNEO ON 4' }
    ],
    adminOpts
  );
  assert.strictEqual(ignoredOpen.active, false, 'Non-admin and bot must NOT open tournament');

  const mixedAdminFeed = [
    { id: '1', timestamp: '2026-11-10T10:00:00Z', author: { id: '382962894075199488', username: 'Admin' }, content: '!TORNEO ON 4' },
    { id: '2', timestamp: '2026-11-10T10:01:00Z', author: { id: '111', username: 'Cap1' }, content: '!T1 Faker#KR1' },
    { id: '3', timestamp: '2026-11-10T10:02:00Z', author: { id: '222', username: 'Cap2' }, content: '!G2 Caps#EUW' },
    { id: '4', timestamp: '2026-11-10T10:02:10Z', author: { id: '333', username: 'Cap3' }, content: '!FNC Upset#EUW' },
    { id: '5', timestamp: '2026-11-10T10:02:20Z', author: { id: '444', username: 'Cap4' }, content: '!C9 Blaber#NA1' },
    { id: '6', timestamp: '2026-11-10T10:02:30Z', author: { id: '555', username: 'Cap5' }, content: '!TEMP TempPlayer#LAN' },
    { id: '7', timestamp: '2026-11-10T10:03:00Z', author: { id: '555', username: 'Cap5' }, content: '!BAJA TEMP' },
    { id: '7b', timestamp: '2026-11-10T10:03:05Z', author: { id: '999', username: 'Saboteur' }, content: '!BAJA T1' },
    { id: '7c', timestamp: '2026-11-10T10:03:08Z', author: { id: 'bot1', bot: true, username: 'Bot' }, content: '!BOTOWN Alpha#LAN | reg:owner1' },
    { id: '7d', timestamp: '2026-11-10T10:03:09Z', author: { id: 'bot1', bot: true, username: 'Bot' }, content: '!BAJA BOTOWN | by:wrongowner' },
    { id: '7e', timestamp: '2026-11-10T10:03:10Z', author: { id: 'bot1', bot: true, username: 'Bot' }, content: '!BOTOWN Hijack#LAN | reg:wrongowner' },
    { id: '7f', timestamp: '2026-11-10T10:03:12Z', author: { id: 'bot1', bot: true, username: 'Bot' }, content: '!BAJA BOTOWN | by:owner1' },
    { id: '8', timestamp: '2026-11-10T10:03:15Z', author: { id: 'bot1', bot: true, username: 'Bot' }, content: '!SALA W1 | Faker#KR1' },
    { id: '9', timestamp: '2026-11-10T10:03:30Z', author: { id: '111', username: 'Troll2' }, content: '!GANADOR W1 T1' },
    { id: '10', timestamp: '2026-11-10T10:04:00Z', author: { id: '111', username: 'Troll3' }, content: '!TORNEO OFF' }
  ];
  const guardedState = tournamentEngine.parseDiscordMessagesToTournament(mixedAdminFeed, adminOpts);
  assert.strictEqual(guardedState.active, true, 'Non-admin !TORNEO OFF must be ignored');
  assert.strictEqual(guardedState.teams.length, 4, 'Players can register & drop teams cleanly');
  assert.strictEqual(guardedState.drawn, false, 'Bracket stays undrawn until !SORTEO');
  assert.strictEqual(guardedState.bracket.matches.W1.winner, null, 'Non-admin !GANADOR must be ignored');
  assert.strictEqual(guardedState.lobbyPresence.players.length, 1, 'Bot !SALA command must sync lobby roster');

  const drawnState = tournamentEngine.parseDiscordMessagesToTournament(
    [
      ...mixedAdminFeed,
      { id: '10b', timestamp: '2026-11-10T10:04:30Z', author: { id: '382962894075199488', username: 'Admin' }, content: '!SORTEO 1,0,3,2' }
    ],
    adminOpts
  );
  assert.strictEqual(drawnState.drawn, true, '!SORTEO must mark bracket drawn');
  assert.strictEqual(drawnState.bracket.matches.W1.teamA, 'G2', '!SORTEO order must reorder bracket seeding');

  // Verify Custom Lobby & Match History detection helper (1 participant client is enough)
  const lobbyMatchRes = tournamentEngine.matchLobbyAndCustomGames({
    bracket: guardedState.bracket,
    teams: guardedState.teams,
    openedAt: guardedState.openedAt,
    lobbyPlayers: ['faker#kr1'],
    customGames: [
      {
        gameId: 888999,
        gameCreationMs: new Date('2026-11-10T10:15:00Z').getTime(),
        gameDuration: 1500,
        team100Win: true,
        team200Win: false,
        team100Players: ['Faker#KR1'],
        team200Players: ['Upset#EUW']
      }
    ],
    reportedGameIds: []
  });
  assert.strictEqual(lobbyMatchRes.activeLobbyMatchId, 'W1');
  assert.deepStrictEqual(lobbyMatchRes.detectedResult, {
    matchId: 'W1',
    winnerName: 'T1',
    loserName: 'FNC',
    gameId: 888999,
    gameDuration: 1500,
    playerStats: []
  });

  const botWinnerState = tournamentEngine.parseDiscordMessagesToTournament(
    [
      ...mixedAdminFeed,
      { id: '11', timestamp: '2026-11-10T10:16:00Z', author: { id: 'bot1', bot: true, username: 'Bot' }, content: '!BOTGANADOR W1 T1 | game:888999' },
      { id: '12', timestamp: '2026-11-10T10:17:00Z', author: { id: 'bot1', bot: true, username: 'Bot' }, content: '!SALA CLEAR' }
    ],
    adminOpts
  );
  assert.strictEqual(botWinnerState.bracket.matches.W1.winner, 'T1', 'Bot !BOTGANADOR must advance verified winner');
  assert.strictEqual(botWinnerState.lobbyPresence.players.length, 0, '!SALA CLEAR must clear lobby presence');

  const adminClosedState = tournamentEngine.parseDiscordMessagesToTournament(
    [
      ...mixedAdminFeed,
      { id: '13', timestamp: '2026-11-10T10:05:00Z', author: { id: '382962894075199488', username: 'Admin' }, content: '!GANADOR W1 T1' },
      { id: '14', timestamp: '2026-11-10T10:06:00Z', author: { id: '382962894075199488', username: 'Admin' }, content: '!TORNEO OFF' }
    ],
    adminOpts
  );
  assert.strictEqual(adminClosedState.active, false, 'Real admin !TORNEO OFF must close tournament');

  // Verify Resize (8 -> 4 preserving teams), Start (!TORNEO INICIAR + 30m countdown), Downstream trigger, & Overnight Pause/Resume
  const resizeStartFeed = [
    { id: 'r1', timestamp: '2026-11-10T18:00:00Z', author: { id: '382962894075199488', username: 'Admin' }, content: '!TORNEO ON 8' },
    { id: 'r2', timestamp: '2026-11-10T18:01:00Z', author: { id: '111', username: 'C1' }, content: '!T1 Faker#KR1' },
    { id: 'r3', timestamp: '2026-11-10T18:02:00Z', author: { id: '222', username: 'C2' }, content: '!G2 Caps#EUW' },
    { id: 'r4', timestamp: '2026-11-10T18:03:00Z', author: { id: '333', username: 'C3' }, content: '!FNC Upset#EUW' },
    { id: 'r5', timestamp: '2026-11-10T18:04:00Z', author: { id: '444', username: 'C4' }, content: '!C9 Blaber#NA1' },
    { id: 'r6', timestamp: '2026-11-10T18:05:00Z', author: { id: '382962894075199488', username: 'Admin' }, content: '!TORNEO 4' },
    { id: 'r6b', timestamp: '2026-11-10T18:06:00Z', author: { id: '382962894075199488', username: 'Admin' }, content: '!SORTEO 0,1,2,3' },
    { id: 'r7', timestamp: '2026-11-10T18:10:00Z', author: { id: '382962894075199488', username: 'Admin' }, content: '!TORNEO INICIAR' },
    { id: 'r8', timestamp: '2026-11-10T18:20:00Z', author: { id: '382962894075199488', username: 'Admin' }, content: '!GANADOR W1 T1' },
    { id: 'r9', timestamp: '2026-11-10T18:25:00Z', author: { id: '382962894075199488', username: 'Admin' }, content: '!TORNEO PAUSA' },
    { id: 'r10', timestamp: '2026-11-11T18:25:00Z', author: { id: '382962894075199488', username: 'Admin' }, content: '!TORNEO REANUDAR' },
    { id: 'r11', timestamp: '2026-11-11T18:27:00Z', author: { id: '382962894075199488', username: 'Admin' }, content: '!GANADOR W2 G2' }
  ];
  const rsState = tournamentEngine.parseDiscordMessagesToTournament(resizeStartFeed, adminOpts);
  assert.strictEqual(rsState.size, 4, '!TORNEO 4 must resize 8 -> 4');
  assert.strictEqual(rsState.teams.length, 4, 'Resize must keep all 4 registered teams');
  assert.strictEqual(rsState.started, true, '!TORNEO INICIAR must start tournament');
  assert.strictEqual(rsState.paused, false, '!TORNEO REANUDAR must clear paused flag');
  assert.strictEqual(rsState.bracket.matches.W1.readyAtMs, new Date('2026-11-10T18:10:00Z').getTime());
  assert.strictEqual(rsState.bracket.matches.W2.readyAtMs, new Date('2026-11-10T18:10:00Z').getTime());
  assert.strictEqual(
    rsState.bracket.matches.W3.readyAtMs,
    new Date('2026-11-11T18:27:00Z').getTime(),
    'Downstream W3 30-min timer must only start once BOTH finalists arrive'
  );
  // Check overnight pause (18:25 day 1 -> 18:25 day 2 = 24h paused) leaves W2 with exact remaining time (15m elapsed since 18:10 -> 15m left at 18:25 day 2, 10m left at 18:30 day 2)
  const w2RemAtResumePlus5m = tournamentEngine.computeMatchRemainingMs(
    rsState.bracket.matches.W2.readyAtMs,
    rsState.pauseIntervals,
    new Date('2026-11-11T18:30:00Z').getTime()
  );
  assert.strictEqual(w2RemAtResumePlus5m, 10 * 60 * 1000, 'Overnight 24h pause must freeze 30-min match clock accurately');

  const autoDrawnStart = tournamentEngine.parseDiscordMessagesToTournament(
    resizeStartFeed.filter((m) => m.id !== 'r6b').slice(0, 7),
    adminOpts
  );
  assert.strictEqual(autoDrawnStart.drawn, true, '!TORNEO INICIAR must auto-draw if not yet drawn');

  // Verify !AVISO (even before !TORNEO ON), !CLAVE room codes, & !BOTSTATS -> MVP leaderboard
  const featuresFeed = [
    { id: 'f0', timestamp: '2026-11-10T09:50:00Z', author: { id: '382962894075199488' }, content: '!AVISO Hoy 9 PM Torneo Express!' },
    { id: 'f0b', timestamp: '2026-11-10T09:51:00Z', author: { id: '999' }, content: '!AVISO Hacked!' },
    { id: 'f1', timestamp: '2026-11-10T10:00:00Z', author: { id: '382962894075199488' }, content: '!TORNEO ON 2' },
    { id: 'f2', timestamp: '2026-11-10T10:01:00Z', author: { id: 'bot', bot: true }, content: '!T1 Faker#KR1 | reg:cap_a' },
    { id: 'f3', timestamp: '2026-11-10T10:02:00Z', author: { id: 'bot', bot: true }, content: '!G2 Caps#EUW | reg:cap_b' },
    { id: 'f4', timestamp: '2026-11-10T10:03:00Z', author: { id: 'bot', bot: true }, content: '!CLAVE GF1 | SalaHack | 000 | by:wrong_cap' },
    { id: 'f5', timestamp: '2026-11-10T10:04:00Z', author: { id: 'bot', bot: true }, content: '!CLAVE GF1 | BlitzFinal | 9090 | by:cap_a' },
    {
      id: 'f6',
      timestamp: '2026-11-10T10:30:00Z',
      author: { id: 'bot', bot: true },
      content: tournamentEngine.encodeCompactMatchStats('GF1', 777, 1800, [
        { riotId: 'Faker#KR1', teamName: 'T1', championId: 103, win: true, kills: 10, deaths: 1, assists: 7, cs: 250, damage: 32000, gold: 16000 },
        { riotId: 'Caps#EUW', teamName: 'G2', championId: 7, win: false, kills: 4, deaths: 5, assists: 2, cs: 205, damage: 21000, gold: 12000 }
      ])
    }
  ];
  const featState = tournamentEngine.parseDiscordMessagesToTournament(featuresFeed, adminOpts);
  assert.strictEqual(featState.announcement?.text, 'Hoy 9 PM Torneo Express!', 'Only Admin !AVISO must stick');
  assert.strictEqual(featState.bracket.matches.GF1.roomName, 'BlitzFinal', 'Only match captains/Admin may set room credentials');
  assert.strictEqual(featState.bracket.matches.GF1.roomPass, '9090');
  assert.strictEqual(featState.mvpLeaderboard.length, 2, 'Compact !BOTSTATS must build MVP leaderboard');
  assert.strictEqual(featState.mvpLeaderboard[0].riotId, 'Faker#KR1', 'Top KDA/Win player must be rank #1 MVP');

  // Verify Discord channel ID / URL / mention normalization
  assert.strictEqual(
    discordClient.normalizeChannelId('https://discord.com/channels/1540533385154396291/1569830216757411911'),
    '1569830216757411911'
  );
  assert.strictEqual(discordClient.normalizeChannelId('<#1540540850331844658>'), '1540540850331844658');
  assert.strictEqual(discordClient.normalizeChannelId('  1569830216757411911  '), '1569830216757411911');

  console.log('[PASS] TORNEO BLITZ Discord parser & 4/8/16 Double-Elimination bracket unit tests');
}

function testRoadToEngine() {
  // Verify exact category mapping rules: Iron/Bronze -> Oro, Silver/Gold -> Esmeralda, Plat/Emerald -> Diamante, Diamond -> Master, Master+ -> Challenger
  assert.strictEqual(roadToEngine.tierToCategoryId('IRON'), 'road_oro');
  assert.strictEqual(roadToEngine.tierToCategoryId('BRONZE'), 'road_oro');
  assert.strictEqual(roadToEngine.tierToCategoryId('SILVER'), 'road_esmeralda');
  assert.strictEqual(roadToEngine.tierToCategoryId('GOLD'), 'road_esmeralda');
  assert.strictEqual(roadToEngine.tierToCategoryId('PLATINUM'), 'road_diamante');
  assert.strictEqual(roadToEngine.tierToCategoryId('EMERALD'), 'road_diamante');
  assert.strictEqual(roadToEngine.tierToCategoryId('DIAMOND'), 'road_master');
  assert.strictEqual(roadToEngine.tierToCategoryId('MASTER'), 'road_challenger');
  assert.strictEqual(roadToEngine.tierToCategoryId('GRANDMASTER'), 'road_challenger');

  // Smurf check: currently Silver II, but past season was Emerald III -> must place in Road to Diamante
  const smurfProfile = {
    game_name: 'SmurfTest',
    tagline: 'LAN',
    level: 50,
    previous_seasons: [{ season_id: 31, tier_info: { tier: 'EMERALD', division: 3, lp: 40 } }],
    previous_season_tiers: [],
    current_season_high_tiers: [],
    league_stats: [{ game_type: 'SOLORANKED', win: 10, lose: 5, tier_info: { tier: 'SILVER', division: 2, lp: 55 } }]
  };
  const smurfAnalysis = roadToEngine.analyzeSummonerRoadToPlacement(smurfProfile);
  assert.strictEqual(smurfAnalysis.categoryId, 'road_diamante', 'Past season Emerald must override current Silver placement');

  // Cap & Jump check: Bronze player climbs to Gold I -> reaches cap of Road to Oro -> jumps to Road to Esmeralda
  const reachedOroCap = roadToEngine.analyzeSummonerRoadToPlacement(
    {
      game_name: 'Climber',
      tagline: 'LAN',
      level: 80,
      previous_seasons: [{ season_id: 31, tier_info: { tier: 'BRONZE', division: 2, lp: 10 } }],
      league_stats: [{ game_type: 'SOLORANKED', win: 40, lose: 20, tier_info: { tier: 'GOLD', division: 1, lp: 85 } }]
    },
    'road_oro'
  );
  assert.strictEqual(reachedOroCap.categoryId, 'road_oro');
  assert.strictEqual(reachedOroCap.reachedCap, true);
  assert.strictEqual(reachedOroCap.canJump, true);
  assert.strictEqual(reachedOroCap.nextCategoryId, 'road_esmeralda');

  // Master player climbs to Challenger target with live high_leagues cut
  const masterPlayer = roadToEngine.analyzeSummonerRoadToPlacement({
    game_name: 'MasterMain',
    tagline: 'KR1',
    level: 200,
    previous_seasons: [],
    league_stats: [
      {
        game_type: 'SOLORANKED',
        win: 100,
        lose: 80,
        tier_info: { tier: 'MASTER', division: 1, lp: 420 },
        high_leagues: [{ key: 'CHALLENGER', lp_threshold: 1200 }, { key: 'GRANDMASTER', lp_threshold: 700 }]
      }
    ]
  });
  assert.strictEqual(masterPlayer.categoryId, 'road_challenger');
  assert.strictEqual(masterPlayer.reachedCap, false);

  // Streak & Road To Master / Challenger Badges unit test
  const hotMaster = roadToEngine.analyzeSummonerRoadToPlacement(
    {
      game_name: 'RachaKing',
      tagline: 'LAN',
      level: 150,
      previous_seasons: [{ season_id: 31, tier_info: { tier: 'DIAMOND', division: 2, lp: 60 } }],
      league_stats: [{ game_type: 'SOLORANKED', win: 45, lose: 20, tier_info: { tier: 'DIAMOND', division: 1, lp: 70 } }]
    },
    'road_master',
    [
      { game_type: 'SOLORANKED', game_length_second: 1500, created_at: '2026-11-10T18:00:00Z', participants: [{ summoner: { game_name: 'RachaKing', tagline: 'LAN' }, stats: { result: 'WIN' } }] },
      { game_type: 'SOLORANKED', game_length_second: 1600, created_at: '2026-11-10T17:00:00Z', participants: [{ summoner: { game_name: 'RachaKing', tagline: 'LAN' }, stats: { result: 'WIN' } }] },
      { game_type: 'SOLORANKED', game_length_second: 1700, created_at: '2026-11-10T16:00:00Z', participants: [{ summoner: { game_name: 'RachaKing', tagline: 'LAN' }, stats: { result: 'WIN' } }] },
      { game_type: 'SOLORANKED', game_length_second: 1800, created_at: '2026-11-10T15:00:00Z', participants: [{ summoner: { game_name: 'RachaKing', tagline: 'LAN' }, stats: { result: 'LOSE' } }] }
    ],
    { jumpsCount: 1, rankPos: 1 }
  );
  assert.strictEqual(hotMaster.streak?.type, 'W');
  assert.strictEqual(hotMaster.streak?.count, 3, 'Must detect 3-game Solo/Duo win streak');
  assert(hotMaster.badges.some((b) => b.label.includes('Racha 3V')), 'Must generate 🔥 Racha 3V badge');
  assert(hotMaster.badges.some((b) => b.label.includes('Ascendido')), 'Must generate jump badge');
  assert(hotMaster.badges.some((b) => b.label.includes('Camino a Master')), 'Must generate Road to Master milestone badge');

  // Admin-only Discord parser for !ROADTO ON / !ROADTO OFF / !RTREG / !RTSALTO / !RTBAJA
  const rtOpts = { adminOnly: true, allowedAdminIds: ['382962894075199488'] };
  const blockedOpen = roadToEngine.parseDiscordMessagesToRoadTo(
    [{ id: '1', timestamp: '2026-11-10T10:00:00Z', author: { id: '999', username: 'Random' }, content: '!ROADTO ON' }],
    rtOpts
  );
  assert.strictEqual(blockedOpen.active, false);

  const rtFeed = [
    { id: '1', timestamp: '2026-11-10T10:00:00Z', author: { id: '382962894075199488', username: 'Admin' }, content: '!ROADTO ON Copa' },
    { id: '2', timestamp: '2026-11-10T10:01:00Z', author: { id: 'bot', bot: true }, content: '!RTREG Climber#LAN | LAN | road_oro | Bronce II | reg:owner_a' },
    { id: '2b', timestamp: '2026-11-10T10:01:20Z', author: { id: 'bot', bot: true }, content: '!RTREG Target#LAN | LAN | road_oro | Hierro I | reg:owner_b' },
    { id: '2c', timestamp: '2026-11-10T10:01:30Z', author: { id: 'bot', bot: true }, content: '!RTBAJA Climber#LAN | by:wrong_owner' },
    { id: '2d', timestamp: '2026-11-10T10:01:35Z', author: { id: '999', username: 'Saboteur' }, content: '!RTBAJA Climber#LAN' },
    { id: '2e', timestamp: '2026-11-10T10:01:40Z', author: { id: 'bot', bot: true }, content: '!RTBAJA Target#LAN | by:owner_b' },
    { id: '3', timestamp: '2026-11-10T10:02:00Z', author: { id: 'bot', bot: true }, content: '!RTSALTO Climber#LAN | road_esmeralda' },
    { id: '4', timestamp: '2026-11-10T10:03:00Z', author: { id: '999', username: 'Random' }, content: '!ROADTO OFF' }
  ];
  const activeRt = roadToEngine.parseDiscordMessagesToRoadTo(rtFeed, rtOpts);
  assert.strictEqual(activeRt.active, true);
  assert.strictEqual(activeRt.title, 'Copa');
  assert.strictEqual(activeRt.participants.length, 1);
  assert.strictEqual(activeRt.participants[0].riotId, 'Climber#LAN', 'Wrong owner/saboteur must NOT drop another Road To participant');
  assert.strictEqual(activeRt.participants[0].categoryId, 'road_esmeralda');

  const closedRt = roadToEngine.parseDiscordMessagesToRoadTo(
    [...rtFeed, { id: '5', timestamp: '2026-11-10T10:04:00Z', author: { id: '382962894075199488' }, content: '!ROADTO OFF' }],
    rtOpts
  );
  assert.strictEqual(closedRt.active, false);

  console.log('[PASS] ROAD TO ladder categories, past-seasons analysis, jump & Discord parser unit tests');
}

async function testDiscordBridgeWorker() {
  assert.strictEqual(discordClient.hasDiscordTransport({ bridgeUrl: 'https://test.workers.dev/' }), true);
  assert.strictEqual(discordClient.normalizeBridgeUrl('https://test.workers.dev///'), 'https://test.workers.dev');

  const { pathToFileURL } = require('url');
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'cloudflare', 'worker.js')).href);
  const worker = mod.default;
  const env = {
    DISCORD_BOT_TOKEN: 'test-secret-token',
    TORNEO_CHANNEL_ID: '1569830216757411911',
    ROADTO_CHANNEL_ID: '1569855142528950282'
  };

  const healthRes = await worker.fetch(new Request('https://bridge.test/health'), env);
  assert.strictEqual(healthRes.status, 200);
  const healthJson = await healthRes.json();
  assert.strictEqual(healthJson.ok, true);
  assert.strictEqual(healthJson.botConfigured, true);

  const badChanRes = await worker.fetch(new Request('https://bridge.test/messages?channelId=999999'), env);
  assert.strictEqual(badChanRes.status, 403, 'Unauthorized channel ID must be rejected by bridge');

  for (const blockedCmd of ['!TORNEO ON 4', '!TORNEO OFF', '!AVISO Fake', '!GANADOR W1 T1', '!ROADTO OFF']) {
    const res = await worker.fetch(
      new Request('https://bridge.test/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: '1569830216757411911', content: blockedCmd })
      }),
      env
    );
    assert.strictEqual(res.status, 403, `Admin command "${blockedCmd}" must be blocked at bridge`);
  }

  const badRoadToCmd = await worker.fetch(
    new Request('https://bridge.test/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: '1569855142528950282', content: '!T1 Faker#KR1' })
    }),
    env
  );
  assert.strictEqual(badRoadToCmd.status, 403, 'Non-RoadTo commands must be blocked in #road-to');

  // Telemetry Ping & Stats tests
  const pingRes = await worker.fetch(
    new Request('https://bridge.test/api/telemetry/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'unit-test-cid', version: '2.2.2', region: 'LAN' })
    }),
    env
  );
  assert.strictEqual(pingRes.status, 200);
  const pingJson = await pingRes.json();
  assert.strictEqual(pingJson.ok, true);
  assert(pingJson.onlineNow >= 1, 'Ping must return onlineNow count');

  const statsRes = await worker.fetch(new Request('https://bridge.test/api/telemetry/stats'), env);
  assert.strictEqual(statsRes.status, 200);
  const statsJson = await statsRes.json();
  assert.strictEqual(statsJson.ok, true);
  assert(statsJson.onlineNow >= 1, 'Stats must return onlineNow count');
  console.log('[PASS] Cloudflare Worker Discord bridge & telemetry unit tests');
}

async function main() {
  await runUnitTests();
  testTournamentEngine();
  testRoadToEngine();
  await testDiscordBridgeWorker();
  const season = await ensureSeasonSynced();
  testSmartEnemyInference(season);
  await runHttpIntegrationTests();
  console.log('ALL TESTS PASSED');
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
