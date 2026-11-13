const fs = require('fs');
const path = require('path');
const opgg = require('./opggClient');
const { MATCH_CACHE_DIR } = require('./dataPaths');

function ensureMatchCacheDir() {
  if (!fs.existsSync(MATCH_CACHE_DIR)) {
    fs.mkdirSync(MATCH_CACHE_DIR, { recursive: true });
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIdx = 0;
  async function runner() {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runner()));
  return results;
}

async function getGameDetailCached(region, gameId, createdAt, focusRiotId) {
  ensureMatchCacheDir();
  const safeId = String(gameId).replace(/[^A-Za-z0-9_-]/g, '_');
  const filePath = path.join(MATCH_CACHE_DIR, `${safeId}.json`);
  if (fs.existsSync(filePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (cached && cached.teams?.length) return cached;
    } catch {
      // Refetch if corrupted
    }
  }

  const detail = await opgg.getSummonerGameDetail(region, gameId, createdAt, focusRiotId);
  if (detail && detail.teams?.length) {
    fs.writeFileSync(filePath, JSON.stringify(detail), 'utf8');
  }
  return detail;
}

function getRoleBenchmarks(primaryRole) {
  const role = String(primaryRole || 'MID').toUpperCase();
  if (role === 'SUPPORT') {
    return {
      csMinTarget: 1.5,
      csMinWarn: 0.8,
      wardsMinTarget: 1.1,
      wardsMinWarn: 0.75,
      pinksTarget: 2.5,
      pinksWarn: 1.4,
      kpTarget: 0.62,
      kpWarn: 0.50,
      deathsWarn: 5.8
    };
  }
  if (role === 'JUNGLE') {
    return {
      csMinTarget: 6.0,
      csMinWarn: 5.0,
      wardsMinTarget: 0.40,
      wardsMinWarn: 0.25,
      pinksTarget: 2.0,
      pinksWarn: 1.0,
      kpTarget: 0.60,
      kpWarn: 0.48,
      deathsWarn: 5.5
    };
  }
  if (role === 'TOP') {
    return {
      csMinTarget: 7.0,
      csMinWarn: 5.9,
      wardsMinTarget: 0.38,
      wardsMinWarn: 0.25,
      pinksTarget: 1.5,
      pinksWarn: 0.8,
      kpTarget: 0.48,
      kpWarn: 0.38,
      deathsWarn: 5.8
    };
  }
  // MID / ADC
  return {
    csMinTarget: 7.2,
    csMinWarn: 6.0,
    wardsMinTarget: 0.38,
    wardsMinWarn: 0.25,
    pinksTarget: 1.5,
    pinksWarn: 0.8,
    kpTarget: 0.55,
    kpWarn: 0.44,
    deathsWarn: 5.5
  };
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Analyze ONLY Solo/Duo (SOLORANKED) match history for a summoner and generate
 * concrete coaching diagnostics (CS, Vision, Kill Participation, Level Diff, Deaths).
 */
async function analyzeSoloDuoHistory({ gameName, tagLine, region, seasonData = null }) {
  const normRegion = opgg.normalizeOpggRegion(region);
  const focusRiotId = `${gameName}#${tagLine}`;

  const [profile, rawMatches] = await Promise.all([
    opgg.getSummonerProfile(gameName, tagLine, normRegion),
    opgg.listSummonerMatches(gameName, tagLine, normRegion, 20)
  ]);

  if (!profile) {
    throw new Error(`No se encontró al invocador ${focusRiotId} en la región ${normRegion}.`);
  }

  // Strictly filter ONLY Solo/Duo ranked matches!
  const soloDuoMatches = (rawMatches || []).filter(
    (m) => String(m.game_type || '').toUpperCase() === 'SOLORANKED'
  );

  const soloLeague = (profile.league_stats || []).find(
    (l) => String(l.game_type || '').toUpperCase() === 'SOLORANKED'
  );

  // Enrich up to 12 most recent Solo/Duo matches with full 10-player detail for opponent comparison
  const toInspect = soloDuoMatches.slice(0, 12);
  const details = await mapWithConcurrency(toInspect, 5, async (m) => {
    try {
      return await getGameDetailCached(normRegion, m.id, m.created_at, focusRiotId);
    } catch {
      return null;
    }
  });

  const detailById = new Map();
  for (const d of details) {
    if (d && d.id) detailById.set(d.id, d);
  }

  const parsedGames = [];
  const roleCounts = {};

  for (const m of soloDuoMatches) {
    const durationSec = Number(m.game_length_second) || 1;
    const durationMin = Math.max(1, durationSec / 60);
    const detail = detailById.get(m.id);

    let me = null;
    let opp = null;
    let myTeamKills = 0;

    if (detail?.teams?.length) {
      for (const t of detail.teams) {
        for (const p of t.participants || []) {
          if (p.is_target) {
            me = p;
            myTeamKills = Number(t.game_stat?.champion_kill) || 0;
          }
        }
      }
      if (me) {
        const enemyTeam = detail.teams.find((t) => t.key !== me.team_key);
        opp = (enemyTeam?.participants || []).find(
          (p) => String(p.position || '').toUpperCase() === String(me.position || '').toUpperCase()
        ) || null;
      }
    }

    // Fallback to summary match payload if detail wasn't fetched (>12th match)
    if (!me) {
      me = (m.participants || []).find(
        (p) =>
          String(p.summoner?.game_name || '').toLowerCase() === String(gameName).toLowerCase() &&
          String(p.summoner?.tagline || '').toLowerCase() === String(tagLine).toLowerCase()
      ) || m.participants?.[0];

      const myTeam = (m.teams || []).find((t) => t.key === me?.team_key);
      myTeamKills = Number(myTeam?.game_stat?.champion_kill) || 0;
    }

    if (!me || !me.stats) continue;

    const s = me.stats;
    const pos = String(me.position || 'MID').toUpperCase();
    roleCounts[pos] = (roleCounts[pos] || 0) + 1;

    const kills = Number(s.kill) || 0;
    const deaths = Number(s.death) || 0;
    const assists = Number(s.assist) || 0;
    const cs = (Number(s.minion_kill) || 0) + (Number(s.neutral_minion_kill) || 0);
    const csPerMin = cs / durationMin;
    const wardsPlaced = Number(s.ward_place) || 0;
    const wardsPerMin = wardsPlaced / durationMin;
    const pinks = Number(s.vision_wards_bought_in_game) || 0;
    const level = Number(s.champion_level) || 1;
    const gold = Number(s.gold_earned) || 0;
    const dmg = Number(s.total_damage_dealt_to_champions) || 0;
    const kp = myTeamKills > 0 ? Math.min(1, (kills + assists) / myTeamKills) : 0;

    let levelDiff = null;
    let csDiff = null;
    let goldDiff = null;
    let oppChampName = null;
    if (opp && opp.stats) {
      oppChampName = opp.champion_name;
      const oppCs = (Number(opp.stats.minion_kill) || 0) + (Number(opp.stats.neutral_minion_kill) || 0);
      levelDiff = level - (Number(opp.stats.champion_level) || 1);
      csDiff = cs - oppCs;
      goldDiff = gold - (Number(opp.stats.gold_earned) || 0);
    }

    const champMeta = seasonData?.champions?.[Number(me.champion_id)];
    const oppMeta = opp ? seasonData?.champions?.[Number(opp.champion_id)] : null;

    parsedGames.push({
      id: m.id,
      createdAt: m.created_at,
      durationMin: Number(durationMin.toFixed(1)),
      win: String(s.result || '').toUpperCase() === 'WIN',
      position: pos,
      championId: Number(me.champion_id),
      championName: champMeta?.name || me.champion_name,
      championIcon: champMeta?.iconUrl || '',
      opponentName: oppMeta?.name || oppChampName || null,
      opponentIcon: oppMeta?.iconUrl || '',
      kills,
      deaths,
      assists,
      kda: Number(((kills + assists) / Math.max(1, deaths)).toFixed(2)),
      kp,
      cs,
      csPerMin: Number(csPerMin.toFixed(2)),
      csDiff,
      level,
      levelDiff,
      goldPerMin: Math.round(gold / durationMin),
      goldDiff,
      dmgPerMin: Math.round(dmg / durationMin),
      wardsPlaced,
      wardsPerMin: Number(wardsPerMin.toFixed(2)),
      pinks,
      opScore: Number(s.op_score || 0),
      opRank: Number(s.op_score_rank || 0)
    });
  }

  // Most played role across these Solo/Duo matches
  const primaryRole =
    Object.entries(roleCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'MID';
  const bench = getRoleBenchmarks(primaryRole);

  // Compute aggregate averages (ignoring Support for CS averages unless primaryRole === SUPPORT)
  const nonSupportGames = parsedGames.filter((g) => g.position !== 'SUPPORT');
  const csSample = primaryRole === 'SUPPORT' ? parsedGames : (nonSupportGames.length ? nonSupportGames : parsedGames);

  const avgCsPerMin = avg(csSample.map((g) => g.csPerMin));
  const avgKp = avg(parsedGames.map((g) => g.kp));
  const avgWardsPerMin = avg(parsedGames.map((g) => g.wardsPerMin));
  const avgPinks = avg(parsedGames.map((g) => g.pinks));
  const avgDeaths = avg(parsedGames.map((g) => g.deaths));
  const avgOpScore = avg(parsedGames.map((g) => g.opScore));
  const winsCount = parsedGames.filter((g) => g.win).length;

  const gamesWithOpp = parsedGames.filter((g) => g.levelDiff !== null);
  const avgLevelDiff = avg(gamesWithOpp.map((g) => g.levelDiff));
  const behindLevelRate = gamesWithOpp.length
    ? gamesWithOpp.filter((g) => g.levelDiff <= -1).length / gamesWithOpp.length
    : 0;
  const csDiffSample = gamesWithOpp.filter((g) => primaryRole === 'SUPPORT' || g.position !== 'SUPPORT');
  const avgCsDiff = avg(csDiffSample.map((g) => g.csDiff));

  // Build prioritized coaching insights
  const advice = [];

  // 1. Farmeo
  if (primaryRole !== 'SUPPORT') {
    if (avgCsPerMin < bench.csMinWarn || avgCsDiff <= -12) {
      advice.push({
        area: 'Farmeo (CS)',
        severity: 'critical',
        metric: `${avgCsPerMin.toFixed(1)} CS/min (${avgCsDiff >= 0 ? '+' : ''}${Math.round(avgCsDiff)} vs rival)`,
        target: `Objetivo: ${bench.csMinTarget.toFixed(1)}+ CS/min`,
        tip: 'Estás perdiendo demasiado oro en oleadas. Empuja la línea antes de rotar y no regales waves enteras en mid-game; recoge líneas laterales seguras cuando no haya objetivo.'
      });
    } else if (avgCsPerMin < bench.csMinTarget) {
      advice.push({
        area: 'Farmeo (CS)',
        severity: 'warn',
        metric: `${avgCsPerMin.toFixed(1)} CS/min (${avgCsDiff >= 0 ? '+' : ''}${Math.round(avgCsDiff)} vs rival)`,
        target: `Objetivo: ${bench.csMinTarget.toFixed(1)}+ CS/min`,
        tip: 'Tu farmeo es aceptable pero puedes exprimir más oro: mejora el last-hit bajo torre y limpia campamentos aliados libres en mid-game.'
      });
    } else {
      advice.push({
        area: 'Farmeo (CS)',
        severity: 'good',
        metric: `${avgCsPerMin.toFixed(1)} CS/min (${avgCsDiff >= 0 ? '+' : ''}${Math.round(avgCsDiff)} vs rival)`,
        target: `Supera objetivo (${bench.csMinTarget.toFixed(1)})`,
        tip: 'Buen ritmo de farmeo frente a tu rival de línea. Mantén la presión lateral sin regalarte por exceso.'
      });
    }
  }

  // 2. Subida de nivel / XP
  if (gamesWithOpp.length) {
    if (avgLevelDiff <= -0.6 || behindLevelRate >= 0.5) {
      advice.push({
        area: 'Subida de Nivel (XP)',
        severity: 'critical',
        metric: `${avgLevelDiff >= 0 ? '+' : ''}${avgLevelDiff.toFixed(1)} niveles vs rival (${Math.round(behindLevelRate * 100)}% atrás)`,
        target: 'Objetivo: ≥ 0.0 dif. nivel',
        tip: 'Te quedas atrás en experiencia con frecuencia. Evita hacer roams o backs largos cuando la oleada enemiga está chocando contra tu torre y no compartas XP innecesariamente en mid.'
      });
    } else if (avgLevelDiff < 0.1) {
      advice.push({
        area: 'Subida de Nivel (XP)',
        severity: 'warn',
        metric: `${avgLevelDiff >= 0 ? '+' : ''}${avgLevelDiff.toFixed(1)} niveles vs rival`,
        target: 'Objetivo: ventaja +0.5 nivel',
        tip: 'Estás parejo en experiencia pero pierdes oportunidad de sacar nivel 6/11 antes. Cuida los tiempos de recall (cannon waves) para no perder experiencia de súbditos.'
      });
    } else {
      advice.push({
        area: 'Subida de Nivel (XP)',
        severity: 'good',
        metric: `+${avgLevelDiff.toFixed(1)} niveles vs rival`,
        target: 'Ventaja constante',
        tip: 'Mantienes buena ventaja de experiencia respecto a tu rival directo. Usa esos picos de nivel (6, 9, 11) para forzar peleas.'
      });
    }
  }

  // 3. Visión
  if (avgPinks < bench.pinksWarn || avgWardsPerMin < bench.wardsMinWarn) {
    advice.push({
      area: 'Visión y Control',
      severity: 'critical',
      metric: `${avgPinks.toFixed(1)} Pinks/part · ${avgWardsPerMin.toFixed(2)} wards/min`,
      target: `Objetivo: ${bench.pinksTarget}+ Pinks · ${bench.wardsMinTarget}+ w/m`,
      tip: 'Visión insuficiente para Solo/Duo. Compra al menos 1 Centinela de Control (75g) cada 2 backs y colócalo en arbustos clave de río o entradas de jungla antes de objetivos.'
    });
  } else if (avgPinks < bench.pinksTarget || avgWardsPerMin < bench.wardsMinTarget) {
    advice.push({
      area: 'Visión y Control',
      severity: 'warn',
      metric: `${avgPinks.toFixed(1)} Pinks/part · ${avgWardsPerMin.toFixed(2)} wards/min`,
      target: `Objetivo: ${bench.pinksTarget}+ Pinks · ${bench.wardsMinTarget}+ w/m`,
      tip: 'Colocas wards pero te falta comprar más Centinelas de Control o cambiar a lente revelador al rotar hacia Barón/Dragón.'
    });
  } else {
    advice.push({
      area: 'Visión y Control',
      severity: 'good',
      metric: `${avgPinks.toFixed(1)} Pinks/part · ${avgWardsPerMin.toFixed(2)} wards/min`,
      target: 'Buen control de mapa',
      tip: 'Excelente aporte de visión y pinks para tu rol. Sigue negando visión en la zona de objetivos.'
    });
  }

  // 4. Participación en Kills (KP%)
  if (avgKp < bench.kpWarn) {
    advice.push({
      area: 'Participación en Kills (KP%)',
      severity: 'critical',
      metric: `${(avgKp * 100).toFixed(1)}% KP`,
      target: `Objetivo: ${(bench.kpTarget * 100).toFixed(0)}%+ KP`,
      tip: 'Participas poco en las jugadas de tu equipo. Mueve tu cámara hacia el jungla cuando pelee el cangrejo/invasiones y llega 30s antes a los dragones y larvas.'
    });
  } else if (avgKp < bench.kpTarget) {
    advice.push({
      area: 'Participación en Kills (KP%)',
      severity: 'warn',
      metric: `${(avgKp * 100).toFixed(1)}% KP`,
      target: `Objetivo: ${(bench.kpTarget * 100).toFixed(0)}%+ KP`,
      tip: 'Tu presencia en peleas es media; busca acompañar más las rotaciones después de empujar tu oleada o usar Teleport en flancos.'
    });
  } else {
    advice.push({
      area: 'Participación en Kills (KP%)',
      severity: 'good',
      metric: `${(avgKp * 100).toFixed(1)}% KP`,
      target: 'Alta presencia en equipo',
      tip: 'Muy buena participación en escaramuzas y peleas de equipo.'
    });
  }

  // 5. Supervivencia / Muertes
  if (avgDeaths >= bench.deathsWarn) {
    advice.push({
      area: 'Supervivencia (Muertes)',
      severity: 'critical',
      metric: `${avgDeaths.toFixed(1)} muertes/part`,
      target: 'Objetivo: ≤ 4.5 muertes/part',
      tip: 'Mueres demasiado por partida, lo que regala tempo, objetivos y XP al rival. Respeta cuando no ves al jungla enemigo y no empujes sin visión.'
    });
  } else if (avgDeaths > 4.6) {
    advice.push({
      area: 'Supervivencia (Muertes)',
      severity: 'warn',
      metric: `${avgDeaths.toFixed(1)} muertes/part`,
      target: 'Objetivo: ≤ 4.5 muertes/part',
      tip: 'Reduce 1–2 muertes evitables por partida (sobre todo justo antes de Dragón o Barón) para mantener tu ventaja de nivel.'
    });
  } else {
    advice.push({
      area: 'Supervivencia (Muertes)',
      severity: 'good',
      metric: `${avgDeaths.toFixed(1)} muertes/part`,
      target: 'Control sólido',
      tip: 'Mueres muy poco, manteniendo constante tu tiempo vivo en el mapa para farmear y sumar XP.'
    });
  }

  // Sort advice: critical first, then warn, then good
  const sevOrder = { critical: 0, warn: 1, good: 2 };
  advice.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);

  // Season champion stats from OP.GG profile
  const seasonChampions = (profile.ranked_most_champions?.my_champion_stats || [])
    .slice(0, 8)
    .map((c) => {
      const play = Number(c.play) || 0;
      const win = Number(c.win) || 0;
      const mins = Math.max(1, (Number(c.game_second) || 0) / 60);
      return {
        name: c.champion_name,
        play,
        win,
        lose: Number(c.lose) || 0,
        winRate: play > 0 ? win / play : 0,
        kda: c.basic ? Number(((c.basic.kill + c.basic.assist) / Math.max(1, c.basic.death)).toFixed(2)) : 0,
        csPerMin: c.basic ? Number((c.basic.cs / mins).toFixed(1)) : 0,
        kp: c.basic?.kill_participation ? Number(c.basic.kill_participation.toFixed(1)) : 0,
        opScore: play > 0 && c.basic?.op_score ? Number((c.basic.op_score / play).toFixed(2)) : 0,
        csAt10: play > 0 && c.extend?.lane_cs_10_minute ? Number((c.extend.lane_cs_10_minute / play).toFixed(1)) : null
      };
    });

  return {
    summoner: {
      gameName: profile.game_name || gameName,
      tagLine: profile.tagline || tagLine,
      region: normRegion,
      level: profile.level || 0,
      profileIcon: profile.profile_image_url || '',
      soloRank: soloLeague
        ? {
            tier: soloLeague.tier_info?.tier || 'UNRANKED',
            division: soloLeague.tier_info?.division || '',
            lp: soloLeague.tier_info?.lp ?? 0,
            win: soloLeague.win || 0,
            lose: soloLeague.lose || 0,
            tierIcon: soloLeague.tier_info?.tier_image_url || ''
          }
        : null
    },
    scannedTotalMatches: (rawMatches || []).length,
    soloDuoCount: parsedGames.length,
    primaryRole,
    summary: {
      wins: winsCount,
      losses: parsedGames.length - winsCount,
      winRate: parsedGames.length ? winsCount / parsedGames.length : 0,
      avgCsPerMin: Number(avgCsPerMin.toFixed(2)),
      avgCsDiff: Number(avgCsDiff.toFixed(1)),
      avgLevelDiff: Number(avgLevelDiff.toFixed(2)),
      behindLevelRate: Number(behindLevelRate.toFixed(2)),
      avgKp: Number(avgKp.toFixed(3)),
      avgWardsPerMin: Number(avgWardsPerMin.toFixed(2)),
      avgPinks: Number(avgPinks.toFixed(2)),
      avgDeaths: Number(avgDeaths.toFixed(2)),
      avgOpScore: Number(avgOpScore.toFixed(2))
    },
    advice,
    seasonChampions,
    matches: parsedGames
  };
}

module.exports = {
  analyzeSoloDuoHistory
};
