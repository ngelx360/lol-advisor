/**
 * Double-Elimination (Winners + Losers + Grand Final) Tournament Engine
 * for 4, 8, or 16 League of Legends teams, driven by Discord chat commands
 * or local organizer controls.
 */

const VALID_SIZES = [2, 4, 8, 16];

function normalizeTeamKey(name) {
  return String(name || '').trim().toLowerCase();
}

function normalizePlayerTag(name) {
  return String(name || '')
    .trim()
    .replace(/\s*#\s*/g, '#')
    .toLowerCase();
}

/**
 * Compare a registered Riot ID against a live/history player Riot ID.
 * Uses strict `name#tag` equality when both include `#`, or `gameName` fallback if one omits `#TAG`.
 */
function playersMatch(regName, liveName) {
  const a = normalizePlayerTag(regName);
  const b = normalizePlayerTag(liveName);
  if (!a || !b) return false;
  if (a.includes('#') && b.includes('#')) {
    return a === b;
  }
  return a.split('#')[0] === b.split('#')[0];
}

function isPlayerInList(playerName, playerList) {
  return (playerList || []).some((p) => playersMatch(playerName, p));
}

/**
 * Standard seeded pairing order for power-of-two single/double elimination brackets.
 * E.g. 4 -> [0,3, 1,2], 8 -> [0,7, 3,4, 1,6, 2,5]
 */
function seededOrder(n) {
  let rounds = [0, 1];
  while (rounds.length < n) {
    const next = [];
    const sum = rounds.length * 2 - 1;
    for (const s of rounds) {
      next.push(s, sum - s);
    }
    rounds = next;
  }
  return rounds;
}

/**
 * Create a clean match node.
 */
function createMatch(id, bracketType, roundIndex, roundLabel, teamA = null, teamB = null) {
  return {
    id,
    bracketType, // 'winners' | 'losers' | 'grand_final'
    roundIndex,
    roundLabel,
    teamA,
    teamB,
    winner: null,
    loser: null,
    nextWinMatchId: null,
    nextWinSlot: null, // 'teamA' | 'teamB'
    nextLoseMatchId: null,
    nextLoseSlot: null
  };
}

/**
 * Generate a complete Double-Elimination bracket (Winners + Losers + Grand Final)
 * for 4, 8, or 16 teams.
 * @param {Array<{ name: string, players: string[] }>} teams
 * @param {4|8|16} size
 */
function generateDoubleElimBracket(teams, size = 8) {
  const n = VALID_SIZES.includes(Number(size)) ? Number(size) : 8;
  const slots = new Array(n).fill(null);
  const order = seededOrder(n);

  for (let i = 0; i < Math.min(teams.length, n); i++) {
    slots[order[i]] = teams[i].name;
  }

  const matches = {};
  const winnersRounds = [];
  const losersRounds = [];

  if (n === 2) {
    matches.GF1 = createMatch('GF1', 'grand_final', 0, 'Gran Final', slots[0], slots[1]);
  } else if (n === 4) {
    // Winners: WR1 (W1, W2) -> WF (W3)
    const w1 = createMatch('W1', 'winners', 0, 'Winners Semi', slots[0], slots[1]);
    const w2 = createMatch('W2', 'winners', 0, 'Winners Semi', slots[2], slots[3]);
    const w3 = createMatch('W3', 'winners', 1, 'Winners Final');

    w1.nextWinMatchId = 'W3'; w1.nextWinSlot = 'teamA';
    w2.nextWinMatchId = 'W3'; w2.nextWinSlot = 'teamB';
    w1.nextLoseMatchId = 'L1'; w1.nextLoseSlot = 'teamA';
    w2.nextLoseMatchId = 'L1'; w2.nextLoseSlot = 'teamB';
    w3.nextWinMatchId = 'GF1'; w3.nextWinSlot = 'teamA';
    w3.nextLoseMatchId = 'L2'; w3.nextLoseSlot = 'teamB';

    // Losers: LR1 (L1) -> LF (L2)
    const l1 = createMatch('L1', 'losers', 0, 'Losers Ronda 1');
    const l2 = createMatch('L2', 'losers', 1, 'Losers Final');
    l1.nextWinMatchId = 'L2'; l1.nextWinSlot = 'teamA';
    l2.nextWinMatchId = 'GF1'; l2.nextWinSlot = 'teamB';

    const gf = createMatch('GF1', 'grand_final', 0, 'Gran Final');

    Object.assign(matches, { W1: w1, W2: w2, W3: w3, L1: l1, L2: l2, GF1: gf });
    winnersRounds.push(['W1', 'W2'], ['W3']);
    losersRounds.push(['L1'], ['L2']);
  } else if (n === 8) {
    // Winners: WR1 (W1..W4) -> WR2 (W5, W6) -> WF (W7)
    const wr1 = [];
    for (let i = 0; i < 4; i++) {
      const id = `W${i + 1}`;
      const m = createMatch(id, 'winners', 0, 'Winners Cuartos', slots[i * 2], slots[i * 2 + 1]);
      m.nextWinMatchId = `W${5 + Math.floor(i / 2)}`;
      m.nextWinSlot = i % 2 === 0 ? 'teamA' : 'teamB';
      m.nextLoseMatchId = `L${1 + Math.floor(i / 2)}`;
      m.nextLoseSlot = i % 2 === 0 ? 'teamA' : 'teamB';
      matches[id] = m;
      wr1.push(id);
    }

    const w5 = createMatch('W5', 'winners', 1, 'Winners Semi');
    const w6 = createMatch('W6', 'winners', 1, 'Winners Semi');
    w5.nextWinMatchId = 'W7'; w5.nextWinSlot = 'teamA';
    w6.nextWinMatchId = 'W7'; w6.nextWinSlot = 'teamB';
    // Cross drop-ins into LR2 to prevent immediate rematches
    w5.nextLoseMatchId = 'L4'; w5.nextLoseSlot = 'teamB';
    w6.nextLoseMatchId = 'L3'; w6.nextLoseSlot = 'teamB';

    const w7 = createMatch('W7', 'winners', 2, 'Winners Final');
    w7.nextWinMatchId = 'GF1'; w7.nextWinSlot = 'teamA';
    w7.nextLoseMatchId = 'L6'; w7.nextLoseSlot = 'teamB';

    // Losers: LR1 (L1, L2) -> LR2 (L3, L4) -> LR3 (L5) -> LF (L6)
    const l1 = createMatch('L1', 'losers', 0, 'Losers Ronda 1');
    const l2 = createMatch('L2', 'losers', 0, 'Losers Ronda 1');
    l1.nextWinMatchId = 'L3'; l1.nextWinSlot = 'teamA';
    l2.nextWinMatchId = 'L4'; l2.nextWinSlot = 'teamA';

    const l3 = createMatch('L3', 'losers', 1, 'Losers Ronda 2');
    const l4 = createMatch('L4', 'losers', 1, 'Losers Ronda 2');
    l3.nextWinMatchId = 'L5'; l3.nextWinSlot = 'teamA';
    l4.nextWinMatchId = 'L5'; l4.nextWinSlot = 'teamB';

    const l5 = createMatch('L5', 'losers', 2, 'Losers Semi');
    l5.nextWinMatchId = 'L6'; l5.nextWinSlot = 'teamA';

    const l6 = createMatch('L6', 'losers', 3, 'Losers Final');
    l6.nextWinMatchId = 'GF1'; l6.nextWinSlot = 'teamB';

    const gf = createMatch('GF1', 'grand_final', 0, 'Gran Final');

    Object.assign(matches, { W5: w5, W6: w6, W7: w7, L1: l1, L2: l2, L3: l3, L4: l4, L5: l5, L6: l6, GF1: gf });
    winnersRounds.push(wr1, ['W5', 'W6'], ['W7']);
    losersRounds.push(['L1', 'L2'], ['L3', 'L4'], ['L5'], ['L6']);
  } else {
    // 16 teams: Winners WR1 (W1..W8) -> WR2 (W9..W12) -> WR3 (W13,W14) -> WF (W15)
    const wr1 = [];
    for (let i = 0; i < 8; i++) {
      const id = `W${i + 1}`;
      const m = createMatch(id, 'winners', 0, 'Winners Octavos', slots[i * 2], slots[i * 2 + 1]);
      m.nextWinMatchId = `W${9 + Math.floor(i / 2)}`;
      m.nextWinSlot = i % 2 === 0 ? 'teamA' : 'teamB';
      m.nextLoseMatchId = `L${1 + Math.floor(i / 2)}`;
      m.nextLoseSlot = i % 2 === 0 ? 'teamA' : 'teamB';
      matches[id] = m;
      wr1.push(id);
    }

    const wr2 = [];
    for (let i = 0; i < 4; i++) {
      const id = `W${9 + i}`;
      const m = createMatch(id, 'winners', 1, 'Winners Cuartos');
      m.nextWinMatchId = `W${13 + Math.floor(i / 2)}`;
      m.nextWinSlot = i % 2 === 0 ? 'teamA' : 'teamB';
      // Reverse drop into LR2 (L8, L7, L6, L5)
      m.nextLoseMatchId = `L${8 - i}`;
      m.nextLoseSlot = 'teamB';
      matches[id] = m;
      wr2.push(id);
    }

    const w13 = createMatch('W13', 'winners', 2, 'Winners Semi');
    const w14 = createMatch('W14', 'winners', 2, 'Winners Semi');
    w13.nextWinMatchId = 'W15'; w13.nextWinSlot = 'teamA';
    w14.nextWinMatchId = 'W15'; w14.nextWinSlot = 'teamB';
    w13.nextLoseMatchId = 'L12'; w13.nextLoseSlot = 'teamB';
    w14.nextLoseMatchId = 'L11'; w14.nextLoseSlot = 'teamB';

    const w15 = createMatch('W15', 'winners', 3, 'Winners Final');
    w15.nextWinMatchId = 'GF1'; w15.nextWinSlot = 'teamA';
    w15.nextLoseMatchId = 'L14'; w15.nextLoseSlot = 'teamB';

    // Losers 16: LR1 (L1..L4) -> LR2 (L5..L8) -> LR3 (L9,L10) -> LR4 (L11,L12) -> LR5 (L13) -> LF (L14)
    const lr1 = [];
    const lr2 = [];
    for (let i = 0; i < 4; i++) {
      const lid = `L${i + 1}`;
      const m1 = createMatch(lid, 'losers', 0, 'Losers Ronda 1');
      m1.nextWinMatchId = `L${5 + i}`; m1.nextWinSlot = 'teamA';
      matches[lid] = m1;
      lr1.push(lid);

      const lid2 = `L${5 + i}`;
      const m2 = createMatch(lid2, 'losers', 1, 'Losers Ronda 2');
      m2.nextWinMatchId = `L${9 + Math.floor(i / 2)}`;
      m2.nextWinSlot = i % 2 === 0 ? 'teamA' : 'teamB';
      matches[lid2] = m2;
      lr2.push(lid2);
    }

    const l9 = createMatch('L9', 'losers', 2, 'Losers Ronda 3');
    const l10 = createMatch('L10', 'losers', 2, 'Losers Ronda 3');
    l9.nextWinMatchId = 'L11'; l9.nextWinSlot = 'teamA';
    l10.nextWinMatchId = 'L12'; l10.nextWinSlot = 'teamA';

    const l11 = createMatch('L11', 'losers', 3, 'Losers Cuartos');
    const l12 = createMatch('L12', 'losers', 3, 'Losers Cuartos');
    l11.nextWinMatchId = 'L13'; l11.nextWinSlot = 'teamA';
    l12.nextWinMatchId = 'L13'; l12.nextWinSlot = 'teamB';

    const l13 = createMatch('L13', 'losers', 4, 'Losers Semi');
    l13.nextWinMatchId = 'L14'; l13.nextWinSlot = 'teamA';

    const l14 = createMatch('L14', 'losers', 5, 'Losers Final');
    l14.nextWinMatchId = 'GF1'; l14.nextWinSlot = 'teamB';

    const gf = createMatch('GF1', 'grand_final', 0, 'Gran Final');

    Object.assign(matches, {
      W13: w13, W14: w14, W15: w15,
      L9: l9, L10: l10, L11: l11, L12: l12, L13: l13, L14: l14,
      GF1: gf
    });
    winnersRounds.push(wr1, wr2, ['W13', 'W14'], ['W15']);
    losersRounds.push(lr1, lr2, ['L9', 'L10'], ['L11', 'L12'], ['L13'], ['L14']);
  }

  return {
    size: n,
    matches,
    winnersRounds,
    losersRounds,
    grandFinalId: 'GF1',
    champion: null
  };
}

/**
 * Advance a match result in the Double-Elimination bracket.
 * Moves the winner to nextWinMatchId and drops the loser into Losers Bracket.
 */
function applyMatchResult(bracket, matchId, winnerName) {
  if (!bracket?.matches) return false;
  const m = bracket.matches[String(matchId || '').toUpperCase()];
  if (!m) return false;

  const winKey = normalizeTeamKey(winnerName);
  let winner = null;
  let loser = null;

  if (m.teamA && normalizeTeamKey(m.teamA) === winKey) {
    winner = m.teamA;
    loser = m.teamB;
  } else if (m.teamB && normalizeTeamKey(m.teamB) === winKey) {
    winner = m.teamB;
    loser = m.teamA;
  } else {
    return false;
  }

  m.winner = winner;
  m.loser = loser;

  if (m.nextWinMatchId && bracket.matches[m.nextWinMatchId]) {
    bracket.matches[m.nextWinMatchId][m.nextWinSlot] = winner;
  }
  if (m.nextLoseMatchId && bracket.matches[m.nextLoseMatchId] && loser) {
    bracket.matches[m.nextLoseMatchId][m.nextLoseSlot] = loser;
  }
  if (m.id === bracket.grandFinalId) {
    bracket.champion = winner;
  }

  return true;
}

function deterministicShuffleOrder(count, seedInput) {
  const arr = Array.from({ length: count }, (_, i) => i);
  let hash = 2166136261;
  const str = String(seedInput || 'seed');
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  for (let i = arr.length - 1; i > 0; i--) {
    hash = (Math.imul(hash, 1664525) + 1013904223) >>> 0;
    const j = hash % (i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function applyDrawOrder(teams, drawOrder) {
  if (!Array.isArray(drawOrder) || !drawOrder.length) return teams;
  const seen = new Set();
  const reordered = [];
  for (const idx of drawOrder) {
    if (Number.isInteger(idx) && idx >= 0 && idx < teams.length && !seen.has(idx)) {
      seen.add(idx);
      reordered.push(teams[idx]);
    }
  }
  for (let i = 0; i < teams.length; i++) {
    if (!seen.has(i)) reordered.push(teams[i]);
  }
  return reordered;
}

const MATCH_COUNTDOWN_MS = 30 * 60 * 1000;

/**
 * Compute remaining 30-min match start countdown excluding any pause intervals.
 */
function computeMatchRemainingMs(readyAtMs, pauseIntervals = [], nowMs = Date.now()) {
  if (!readyAtMs) return null;
  const totalElapsed = Math.max(0, nowMs - readyAtMs);
  let pausedElapsed = 0;
  for (const p of pauseIntervals || []) {
    if (!p || !p.startMs) continue;
    const pEnd = p.endMs != null ? p.endMs : nowMs;
    const overlapStart = Math.max(readyAtMs, p.startMs);
    const overlapEnd = Math.min(nowMs, pEnd);
    if (overlapEnd > overlapStart) {
      pausedElapsed += overlapEnd - overlapStart;
    }
  }
  const activeElapsed = Math.max(0, totalElapsed - pausedElapsed);
  return Math.max(0, MATCH_COUNTDOWN_MS - activeElapsed);
}

/**
 * Build Double-Elimination bracket replaying results chronologically to stamp
 * exact 30-minute readiness timestamps onto each matchup once both rivals exist.
 */
function buildBracketWithTimers({
  teams = [],
  size = 8,
  drawn = false,
  drawOrder = null,
  started = false,
  startedAtMs = null,
  results = []
}) {
  const orderedTeams = drawn && drawOrder ? applyDrawOrder(teams, drawOrder) : teams;
  const bracket = generateDoubleElimBracket(orderedTeams, size);

  const stampReadyMatches = (atMs) => {
    if (!started || !atMs) return;
    for (const m of Object.values(bracket.matches)) {
      if (m.teamA && m.teamB && !m.winner && !m.readyAtMs) {
        m.readyAtMs = atMs;
      }
    }
  };

  // Seed initial matches at startedAtMs, then stamp downstream matches as results arrive
  if (started && startedAtMs) {
    stampReadyMatches(startedAtMs);
  }
  for (const r of results || []) {
    applyMatchResult(bracket, r.matchId, r.winnerName);
    if (started) {
      const eventMs = Math.max(Number(startedAtMs || 0), Number(r.atMs || Date.now()));
      stampReadyMatches(eventMs);
    }
  }

  return bracket;
}

function encodeCompactMatchStats(matchId, gameId, durationSec, players = []) {
  const cleanField = (s) => String(s || '').replace(/[|~;\n\r]+/g, ' ').trim();
  const rows = (players || [])
    .slice(0, 10)
    .map((p) =>
      [
        cleanField(p.riotId),
        cleanField(p.teamName || ''),
        Number(p.championId || 0),
        p.win ? 1 : 0,
        Number(p.kills || 0),
        Number(p.deaths || 0),
        Number(p.assists || 0),
        Number(p.cs || 0),
        Number(p.damage || 0),
        Number(p.gold || 0)
      ].join('~')
    )
    .join(';');
  return `!BOTSTATS ${cleanField(matchId).toUpperCase()} | game:${Number(gameId || 0)} | dur:${Number(durationSec || 0)} | ${rows}`;
}

function decodeCompactMatchStats(payloadStr) {
  return String(payloadStr || '')
    .split(';')
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => {
      const [riotId, teamName, championId, win, kills, deaths, assists, cs, damage, gold] = seg.split('~');
      if (!riotId) return null;
      return {
        riotId: riotId.trim(),
        teamName: (teamName || '').trim(),
        championId: Number(championId || 0),
        win: win === '1' || win === 'true',
        kills: Number(kills || 0),
        deaths: Number(deaths || 0),
        assists: Number(assists || 0),
        cs: Number(cs || 0),
        damage: Number(damage || 0),
        gold: Number(gold || 0)
      };
    })
    .filter(Boolean);
}

function computeTournamentMvpLeaderboard({ matchStats = [], teams = [] } = {}) {
  const byPlayer = new Map();
  const findTeamForRiot = (riotId) => {
    const found = (teams || []).find((t) => isPlayerInList(riotId, t.players || []));
    return found?.name || '';
  };

  for (const ms of matchStats || []) {
    for (const p of ms.players || []) {
      const key = normalizePlayerTag(p.riotId);
      if (!key) continue;
      const teamName = p.teamName || findTeamForRiot(p.riotId);
      if (!byPlayer.has(key)) {
        byPlayer.set(key, {
          riotId: p.riotId,
          teamName,
          games: 0,
          wins: 0,
          losses: 0,
          kills: 0,
          deaths: 0,
          assists: 0,
          totalDamage: 0,
          totalCs: 0,
          totalGold: 0,
          championIds: []
        });
      }
      const agg = byPlayer.get(key);
      if (teamName && !agg.teamName) agg.teamName = teamName;
      agg.games += 1;
      if (p.win) agg.wins += 1;
      else agg.losses += 1;
      agg.kills += Number(p.kills || 0);
      agg.deaths += Number(p.deaths || 0);
      agg.assists += Number(p.assists || 0);
      agg.totalDamage += Number(p.damage || 0);
      agg.totalCs += Number(p.cs || 0);
      agg.totalGold += Number(p.gold || 0);
      if (p.championId && !agg.championIds.includes(Number(p.championId))) {
        agg.championIds.push(Number(p.championId));
      }
    }
  }

  const list = [...byPlayer.values()].map((a) => {
    const g = Math.max(1, a.games);
    const kda = Number(((a.kills + a.assists) / Math.max(1, a.deaths)).toFixed(2));
    const avgKills = Number((a.kills / g).toFixed(1));
    const avgDeaths = Number((a.deaths / g).toFixed(1));
    const avgAssists = Number((a.assists / g).toFixed(1));
    const avgDamage = Math.round(a.totalDamage / g);
    const avgCs = Math.round(a.totalCs / g);
    const avgGold = Math.round(a.totalGold / g);
    const winRate = Math.round((a.wins / g) * 100);
    const mvpScore = Number(
      Math.max(
        0,
        (a.kills * 3 + a.assists * 1.8 - a.deaths * 1.5) / g +
          (a.wins / g) * 6 +
          avgDamage / 4000 +
          avgCs / 40
      ).toFixed(1)
    );
    return {
      ...a,
      kda,
      avgKills,
      avgDeaths,
      avgAssists,
      avgDamage,
      avgCs,
      avgGold,
      winRate,
      mvpScore
    };
  });

  list.sort((x, y) => (y.mvpScore - x.mvpScore) || (y.kda - x.kda) || (y.wins - x.wins) || (y.kills - x.kills));
  return list;
}

/**
 * Parse chronological Discord chat messages into an authoritative tournament state.
 * Supported commands:
 *   !TORNEO ON [2|4|8|16]
 *   !TORNEO [2|4|8|16]      (resize keeping registered teams)
 *   !TORNEO INICIAR / START (start tournament & 30-min match timers)
 *   !TORNEO PAUSA / PAUSE   (freeze active match timers overnight)
 *   !TORNEO REANUDAR        (resume timers seamlessly)
 *   !TORNEO OFF
 *   !AVISO <text> / !AVISO OFF (Admin global banner)
 *   !CLAVE <MatchId> | <Room> | <Pass> (custom lobby credentials)
 *   !SORTEO [0,1,2,...]
 *   !<TeamName> jugador1, jugador2, jugador3, jugador4, jugador5
 *   !BAJA <TeamName>
 *   !GANADOR <MatchId> <TeamName>
 */
function parseDiscordMessagesToTournament(messages, options = {}) {
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
  let size = 8;
  let openedAt = null;
  let openedBy = '';
  let teams = [];
  let drawn = false;
  let drawOrder = null;
  let started = false;
  let startedAt = null;
  let startedAtMs = null;
  let paused = false;
  const pauseIntervals = [];
  const results = [];
  const reportedGameIds = new Set();
  const roomsByMatchId = {};
  const matchStatsByKey = new Map();
  let announcement = null;
  let lobbyPresence = { matchId: null, players: [], updatedAt: null, reportedBy: '' };

  for (const msg of ordered) {
    const content = String(msg.content || '').trim();
    if (!content.startsWith('!')) continue;
    const msgAuthorId = String(msg.author?.id || '').trim();
    const msgIsBot = Boolean(msg.author?.bot);
    const msgIso = msg.timestamp || new Date().toISOString();
    const msgMs = new Date(msgIso).getTime() || Date.now();

    // 0. Global Admin Announcement: !AVISO <texto> | !AVISO OFF (works anytime, active or closed!)
    const avisoOffMatch = /^!(?:AVISO|ANUNCIO)\s+(?:OFF|CLEAR|NONE)(?:\b|$)/i.exec(content);
    if (avisoOffMatch) {
      if (isAuthorizedAdmin(msg)) announcement = null;
      continue;
    }
    const avisoMatch = /^!(?:AVISO|ANUNCIO)\s+(.+)$/i.exec(content);
    if (avisoMatch) {
      if (isAuthorizedAdmin(msg)) {
        announcement = { text: avisoMatch[1].trim(), at: msgIso, atMs: msgMs, by: 'NGELX' };
      }
      continue;
    }

    // 1. !TORNEO ON [2|4|8|16] (Admin only)
    const onMatch = /^!TORNEO\s+ON(?:\s+(2|4|8|16))?(?:\b|$)/i.exec(content);
    if (onMatch) {
      if (!isAuthorizedAdmin(msg)) continue;
      active = true;
      size = onMatch[1] ? Number(onMatch[1]) : 8;
      openedAt = msgIso;
      openedBy = 'NGELX';
      teams = [];
      drawn = false;
      drawOrder = null;
      started = false;
      startedAt = null;
      startedAtMs = null;
      paused = false;
      pauseIntervals.length = 0;
      results.length = 0;
      reportedGameIds.clear();
      Object.keys(roomsByMatchId).forEach((k) => delete roomsByMatchId[k]);
      matchStatsByKey.clear();
      lobbyPresence = { matchId: null, players: [], updatedAt: null, reportedBy: '' };
      continue;
    }

    // 2. !TORNEO OFF (Admin only)
    if (/^!TORNEO\s+OFF(?:\b|$)/i.test(content)) {
      if (!isAuthorizedAdmin(msg)) continue;
      active = false;
      size = 8;
      openedAt = null;
      openedBy = '';
      teams = [];
      drawn = false;
      drawOrder = null;
      started = false;
      startedAt = null;
      startedAtMs = null;
      paused = false;
      pauseIntervals.length = 0;
      results.length = 0;
      reportedGameIds.clear();
      Object.keys(roomsByMatchId).forEach((k) => delete roomsByMatchId[k]);
      matchStatsByKey.clear();
      lobbyPresence = { matchId: null, players: [], updatedAt: null, reportedBy: '' };
      continue;
    }

    if (!active) continue;

    // 2b. Resize without losing teams: !TORNEO [CUPOS|TAMANO|TAMAÑO|SIZE|CAMBIAR] 2|4|8|16 (Admin only)
    const resizeMatch = /^!TORNEO(?:\s+(?:CUPOS|TAMA[NÑ]O|SIZE|CAMBIAR))?\s+(2|4|8|16)(?:\b|$)/i.exec(content);
    if (resizeMatch) {
      if (!isAuthorizedAdmin(msg)) continue;
      size = Number(resizeMatch[1]);
      if (teams.length > size) {
        teams = teams.slice(0, size);
      }
      if (drawOrder && drawOrder.length !== size) {
        drawOrder = null;
        drawn = false;
      }
      continue;
    }

    // 2c. !TORNEO INICIAR / !TORNEO START (Admin only -> starts 30-min match countdowns)
    if (/^!(?:TORNEO\s+(?:INICIAR|START)|INICIAR)(?:\b|$)/i.test(content)) {
      if (!isAuthorizedAdmin(msg)) continue;
      started = true;
      startedAt = msgIso;
      startedAtMs = msgMs;
      if (paused && pauseIntervals.length && pauseIntervals[pauseIntervals.length - 1].endMs === null) {
        pauseIntervals[pauseIntervals.length - 1].endMs = msgMs;
      }
      paused = false;
      if (!drawn && teams.length >= 2) {
        drawOrder = deterministicShuffleOrder(teams.length, msg.id || msgIso || content);
        drawn = true;
      }
      continue;
    }

    // 2d. !TORNEO PAUSA / !TORNEO PAUSE / !PAUSAR (Admin only -> freeze timers overnight)
    if (/^!(?:TORNEO\s+(?:PAUSA|PAUSAR|PAUSE)|PAUSA|PAUSAR)(?:\b|$)/i.test(content)) {
      if (!isAuthorizedAdmin(msg)) continue;
      if (!paused) {
        paused = true;
        pauseIntervals.push({ startMs: msgMs, endMs: null });
      }
      continue;
    }

    // 2e. !TORNEO REANUDAR / !TORNEO RESUME / !REANUDAR (Admin only -> resume frozen timers)
    if (/^!(?:TORNEO\s+(?:REANUDAR|RESUME)|REANUDAR)(?:\b|$)/i.test(content)) {
      if (!isAuthorizedAdmin(msg)) continue;
      if (paused && pauseIntervals.length && pauseIntervals[pauseIntervals.length - 1].endMs === null) {
        pauseIntervals[pauseIntervals.length - 1].endMs = msgMs;
      }
      paused = false;
      continue;
    }

    // 3. !BAJA <TeamName> [| by:<ownerKey>] (only whoever registered the team or Admin)
    const dropMatch = /^!BAJA\s+([^|\n]+?)(?:\s*\|\s*by:([a-z0-9_-]+))?$/i.exec(content);
    if (dropMatch) {
      const targetKey = normalizeTeamKey(dropMatch[1]);
      const byOwnerKey = dropMatch[2] ? dropMatch[2].trim().toLowerCase() : '';
      const existing = teams.find((t) => normalizeTeamKey(t.name) === targetKey);
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

      teams = teams.filter((t) => normalizeTeamKey(t.name) !== targetKey);
      if (teams.length < size && !started) {
        drawn = false;
        drawOrder = null;
      }
      continue;
    }

    // 3b. !SORTEO [0,1,2,...]
    const drawMatch = /^!SORTEO(?:\s+([0-9,\s]+))?$/i.exec(content);
    if (drawMatch) {
      const canDraw = isAuthorizedAdmin(msg) || (msgIsBot && !drawn);
      if (!canDraw || teams.length < 2) continue;
      const explicit = drawMatch[1]
        ? drawMatch[1].split(',').map((s) => Number(s.trim())).filter((x) => Number.isInteger(x))
        : null;
      drawOrder =
        explicit && explicit.length === teams.length
          ? explicit
          : deterministicShuffleOrder(teams.length, msg.id || msg.timestamp || content);
      drawn = true;
      continue;
    }

    // 4. !GANADOR <MatchId> <TeamName> (Admin only)
    const winMatch = /^!(?:GANADOR|WIN)\s+([A-Za-z0-9]+)\s+(.+)$/i.exec(content);
    if (winMatch) {
      if (!isAuthorizedAdmin(msg)) continue;
      drawn = true;
      results.push({
        matchId: winMatch[1].toUpperCase(),
        winnerName: winMatch[2].trim(),
        atMs: msgMs
      });
      continue;
    }

    // 4b. !BOTGANADOR <MatchId> <TeamName> | game:<gameId>
    const botWinMatch = /^!BOTGANADOR\s+([A-Za-z0-9]+)\s+(.+?)\s*\|\s*game:(\d+)$/i.exec(content);
    if (botWinMatch) {
      if (adminOnly && !msgIsBot && !isAuthorizedAdmin(msg)) continue;
      drawn = true;
      reportedGameIds.add(Number(botWinMatch[3]));
      results.push({
        matchId: botWinMatch[1].toUpperCase(),
        winnerName: botWinMatch[2].trim(),
        atMs: msgMs
      });
      continue;
    }

    // 4c. !SALA <MatchId|SALA|CLEAR> [| p1, p2, ...]
    const salaClearMatch = /^!SALA\s+(?:CLEAR|NONE)$/i.exec(content);
    if (salaClearMatch) {
      lobbyPresence = {
        matchId: null,
        players: [],
        updatedAt: msgIso,
        reportedBy: msg.author?.global_name || msg.author?.username || 'Bot'
      };
      continue;
    }
    const salaMatch = /^!SALA\s+([A-Za-z0-9_-]+)\s*\|\s*(.*)$/i.exec(content);
    if (salaMatch) {
      const players = salaMatch[2]
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      lobbyPresence = {
        matchId: salaMatch[1].toUpperCase() === 'SALA' ? null : salaMatch[1].toUpperCase(),
        players,
        updatedAt: msgIso,
        reportedBy: msg.author?.global_name || msg.author?.username || 'Bot'
      };
      continue;
    }

    // 4d. !CLAVE <MatchId> | <RoomName> | <RoomPass> [| by:<ownerKey>]
    const roomClearMatch = /^!(?:CLAVE|SALACODE|SALAINFO)\s+([A-Za-z0-9]+)\s*\|\s*(?:CLEAR|NONE)(?:\s*\|\s*by:([a-z0-9_-]+))?$/i.exec(content);
    if (roomClearMatch) {
      const mId = roomClearMatch[1].toUpperCase();
      const byKey = (roomClearMatch[2] || '').trim().toLowerCase();
      let canEdit = isAuthorizedAdmin(msg);
      if (!canEdit && msgIsBot && byKey) {
        const snapB = buildBracketWithTimers({ teams, size, drawn, drawOrder, started, startedAtMs, results });
        const mObj = snapB.matches?.[mId];
        const tA = teams.find((t) => normalizeTeamKey(t.name) === normalizeTeamKey(mObj?.teamA));
        const tB = teams.find((t) => normalizeTeamKey(t.name) === normalizeTeamKey(mObj?.teamB));
        canEdit = Boolean((tA?.ownerKey && tA.ownerKey === byKey) || (tB?.ownerKey && tB.ownerKey === byKey));
      }
      if (canEdit) delete roomsByMatchId[mId];
      continue;
    }
    const roomMatch = /^!(?:CLAVE|SALACODE|SALAINFO)\s+([A-Za-z0-9]+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)(?:\s*\|\s*by:([a-z0-9_-]+))?$/i.exec(content);
    if (roomMatch) {
      const mId = roomMatch[1].toUpperCase();
      const roomName = roomMatch[2].trim();
      const roomPass = roomMatch[3].trim();
      const byKey = (roomMatch[4] || '').trim().toLowerCase();
      let canEdit = isAuthorizedAdmin(msg);
      if (!canEdit && msgIsBot && byKey) {
        const snapB = buildBracketWithTimers({ teams, size, drawn, drawOrder, started, startedAtMs, results });
        const mObj = snapB.matches?.[mId];
        const tA = teams.find((t) => normalizeTeamKey(t.name) === normalizeTeamKey(mObj?.teamA));
        const tB = teams.find((t) => normalizeTeamKey(t.name) === normalizeTeamKey(mObj?.teamB));
        canEdit = Boolean((tA?.ownerKey && tA.ownerKey === byKey) || (tB?.ownerKey && tB.ownerKey === byKey));
      }
      if (canEdit && roomName) {
        roomsByMatchId[mId] = { matchId: mId, roomName, roomPass, updatedAt: msgIso };
      }
      continue;
    }

    // 4e. !BOTSTATS <MatchId> | game:<gameId> | dur:<sec> | <compactPlayers>
    const botStatsMatch = /^!BOTSTATS\s+([A-Za-z0-9]+)\s*\|\s*game:(\d+)\s*\|\s*dur:(\d+)\s*\|\s*(.+)$/i.exec(content);
    if (botStatsMatch) {
      if (adminOnly && !msgIsBot && !isAuthorizedAdmin(msg)) continue;
      const mId = botStatsMatch[1].toUpperCase();
      const gameId = Number(botStatsMatch[2]);
      const durationSec = Number(botStatsMatch[3]);
      const players = decodeCompactMatchStats(botStatsMatch[4]);
      if (players.length) {
        matchStatsByKey.set(`${mId}:${gameId}`, { matchId: mId, gameId, durationSec, players, at: msgIso });
      }
      continue;
    }

    // 5. Team registration: !<TeamName> int1, int2, ... [| reg:<ownerKey>]
    const regMatch = /^!([^\s|]+)(?:\s*\|\s*|\s+)(.+)$/.exec(content);
    if (regMatch) {
      const cmdToken = regMatch[1].trim();
      if (/^(TORNEO|GANADOR|WIN|BOTGANADOR|BOTSTATS|BAJA|SALA|CLAVE|SALACODE|SALAINFO|AVISO|ANUNCIO|SORTEO|INICIAR|PAUSA|PAUSAR|REANUDAR)$/i.test(cmdToken)) continue;

      let rawPlayersStr = regMatch[2];
      let ownerKey = '';
      const ownerTagMatch = /\|\s*reg:([a-z0-9_-]+)\s*$/i.exec(rawPlayersStr);
      if (ownerTagMatch) {
        ownerKey = ownerTagMatch[1].trim().toLowerCase();
        rawPlayersStr = rawPlayersStr.slice(0, ownerTagMatch.index).trim();
      }

      const players = rawPlayersStr
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 5);

      if (!players.length) continue;

      const existingIdx = teams.findIndex((t) => normalizeTeamKey(t.name) === normalizeTeamKey(cmdToken));
      const record = {
        name: cmdToken,
        players,
        ownerKey,
        authorId: msgAuthorId,
        authorIsBot: msgIsBot,
        registeredBy: msg.author?.global_name || msg.author?.username || 'Discord',
        registeredAt: msgIso
      };

      if (existingIdx >= 0) {
        const existing = teams[existingIdx];
        const canEdit =
          isAuthorizedAdmin(msg) ||
          (!msgIsBot && !existing.authorIsBot && existing.authorId && existing.authorId === msgAuthorId) ||
          (msgIsBot && ownerKey && existing.ownerKey && ownerKey === String(existing.ownerKey).toLowerCase());
        if (canEdit) {
          teams[existingIdx] = record;
        }
      } else if (teams.length < size) {
        teams.push(record);
      }
    }
  }

  if (!active) {
    return {
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
      mvpLeaderboard: [],
      announcement,
      lobbyPresence,
      reportedGameIds: []
    };
  }

  const bracket = buildBracketWithTimers({
    teams,
    size,
    drawn,
    drawOrder,
    started,
    startedAtMs,
    results
  });
  for (const [mId, rm] of Object.entries(roomsByMatchId)) {
    if (bracket.matches?.[mId]) {
      bracket.matches[mId].roomName = rm.roomName;
      bracket.matches[mId].roomPass = rm.roomPass;
    }
  }
  const matchStats = [...matchStatsByKey.values()];
  const mvpLeaderboard = computeTournamentMvpLeaderboard({ matchStats, teams });

  return {
    active: true,
    size,
    openedAt,
    openedBy,
    teams,
    drawn,
    started,
    startedAt,
    paused,
    pauseIntervals,
    bracket,
    roomsByMatchId,
    matchStats,
    mvpLeaderboard,
    announcement,
    lobbyPresence,
    reportedGameIds: [...reportedGameIds]
  };
}

/**
 * Identify which pending bracket match is gathering in the current Custom Lobby,
 * and detect if any finished Custom Game in LoL Match History decides a pending match.
 */
function matchLobbyAndCustomGames({
  bracket,
  teams = [],
  openedAt = null,
  lobbyPlayers = [],
  customGames = [],
  reportedGameIds = []
}) {
  if (!bracket?.matches) {
    return { activeLobbyMatchId: null, matchedTournamentLobbyPlayers: [], detectedResult: null };
  }

  const teamRosterMap = new Map(
    (teams || []).map((t) => [normalizeTeamKey(t.name), Array.isArray(t.players) ? t.players : []])
  );

  // Deduplicated subset of registered tournament players currently inside the Custom Lobby
  const matchedPlayersMap = new Map();
  for (const t of teams || []) {
    for (const p of t.players || []) {
      if (isPlayerInList(p, lobbyPlayers)) {
        matchedPlayersMap.set(normalizePlayerTag(p), p);
      }
    }
  }
  const matchedTournamentLobbyPlayers = [...matchedPlayersMap.values()];

  let activeLobbyMatchId = null;
  let bestLobbyScore = 0;

  const pendingMatches = Object.values(bracket.matches).filter((m) => m.teamA && m.teamB && !m.winner);
  for (const m of pendingMatches) {
    const rA = teamRosterMap.get(normalizeTeamKey(m.teamA)) || [];
    const rB = teamRosterMap.get(normalizeTeamKey(m.teamB)) || [];
    const hitsA = rA.filter((p) => isPlayerInList(p, lobbyPlayers)).length;
    const hitsB = rB.filter((p) => isPlayerInList(p, lobbyPlayers)).length;
    const score = hitsA + hitsB + (hitsA > 0 && hitsB > 0 ? 5 : 0);
    if (hitsA + hitsB > 0 && score > bestLobbyScore) {
      bestLobbyScore = score;
      activeLobbyMatchId = m.id;
    }
  }

  const openedMs = openedAt ? new Date(openedAt).getTime() : 0;
  const reportedSet = new Set((reportedGameIds || []).map(Number));
  let detectedResult = null;

  for (const game of customGames || []) {
    if (!game || reportedSet.has(Number(game.gameId))) continue;
    const gameEndMs = Number(game.gameCreationMs || 0) + Number(game.gameDuration || 0) * 1000;
    if (openedMs && gameEndMs && gameEndMs < openedMs - 120000) continue;
    if (game.team100Win === game.team200Win) continue;

    for (const m of pendingMatches) {
      const rA = teamRosterMap.get(normalizeTeamKey(m.teamA)) || [];
      const rB = teamRosterMap.get(normalizeTeamKey(m.teamB)) || [];
      if (!rA.length || !rB.length) continue;

      const a100 = rA.filter((p) => isPlayerInList(p, game.team100Players)).length;
      const a200 = rA.filter((p) => isPlayerInList(p, game.team200Players)).length;
      const b100 = rB.filter((p) => isPlayerInList(p, game.team100Players)).length;
      const b200 = rB.filter((p) => isPlayerInList(p, game.team200Players)).length;

      const aSide100 = a100 >= 1 && b200 >= 1 && a100 > b100 && b200 > a200 && a100 >= a200 && b200 >= b100;
      const aSide200 = a200 >= 1 && b100 >= 1 && a200 > b200 && b100 > a100 && a200 >= a100 && b100 >= b200;

      if (aSide100 && !aSide200) {
        detectedResult = {
          matchId: m.id,
          winnerName: game.team100Win ? m.teamA : m.teamB,
          loserName: game.team100Win ? m.teamB : m.teamA,
          gameId: Number(game.gameId),
          gameDuration: Number(game.gameDuration || 0),
          playerStats: (game.playerStats || []).map((ps) => ({
            ...ps,
            teamName: ps.teamId === 100 ? m.teamA : (ps.teamId === 200 ? m.teamB : '')
          }))
        };
        break;
      }
      if (aSide200 && !aSide100) {
        detectedResult = {
          matchId: m.id,
          winnerName: game.team200Win ? m.teamA : m.teamB,
          loserName: game.team200Win ? m.teamB : m.teamA,
          gameId: Number(game.gameId),
          gameDuration: Number(game.gameDuration || 0),
          playerStats: (game.playerStats || []).map((ps) => ({
            ...ps,
            teamName: ps.teamId === 200 ? m.teamA : (ps.teamId === 100 ? m.teamB : '')
          }))
        };
        break;
      }
    }
    if (detectedResult) break;
  }

  return {
    activeLobbyMatchId,
    matchedTournamentLobbyPlayers,
    detectedResult
  };
}

module.exports = {
  VALID_SIZES,
  MATCH_COUNTDOWN_MS,
  normalizePlayerTag,
  playersMatch,
  isPlayerInList,
  applyDrawOrder,
  computeMatchRemainingMs,
  buildBracketWithTimers,
  generateDoubleElimBracket,
  applyMatchResult,
  encodeCompactMatchStats,
  decodeCompactMatchStats,
  computeTournamentMvpLeaderboard,
  parseDiscordMessagesToTournament,
  matchLobbyAndCustomGames
};
