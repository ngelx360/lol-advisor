const syncEngine = require('./syncEngine');
const { inferEnemyRoles } = require('./lcuWatcher');

const TIER_LABELS = {
  1: 'OP',
  2: 'S',
  3: 'A',
  4: 'B',
  5: 'C'
};

const MAGES_NOT_ADC = new Set([
  'swain', 'velkoz', 'karthus', 'aurelionsol', 'hwei', 'veigar',
  'viktor', 'xerath', 'syndra', 'mel', 'katarina', 'yasuo', 'ziggs'
]);

const ROLE_SPANISH = {
  top: 'Superior',
  jungle: 'Jungla',
  mid: 'Central',
  adc: 'Inferior',
  support: 'Apoyo',
  all: 'Todos'
};

function isAllowedForLane(champ, entry, lane) {
  if (!champ || !entry) return false;
  const key = String(champ.key || champ.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (lane === 'adc') {
    if (MAGES_NOT_ADC.has(key)) return false;
    if ((entry.roleRate || 0) < 0.40) return false;
  } else {
    if ((entry.roleRate || 0) < 0.15) return false;
  }
  return true;
}

function getTopCountersForChampion(entry, seasonData) {
  const list = [];
  for (const [oid, stats] of Object.entries(entry?.counters || {})) {
    if (stats.play >= 20) {
      const opp = seasonData.champions[oid];
      if (opp) {
        list.push({
          championId: Number(oid),
          name: opp.name,
          iconUrl: opp.iconUrl,
          winRate: stats.win / stats.play,
          play: stats.play
        });
      }
    }
  }
  list.sort((a, b) => a.winRate - b.winRate);
  return list.slice(0, 3);
}

/**
 * Compute early-game (<25m) win rate from OP.GG game_lengths array.
 */
function getEarlyGameWinRate(laneEntry) {
  const gl = laneEntry?.build?.gameLengths;
  if (!Array.isArray(gl) || !gl.length) return null;
  const early = gl.find((g) => Number(g.length) <= 25) || gl[0];
  return early && typeof early.rate === 'number' ? early.rate : null;
}

/**
 * Resolve head-to-head matchup stats and counter score against enemyLanerId.
 */
function computeMatchupStats(entry, enemyLanerId, enemyLaneEntry, cid, minSample) {
  if (!enemyLanerId) return null;
  let play = 0;
  let win = 0;
  let winRate = null;

  const direct = entry.counters?.[enemyLanerId];
  if (direct && direct.play > 0) {
    play = direct.play;
    win = direct.win;
    winRate = direct.win / direct.play;
  } else if (enemyLaneEntry?.counters?.[cid]?.play > 0) {
    const rev = enemyLaneEntry.counters[cid];
    play = rev.play;
    win = rev.play - rev.win;
    winRate = win / rev.play;
  }

  // Subtract 100 for low-sample matchups so well-sampled (>= minSample) counters always rank strictly above small flukes.
  const counterScore =
    winRate !== null
      ? play >= minSample
        ? winRate * 100
        : winRate * 100 - 100
      : -200;

  return {
    play,
    win,
    winRate,
    lowSample: play > 0 && play < minSample,
    counterScore
  };
}

/**
 * Build candidate recommendations for a given Draft state and ranking mode.
 */
async function getRecommendations({
  seasonData,
  myRole = 'mid',
  enemyLanerId = null,
  allies = [],
  enemies = [],
  bans = [],
  myChampionId = null,
  myPool = [],
  onlyPool = false,
  minSample = 40,
  mode = 'auto',
  enrich1v1 = true
}) {
  if (!seasonData || (!seasonData.lanes?.[myRole] && myRole !== 'all')) {
    return {
      mode: 'patch_wr',
      isFirstPickOrBlind: true,
      candidates: [],
      topCounters: [],
      allySynergiesSummary: []
    };
  }

  const laneMap = myRole === 'all' ? seasonData.lanes.mid : seasonData.lanes[myRole];
  const isFirstPickOrBlind = !enemyLanerId;
  const effectiveMode =
    mode === 'auto'
      ? isFirstPickOrBlind
        ? 'patch_wr'
        : 'counter_wr'
      : mode;

  // Exclude banned and already-picked champions (except myChampionId so user can still see it)
  const unavailableSet = new Set([
    ...(bans || []).map(Number),
    ...(allies || []).map((a) => Number(a.championId || a)),
    ...(enemies || []).map((e) => Number(e.championId || e)),
    ...(enemyLanerId ? [Number(enemyLanerId)] : [])
  ]);
  if (myChampionId) {
    unavailableSet.delete(Number(myChampionId));
  }

  const poolSet = new Set((myPool || []).map(Number));

  // Normalize allies with roles (infer missing ally roles via OP.GG roleRate if needed)
  const normalizedAllies = [];
  const rawAlliesWithoutRole = [];
  for (const a of allies || []) {
    const cid = Number(a.championId || a);
    if (!cid) continue;
    if (a.role && a.role !== myRole) {
      normalizedAllies.push({ championId: cid, role: a.role });
    } else if (!a.role) {
      rawAlliesWithoutRole.push(cid);
    }
  }
  if (rawAlliesWithoutRole.length) {
    const inferred = inferEnemyRoles(rawAlliesWithoutRole, seasonData);
    for (const inf of inferred) {
      if (inf.inferredRole && inf.inferredRole !== myRole) {
        normalizedAllies.push({ championId: inf.championId, role: inf.inferredRole });
      }
    }
  }

  // Fetch ally synergies in parallel (cached per patch)
  const synergyByCandidate = new Map(); // candId -> [{ allyId, allyName, allyRole, winRate, play, tier, rank }]
  const allySynergiesSummary = [];

  if (normalizedAllies.length) {
    const synLists = await Promise.all(
      normalizedAllies.map(async (ally) => {
        try {
          const list = await syncEngine.getAllySynergiesCached(
            seasonData,
            ally.championId,
            ally.role,
            myRole
          );
          return { ally, list };
        } catch {
          return { ally, list: [] };
        }
      })
    );

    for (const { ally, list } of synLists) {
      const allyMeta = seasonData.champions[ally.championId];
      allySynergiesSummary.push({
        allyId: ally.championId,
        allyName: allyMeta?.name || String(ally.championId),
        allyIcon: allyMeta?.iconUrl || '',
        allyRole: ally.role,
        partnersCount: list.length
      });

      for (const s of list) {
        if (!synergyByCandidate.has(s.partnerId)) {
          synergyByCandidate.set(s.partnerId, []);
        }
        synergyByCandidate.get(s.partnerId).push({
          allyId: ally.championId,
          allyName: allyMeta?.name || String(ally.championId),
          allyIcon: allyMeta?.iconUrl || '',
          allyRole: ally.role,
          winRate: s.winRate,
          play: s.play,
          tier: s.tier,
          rank: s.rank
        });
      }
    }
  }

  const rows = [];
  const counterCandidates = [];

  const filterToPoolOnly = Boolean(onlyPool || effectiveMode === 'my_pool');
  const lanesToScan = myRole === 'all' ? ['top', 'jungle', 'mid', 'adc', 'support'] : [myRole];

  for (const curLane of lanesToScan) {
    const curLaneMap = seasonData.lanes[curLane] || {};
    const enemyLaneEntry = enemyLanerId ? curLaneMap[Number(enemyLanerId)] : null;

    for (const [cidStr, entry] of Object.entries(curLaneMap)) {
      const cid = Number(cidStr);
      if (unavailableSet.has(cid)) continue;

      const champ = seasonData.champions[cid];
      if (!champ) continue;
      if (!isAllowedForLane(champ, entry, curLane)) continue;

      const patchWr = entry.winRate || 0.5;
      const isPoolChamp = poolSet.has(cid);

      // Head-to-head matchup stats vs enemyLanerId (computed before pool filter so topCounters always shows best lane counters)
      const matchupStats = computeMatchupStats(entry, enemyLanerId, enemyLaneEntry, cid, minSample);
      const matchupPlay = matchupStats?.play || 0;
      const matchupWin = matchupStats?.win || 0;
      const matchupWr = matchupStats ? matchupStats.winRate : null;
      const counterWrScore = matchupStats ? matchupStats.counterScore : -200;

      if (matchupStats && matchupWr !== null && matchupPlay > 0) {
        counterCandidates.push({
          championId: cid,
          name: champ.name,
          enName: champ.enName,
          iconUrl: champ.iconUrl,
          inPool: isPoolChamp,
          tier: entry.tier,
          tierLabel: TIER_LABELS[entry.tier] || 'C',
          patchWinRate: patchWr,
          winRateVsEnemy: matchupWr,
          playVsEnemy: matchupPlay,
          lowSample: matchupStats.lowSample,
          counterScore: counterWrScore,
          soloKillAdvantage: null,
          laneAdvantage: null
        });
      }

      if (filterToPoolOnly && !isPoolChamp) continue;

      const synEntries = synergyByCandidate.get(cid) || [];
      let synergyAvgWr = null;
      let synergyScoreDelta = 0;
      if (synEntries.length) {
        const totalPlay = synEntries.reduce((acc, s) => acc + Math.max(1, s.play), 0);
        synergyAvgWr =
          synEntries.reduce((acc, s) => acc + s.winRate * Math.max(1, s.play), 0) / totalPlay;
        synergyScoreDelta =
          synEntries.reduce((acc, s) => acc + (s.winRate - 0.5) * 100 + (5 - Math.min(4, s.tier)) * 0.6, 0) /
          synEntries.length;
      }

      const earlyWr = getEarlyGameWinRate(entry);
      const tierBonus = Math.max(0, 6 - (entry.tier || 5)) * 0.7;

      // Base scores before live 1v1 enrichment
      const counterDelta =
        matchupWr !== null && matchupPlay >= minSample
          ? (matchupWr - 0.5) * 100
          : matchupWr !== null
          ? (matchupWr - 0.5) * 35 // dampened low-sample matchup
          : 0;

      const globalScore =
        (patchWr - 0.5) * 100 * 1.1 +
        tierBonus +
        counterDelta * (enemyLanerId ? 1.5 : 0) +
        synergyScoreDelta * (normalizedAllies.length ? 1.1 : 0);

      const lane1v1PrelimScore =
        (matchupWr !== null ? (matchupWr - 0.5) * 100 * 1.6 : (patchWr - 0.5) * 40) +
        (earlyWr !== null ? (earlyWr - 0.5) * 50 : 0) +
        (matchupPlay >= minSample ? 2 : -3);

      rows.push({
        championId: cid,
        name: champ.name,
        enName: champ.enName,
        opggSlug: champ.opggSlug,
        iconUrl: champ.iconUrl,
        tags: champ.tags,
        inPool: isPoolChamp,
        role: curLane,
        lane: curLane,
        laneLabel: ROLE_SPANISH[curLane] || curLane,
        tier: entry.tier,
        tierLabel: TIER_LABELS[entry.tier] || 'C',
        rank: entry.rank,
        play: entry.play,
        winRate: patchWr,
        pickRate: entry.pickRate,
        banRate: entry.banRate,
        roleRate: entry.roleRate,
        kda: entry.kda,
        earlyWr,
        counters: getTopCountersForChampion(entry, seasonData),
        matchup: enemyLanerId
          ? {
              opponentId: Number(enemyLanerId),
              play: matchupPlay,
              win: matchupWin,
              winRate: matchupWr,
              lowSample: matchupStats.lowSample,
              soloKillAdvantage: null,
              laneAdvantage: null,
              tip: ''
            }
          : null,
        synergies: synEntries,
        synergyAvgWr,
        scores: {
          global: globalScore,
          my_pool: globalScore,
          lane_1v1: lane1v1PrelimScore,
          counter_wr: counterWrScore,
          synergy: synergyAvgWr !== null ? synergyAvgWr * 100 + synEntries.length * 0.8 : -99,
          patch_wr: patchWr * 100 + tierBonus * 0.45
        },
        build: entry.build || null,
        trendWin: entry.trendWin || []
      });
    }
  }

  // If enemyLanerId is set & enrich1v1 is enabled, fetch real OP.GG 1v1 signals
  // (lane_solo_kill_advantage_champion, lane_advantage_champion, tip) for top 14 candidates & counters
  if (
    enemyLanerId &&
    enrich1v1 &&
    (effectiveMode === 'lane_1v1' ||
      effectiveMode === 'global' ||
      effectiveMode === 'counter_wr' ||
      effectiveMode === 'my_pool')
  ) {
    const top1v1Set = new Set(
      [...rows]
        .filter((r) => r.matchup && r.matchup.play >= Math.min(20, minSample))
        .sort((a, b) => b.scores.lane_1v1 - a.scores.lane_1v1)
        .slice(0, 10)
        .map((r) => r.championId)
    );
    for (const c of [...counterCandidates]
      .filter((x) => x.playVsEnemy >= Math.min(20, minSample))
      .sort((a, b) => b.counterScore - a.counterScore)
      .slice(0, 8)) {
      if (top1v1Set.size >= 14) break;
      top1v1Set.add(c.championId);
    }
    const topIdsFor1v1 = [...top1v1Set];

    if (topIdsFor1v1.length) {
      const detailsMap = await syncEngine.enrich1v1Matchups(
        seasonData,
        topIdsFor1v1,
        Number(enemyLanerId),
        myRole
      );

      for (const row of rows) {
        const det = detailsMap[row.championId];
        if (!det || !row.matchup) continue;

        row.matchup.soloKillAdvantage = det.soloKillAdvantage;
        row.matchup.laneAdvantage = det.laneAdvantage;
        row.matchup.tip = det.tip || '';
        if (det.build) {
          row.matchupBuild = det.build;
        }

        // Adjust 1v1 score using live OP.GG solo kill & lane advantage flags
        let bonus1v1 = 0;
        if (det.soloKillAdvantage === 'me') bonus1v1 += 6.5;
        else if (det.soloKillAdvantage === 'enemy') bonus1v1 -= 4.5;

        if (det.laneAdvantage === 'me') bonus1v1 += 5.0;
        else if (det.laneAdvantage === 'enemy') bonus1v1 -= 3.5;

        row.scores.lane_1v1 += bonus1v1;
        row.scores.global += bonus1v1 * 0.45;
        row.scores.my_pool += bonus1v1 * 0.45;
      }

      for (const c of counterCandidates) {
        const det = detailsMap[c.championId];
        if (!det) continue;
        c.soloKillAdvantage = det.soloKillAdvantage;
        c.laneAdvantage = det.laneAdvantage;
      }
    }
  }

  let topCounters = [];
  if (enemyLanerId && counterCandidates.length) {
    counterCandidates.sort((a, b) => {
      const diff = b.counterScore - a.counterScore;
      if (Math.abs(diff) > 1e-6) return diff;
      return b.patchWinRate - a.patchWinRate;
    });
    topCounters = counterCandidates.slice(0, 8);
  }

  // Sort according to effectiveMode / OP.GG ranking
  rows.sort((a, b) => {
    if (myRole === 'all' || effectiveMode === 'patch_wr') {
      if (a.tier !== b.tier) return (a.tier || 3) - (b.tier || 3);
      return b.winRate - a.winRate;
    }
    const diff = (b.scores[effectiveMode] ?? 0) - (a.scores[effectiveMode] ?? 0);
    if (Math.abs(diff) > 1e-6) return diff;
    return b.winRate - a.winRate;
  });

  rows.forEach((r, idx) => {
    r.displayRank = idx + 1;
  });

  return {
    mode: effectiveMode,
    isFirstPickOrBlind,
    myRole,
    enemyLanerId: enemyLanerId ? Number(enemyLanerId) : null,
    allySynergiesSummary,
    poolCount: poolSet.size,
    totalCandidates: rows.length,
    topCounters,
    candidates: rows
  };
}

module.exports = {
  TIER_LABELS,
  getRecommendations
};
