const fs = require('fs');
const path = require('path');
const { DDRAGON_DIR } = require('./dataPaths');

const DATA_DIR = DDRAGON_DIR;

const STAT_SHARDS = {
  5008: {
    id: 5008,
    name: 'Fuerza adaptable (+9)',
    short: 'Adaptable',
    iconUrl: 'https://ddragon.leagueoflegends.com/cdn/img/perk-images/StatMods/StatModsAdaptiveForceIcon.png'
  },
  5005: {
    id: 5005,
    name: 'Velocidad de ataque (+10%)',
    short: 'Vel. Ataque',
    iconUrl: 'https://ddragon.leagueoflegends.com/cdn/img/perk-images/StatMods/StatModsAttackSpeedIcon.png'
  },
  5007: {
    id: 5007,
    name: 'Velocidad de habilidades (+8)',
    short: 'Haste',
    iconUrl: 'https://ddragon.leagueoflegends.com/cdn/img/perk-images/StatMods/StatModsCDRScalingIcon.png'
  },
  5001: {
    id: 5001,
    name: 'Vida progresiva (+10-180)',
    short: 'Vida/Nv',
    iconUrl: 'https://ddragon.leagueoflegends.com/cdn/img/perk-images/StatMods/StatModsHealthScalingIcon.png'
  },
  5011: {
    id: 5011,
    name: 'Vida básica (+65)',
    short: 'Vida +65',
    iconUrl: 'https://ddragon.leagueoflegends.com/cdn/img/perk-images/StatMods/StatModsHealthPlusIcon.png'
  },
  5010: {
    id: 5010,
    name: 'Velocidad de movimiento (+2%)',
    short: 'Vel. Mov',
    iconUrl: 'https://ddragon.leagueoflegends.com/cdn/img/perk-images/StatMods/StatModsMovementSpeedIcon.png'
  },
  5013: {
    id: 5013,
    name: 'Tenacidad y resistencia (+10%)',
    short: 'Tenacidad',
    iconUrl: 'https://ddragon.leagueoflegends.com/cdn/img/perk-images/StatMods/StatModsTenacityIcon.png'
  }
};

let memoryAssets = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getCacheFilePath() {
  return path.join(DATA_DIR, 'assets.json');
}

/**
 * Fetch latest Data Dragon assets (champions, items, runes, summoner spells)
 * and cache them on disk.
 * @param {boolean} forceRefresh
 */
async function loadDataDragonAssets(forceRefresh = false) {
  if (memoryAssets && !forceRefresh) {
    return memoryAssets;
  }

  ensureDir();
  const cacheFile = getCacheFilePath();
  if (!forceRefresh && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached && cached.version && cached.championsById) {
        memoryAssets = cached;
        return cached;
      }
    } catch {
      // Rebuild if corrupted
    }
  }

  const versions = await fetch('https://ddragon.leagueoflegends.com/api/versions.json', {
    signal: AbortSignal.timeout(12000)
  }).then((r) => r.json());
  const version = versions[0];

  const base = `https://ddragon.leagueoflegends.com/cdn/${version}/data/es_ES`;
  const [champRes, itemRes, runeRes, summRes] = await Promise.all([
    fetch(`${base}/champion.json`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()),
    fetch(`${base}/item.json`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()),
    fetch(`${base}/runesReforged.json`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()),
    fetch(`${base}/summoner.json`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json())
  ]);

  const championsById = {};
  for (const c of Object.values(champRes.data || {})) {
    const id = Number(c.key);
    championsById[id] = {
      id,
      ddKey: c.id,
      name: c.name,
      title: c.title,
      tags: c.tags || [],
      iconUrl: `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${c.id}.png`,
      splashUrl: `https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${c.id}_0.jpg`
    };
  }

  const itemsById = {};
  for (const [itemId, item] of Object.entries(itemRes.data || {})) {
    itemsById[itemId] = {
      id: Number(itemId),
      name: item.name,
      plaintext: item.plaintext || '',
      gold: item.gold?.total || 0,
      iconUrl: `https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${itemId}.png`
    };
  }

  const runesById = {};
  const runeTreesById = {};
  for (const tree of runeRes || []) {
    runeTreesById[tree.id] = {
      id: tree.id,
      key: tree.key,
      name: tree.name,
      iconUrl: `https://ddragon.leagueoflegends.com/cdn/img/${tree.icon}`
    };
    for (const slot of tree.slots || []) {
      for (const rune of slot.runes || []) {
        runesById[rune.id] = {
          id: rune.id,
          key: rune.key,
          name: rune.name,
          treeId: tree.id,
          iconUrl: `https://ddragon.leagueoflegends.com/cdn/img/${rune.icon}`
        };
      }
    }
  }

  const summonersById = {};
  for (const spell of Object.values(summRes.data || {})) {
    const id = Number(spell.key);
    summonersById[id] = {
      id,
      ddKey: spell.id,
      name: spell.name,
      iconUrl: `https://ddragon.leagueoflegends.com/cdn/${version}/img/spell/${spell.id}.png`
    };
  }

  const assets = {
    version,
    updatedAt: new Date().toISOString(),
    championsById,
    itemsById,
    runesById,
    runeTreesById,
    summonersById,
    statShardsById: STAT_SHARDS
  };

  fs.writeFileSync(cacheFile, JSON.stringify(assets), 'utf8');
  memoryAssets = assets;
  return assets;
}

module.exports = {
  STAT_SHARDS,
  loadDataDragonAssets
};
