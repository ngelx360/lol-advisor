/**
 * Road To Competitive Ladder Engine
 * Categories:
 *   - road_oro        : Unranked / Hierro / Bronce       -> Goal: Oro I
 *   - road_esmeralda  : Plata / Oro                      -> Goal: Esmeralda I
 *   - road_diamante   : Platino / Esmeralda              -> Goal: Diamante I
 *   - road_master     : Diamante                         -> Goal: Master (máx LP antes de Challenger)
 *   - road_challenger : Master / Grandmaster             -> Goal: Challenger
 */

const TIER_ORDER = {
  UNRANKED: 0,
  IRON: 1,
  BRONZE: 2,
  SILVER: 3,
  GOLD: 4,
  PLATINUM: 5,
  EMERALD: 6,
  DIAMOND: 7,
  MASTER: 8,
  GRANDMASTER: 9,
  CHALLENGER: 10
};

const TIER_ES = {
  UNRANKED: 'Sin rango',
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

const DIV_ROMAN = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV' };

const ROAD_CATEGORIES = [
  {
    id: 'road_oro',
    index: 0,
    name: 'Road to Oro',
    eligibleLabel: 'Hierro · Bronce',
    targetTier: 'GOLD',
    targetDivision: 1,
    targetLabel: 'Oro I',
    nextId: 'road_esmeralda',
    nextName: 'Road to Esmeralda',
    color: '#f5b942'
  },
  {
    id: 'road_esmeralda',
    index: 1,
    name: 'Road to Esmeralda',
    eligibleLabel: 'Plata · Oro',
    targetTier: 'EMERALD',
    targetDivision: 1,
    targetLabel: 'Esmeralda I',
    nextId: 'road_diamante',
    nextName: 'Road to Diamante',
    color: '#38e89e'
  },
  {
    id: 'road_diamante',
    index: 2,
    name: 'Road to Diamante',
    eligibleLabel: 'Platino · Esmeralda',
    targetTier: 'DIAMOND',
    targetDivision: 1,
    targetLabel: 'Diamante I',
    nextId: 'road_master',
    nextName: 'Road to Master',
    color: '#60b8ff'
  },
  {
    id: 'road_master',
    index: 3,
    name: 'Road to Master',
    eligibleLabel: 'Diamante',
    targetTier: 'MASTER',
    targetDivision: 1,
    targetLabel: 'Master (Máx LP)',
    nextId: 'road_challenger',
    nextName: 'Road to Challenger',
    color: '#c77dff'
  },
  {
    id: 'road_challenger',
    index: 4,
    name: 'Road to Challenger',
    eligibleLabel: 'Master · GM',
    targetTier: 'CHALLENGER',
    targetDivision: 1,
    targetLabel: 'Challenger',
    nextId: null,
    nextName: null,
    color: '#ffe066'
  }
];

const CATEGORY_MAP = new Map(ROAD_CATEGORIES.map((c) => [c.id, c]));

function normalizeTier(tier) {
  const t = String(tier || '').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(TIER_ORDER, t) ? t : 'UNRANKED';
}

function normalizeDivision(div) {
  const n = Number(div);
  if (n >= 1 && n <= 4) return n;
  return 4;
}

/**
 * Convert any LoL rank into a monotonic numeric score so leaderboards and caps sort accurately.
 */
function rankToScore(rank) {
  const tier = normalizeTier(rank?.tier);
  const lp = Math.max(0, Number(rank?.lp || 0));
  const tierIdx = TIER_ORDER[tier] || 0;
  if (tierIdx === 0) return 0;
  if (tier === 'MASTER') return 3200 + lp;
  if (tier === 'GRANDMASTER') return 10000 + lp;
  if (tier === 'CHALLENGER') return 20000 + lp;
  const div = normalizeDivision(rank?.division);
  return tierIdx * 400 + (4 - div) * 100 + Math.min(99, lp);
}

function formatRankEs(rank) {
  const tier = normalizeTier(rank?.tier);
  if (tier === 'UNRANKED') return 'Sin rango';
  const esName = TIER_ES[tier] || tier;
  const lp = rank?.lp != null ? ` · ${Number(rank.lp)} LP` : '';
  if (tier === 'MASTER' || tier === 'GRANDMASTER' || tier === 'CHALLENGER') {
    return `${esName}${lp}`;
  }
  const roman = DIV_ROMAN[normalizeDivision(rank?.division)] || 'IV';
  return `${esName} ${roman}${lp}`;
}

function tierToCategoryId(tier) {
  const t = normalizeTier(tier);
  if (t === 'UNRANKED' || t === 'IRON' || t === 'BRONZE') return 'road_oro';
  if (t === 'SILVER' || t === 'GOLD') return 'road_esmeralda';
  if (t === 'PLATINUM' || t === 'EMERALD') return 'road_diamante';
  if (t === 'DIAMOND') return 'road_master';
  return 'road_challenger';
}

/**
 * Pick the stronger category so players can jump up to higher Roads without ever being downgraded.
 */
function higherCategoryId(catA, catB) {
  const a = CATEGORY_MAP.get(catA);
  const b = CATEGORY_MAP.get(catB);
  if (!a) return b?.id || 'road_oro';
  if (!b) return a.id;
  return a.index >= b.index ? a.id : b.id;
}

function extractTierObj(raw) {
  if (!raw || !raw.tier) return null;
  const tier = normalizeTier(raw.tier);
  if (tier === 'UNRANKED') return null;
  return {
    tier,
    division: raw.division != null ? normalizeDivision(raw.division) : 4,
    lp: Number(raw.lp || 0)
  };
}

/**
 * Calculate the player's current Solo/Duo win or loss streak from OP.GG match summaries.
 */
function computeSoloStreak(matches = [], gameName = '', tagLine = '') {
  const solo = (matches || [])
    .filter((m) => String(m.game_type || '').toUpperCase() === 'SOLORANKED' && Number(m.game_length_second || 301) >= 300)
    .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
  if (!solo.length) return { type: null, count: 0 };

  const gLow = String(gameName || '').trim().toLowerCase();
  const tLow = String(tagLine || '').trim().toLowerCase();
  const resolveWin = (m) => {
    const me = (m.participants || []).find(
      (p) =>
        String(p.summoner?.game_name || '').toLowerCase() === gLow &&
        String(p.summoner?.tagline || '').toLowerCase() === tLow
    ) || m.participants?.[0];
    if (me?.stats?.result) {
      return String(me.stats.result).toUpperCase() === 'WIN';
    }
    const myTeam = (m.teams || []).find((t) => t.key === me?.team_key);
    return myTeam?.game_stat?.is_win != null ? Boolean(myTeam.game_stat.is_win) : null;
  };

  const first = resolveWin(solo[0]);
  if (first === null) return { type: null, count: 0 };
  let count = 0;
  for (const m of solo) {
    const w = resolveWin(m);
    if (w !== first) break;
    count += 1;
  }
  return { type: first ? 'W' : 'L', count };
}

/**
 * Generate visual Road To badges (streaks, category promotions, cap reached, tier milestones, high WR).
 */
function buildRoadToBadges({ categoryId, reachedCap, winRate = 0, wins = 0, losses = 0, streak = null, jumpsCount = 0, rankPos = null } = {}) {
  const badges = [];
  if (streak?.type === 'W' && streak.count >= 3) {
    badges.push({ id: 'hot_streak', label: `🔥 Racha ${streak.count}V`, tone: 'fire' });
  } else if (streak?.type === 'W' && streak.count === 2) {
    badges.push({ id: 'warm_streak', label: '⚡ Racha 2V', tone: 'warm' });
  }
  if (rankPos === 1 && (wins + losses > 0 || categoryId)) {
    badges.push({ id: 'top1', label: '💎 Top #1', tone: 'top1' });
  }
  if (jumpsCount > 0) {
    badges.push({ id: 'jumper', label: `🚀 Ascendido${jumpsCount > 1 ? ` x${jumpsCount}` : ''}`, tone: 'jump' });
  }
  if (reachedCap) {
    badges.push({ id: 'cap', label: '🏆 Tope Logrado', tone: 'cap' });
  }
  if (categoryId === 'road_master') {
    badges.push({ id: 'master', label: '👑 Camino a Master', tone: 'master' });
  } else if (categoryId === 'road_challenger') {
    badges.push({ id: 'chall', label: '⚔️ Élite Challenger', tone: 'chall' });
  }
  if (winRate >= 60 && wins + losses >= 15 && badges.length < 4) {
    badges.push({ id: 'high_wr', label: `⭐ ${winRate}% WR`, tone: 'wr' });
  }
  return badges.slice(0, 4);
}

/**
 * Inspect OP.GG Summoner profile (current Solo/Duo, current peak, and previous seasons)
 * to determine initial Road To category, live progress, streak, badges, and whether they reached category cap.
 */
function analyzeSummonerRoadToPlacement(profile, overrideCategoryId = null, matches = [], extras = {}) {
  if (!profile) return null;

  const stats = Array.isArray(profile.league_stats) ? profile.league_stats : [];
  const soloStat = stats.find((s) => String(s.game_type || '').toUpperCase() === 'SOLORANKED') || null;
  const flexStat = stats.find((s) => String(s.game_type || '').toUpperCase() === 'FLEXRANKED') || null;

  const currentSolo = extractTierObj(soloStat?.tier_info) || { tier: 'UNRANKED', division: 4, lp: 0 };
  const currentFlex = extractTierObj(flexStat?.tier_info);

  // Collect Solo/Duo history across previous_seasons, previous_season_tiers, current_season_high_tiers
  const historyRecords = [];
  const soloCandidates = [];
  const flexCandidates = [];

  if (currentSolo.tier !== 'UNRANKED') soloCandidates.push({ label: 'Actual', ...currentSolo });
  if (currentFlex) flexCandidates.push({ label: 'Flex Actual', ...currentFlex });

  const rawCurrHigh = profile.current_season_high_tiers;
  const currentHighEntries = Array.isArray(rawCurrHigh)
    ? rawCurrHigh
    : (Array.isArray(rawCurrHigh?.rank_entries) ? rawCurrHigh.rank_entries : []);

  for (const ch of currentHighEntries) {
    const gt = String(ch?.game_type || '').toUpperCase();
    const r = extractTierObj(ch?.high_rank_info || ch?.rank_info);
    if (!r) continue;
    if (gt === 'SOLORANKED') soloCandidates.push({ label: 'Peak Actual', ...r });
    else if (gt === 'FLEXRANKED') flexCandidates.push({ label: 'Peak Flex', ...r });
  }

  const seenSeasonIds = new Set();
  for (const pst of Array.isArray(profile.previous_season_tiers) ? profile.previous_season_tiers : []) {
    const sid = pst.season_id;
    for (const ent of Array.isArray(pst.rank_entries) ? pst.rank_entries : []) {
      const gt = String(ent.game_type || '').toUpperCase();
      const peakR = extractTierObj(ent.high_rank_info) || extractTierObj(ent.rank_info);
      const endR = extractTierObj(ent.rank_info) || peakR;
      if (!peakR) continue;
      if (gt === 'SOLORANKED') {
        soloCandidates.push({ label: `S${sid}`, ...peakR });
        if (!seenSeasonIds.has(sid)) {
          seenSeasonIds.add(sid);
          historyRecords.push({ seasonId: sid, rank: endR, peak: peakR });
        }
      } else if (gt === 'FLEXRANKED') {
        flexCandidates.push({ label: `S${sid} Flex`, ...peakR });
      }
    }
  }

  for (const ps of Array.isArray(profile.previous_seasons) ? profile.previous_seasons : []) {
    const r = extractTierObj(ps.tier_info);
    if (!r) continue;
    soloCandidates.push({ label: `S${ps.season_id}`, ...r });
    if (!seenSeasonIds.has(ps.season_id)) {
      seenSeasonIds.add(ps.season_id);
      historyRecords.push({ seasonId: ps.season_id, rank: r, peak: r });
    }
  }

  historyRecords.sort((a, b) => Number(b.seasonId || 0) - Number(a.seasonId || 0));

  const poolForPlacement = soloCandidates.length ? soloCandidates : flexCandidates;
  let referencePeak = { tier: 'UNRANKED', division: 4, lp: 0, label: 'Sin historial' };
  for (const cand of poolForPlacement) {
    if (rankToScore(cand) > rankToScore(referencePeak)) {
      referencePeak = cand;
    }
  }

  const assignedCategoryId = tierToCategoryId(referencePeak.tier);
  const activeCategoryId = overrideCategoryId && CATEGORY_MAP.has(overrideCategoryId)
    ? overrideCategoryId
    : assignedCategoryId;
  const cat = CATEGORY_MAP.get(activeCategoryId) || ROAD_CATEGORIES[0];

  // Live Challenger / Grandmaster thresholds from OP.GG
  const highLeagues = soloStat?.high_leagues || [];
  const challengerThreshold = Number(
    highLeagues.find((h) => String(h.key || '').toUpperCase() === 'CHALLENGER')?.lp_threshold || 1200
  );
  const gmThreshold = Number(
    highLeagues.find((h) => String(h.key || '').toUpperCase() === 'GRANDMASTER')?.lp_threshold || 700
  );

  // Compute target cap & progress for the player's active Road category
  const currScore = rankToScore(currentSolo);
  let targetScore = rankToScore({ tier: cat.targetTier, division: cat.targetDivision, lp: 0 });
  let floorScore = 0;

  if (cat.id === 'road_oro') {
    floorScore = rankToScore({ tier: 'IRON', division: 4, lp: 0 });
    targetScore = rankToScore({ tier: 'GOLD', division: 1, lp: 0 });
  } else if (cat.id === 'road_esmeralda') {
    floorScore = rankToScore({ tier: 'SILVER', division: 4, lp: 0 });
    targetScore = rankToScore({ tier: 'EMERALD', division: 1, lp: 0 });
  } else if (cat.id === 'road_diamante') {
    floorScore = rankToScore({ tier: 'PLATINUM', division: 4, lp: 0 });
    targetScore = rankToScore({ tier: 'DIAMOND', division: 1, lp: 0 });
  } else if (cat.id === 'road_master') {
    floorScore = rankToScore({ tier: 'DIAMOND', division: 4, lp: 0 });
    targetScore = rankToScore({ tier: 'MASTER', division: 1, lp: 0 });
  } else {
    floorScore = rankToScore({ tier: 'MASTER', division: 1, lp: 0 });
    targetScore = rankToScore({ tier: 'MASTER', division: 1, lp: challengerThreshold });
  }

  let reachedCap = false;
  if (cat.id === 'road_challenger') {
    reachedCap = currentSolo.tier === 'CHALLENGER';
  } else {
    reachedCap = currScore >= targetScore;
  }

  let progressPct = 0;
  if (reachedCap) {
    progressPct = 100;
  } else if (cat.id === 'road_challenger' && currentSolo.tier === 'GRANDMASTER') {
    const lp = Number(currentSolo.lp || 0);
    progressPct = Math.max(5, Math.min(99, Math.round((lp / Math.max(1, challengerThreshold)) * 100)));
  } else if (cat.id === 'road_challenger' && currentSolo.tier === 'MASTER') {
    const lp = Number(currentSolo.lp || 0);
    progressPct = Math.max(3, Math.min(99, Math.round((lp / Math.max(1, challengerThreshold)) * 100)));
  } else if (currScore > floorScore && targetScore > floorScore) {
    progressPct = Math.max(2, Math.min(99, Math.round(((currScore - floorScore) / (targetScore - floorScore)) * 100)));
  }

  const wins = Number(soloStat?.win || 0);
  const losses = Number(soloStat?.lose || 0);
  const totalGames = wins + losses;
  const winRate = totalGames > 0 ? Math.round((wins / totalGames) * 100) : 0;

  const previousSummary = historyRecords.length
    ? historyRecords
        .slice(0, 3)
        .map((h) => `S${h.seasonId}: ${formatRankEs({ tier: h.peak.tier, division: h.peak.division })}`)
        .join(' · ')
    : (flexCandidates.length ? `Flex: ${formatRankEs(flexCandidates[0])}` : 'Sin seasons previas');

  const streak = computeSoloStreak(matches, profile.game_name, profile.tagline);
  const jumpsCount = Number(extras?.jumpsCount || 0);
  const reachedCapBool = reachedCap;
  const canJumpBool = Boolean(reachedCapBool && cat.nextId);
  const badges = buildRoadToBadges({
    categoryId: cat.id,
    reachedCap: reachedCapBool,
    winRate,
    wins,
    losses,
    streak,
    jumpsCount,
    rankPos: extras?.rankPos || null
  });

  return {
    riotId: `${profile.game_name}#${profile.tagline}`,
    profileIcon: profile.profile_image_url || '',
    level: Number(profile.level || 0),
    currentRank: currentSolo,
    currentRankLabel: formatRankEs(currentSolo),
    tierIcon: soloStat?.tier_info?.tier_image_url || '',
    wins,
    losses,
    winRate,
    rankScore: currScore,
    referencePeak,
    referencePeakLabel: formatRankEs(referencePeak),
    previousSummary,
    assignedCategoryId,
    categoryId: cat.id,
    categoryName: cat.name,
    targetLabel:
      cat.id === 'road_challenger'
        ? `Challenger (${challengerThreshold} LP corte)`
        : cat.id === 'road_master'
        ? `Master (GM ${gmThreshold} / Chall ${challengerThreshold} LP)`
        : cat.targetLabel,
    challengerThreshold,
    gmThreshold,
    progressPct,
    reachedCap: reachedCapBool,
    canJump: canJumpBool,
    nextCategoryId: cat.nextId,
    nextCategoryName: cat.nextName,
    streak,
    jumpsCount,
    badges
  };
}

function normalizeRiotKey(riotId) {
  return String(riotId || '').trim().replace(/\s*#\s*/g, '#').toLowerCase();
}

/**
 * Parse chronological Discord messages from `#road-to` channel.
 * Commands:
 *   !ROADTO ON [title]   (Admin only when adminOnly = true)
 *   !ROADTO OFF          (Admin only when adminOnly = true)
 *   !RTREG <RiotID> | <Region> | <CategoryId> | <PeakLabel>
 *   !RTSALTO <RiotID> | <NextCategoryId>
 *   !RTBAJA <RiotID>
 */
function parseDiscordMessagesToRoadTo(messages, options = {}) {
  const ordered = [...(messages || [])].sort(
    (a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime()
  );

  const adminOnly = Boolean(options.adminOnly);
  const allowedAdmins = new Set(
    (options.allowedAdminIds || []).map((id) => String(id || '').trim()).filter(Boolean)
  );
  const isAuthorizedAdmin = (msg) => {
    if (!adminOnly) return true;
    if (msg.author?.bot) return false;
    const authorId = String(msg.author?.id || '').trim();
    if (allowedAdmins.has(authorId)) return true;
    if (authorId === '382962894075199488') return true;
    return false;
  };

  let active = false;
  let title = '';
  let openedAt = null;
  let openedBy = '';
  let announcement = null;
  const byKey = new Map();

  for (const msg of ordered) {
    const content = String(msg.content || '').trim();
    if (!content.startsWith('!')) continue;
    const msgAuthorId = String(msg.author?.id || '').trim();
    const msgIsBot = Boolean(msg.author?.bot);
    const msgIso = msg.timestamp || new Date().toISOString();
    const msgMs = new Date(msgIso).getTime() || Date.now();

    // 0. Global Admin Announcement (!AVISO ... / !AVISO OFF)
    if (/^!(?:AVISO|ANUNCIO)\s+(?:OFF|CLEAR|NONE)(?:\b|$)/i.test(content)) {
      if (isAuthorizedAdmin(msg)) announcement = null;
      continue;
    }
    const avisoMatch = /^!(?:AVISO|ANUNCIO)\s+(.+)$/i.exec(content);
    if (avisoMatch) {
      if (isAuthorizedAdmin(msg)) announcement = { text: avisoMatch[1].trim(), at: msgIso, atMs: msgMs, by: 'NGELX' };
      continue;
    }

    // 1. !ROADTO ON [optional title] (or !ROAD TO ON)
    const onMatch = /^!ROAD\s*TO\s+ON(?:\s+(.+))?$/i.exec(content);
    if (onMatch) {
      if (!isAuthorizedAdmin(msg)) continue;
      const newTitle = (onMatch[1] || '').trim();
      if (!active) {
        active = true;
        title = newTitle || 'Temporada Activa';
        openedAt = msg.timestamp || new Date().toISOString();
        openedBy = 'NGELX';
        byKey.clear();
      } else if (newTitle) {
        title = newTitle;
      }
      continue;
    }

    // 2. !ROADTO OFF (or !ROAD TO OFF)
    if (/^!ROAD\s*TO\s+OFF(?:\b|$)/i.test(content)) {
      if (!isAuthorizedAdmin(msg)) continue;
      active = false;
      title = '';
      openedAt = null;
      openedBy = '';
      byKey.clear();
      continue;
    }

    if (!active) continue;

    // 3. !RTBAJA <RiotID> [| by:<ownerKey>] (only whoever registered or Admin)
    const dropMatch = /^!RTBAJA\s+([^|\n]+?)(?:\s*\|\s*by:([a-z0-9_-]+))?$/i.exec(content);
    if (dropMatch) {
      const targetKey = normalizeRiotKey(dropMatch[1]);
      const byOwnerKey = dropMatch[2] ? dropMatch[2].trim().toLowerCase() : '';
      const existing = byKey.get(targetKey);
      if (!existing) continue;

      let canDrop = false;
      if (isAuthorizedAdmin(msg)) {
        canDrop = true;
      } else if (!msgIsBot) {
        canDrop = Boolean(!existing.authorIsBot && existing.authorId && existing.authorId === msgAuthorId);
      } else if (byOwnerKey && existing.ownerKey) {
        canDrop = byOwnerKey === String(existing.ownerKey).toLowerCase();
      }
      if (!canDrop) continue;

      byKey.delete(targetKey);
      continue;
    }

    // 4. !RTSALTO <RiotID> | <NextCategoryId>
    const jumpMatch = /^!RTSALTO\s+([^|]+?)\s*\|\s*(road_[a-z]+)$/i.exec(content);
    if (jumpMatch) {
      const key = normalizeRiotKey(jumpMatch[1]);
      const nextCat = jumpMatch[2].trim().toLowerCase();
      const existing = byKey.get(key);
      if (existing && CATEGORY_MAP.has(nextCat)) {
        const nextResolved = higherCategoryId(existing.categoryId, nextCat);
        if (nextResolved !== existing.categoryId) {
          existing.jumpsCount = (existing.jumpsCount || 0) + 1;
        }
        existing.categoryId = nextResolved;
      }
      continue;
    }

    // 5. !RTREG <RiotID> [| <Region> [| <CategoryId> [| <PeakLabel> [| reg:<ownerKey>]]]]
    const regMatch = /^!RTREG\s+(.+)$/i.exec(content);
    if (regMatch) {
      let rawParts = regMatch[1].split('|').map((s) => s.trim());
      let ownerKey = '';
      rawParts = rawParts.filter((part) => {
        const tag = /^reg:([a-z0-9_-]+)$/i.exec(part);
        if (tag) {
          ownerKey = tag[1].trim().toLowerCase();
          return false;
        }
        return true;
      });
      const riotId = rawParts[0] || '';
      if (!riotId.includes('#')) continue;
      const region = (rawParts[1] || 'LAN').toUpperCase();
      const catId = CATEGORY_MAP.has((rawParts[2] || '').toLowerCase()) ? rawParts[2].toLowerCase() : null;
      const peakLabel = rawParts[3] || '';
      const key = normalizeRiotKey(riotId);
      const prev = byKey.get(key);
      if (prev) {
        const canEdit =
          isAuthorizedAdmin(msg) ||
          (!msgIsBot && !prev.authorIsBot && prev.authorId && prev.authorId === msgAuthorId) ||
          (msgIsBot && ownerKey && prev.ownerKey && ownerKey === String(prev.ownerKey).toLowerCase());
        if (!canEdit) continue;
      }
      byKey.set(key, {
        riotId,
        region,
        categoryId: prev?.categoryId ? higherCategoryId(prev.categoryId, catId) : catId,
        peakLabel: peakLabel || prev?.peakLabel || '',
        jumpsCount: prev?.jumpsCount || 0,
        ownerKey: ownerKey || prev?.ownerKey || '',
        authorId: msgAuthorId,
        authorIsBot: msgIsBot,
        registeredAt: msg.timestamp || new Date().toISOString()
      });
    }
  }

  return {
    active,
    title,
    openedAt,
    openedBy,
    announcement,
    participants: [...byKey.values()]
  };
}

module.exports = {
  TIER_ORDER,
  ROAD_CATEGORIES,
  normalizeTier,
  rankToScore,
  formatRankEs,
  tierToCategoryId,
  higherCategoryId,
  computeSoloStreak,
  buildRoadToBadges,
  analyzeSummonerRoadToPlacement,
  parseDiscordMessagesToRoadTo
};
