// lib/tacticalAnalyzer.js - Generates tactical briefing for your team in Draft and Live Game
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

/**
 * Analyzes team composition for tactical summary and lane matchup tendencies.
 */
function analyzeTeamBriefing({ seasonData, myRole, myChampionId, allies = [], enemies = [] }) {
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
      isMe: true
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
          isMe: role === myRole
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

  // Role analyses
  const members = ROLE_ORDER.map((role) => {
    const allyEntry = allyByRole[role] || null;
    const enemyEntry = enemyByRole[role] || null;
    const isMe = role === myRole;
    const champ = allyEntry?.champion || null;
    const enemyChamp = enemyEntry?.champion || null;

    return buildRoleTacticalCard({
      role,
      champ,
      enemyChamp,
      isMe,
      lanes
    });
  });

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

function buildRoleTacticalCard({ role, champ, enemyChamp, isMe, lanes }) {
  const roleLabel = ROLE_NAMES[role] || role;
  if (!champ) {
    return {
      role,
      roleLabel,
      isMe,
      champion: null,
      enemyChampion: enemyChamp ? { id: enemyChamp.id, name: enemyChamp.name, iconUrl: enemyChamp.iconUrl } : null,
      archetype: 'Por Definir',
      badgeColor: 'neutral',
      behavior: 'Sin campeón seleccionado. Esperando selección en Draft o detección de partida.',
      laneTendency: null
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

  return {
    role,
    roleLabel,
    isMe,
    champion: {
      id: champ.id,
      name: champ.name,
      iconUrl: champ.iconUrl
    },
    enemyChampion: enemyChamp ? { id: enemyChamp.id, name: enemyChamp.name, iconUrl: enemyChamp.iconUrl } : null,
    archetype,
    badgeColor,
    behavior,
    laneTendency
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
  ROLE_ORDER,
  ROLE_NAMES
};
