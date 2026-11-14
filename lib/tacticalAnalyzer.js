// lib/tacticalAnalyzer.js - Generates tactical briefing for your team in Draft and Live Game
const opggClient = require('./opggClient');

const ROLE_ORDER = ['top', 'jungle', 'mid', 'adc', 'support'];
const ROLE_NAMES = {
  top: 'Top',
  jungle: 'Jungla',
  mid: 'Mid',
  adc: 'ADC / Bot',
  support: 'Support'
};

// Normalized champion keys for archetypes
const JUNGLE_ARCHETYPES = {
  early: new Set([
    'leesin', 'elise', 'xinzhao', 'jarvaniv', 'shaco', 'reksai', 'warwick', 'volibear',
    'pantheon', 'nidalee', 'vi', 'rengar', 'kindred', 'briar', 'nocturne', 'trundle',
    'poppy', 'sylas', 'khazix', 'rammus', 'wukong'
  ]),
  farm: new Set([
    'masteryi', 'karthus', 'shyvana', 'lillia', 'diana', 'fiddlesticks', 'graves',
    'belveth', 'evelynn', 'hecarim', 'udyr', 'kayn', 'viego', 'ekko', 'brand',
    'taliyah', 'zyra'
  ]),
  tank: new Set([
    'sejuani', 'zac', 'amumu', 'skarner', 'nunu', 'maokai', 'ivern', 'gragas'
  ])
};

const MID_ARCHETYPES = {
  roam: new Set([
    'ahri', 'talon', 'zed', 'katarina', 'twistedfate', 'galio', 'qiyana', 'leblanc',
    'fizz', 'akali', 'sylas', 'naafiri', 'ekko', 'pyke', 'pantheon', 'aurelionsol'
  ]),
  control: new Set([
    'viktor', 'anivia', 'orianna', 'veigar', 'syndra', 'azir', 'hwei', 'malzahar',
    'cassiopeia', 'lux', 'xerath', 'vex', 'zoe', 'neeko', 'velkoz', 'swain',
    'ryze', 'kassadin', 'vladimir', 'karthus', 'ziggs'
  ]),
  skirmish: new Set([
    'yasuo', 'yone', 'irelia', 'tristana', 'jayce', 'lucian', 'corki'
  ])
};

const SUPPORT_ARCHETYPES = {
  roam: new Set([
    'bard', 'pyke', 'nautilus', 'thresh', 'alistar', 'blitzcrank', 'rell', 'leona',
    'rakan', 'pantheon', 'poppy', 'shen', 'maokai', 'tahmkench', 'sett'
  ]),
  enchant: new Set([
    'lulu', 'janna', 'soraka', 'milio', 'yuumi', 'nami', 'sona', 'karma',
    'taric', 'braum', 'renata', 'zilean', 'ivern'
  ]),
  poke: new Set([
    'brand', 'zyra', 'lux', 'velkoz', 'xerath', 'senna', 'swain', 'morgana',
    'hwei', 'heimerdinger', 'shaco', 'ashe', 'seraphine'
  ])
};

const TOP_ARCHETYPES = {
  bully: new Set([
    'darius', 'renekton', 'fiora', 'jax', 'camille', 'aatrox', 'irelia', 'olaf',
    'illaoi', 'sett', 'kled', 'gwen', 'tryndamere', 'riven', 'gnar', 'yorick',
    'teemo', 'quinn', 'jayce', 'urgot', 'vayne', 'kennen', 'warwick', 'mordekaiser'
  ]),
  tank: new Set([
    'ornn', 'malphite', 'shen', 'sion', 'maokai', 'ksante', 'chogath', 'gragas',
    'poppy', 'drmundo', 'singed', 'tahmkench', 'volibear', 'nasus', 'kayle'
  ])
};

const ADC_ARCHETYPES = {
  early: new Set([
    'draven', 'lucian', 'kalista', 'caitlyn', 'tristana', 'samira', 'missfortune',
    'varus', 'nilah'
  ]),
  hyper: new Set([
    'jinx', 'vayne', 'smolder', 'kaisa', 'kogmaw', 'aphelios', 'twitch', 'zeri',
    'sivir', 'ezreal', 'ashe', 'jhin', 'xayah'
  ])
};

function normalizeKey(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const ALLY_STATS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const allyStatsCache = new Map();

/**
 * Generate sensible lane benchmark stats for players without history or in offline/demo mode.
 */
function generateLaneBenchmark(role, championId, summonerName) {
  const isJungle = role === 'jungle';
  const isSupport = role === 'support';
  const isTop = role === 'top';
  const isMid = role === 'mid';
  const isAdc = role === 'adc';

  const seed = (Number(championId) || 12) * 7 + (String(summonerName || '').length * 3);
  const wrDelta = ((seed % 15) - 6) * 0.01;
  const wr = Math.max(0.48, Math.min(0.64, 0.54 + wrDelta));
  const cs = isSupport ? 1.2 : isJungle ? 6.1 : isTop ? 7.6 : isMid ? 7.5 : 8.1;
  const kdaVal = isSupport ? 3.8 : isJungle ? 3.4 : isTop ? 2.9 : isMid ? 3.3 : 3.5;
  const kills = isSupport ? 1.4 : isJungle ? 6.2 : isTop ? 5.2 : isMid ? 6.8 : 7.4;
  const deaths = isSupport ? 3.2 : isJungle ? 4.1 : isTop ? 3.8 : isMid ? 4.0 : 4.2;
  const assists = isSupport ? 11.5 : isJungle ? 7.8 : isTop ? 5.8 : isMid ? 6.4 : 7.2;
  const kp = isSupport ? 0.61 : isJungle ? 0.56 : isTop ? 0.41 : isMid ? 0.49 : 0.52;
  const wards = isSupport ? 1.85 : isJungle ? 0.88 : isTop ? 0.58 : isMid ? 0.85 : 0.62;

  return {
    gamesCount: 8,
    winRate: Number(wr.toFixed(3)),
    winRatePct: `${Math.round(wr * 100)}%`,
    kills: Number(kills.toFixed(1)),
    deaths: Number(deaths.toFixed(1)),
    assists: Number(assists.toFixed(1)),
    kda: Number(kdaVal.toFixed(2)),
    csPerMin: Number(cs.toFixed(1)),
    kpPct: Number(kp.toFixed(2)),
    wardsPerMin: Number(wards.toFixed(2)),
    sampleType: 'benchmark'
  };
}

/**
 * Fetch match history for an ally via OP.GG or return benchmark stats.
 */
async function fetchAllyMatchHistory({ summonerName, role, championId, region = 'lan' }) {
  const normName = String(summonerName || '').trim();
  const cacheKey = `${normName.toLowerCase()}|${role}|${String(region || 'lan').toLowerCase()}`;

  const cached = allyStatsCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < ALLY_STATS_CACHE_TTL_MS) {
    return cached.stats;
  }

  // If no tag '#' in summonerName or known mock/demo name without tag
  if (!normName.includes('#')) {
    const fallbackStats = generateLaneBenchmark(role, championId, normName);
    allyStatsCache.set(cacheKey, { stats: fallbackStats, timestamp: Date.now() });
    return fallbackStats;
  }

  const [gameName, tagLine] = normName.split('#');
  if (!gameName || !tagLine) {
    const fallbackStats = generateLaneBenchmark(role, championId, normName);
    allyStatsCache.set(cacheKey, { stats: fallbackStats, timestamp: Date.now() });
    return fallbackStats;
  }

  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('OP.GG match history timeout')), 3500)
    );
    const fetchPromise = opggClient.listSummonerMatches(gameName, tagLine, region, 8);
    const rawMatches = await Promise.race([fetchPromise, timeoutPromise]);

    if (!Array.isArray(rawMatches) || rawMatches.length === 0) {
      const fallbackStats = generateLaneBenchmark(role, championId, normName);
      allyStatsCache.set(cacheKey, { stats: fallbackStats, timestamp: Date.now() });
      return fallbackStats;
    }

    let gamesCount = 0;
    let wins = 0;
    let totalKills = 0;
    let totalDeaths = 0;
    let totalAssists = 0;
    let totalCs = 0;
    let totalDurationSec = 0;
    let totalWards = 0;
    let totalTeamKills = 0;

    for (const m of rawMatches) {
      const part = (m.participants || []).find((p) => {
        const pName = String(p.summoner?.game_name || '').toLowerCase();
        const pTag = String(p.summoner?.tagline || '').toLowerCase();
        return pName === gameName.toLowerCase() && (!tagLine || pTag === tagLine.toLowerCase());
      });
      if (!part) continue;

      gamesCount++;
      if (part.stats?.result === 'WIN') wins++;
      const k = Number(part.stats?.kill) || 0;
      const d = Number(part.stats?.death) || 0;
      const a = Number(part.stats?.assist) || 0;
      const cs = (Number(part.stats?.minion_kill) || 0) + (Number(part.stats?.neutral_minion_kill) || 0);
      const w = (Number(part.stats?.ward_place) || 0) + (Number(part.stats?.vision_wards_bought_in_game) || 0);
      const dur = Math.max(60, Number(m.game_length_second) || 1500);

      const myTeam = (m.teams || []).find((t) => t.key === part.team_key);
      const teamKills = Number(myTeam?.game_stat?.champion_kill) || Math.max(1, k + a);

      totalKills += k;
      totalDeaths += d;
      totalAssists += a;
      totalCs += cs;
      totalDurationSec += dur;
      totalWards += w;
      totalTeamKills += teamKills;
    }

    if (gamesCount === 0) {
      const fallbackStats = generateLaneBenchmark(role, championId, normName);
      allyStatsCache.set(cacheKey, { stats: fallbackStats, timestamp: Date.now() });
      return fallbackStats;
    }

    const durationMin = Math.max(1, totalDurationSec / 60);
    const avgKills = totalKills / gamesCount;
    const avgDeaths = totalDeaths / gamesCount;
    const avgAssists = totalAssists / gamesCount;
    const kda = (totalKills + totalAssists) / Math.max(1, totalDeaths);
    const wr = wins / gamesCount;
    const csPerMin = totalCs / durationMin;
    const wardsPerMin = totalWards / durationMin;
    const kpPct = totalTeamKills > 0 ? (totalKills + totalAssists) / totalTeamKills : 0.5;

    const realStats = {
      gamesCount,
      winRate: Number(wr.toFixed(3)),
      winRatePct: `${Math.round(wr * 100)}%`,
      kills: Number(avgKills.toFixed(1)),
      deaths: Number(avgDeaths.toFixed(1)),
      assists: Number(avgAssists.toFixed(1)),
      kda: Number(kda.toFixed(2)),
      csPerMin: Number(csPerMin.toFixed(1)),
      kpPct: Number(kpPct.toFixed(2)),
      wardsPerMin: Number(wardsPerMin.toFixed(2)),
      sampleType: 'real'
    };

    allyStatsCache.set(cacheKey, { stats: realStats, timestamp: Date.now() });
    return realStats;
  } catch {
    const fallbackStats = generateLaneBenchmark(role, championId, normName);
    allyStatsCache.set(cacheKey, { stats: fallbackStats, timestamp: Date.now() });
    return fallbackStats;
  }
}

/**
 * Diagnoses specific player strong points depending on the lane they are playing.
 */
function computeLaneStrongPoints(role, stats, champ, isMe) {
  const cName = champ?.name || 'su campeón';

  if (role === 'top') {
    if (stats.csPerMin >= 7.2 && stats.kda >= 2.6) {
      return {
        badge: '★ Gana Línea & Dominio 1v1',
        color: 'emerald',
        summary: `Historial dominante en Top: destaca por ganar la prioridad de farm (${stats.csPerMin} CS/m) y sacar ventajas individuales en el 1v1 con pocas muertes (${stats.deaths} m/p).`,
        advice: isMe
          ? 'Mantén la presión en línea, controla la oleada y aprovecha los picos de nivel para castigar al rival o invadir su jungla superior.'
          : 'Tu Top suele ganar su línea por sí solo. No necesitas forzar ganks tempranos en su carril; enfócate en bot/dragones y déjale absorber presión o splitpushear.'
      };
    } else if (stats.deaths <= 4.0 && stats.kda >= 2.7) {
      return {
        badge: '★ Línea Segura (Weakside Sólido)',
        color: 'blue',
        summary: `Historial muy seguro en Top: jugador disciplinado que casi no concede muertes (${stats.deaths} m/p) y aguanta bien la presión en weakside.`,
        advice: isMe
          ? 'Prioriza el control de oleadas cerca de tu torre y guarda el Teleport para disputas de Dragón o contra-iniciaciones grupales.'
          : 'Tu Top aguanta la línea con seguridad bajo torre. Puedes jugar en torno a carril inferior o medio sin preocuparte de que feedee al rival.'
      };
    } else {
      return {
        badge: '★ Presión Agresiva & Splitpush',
        color: 'amber',
        summary: `Historial agresivo en Top con ${cName}: busca constantemente intercambios de daño y splitpushing para abrir el mapa.`,
        advice: isMe
          ? 'Asegura visión profunda en el río antes de empujar y coordina con tu jungla cuando busques tirar torre.'
          : 'Suele jugar agresivo y adelantado. Coloca visión profunda en el río superior o acompáñalo si el jungla enemigo intenta colapsarlo.'
      };
    }
  }

  if (role === 'jungle') {
    if (stats.kpPct >= 0.50 || stats.assists >= 6.5) {
      return {
        badge: '★ Ganker Activo en Early (KP Alto)',
        color: 'emerald',
        summary: `Historial de alto impacto en escaramuzas: participa en el ${Math.round(stats.kpPct * 100)}% de los asesinatos del equipo con presencia temprana en todas las líneas.`,
        advice: isMe
          ? 'Aprovecha tus rutas de nivel 2-3 para buscar ganks tempranos en líneas con CC aliado y asegura los primeros Grubs (Larvas).'
          : 'Tu jungla busca pelear y gankear constantemente en early game. Congela o atrae la oleada hacia tu torre para facilitarle entradas limpias con daño o CC.'
      };
    } else if (stats.csPerMin >= 6.0) {
      return {
        badge: '★ Power Farm & Objetivos Neutrales',
        color: 'purple',
        summary: `Historial metódico de farmeo y macro: mantiene ${stats.csPerMin} CS/m asegurando campamentos y disputando Dragones con ventaja de niveles y oro.`,
        advice: isMe
          ? 'Optimiza tus rutas de campamentos hacia los tiempos de reaparición y evita escaramuzas 2v2 innecesarias antes de tu primer objeto clave.'
          : 'Tu jungla prioriza limpiar sus campamentos y escalar. Evita forzar peleas 2v2 o 3v3 arriesgadas en río antes de que complete sus items.'
      };
    } else {
      return {
        badge: '★ Iniciador & Peleas de Equipo',
        color: 'blue',
        summary: `Historial de utilidad y escaramuzas con ${cName}: destaca por asegurar objetivos neutrales y aportar iniciación sólida en peleas grupales.`,
        advice: isMe
          ? 'Lidera las iniciaciones en objetivos y coordina el smite con el daño de tus carries.'
          : 'Acompáñalo en disputas de Grubs (Larvas) y Dragón; aporta la iniciación para que tú y tu equipo rematen.'
      };
    }
  }

  if (role === 'mid') {
    if (stats.kpPct >= 0.46 || stats.wardsPerMin >= 0.8) {
      return {
        badge: '★ Roam & Presencia en Mapa',
        color: 'amber',
        summary: `Historial de alta movilidad y asistencia: participa en el ${Math.round(stats.kpPct * 100)}% de kills y suele rotar hacia las líneas laterales y el río.`,
        advice: isMe
          ? 'Empuja la oleada rápido con tus habilidades y aprovecha la prioridad para rotar a bot, apoyar a tu jungla o colocar visión profunda.'
          : 'Tu Mid tiene hábito de rotar. Mantén tu línea en posición favorable para recibir sus roams y síguelo si va a disputar el escurridizo o los Grubs.'
      };
    } else if (stats.csPerMin >= 7.5) {
      return {
        badge: '★ Farmeo Impecable & Escalado',
        color: 'purple',
        summary: `Historial de gran acumulación de recursos: promedia ${stats.csPerMin} CS/m y escala con solidez hacia las peleas decisivas de mid y late game.`,
        advice: isMe
          ? 'Farmea con disciplina, castiga al rival cuando gaste habilidades en la oleada y llega a tus objetos clave para dominar las peleas 5v5.'
          : 'Tu Mid se concentra en farmear y escalar. Cúbrele los laterales en early game; en midgame será la principal fuente de daño.'
      };
    } else {
      return {
        badge: '★ Alto Daño & Cazadas (Picks)',
        color: 'red',
        summary: `Historial agresivo de burst con ${cName}: promedia ${stats.kills} kills por partida con alto potencial de eliminar enemigos desposicionados.`,
        advice: isMe
          ? 'Busca tradeos agresivos cuando el rival cometa errores de posicionamiento y busca remates rápidos en el río.'
          : 'Tu Mid cuenta con gran daño explosivo. Prepara CC o ralentizaciones en tu carril para que pueda conectar todo su daño.'
      };
    }
  }

  if (role === 'adc') {
    if (stats.csPerMin >= 7.6 && stats.kda >= 2.8) {
      return {
        badge: '★ Hypercarry de Alto Farm & Escalado',
        color: 'purple',
        summary: `Historial sobresaliente de carry: promedia ${stats.csPerMin} CS/m con un KDA de ${stats.kda}, garantizando daño constante en late game.`,
        advice: isMe
          ? 'Prioriza asegurar cada súbdito, no te sobreextiendas sin visión y llega a tus 2-3 objetos para destrozar las peleas en equipo.'
          : 'Tu ADC es un seguro de vida para el late game. Dale recursos, protégele las oleadas y prioriza hacerle peel en las peleas de equipo.'
      };
    } else if (stats.kills >= 6.5 || stats.kpPct >= 0.50) {
      return {
        badge: '★ Línea Agresiva (Snowball 2v2)',
        color: 'red',
        summary: `Historial agresivo en bot: promedia ${stats.kills} kills/partida y busca constantemente presionar y conseguir eliminaciones en fase de líneas.`,
        advice: isMe
          ? 'Busca intercambios favorables en nivel 2 y castiga las entradas del rival para raspar placas de torre antes del minuto 14.'
          : 'Tu bot busca peleas y ventaja en fase de líneas. Aprovecha para gankear bot y asegurar Dragones tempranos gracias a su presión.'
      };
    } else {
      return {
        badge: '★ Posicionamiento Confiable & DPS',
        color: 'blue',
        summary: `Historial consistente con ${cName}: mantiene KDA de ${stats.kda} con bajo margen de muertes innecesarias en peleas grupales.`,
        advice: isMe
          ? 'Mantén una posición protegida detrás de la frontline y enfócate en el objetivo más cercano sin exponerte a flancos.'
          : 'Juega como escudo frontal para tu ADC y mantenlo a salvo de los asesinos enemigos para que pueda aplicar su DPS.'
      };
    }
  }

  if (role === 'support') {
    if (stats.wardsPerMin >= 1.35) {
      return {
        badge: '★ Visión Superior & Control de Mapa',
        color: 'emerald',
        summary: `Historial sobresaliente de visión: promedia ${stats.wardsPerMin} centinelas/minuto, garantizando control absoluto de río y objetivos.`,
        advice: isMe
          ? 'Coloca centinelas de control en las entradas de la jungla enemiga y despeja la visión rival antes de que comience el Dragón o Barón.'
          : 'Tu soporte ilumina el mapa excepcionalmente. Aprovecha su visión para invadir la jungla rival o atrapar enemigos sin miedo a ser emboscado.'
      };
    } else if (stats.kpPct >= 0.52 || stats.assists >= 8.5) {
      return {
        badge: '★ Soporte de Rotación & Iniciador',
        color: 'amber',
        summary: `Historial de alta presencia en el mapa: ${Math.round(stats.kpPct * 100)}% KP y ${stats.assists} asistencias/p; suele rotar a mid y disputas de río.`,
        advice: isMe
          ? 'Aprovecha los reinicios de base para pasar por carril central o río y buscar cazadas tempranas con tu jungla.'
          : 'Tu soporte rota frecuentemente hacia mid o el río. Si juegas mid o jungla, mantente atento a sus llamadas para emboscar juntos.'
      };
    } else {
      return {
        badge: '★ Protector Sólido (Peel & Utilidad)',
        color: 'blue',
        summary: `Historial de gran protección con ${cName}: promedia KDA de ${stats.kda} con ${stats.assists} asistencias, enfocado en mantener con vida a los carries.`,
        advice: isMe
          ? 'Guarda tus habilidades de desenganche o escudos para cuando los asesinos enemigos salten sobre tus aliados principales.'
          : 'Tu soporte se enfoca en dar peel y proteger. Pelea cerca de él para recibir escudos, curaciones o control de masas defensivo.'
      };
    }
  }

  return {
    badge: '★ Adaptable a la Partida',
    color: 'blue',
    summary: `Jugador versátil en ${ROLE_NAMES[role] || role}: estadísticas balanceadas de farm y combate.`,
    advice: isMe ? 'Juega en torno a las prioridades de tu composición.' : 'Coordina con él según la fase de la partida.'
  };
}

/**
 * Analyzes team composition for tactical summary and lane matchup tendencies.
 */
async function analyzeTeamBriefing({ seasonData, myRole, myChampionId, allies = [], enemies = [], mySummonerName = '', region = 'lan' }) {
  const champions = seasonData?.champions || {};
  const lanes = seasonData?.lanes || {};

  // Find user champion
  const myChampObj = myChampionId ? champions[myChampionId] : null;

  // Build mapped map of allies and enemies by role
  const allyByRole = {};
  const enemyByRole = {};

  if (myRole && myChampObj) {
    allyByRole[myRole] = {
      championId: myChampionId,
      champion: myChampObj,
      isMe: true,
      summonerName: mySummonerName || 'Tú'
    };
  }

  for (const a of allies || []) {
    const role = a.role || (a.championId ? findPrimaryLane(a.championId, seasonData) : null);
    if (role && !allyByRole[role]) {
      const c = champions[a.championId] || (a.championName ? findChampByName(a.championName, champions) : null);
      if (c) {
        allyByRole[role] = {
          championId: c.id,
          champion: c,
          isMe: role === myRole,
          summonerName: a.summonerName || ''
        };
      }
    }
  }

  for (const e of enemies || []) {
    const role = e.role || e.inferredRole || (e.championId ? findPrimaryLane(e.championId, seasonData) : null);
    if (role && !enemyByRole[role]) {
      const c = champions[e.championId] || (e.championName ? findChampByName(e.championName, champions) : null);
      if (c) {
        enemyByRole[role] = {
          championId: c.id,
          champion: c
        };
      }
    }
  }

  // Count known allies
  const totalAlliesFound = Object.keys(allyByRole).length;
  const hasTeamData = totalAlliesFound >= 1;

  // Role analyses in parallel
  const members = await Promise.all(
    ROLE_ORDER.map((role) => {
      const allyEntry = allyByRole[role] || null;
      const enemyEntry = enemyByRole[role] || null;
      const isMe = role === myRole;

      return buildRoleTacticalCardAsync({
        role,
        allyEntry,
        enemyEntry,
        isMe,
        lanes,
        region
      });
    })
  );

  // Calculate overall team comp strategy
  const compStrategy = computeCompStrategy(members);

  return {
    hasTeamData,
    totalAlliesFound,
    compStrategy,
    members
  };
}

function findPrimaryLane(championId, seasonData) {
  if (!seasonData?.lanes) return null;
  let bestLane = null;
  let bestPlay = 0;
  for (const l of ['top', 'jungle', 'mid', 'adc', 'support']) {
    const entry = seasonData.lanes[l]?.[championId];
    if (entry && (entry.play || 0) > bestPlay) {
      bestPlay = entry.play;
      bestLane = l;
    }
  }
  return bestLane;
}

function findChampByName(name, championsMap) {
  const norm = normalizeKey(name);
  if (!norm) return null;
  for (const c of Object.values(championsMap)) {
    if (normalizeKey(c.name) === norm || normalizeKey(c.key) === norm || normalizeKey(c.enName) === norm) {
      return c;
    }
  }
  return null;
}

async function buildRoleTacticalCardAsync({ role, allyEntry, enemyEntry, isMe, lanes, region }) {
  const roleLabel = ROLE_NAMES[role] || role;
  const champ = allyEntry?.champion || null;
  const enemyChamp = enemyEntry?.champion || null;
  const summonerName = allyEntry?.summonerName || (isMe ? 'Tú' : '');

  if (!champ) {
    return {
      role,
      roleLabel,
      isMe,
      summonerName,
      champion: null,
      enemyChampion: enemyChamp ? { id: enemyChamp.id, name: enemyChamp.name, iconUrl: enemyChamp.iconUrl } : null,
      archetype: 'Por Definir',
      badgeColor: 'neutral',
      behavior: 'Sin campeón seleccionado. Esperando selección en Draft o detección de partida.',
      laneTendency: null,
      strongPointBadge: 'Por Definir',
      strongPointColor: 'neutral',
      strongPointsSummary: 'Esperando selección de campeón para evaluar historial.',
      tacticalAdvice: 'Coordina con el equipo una vez confirmada la selección.',
      stats: null
    };
  }

  const champKey = normalizeKey(champ.key || champ.name);
  let archetype = 'General';
  let badgeColor = 'blue';
  let behavior = '';
  let laneTendency = null;

  // Lane Tendency (Direct counter WR analysis)
  if (enemyChamp && lanes[role]?.[champ.id]?.counters?.[enemyChamp.id]) {
    const match = lanes[role][champ.id].counters[enemyChamp.id];
    if (match.play >= 20) {
      const wr = match.win / match.play;
      const wrPct = (wr * 100).toFixed(1);
      if (wr >= 0.515) {
        laneTendency = {
          status: 'wins',
          badge: 'Gana Línea',
          badgeColor: 'emerald',
          wrVsOpponent: wr,
          playCount: match.play,
          text: `★ Tiende a ganar línea con ${wrPct}% WR vs ${enemyChamp.name}. Tendrá presión favorable para asistir o invadir.`
        };
      } else if (wr <= 0.485) {
        laneTendency = {
          status: 'loses',
          badge: 'Pierde Línea',
          badgeColor: 'amber',
          wrVsOpponent: wr,
          playCount: match.play,
          text: `⚠ Tiende a perder línea con ${wrPct}% WR vs ${enemyChamp.name}. Jugará bajo torre y cederá prioridad en early.`
        };
      } else {
        laneTendency = {
          status: 'even',
          badge: 'Línea Pareja',
          badgeColor: 'blue',
          wrVsOpponent: wr,
          playCount: match.play,
          text: `⚖ Matchup muy parejo (${wrPct}% WR vs ${enemyChamp.name}). La ventaja de línea dependerá de los ganks de jungla.`
        };
      }
    }
  }

  if (role === 'jungle') {
    if (JUNGLE_ARCHETYPES.early.has(champKey)) {
      archetype = 'Ganker Temprano (Lvl 2-3)';
      badgeColor = 'emerald';
      behavior = 'Gankea muy temprano (lvl 2-3) e invade. Deja que la oleada venga hacia tu lado para facilitarle una entrada limpia con daño o CC.';
    } else if (JUNGLE_ARCHETYPES.tank.has(champKey)) {
      archetype = 'Iniciador / Control de Objetivos';
      badgeColor = 'blue';
      behavior = 'Ganks con alto CC tras nivel 4-6. Acompáñalo en disputas de Grubs (Larvas) y Dragón para asegurar peleas en equipo.';
    } else {
      archetype = 'Power Farm & Escala';
      badgeColor = 'purple';
      behavior = 'Prioriza full-clear de campamentos y escalar a nivel 6 / primer objeto. Evita forzar peleas 2v2 o 3v3 arriesgadas antes de sus picos de daño.';
    }
  } else if (role === 'mid') {
    if (MID_ARCHETYPES.roam.has(champKey)) {
      archetype = 'Alta Rotación & Roam';
      badgeColor = 'amber';
      behavior = 'Buscará empujar y rotar rápido a líneas laterales o río. Mantén tu línea en posición accesible y acompáñalo si colapsa en el río.';
    } else if (MID_ARCHETYPES.skirmish.has(champKey)) {
      archetype = 'Presión 1v1 & Duelos';
      badgeColor = 'red';
      behavior = 'Fuerte presión individual y duelos en el río. Dale prioridad en peleas por escurridizo y Grubs tempranos.';
    } else {
      archetype = 'Control de Oleadas & Escala';
      badgeColor = 'blue';
      behavior = 'Juego de desgaste y control de oleadas en carril central. Raras veces rotará antes de midgame; será clave en peleas por Dragón y Barón.';
    }
  } else if (role === 'support') {
    if (SUPPORT_ARCHETYPES.roam.has(champKey)) {
      archetype = 'Roam & Visión Ofensiva';
      badgeColor = 'amber';
      behavior = 'Suele rotar a mid y río tras su primer regreso a base y colocar visión profunda en jungla rival. Busca jugadas agresivas y cazadas.';
    } else if (SUPPORT_ARCHETYPES.poke.has(champKey)) {
      archetype = 'Presión de Línea & Poke';
      badgeColor = 'purple';
      behavior = 'Gran desgaste a distancia y búsqueda de placas de torre en bot. Puede ser vulnerable a ganks rivales por falta de movilidad.';
    } else {
      archetype = 'Protección (Peel) & Visión Segura';
      badgeColor = 'emerald';
      behavior = 'Prioriza mantener con vida al ADC y controlar visión defensiva en el río inferior. Proporciona gran utilidad y sustain en peleas 5v5.';
    }
  } else if (role === 'top') {
    const isBully = TOP_ARCHETYPES.bully.has(champKey);
    if (isBully) {
      archetype = 'Presión 1v1 & Splitpush';
      badgeColor = 'red';
      behavior = 'Buscará dominar su línea 1v1, absorber presión del jungla rival y amenazar con splitpush continuo en mid/late game.';
      if (!laneTendency) {
        laneTendency = {
          status: 'aggressive',
          badge: 'Presión Fuerte',
          badgeColor: 'emerald',
          text: 'Alta probabilidad de sacar presión individual en early; obligará al jungla enemigo a prestarle atención.'
        };
      }
    } else {
      archetype = 'Weakside & Frontline Grupal';
      badgeColor = 'blue';
      behavior = 'Juega seguro en weakside (aguantando bajo torre si es necesario). Guardará su teleportación para peleas grupales e iniciará con resistencia.';
      if (!laneTendency) {
        laneTendency = {
          status: 'weakside',
          badge: 'Juega Weakside',
          badgeColor: 'blue',
          text: 'Fase de líneas pasiva bajo torre; escalará para aportar gran resistencia e iniciación en peleas grupales.'
        };
      }
    }
  } else if (role === 'adc') {
    if (ADC_ARCHETYPES.early.has(champKey)) {
      archetype = 'Snowball & Presión Bot';
      badgeColor = 'red';
      behavior = 'Línea orientada a conseguir kills y raspar placas antes del minuto 14. Buen momento para asegurar primeros Dragones.';
    } else {
      archetype = 'Hypercarry de Escalado';
      badgeColor = 'purple';
      behavior = 'Su objetivo es farmear seguro y llegar a su pico de 2 o 3 objetos. Eviten forzar peleas desventajadas en bot durante el early game.';
    }
  }

  // Fetch ally history and analyze strong points
  const stats = await fetchAllyMatchHistory({
    summonerName,
    role,
    championId: champ.id,
    region
  });

  const strongPoints = computeLaneStrongPoints(role, stats, champ, isMe);

  return {
    role,
    roleLabel,
    isMe,
    summonerName,
    champion: {
      id: champ.id,
      name: champ.name,
      iconUrl: champ.iconUrl
    },
    enemyChampion: enemyChamp ? { id: enemyChamp.id, name: enemyChamp.name, iconUrl: enemyChamp.iconUrl } : null,
    archetype,
    badgeColor,
    behavior,
    laneTendency,
    strongPointBadge: strongPoints.badge,
    strongPointColor: strongPoints.color,
    strongPointsSummary: strongPoints.summary,
    tacticalAdvice: strongPoints.advice,
    stats
  };
}

function computeCompStrategy(members) {
  let earlyCount = 0;
  let roamCount = 0;
  let scalingCount = 0;

  for (const m of members) {
    if (!m.champion) continue;
    if (m.archetype.includes('Ganker') || m.archetype.includes('Snowball') || m.archetype.includes('Presión 1v1')) {
      earlyCount++;
    }
    if (m.archetype.includes('Roam') || m.archetype.includes('Rotación')) {
      roamCount++;
    }
    if (m.archetype.includes('Escala') || m.archetype.includes('Weakside') || m.archetype.includes('Iniciador')) {
      scalingCount++;
    }
  }

  if (roamCount >= 2) {
    return {
      title: 'Composición de Alta Rotación & Cazadas (Picks)',
      badge: 'Control & Roam',
      plan: 'Mid y Support cuentan con gran movilidad para rotar. Mantengan líneas empujadas y visión profunda para emboscar enemigos desposicionados antes de pelear objetivos.'
    };
  }

  if (earlyCount >= 2) {
    return {
      title: 'Composición de Early Game & Presión Temprana',
      badge: 'Early Pressure',
      plan: 'Tienen picos de poder tempranos y ganks rápidos. Aprovechen para forzar peleas de Grubs (Larvas) y Dragón antes de que el equipo rival empiece a escalar.'
    };
  }

  if (scalingCount >= 2) {
    return {
      title: 'Composición de Escalado & Peleas Grupales (5v5)',
      badge: 'Late Game 5v5',
      plan: 'Jueguen con paciencia y respeten los picos iniciales del rival. Su composición se vuelve dominante a partir de los 20 minutos en peleas frontales por objetivos neutrales.'
    };
  }

  return {
    title: 'Composición Equilibrada',
    badge: 'Balanceada',
    plan: 'Equilibrio sólido entre presión temprana y utilidad grupal. Jueguen en torno a las líneas que saquen ventaja en los primeros minutos y coordinen peleas de Dragón.'
  };
}

module.exports = {
  analyzeTeamBriefing,
  fetchAllyMatchHistory,
  computeLaneStrongPoints,
  generateLaneBenchmark,
  ROLE_ORDER,
  ROLE_NAMES
};
