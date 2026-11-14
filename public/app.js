const ROLE_LABELS = {
  top: 'Top',
  jungle: 'Jungle',
  mid: 'Mid',
  adc: 'ADC',
  support: 'Support'
};

const LANE_SPANISH_LABELS = {
  all: 'Todos',
  top: 'Superior',
  jungle: 'Jungla',
  mid: 'Central',
  adc: 'Inferior',
  support: 'Apoyo'
};

function getRoleSvgIcon(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'top') {
    return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 3h10v4H7v6H3V3z"/><rect x="13" y="13" width="8" height="8" rx="1" opacity="0.25"/></svg>`;
  }
  if (r === 'jungle') {
    return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.5 5.5 6 10 6 14.5 6 18.1 8.7 21 12 21s6-2.9 6-6.5C18 10 15.5 5.5 12 2zm0 16c-1.7 0-3-1.3-3-3 0-2 1.3-4.8 3-7 1.7 2.2 3 5 3 7 0 1.7-1.3 3-3 3z"/></svg>`;
  }
  if (r === 'mid') {
    return `<svg viewBox="0 0 24 24" fill="currentColor"><line x1="3" y1="21" x2="21" y2="3" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><rect x="3" y="3" width="6" height="6" rx="1" opacity="0.25"/><rect x="15" y="15" width="6" height="6" rx="1" opacity="0.25"/></svg>`;
  }
  if (r === 'adc' || r === 'bottom') {
    return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 17h6v-6h4v10H11v-4z"/><rect x="3" y="3" width="8" height="8" rx="1" opacity="0.25"/></svg>`;
  }
  if (r === 'support') {
    return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L4 5v6.5C4 16.5 7.4 21 12 22c4.6-1 8-5.5 8-10.5V5l-8-3zm0 3.2l5 1.9v4.9c0 3.7-2.3 7-5 7.9-2.7-.9-5-4.2-5-7.9V7.1l5-1.9z"/><circle cx="12" cy="11.5" r="2.2"/></svg>`;
  }
  return '';
}

const state = {
  config: null,
  activeSeason: null,
  seasons: [],
  champions: [],
  championsById: new Map(),
  laneChampionIds: {},
  currentView: 'draft',

  // Draft state (driven by LCU when in Champ Select, or manual edits)
  draft: {
    myRole: 'mid',
    enemyLanerId: null,
    allies: [], // [{ championId, role }]
    enemies: [], // [{ championId, inferredRole }]
    bans: [],
    myChampionId: null,
    myChampionLocked: false
  },

  // Manual overrides during active Champ Select
  manualEnemyOverride: false,
  manualModeChosen: false,

  mode: 'patch_wr', // 'lane_1v1' | 'counter_wr' | 'synergy' | 'patch_wr' | 'global'
  opggLane: 'all',
  onlyPool: false,
  searchQuery: '',
  poolSearchQuery: '',
  draftPoolSearchQuery: '',
  lastTournamentSnap: null,
  lastRoadToSnap: null,
  torneoAnnouncement: null,
  roadToAnnouncement: null,

  recommendations: null,
  selectedPreviewId: null,
  myChampionBuildData: null,

  lcu: {
    enabled: true,
    connected: false,
    inChampSelect: false,
    statusMessage: 'LCU: Esperando'
  },
  lastSeenLcuChampId: null,
  lastSeenInChampSelect: false,

  pickerContext: null // { type: 'enemyLaner' | 'ally' | 'myChampion', slotIndex?: number }
};

let recAbortController = null;
let syncEventSource = null;

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function pct(val, digits = 1) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return '—';
  return `${(Number(val) * 100).toFixed(digits)}%`;
}

function wrClass(wr) {
  if (wr === null || wr === undefined) return 'metric-mid';
  if (wr >= 0.515) return 'metric-good';
  if (wr < 0.485) return 'metric-bad';
  return 'metric-mid';
}

function advBadgeHtml(adv, prefix) {
  if (!adv) return '';
  if (adv === 'me') return `<span class="adv-tag adv-me">${esc(prefix)}: Tú</span>`;
  if (adv === 'enemy') return `<span class="adv-tag adv-enemy">${esc(prefix)}: Rival</span>`;
  return `<span class="adv-tag adv-even">${esc(prefix)}: Parejo</span>`;
}

async function apiJson(url, options = {}) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
  } catch {
    throw new Error('Sin conexión con el servidor local (puerto 3848). Cierra esta ventana y vuelve a abrir LoL Advisor.exe.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ==================== INITIALIZATION ====================
async function bootstrap() {
  const data = await apiJson('/api/bootstrap');
  state.config = data.config;
  state.activeSeason = data.activeSeason;
  state.seasons = data.seasons || [];
  state.champions = data.champions || [];
  state.championsById = new Map(state.champions.map((c) => [Number(c.id), c]));
  state.laneChampionIds = data.laneChampionIds || {};

  if (state.config?.defaultRoles?.[0] && !state.lcu.inChampSelect) {
    state.draft.myRole = state.config.defaultRoles[0];
  }

  renderTopBar();
  renderDraftControls();
  renderDatabaseView();
  syncSettingsInputs();
  syncSoloDuoInputs();
  syncDiscordInputs();
  refreshOverlayStatus();
  refreshTournamentState();
  refreshRoadToState();

  if (!state.activeSeason) {
    document.getElementById('emptyDbBanner').classList.remove('hidden');
  } else {
    document.getElementById('emptyDbBanner').classList.add('hidden');
  }

  if (data.syncInProgress) {
    attachSyncStream();
  }

  checkCloudUpdates(false);
  await refreshRecommendations();
}

// ==================== NAVIGATION ====================
function switchView(viewName) {
  state.currentView = viewName;
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.view === viewName);
  });
  document.querySelectorAll('.view').forEach((v) => {
    v.classList.toggle('active', v.id === `view-${viewName}`);
  });
  if (viewName === 'my-champion' && state.draft.myChampionId) {
    loadMyChampionTab(state.draft.myChampionId);
  }
}

function renderTopBar() {
  const patchEl = document.getElementById('activePatchPill');
  if (state.activeSeason) {
    patchEl.textContent = `Parche ${state.activeSeason.patch}`;
  } else {
    patchEl.textContent = 'Sin datos';
  }

  // Pinned "Mi Campeón" tab
  const tabBtn = document.getElementById('myChampNavTab');
  const tabIcon = document.getElementById('myChampTabIcon');
  const tabLabel = document.getElementById('myChampTabLabel');
  const myChamp = state.draft.myChampionId ? state.championsById.get(state.draft.myChampionId) : null;

  if (myChamp) {
    tabBtn.classList.remove('hidden');
    tabIcon.src = myChamp.iconUrl;
    tabLabel.textContent = `Mi Campeón: ${myChamp.name}`;
  } else {
    tabBtn.classList.add('hidden');
    if (state.currentView === 'my-champion') {
      switchView('draft');
    }
  }

  // LCU pill
  const ind = document.getElementById('lcuIndicator');
  const txt = document.getElementById('lcuStatusText');
  ind.className = 'dot';
  if (!state.config?.lcuEnabled) {
    txt.textContent = 'Modo Manual';
  } else if (state.isInGame) {
    ind.classList.add('in-champ-select');
    txt.textContent = `En Partida (${state.liveGame?.gameTimeLabel || '0:00'})`;
  } else if (state.lcu.inChampSelect) {
    ind.classList.add('in-champ-select');
    txt.textContent = 'LCU: En Champ Select';
  } else if (state.lcu.connected) {
    ind.classList.add('online');
    txt.textContent = 'LCU: Conectado';
  } else {
    txt.textContent = 'LCU: Esperando LoL';
  }
  renderLcuProfileBadge(state.lcu?.connected ? state.lcu?.currentSummoner : null);
}

function renderLcuProfileBadge(summoner) {
  const badge = document.getElementById('lcuProfileBadge');
  const avatarEl = document.getElementById('lcuProfileAvatar');
  const nameEl = document.getElementById('lcuProfileName');
  const rankEl = document.getElementById('lcuProfileRank');
  if (!badge || !avatarEl || !nameEl || !rankEl) return;

  if (!summoner || !summoner.gameName) {
    badge.classList.add('offline');
    delete badge.dataset.tier;
    avatarEl.classList.add('hidden');
    avatarEl.removeAttribute('src');
    nameEl.textContent = 'LoL no detectado';
    rankEl.textContent = 'Abre League of Legends';
    return;
  }

  badge.classList.remove('offline');
  badge.dataset.tier = String(summoner.soloRank?.tier || 'UNRANKED').toUpperCase();
  const fullName = summoner.tagLine ? `${summoner.gameName}#${summoner.tagLine}` : summoner.gameName;
  nameEl.textContent = fullName;
  rankEl.textContent = summoner.soloRank?.label || 'Unranked (Solo/Duo)';
  if (summoner.profileIconUrl) {
    avatarEl.src = summoner.profileIconUrl;
    avatarEl.classList.remove('hidden');
  } else {
    avatarEl.classList.add('hidden');
  }
}

// ==================== LCU POLLING ====================
async function pollLcu() {
  if (!state.config?.lcuEnabled) return;
  try {
    const lcu = await apiJson('/api/lcu');
    state.lcu = lcu;

    // Auto-fill Riot ID input when LCU detects current summoner and input is empty
    if (lcu.currentSummoner?.gameName) {
      const riotInput = document.getElementById('riotIdInput');
      const regionSel = document.getElementById('regionSelect');
      if (riotInput && !riotInput.value.trim() && lcu.currentSummoner.tagLine) {
        riotInput.value = `${lcu.currentSummoner.gameName}#${lcu.currentSummoner.tagLine}`;
        if (lcu.currentSummoner.region && regionSel) {
          const mapReg = { LA1: 'LAN', LA2: 'LAS', NA1: 'NA', EUW1: 'EUW', EUN1: 'EUNE', BR1: 'BR', KR: 'KR', JP1: 'JP', OC1: 'OCE' };
          const mapped = mapReg[lcu.currentSummoner.region.toUpperCase()] || lcu.currentSummoner.region.toUpperCase();
          if ([...regionSel.options].some((o) => o.value === mapped)) {
            regionSel.value = mapped;
          }
        }
      }
    }

    if (lcu.inChampSelect) {
      let draftChanged = false;

      if (!state.lastSeenInChampSelect) {
        state.manualEnemyOverride = false;
        state.manualModeChosen = false;
        switchView('draft');
      }

      if (lcu.myRole && lcu.myRole !== state.draft.myRole) {
        state.draft.myRole = lcu.myRole;
        state.opggLane = lcu.myRole;
        draftChanged = true;
      }

      const alliesKey = JSON.stringify(lcu.allies || []);
      if (alliesKey !== JSON.stringify(state.draft.allies)) {
        state.draft.allies = lcu.allies || [];
        draftChanged = true;
      }

      const enemiesKey = JSON.stringify(lcu.enemies || []);
      if (enemiesKey !== JSON.stringify(state.draft.enemies)) {
        state.draft.enemies = lcu.enemies || [];
        draftChanged = true;
      }

      if (JSON.stringify(lcu.bans || []) !== JSON.stringify(state.draft.bans)) {
        state.draft.bans = lcu.bans || [];
        draftChanged = true;
      }

      if (!state.manualEnemyOverride && lcu.enemyLanerId !== state.draft.enemyLanerId) {
        state.draft.enemyLanerId = lcu.enemyLanerId || null;
        state.selectedPreviewId = null;
        draftChanged = true;
      }

      if (!state.manualModeChosen) {
        state.mode = state.draft.enemyLanerId ? 'counter_wr' : 'patch_wr';
      } else if (!state.draft.enemyLanerId && (state.mode === 'counter_wr' || state.mode === 'lane_1v1')) {
        state.mode = 'patch_wr';
      }

      if (lcu.myChampionId !== state.draft.myChampionId || lcu.myChampionLocked !== state.draft.myChampionLocked) {
        state.draft.myChampionId = lcu.myChampionId || null;
        state.draft.myChampionLocked = Boolean(lcu.myChampionLocked);
        draftChanged = true;

        if (lcu.myChampionId && lcu.myChampionId !== state.lastSeenLcuChampId) {
          state.lastSeenLcuChampId = lcu.myChampionId;
          await loadMyChampionTab(lcu.myChampionId);
          if (state.config?.autoFocusMyChampTab) {
            switchView('my-champion');
          }
        }
      }

      if (draftChanged) {
        renderDraftControls();
        await refreshRecommendations();
        if (state.draft.myChampionId) {
          await loadMyChampionTab(state.draft.myChampionId);
        }
      }
      state.lastSeenInChampSelect = true;
    } else {
      if (state.lastSeenInChampSelect) {
        state.lastSeenInChampSelect = false;
        state.lastSeenLcuChampId = null;
      }

      // Live In-Game detection
      try {
        const live = await apiJson('/api/live-overlay');
        if (live && live.inGame) {
          state.isInGame = true;
          state.liveGame = live;

          let liveChanged = false;
          if (live.role && live.role !== state.draft.myRole) {
            state.draft.myRole = live.role;
            liveChanged = true;
          }
          if (live.myChampion?.id && live.myChampion.id !== state.draft.myChampionId) {
            state.draft.myChampionId = live.myChampion.id;
            liveChanged = true;
          }
          if (live.opponentChampion?.id && live.opponentChampion.id !== state.draft.enemyLanerId) {
            state.draft.enemyLanerId = live.opponentChampion.id;
            liveChanged = true;
          }
          if (Array.isArray(live.allies) && live.allies.length) {
            const alliesKey = JSON.stringify(live.allies);
            if (alliesKey !== JSON.stringify(state.draft.allies)) {
              state.draft.allies = live.allies;
              liveChanged = true;
            }
          }
          if (Array.isArray(live.enemies) && live.enemies.length) {
            const enemiesKey = JSON.stringify(live.enemies);
            if (enemiesKey !== JSON.stringify(state.draft.enemies)) {
              state.draft.enemies = live.enemies;
              liveChanged = true;
            }
          }

          if (!state.lastSeenInGame) {
            state.lastSeenInGame = true;
            if (state.config?.autoFocusMyChampTab) {
              switchView('my-champion');
            }
          }

          if (liveChanged && state.draft.myChampionId) {
            renderDraftControls();
            await loadMyChampionTab(state.draft.myChampionId);
          }
        } else {
          state.isInGame = false;
          state.lastSeenInGame = false;
          state.liveGame = null;
        }
      } catch {
        // Live overlay polling ignored
      }
    }

    renderTopBar();
  } catch {
    // Non-fatal polling error
  }
}

// ==================== DRAFT CONTROLS ====================
function renderDraftControls() {
  // Role pills
  document.querySelectorAll('#roleSelector .role-pill').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.role === state.draft.myRole);
  });

  // Enemy laner slot
  const enemyBtn = document.getElementById('enemyLanerBtn');
  const clearEnemyBtn = document.getElementById('clearEnemyLanerBtn');
  const enemyChamp = state.draft.enemyLanerId ? state.championsById.get(state.draft.enemyLanerId) : null;
  if (enemyChamp) {
    enemyBtn.classList.add('filled');
    enemyBtn.innerHTML = `<img class="slot-avatar" src="${esc(enemyChamp.iconUrl)}" alt="" /><span>${esc(enemyChamp.name)}</span>`;
    clearEnemyBtn.classList.remove('hidden');
  } else {
    enemyBtn.classList.remove('filled');
    enemyBtn.innerHTML = `<span class="slot-empty">+ Sin rival (1er Pick)</span>`;
    clearEnemyBtn.classList.add('hidden');
  }

  // My champion slot
  const myBtn = document.getElementById('myChampDraftBtn');
  const clearMyBtn = document.getElementById('clearMyChampBtn');
  const myChamp = state.draft.myChampionId ? state.championsById.get(state.draft.myChampionId) : null;
  if (myChamp) {
    myBtn.classList.add('filled');
    myBtn.innerHTML = `<img class="slot-avatar" src="${esc(myChamp.iconUrl)}" alt="" /><span>${esc(myChamp.name)}</span>`;
    clearMyBtn.classList.remove('hidden');
  } else {
    myBtn.classList.remove('filled');
    myBtn.innerHTML = `<span class="slot-empty">+ Elegir pick</span>`;
    clearMyBtn.classList.add('hidden');
  }

  // 4 ally slots
  const alliesWrap = document.getElementById('alliesContainer');
  alliesWrap.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const ally = state.draft.allies[i];
    const allyChamp = ally ? state.championsById.get(ally.championId) : null;
    const btn = document.createElement('button');
    btn.className = `ally-mini-btn ${allyChamp ? 'filled' : ''}`;
    btn.title = allyChamp
      ? `${allyChamp.name}${ally.role ? ` (${ROLE_LABELS[ally.role] || ally.role})` : ''} — Clic para cambiar o quitar`
      : 'Agregar aliado para calcular sinergia';
    if (allyChamp) {
      btn.innerHTML = `<img src="${esc(allyChamp.iconUrl)}" alt="${esc(allyChamp.name)}" />`;
      btn.addEventListener('click', (e) => {
        if (e.shiftKey) {
          state.draft.allies.splice(i, 1);
          renderDraftControls();
          refreshRecommendations();
        } else {
          openChampionPicker({ type: 'ally', slotIndex: i });
        }
      });
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        state.draft.allies.splice(i, 1);
        renderDraftControls();
        refreshRecommendations();
      });
    } else {
      btn.textContent = '+';
      btn.addEventListener('click', () => openChampionPicker({ type: 'ally', slotIndex: i }));
    }
    alliesWrap.appendChild(btn);
  }

  // Extra enemies & bans bar
  const extraRow = document.getElementById('extraDraftRow');
  const otherEnemiesGroup = document.getElementById('otherEnemiesGroup');
  const otherEnemiesList = document.getElementById('otherEnemiesList');
  const bansGroup = document.getElementById('bansGroup');
  const bansList = document.getElementById('bansList');

  const otherEnemies = (state.draft.enemies || []).filter(
    (e) => e.championId !== state.draft.enemyLanerId
  );

  if (otherEnemies.length) {
    otherEnemiesGroup.classList.remove('hidden');
    otherEnemiesList.innerHTML = otherEnemies
      .map((e) => {
        const c = state.championsById.get(e.championId);
        if (!c) return '';
        const roleTag = e.inferredRole ? ` · ${ROLE_LABELS[e.inferredRole] || e.inferredRole}` : '';
        return `<button class="mini-chip" data-promote-enemy="${c.id}" title="Marcar como posible rival">
          <img src="${esc(c.iconUrl)}" alt="" />
          <span>${esc(c.name)}${esc(roleTag)}</span>
        </button>`;
      })
      .join('');
  } else {
    otherEnemiesGroup.classList.add('hidden');
  }

  if (state.draft.bans?.length) {
    bansGroup.classList.remove('hidden');
    bansList.innerHTML = state.draft.bans
      .map((id) => {
        const c = state.championsById.get(id);
        return c
          ? `<span class="mini-chip"><img src="${esc(c.iconUrl)}" alt="" /><span>${esc(c.name)}</span></span>`
          : '';
      })
      .join('');
  } else {
    bansGroup.classList.add('hidden');
  }

  extraRow.classList.toggle('hidden', !otherEnemies.length && !state.draft.bans?.length);

  // Sync OP.GG Lane Tabs & Only Pool toggle
  document.querySelectorAll('#opggLaneTabs .opgg-tab').forEach((tab) => {
    tab.classList.toggle('on', tab.dataset.lane === (state.opggLane || 'all'));
  });
  const poolToggle = document.getElementById('onlyPoolToggle');
  if (poolToggle) {
    poolToggle.checked = Boolean(state.onlyPool);
  }

  // Context banner
  const banner = document.getElementById('draftContextBanner');
  const bannerText = document.getElementById('contextBannerText');
  const roleLabel = ROLE_LABELS[state.draft.myRole] || state.draft.myRole;
  const patchLabel = state.activeSeason?.patch || 'actual';

  if (!state.draft.enemyLanerId) {
    banner.className = 'rbanner ok';
    const allyCount = state.draft.allies.length;
    bannerText.innerHTML = `<strong>Modo Primer Pick / Sin rival en ${esc(roleLabel)}:</strong> El equipo enemigo aún no elige ${esc(roleLabel)}. Mostrando los campeones con <strong>mayor Win Rate del Parche ${esc(patchLabel)}</strong>${allyCount ? ' y sinergia con tus aliados' : ''}.`;
    renderEnemyCountersStrip();
  } else {
    banner.className = 'rbanner';
    bannerText.innerHTML = `<strong>Matchup ${esc(roleLabel)} vs ${esc(enemyChamp?.name || '')}:</strong> Mostrando abajo los <strong>mejores counters</strong>, su Win Rate directo y el mejor <strong>1v1 en Línea</strong> en la Season ${esc(patchLabel)}.`;
    renderEnemyCountersStrip();
  }
}

function selectEnemyLaner(championId) {
  const nextId = championId ? Number(championId) : null;
  const changed = state.draft.enemyLanerId !== nextId;
  state.draft.enemyLanerId = nextId;
  state.manualEnemyOverride = true;
  if (changed) state.selectedPreviewId = null;

  if (nextId) {
    if (!state.manualModeChosen) state.mode = 'counter_wr';
  } else if (!state.manualModeChosen || state.mode === 'counter_wr' || state.mode === 'lane_1v1') {
    state.mode = 'patch_wr';
  }

  renderDraftControls();
  refreshRecommendations();
  if (state.draft.myChampionId) loadMyChampionTab(state.draft.myChampionId);
}

function renderEnemyCountersStrip() {
  const strip = document.getElementById('enemyCountersStrip');
  if (!strip) return;

  if (!state.draft.enemyLanerId || !state.activeSeason) {
    strip.classList.add('hidden');
    strip.innerHTML = '';
    return;
  }

  strip.classList.remove('hidden');
  const enemyChamp = state.championsById.get(state.draft.enemyLanerId);
  const roleLabel = ROLE_LABELS[state.draft.myRole] || state.draft.myRole;
  const enemyIconHtml = enemyChamp?.iconUrl
    ? `<img class="counters-enemy-icon" src="${esc(enemyChamp.iconUrl)}" alt="${esc(enemyChamp.name)}" />`
    : '';

  if (
    !state.recommendations ||
    state.recommendations.enemyLanerId !== state.draft.enemyLanerId ||
    state.recommendations.myRole !== state.draft.myRole
  ) {
    strip.innerHTML = `<div class="counters-strip-head">
      <div class="counters-strip-title">
        ${enemyIconHtml}
        <span>Mejores Counters de <strong>${esc(enemyChamp?.name || 'Rival')}</strong> (${esc(roleLabel)})</span>
      </div>
      <span class="muted counters-strip-hint">Calculando mejores matchups del parche...</span>
    </div>`;
    return;
  }

  const topCounters = (state.recommendations.topCounters || []).slice(0, 6);
  if (!topCounters.length) {
    strip.innerHTML = `<div class="counters-strip-head">
      <div class="counters-strip-title">
        ${enemyIconHtml}
        <span>Mejores Counters de <strong>${esc(enemyChamp?.name || 'Rival')}</strong> (${esc(roleLabel)})</span>
      </div>
      <span class="muted counters-strip-hint">Sin suficientes partidas registradas vs este rival en ${esc(roleLabel)}. Revisa Mejor WR Parche abajo.</span>
    </div>`;
    return;
  }

  strip.innerHTML = `
    <div class="counters-strip-head">
      <div class="counters-strip-title">
        ${enemyIconHtml}
        <div>
          <div class="counters-strip-heading">Mejores Counters de <strong>${esc(enemyChamp?.name || 'Rival')}</strong> <span class="counters-role-tag">${esc(roleLabel)}</span></div>
          <div class="counters-strip-sub">Haz clic en cualquier counter para ver sus runas, build y tip 1v1 contra ${esc(enemyChamp?.name || 'este campeón')}</div>
        </div>
      </div>
      <span class="counters-strip-badge">Top ${topCounters.length} Counters</span>
    </div>
    <div class="counters-cards-grid">
      ${topCounters
        .map((c, idx) => {
          const isSelected = state.selectedPreviewId === c.championId;
          const wrCls = wrClass(c.winRateVsEnemy);
          const gamesText = c.playVsEnemy >= 1000 ? `${(c.playVsEnemy / 1000).toFixed(1)}k` : `${c.playVsEnemy}`;
          return `<div class="counter-card ${isSelected ? 'selected' : ''}" data-counter-champ="${c.championId}">
            <div class="counter-card-top">
              <span class="counter-rank ${idx === 0 ? 'r1' : idx < 3 ? 'rtop' : ''}">#${idx + 1}</span>
              <img class="counter-icon" src="${esc(c.iconUrl)}" alt="${esc(c.name)}" />
              <div class="counter-id-col">
                <div class="counter-name-row">
                  <span class="counter-name">${esc(c.name)}</span>
                  ${c.inPool ? '<span class="counter-pool-star" title="En Mi Pool">★ Pool</span>' : ''}
                </div>
                <div class="counter-meta-row">
                  <span class="tier-badge tier-${c.tier}">${esc(c.tierLabel)}</span>
                  ${c.soloKillAdvantage === 'me' ? '<span class="adv-tag adv-me">1v1</span>' : ''}
                </div>
              </div>
            </div>
            <div class="counter-card-bottom">
              <div>
                <div class="counter-wr ${wrCls}">${pct(c.winRateVsEnemy, 1)} WR</div>
                <div class="counter-games">${gamesText} part.${c.lowSample ? ' · baja muestra' : ''}</div>
              </div>
              <button type="button" class="ghost counter-choose-btn" data-counter-choose="${c.championId}" title="Fijar en Mi Campeón">Elegir</button>
            </div>
          </div>`;
        })
        .join('')}
    </div>`;
}

// ==================== RECOMMENDATIONS ====================
async function refreshRecommendations() {
  if (!state.activeSeason) {
    document.getElementById('candidatesList').innerHTML =
      '<div class="loading-state">Descarga la base de datos de OP.GG para ver recomendaciones.</div>';
    renderEnemyCountersStrip();
    return;
  }

  if (recAbortController) recAbortController.abort();
  recAbortController = new AbortController();

  const listEl = document.getElementById('candidatesList');
  listEl.innerHTML = '<div class="loading-state">Calculando mejores picks desde OP.GG...</div>';

  try {
    const res = await fetch('/api/recommendations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: recAbortController.signal,
      body: JSON.stringify({
        myRole: state.opggLane || 'all',
        enemyLanerId: state.draft.enemyLanerId,
        allies: state.draft.allies,
        enemies: state.draft.enemies,
        bans: state.draft.bans,
        myChampionId: state.draft.myChampionId,
        onlyPool: state.onlyPool,
        mode: 'patch_wr'
      })
    });
    const data = await res.json();
    state.recommendations = data;
    renderEnemyCountersStrip();
    renderRecommendationsList();
  } catch (err) {
    if (err.name === 'AbortError') return;
    listEl.innerHTML = `<div class="loading-state">Error al cargar: ${esc(err.message)}</div>`;
  }
}

function getPrimaryColumnLabel(mode) {
  if (mode === 'lane_1v1') return '1v1 en Línea';
  if (mode === 'counter_wr') return 'WR vs Rival';
  if (mode === 'synergy') return 'Sinergia Aliados';
  if (mode === 'patch_wr') return 'WR Parche';
  if (mode === 'my_pool') return 'Mi Pool (Score)';
  return 'Score Global';
}

function renderPrimaryMetric(row, mode) {
  if (mode === 'lane_1v1') {
    if (!row.matchup || row.matchup.winRate === null) {
      return `<div class="metric-main muted">Sin datos</div><div class="metric-sub">Baja muestra</div>`;
    }
    const advBadges = [
      advBadgeHtml(row.matchup.soloKillAdvantage, 'Solo Kill'),
      advBadgeHtml(row.matchup.laneAdvantage, 'Línea')
    ]
      .filter(Boolean)
      .join(' ');
    return `<div class="metric-main ${wrClass(row.matchup.winRate)}">${pct(row.matchup.winRate)} 1v1</div>
      <div class="metric-sub">${advBadges || `${row.matchup.play.toLocaleString()} partidas`}</div>`;
  }

  if (mode === 'counter_wr') {
    if (!row.matchup || row.matchup.winRate === null) {
      return `<div class="metric-main muted">Sin datos</div><div class="metric-sub">—</div>`;
    }
    return `<div class="metric-main ${wrClass(row.matchup.winRate)}">${pct(row.matchup.winRate, 2)}</div>
      <div class="metric-sub">${row.matchup.play.toLocaleString()} partidas${row.matchup.lowSample ? ' (baja)' : ''}</div>`;
  }

  if (mode === 'synergy') {
    if (row.synergyAvgWr === null) {
      return `<div class="metric-main muted">Elige aliados</div><div class="metric-sub">Para medir dúo</div>`;
    }
    const topSyn = row.synergies[0];
    return `<div class="metric-main ${wrClass(row.synergyAvgWr)}">${pct(row.synergyAvgWr, 2)}</div>
      <div class="metric-sub">c/ ${esc(topSyn?.allyName || '')} (${row.synergies.length})</div>`;
  }

  if (mode === 'patch_wr') {
    return `<div class="metric-main ${wrClass(row.winRate)}">${pct(row.winRate, 2)}</div>
      <div class="metric-sub">Tier ${esc(row.tierLabel)} · Rank #${row.rank}</div>`;
  }

  // global mode
  const parts = [];
  if (row.matchup?.winRate != null) parts.push(`vs: ${pct(row.matchup.winRate, 1)}`);
  if (row.synergyAvgWr != null) parts.push(`Sin: ${pct(row.synergyAvgWr, 1)}`);
  if (!parts.length) parts.push(`Rank #${row.rank} · KDA ${Number(row.kda || 0).toFixed(2)}`);

  const mainWr = row.matchup?.winRate ?? row.winRate;
  return `<div class="metric-main ${wrClass(mainWr)}">${pct(mainWr, 1)} ${row.matchup?.soloKillAdvantage === 'me' ? '<span class="adv-tag adv-me">1v1+</span>' : ''}</div>
    <div class="metric-sub">${parts.join(' · ')}</div>`;
}

function renderRecommendationsList() {
  const listEl = document.getElementById('candidatesList');
  if (!listEl) return;
  const data = state.recommendations;
  if (!data || !data.candidates) return;

  const q = state.searchQuery.trim().toLowerCase();
  let list = data.candidates;

  if (state.onlyPool) {
    list = list.filter((c) => c.inPool);
  }

  if (q) {
    list = list.filter(
      (c) =>
        (c.name && c.name.toLowerCase().includes(q)) ||
        (c.enName && c.enName.toLowerCase().includes(q))
    );
  }

  if (!list.length) {
    if (state.onlyPool) {
      listEl.innerHTML = `<div class="loading-state">
        <p style="margin-bottom:10px;">No tienes campeones en <strong>Mi Pool</strong> para ${esc(LANE_SPANISH_LABELS[state.opggLane] || state.opggLane || 'esta línea')}.</p>
        <p class="metric-sub" style="margin-bottom:12px;">Marca campeones con <strong>★</strong> en la lista o agrégalos en el panel de Mi Champion Pool.</p>
      </div>`;
    } else {
      listEl.innerHTML = `<div class="loading-state">No hay campeones que coincidan con la búsqueda.</div>`;
    }
    return;
  }

  listEl.innerHTML = list
    .map((row) => {
      const isSelected = state.selectedPreviewId === row.championId;
      const rankNum = row.displayRank || row.rank || '-';
      const tierNum = row.tier || 1;
      const curLane = row.lane || row.role || 'all';
      const roleSvg = getRoleSvgIcon(curLane);
      const roleTitle = row.laneLabel || LANE_SPANISH_LABELS[curLane] || curLane;
      const wrPercent = (Number(row.winRate || 0) * 100).toFixed(2);
      const pickPercent = (Number(row.pickRate || 0) * 100).toFixed(2);
      const banPercent = (Number(row.banRate || 0) * 100).toFixed(2);

      const countersHtml = (row.counters || [])
        .map((cnt) => {
          const cWr = (Number(cnt.winRate || 0) * 100).toFixed(1);
          return `<img class="opgg-counter-mini" src="${esc(cnt.iconUrl)}" alt="${esc(cnt.name)}" title="Débil contra ${esc(cnt.name)} (${cWr}% WR)" />`;
        })
        .join('');

      return `<div class="opgg-row ${isSelected ? 'selected' : ''}" data-cand-id="${row.championId}">
        <span class="opgg-rank-col">${rankNum}</span>
        <div class="opgg-champ-cell">
          <img class="opgg-champ-icon" src="${esc(row.iconUrl)}" alt="${esc(row.name)}" />
          <span class="opgg-champ-name" title="${esc(row.name)}">${esc(row.name)}</span>
          <button class="star-btn ${row.inPool ? 'active' : ''}" data-toggle-pool="${row.championId}" title="Agregar/quitar de Mi Pool">★</button>
        </div>
        <div>
          <div class="opgg-tier-ribbon tier-${tierNum}">${tierNum}</div>
        </div>
        <div>
          <span class="opgg-role-badge" title="${esc(roleTitle)}">${roleSvg}</span>
        </div>
        <div class="opgg-val-wr ${wrClass(row.winRate)}">${wrPercent}%</div>
        <div class="opgg-val-sub">${pickPercent}%</div>
        <div class="opgg-val-sub">${banPercent}%</div>
        <div class="opgg-counters-row">${countersHtml || '<span class="muted" style="font-size:11px;">—</span>'}</div>
      </div>`;
    })
    .join('');

  // Auto-select top #1 in preview if nothing selected or previous vanished
  if (!state.selectedPreviewId || !list.some((c) => c.championId === state.selectedPreviewId)) {
    if (list[0]) {
      selectPreviewChampion(list[0].championId);
    }
  }
}

async function selectPreviewChampion(championId) {
  state.selectedPreviewId = championId;
  document.querySelectorAll('.opgg-row, .cand-row').forEach((r) => {
    r.classList.toggle('selected', Number(r.dataset.candId) === championId);
  });
  document.querySelectorAll('.counter-card').forEach((c) => {
    c.classList.toggle('selected', Number(c.dataset.counterChamp) === championId);
  });

  const panel = document.getElementById('quickPreviewPanel');
  panel.innerHTML = '<div class="loading-state">Cargando build y runas...</div>';

  try {
    const qs = new URLSearchParams({
      championId: String(championId),
      role: state.draft.myRole
    });
    if (state.draft.enemyLanerId) qs.set('opponentId', String(state.draft.enemyLanerId));
    if (state.draft.allies?.length) qs.set('allies', JSON.stringify(state.draft.allies));
    if (state.draft.enemies?.length) qs.set('enemies', JSON.stringify(state.draft.enemies));
    const detail = await apiJson(`/api/champion-build?${qs.toString()}`);
    panel.innerHTML = renderBuildDetailHtml(detail, { compact: true });
  } catch (err) {
    panel.innerHTML = `<div class="loading-state">Error: ${esc(err.message)}</div>`;
  }
}

// ==================== MY CHAMPION PINNED TAB ====================
async function chooseMyChampion(championId, openTab = true) {
  state.draft.myChampionId = Number(championId);
  renderTopBar();
  renderDraftControls();
  await loadMyChampionTab(championId);
  if (openTab) {
    switchView('my-champion');
  }
}

async function loadMyChampionTab(championId) {
  const container = document.getElementById('myChampionContent');
  if (!championId) return;
  container.innerHTML = '<div class="panel loading-state">Cargando mejor build, runas y datos de línea...</div>';

  try {
    const qs = new URLSearchParams({
      championId: String(championId),
      role: state.draft.myRole
    });
    if (state.draft.enemyLanerId) qs.set('opponentId', String(state.draft.enemyLanerId));
    if (state.draft.allies?.length) qs.set('allies', JSON.stringify(state.draft.allies));
    if (state.draft.enemies?.length) qs.set('enemies', JSON.stringify(state.draft.enemies));
    const detail = await apiJson(`/api/champion-build?${qs.toString()}`);
    state.myChampionBuildData = detail;
    container.innerHTML = renderBuildDetailHtml(detail, { compact: false });
  } catch (err) {
    container.innerHTML = `<div class="panel loading-state">Error al cargar build: ${esc(err.message)}</div>`;
  }
}

// ==================== BUILD & RUNES RENDERER ====================
window.__runePayloads = window.__runePayloads || {};

function buildRuneImportPayload(runePage, championName) {
  if (!runePage) return null;
  const pIds = (runePage.primaryRunes || []).map((r) => Number(r.id)).filter(Boolean);
  const sIds = (runePage.secondaryRunes || []).map((r) => Number(r.id)).filter(Boolean);
  const shardIds = (runePage.statShards || []).map((s) => Number(s.id)).filter(Boolean);
  return {
    pageName: `LoL Advisor: ${championName || 'Runas'}`,
    primaryStyleId: Number(runePage.primaryTree?.id || runePage.primaryPageId),
    subStyleId: Number(runePage.secondaryTree?.id || runePage.secondaryPageId),
    selectedPerkIds: [...pIds, ...sIds, ...shardIds]
  };
}

async function importRunesToClient(btn, key) {
  const payload = window.__runePayloads[key];
  if (!payload) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Pegando...';
  try {
    const res = await apiJson('/api/lcu/import-runes', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    btn.textContent = `✓ Pegadas (${res.pageName})`;
    setTimeout(() => {
      btn.textContent = orig;
      btn.disabled = false;
    }, 2600);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = orig;
    alert(err.message);
  }
}
window.importRunesToClient = importRunesToClient;

function renderRunesSection(build, championName, slotKey) {
  const runePage = build?.runes?.[0];
  if (!runePage) return '<p class="muted">Sin datos de runas disponibles.</p>';
  const payload = buildRuneImportPayload(runePage, championName);
  if (slotKey && payload) {
    window.__runePayloads[slotKey] = payload;
  }

  return `<div class="rune-box">
    <div class="rune-trees-grid">
      <div>
        <div class="rune-col-header">
          ${runePage.primaryTree.iconUrl ? `<img src="${esc(runePage.primaryTree.iconUrl)}" alt="" />` : ''}
          <span>${esc(runePage.primaryTree.name)}</span>
        </div>
        <div class="rune-list">
          ${runePage.primaryRunes
            .map(
              (r) => `<div class="rune-item ${r.isKeystone ? 'keystone' : ''}">
              ${r.iconUrl ? `<img src="${esc(r.iconUrl)}" alt="" />` : ''}
              <span>${esc(r.name)}</span>
            </div>`
            )
            .join('')}
        </div>
      </div>
      <div>
        <div class="rune-col-header">
          ${runePage.secondaryTree.iconUrl ? `<img src="${esc(runePage.secondaryTree.iconUrl)}" alt="" />` : ''}
          <span>${esc(runePage.secondaryTree.name)}</span>
        </div>
        <div class="rune-list">
          ${runePage.secondaryRunes
            .map(
              (r) => `<div class="rune-item">
              ${r.iconUrl ? `<img src="${esc(r.iconUrl)}" alt="" />` : ''}
              <span>${esc(r.name)}</span>
            </div>`
            )
            .join('')}
        </div>
      </div>
    </div>
    <div class="shards-row">
      <span class="micro-label">Fragmentos:</span>
      ${runePage.statShards
        .map(
          (s) => `<span class="shard-chip" title="${esc(s.name)}">
          ${s.iconUrl ? `<img src="${esc(s.iconUrl)}" alt="" />` : ''}
          <span>${esc(s.short)}</span>
        </span>`
        )
        .join('')}
      <span class="metric-sub mono" style="margin-left:auto;">WR ${pct(runePage.winRate, 1)} · Pick ${pct(runePage.pickRate, 1)}</span>
    </div>
  </div>`;
}

function renderItemGroup(title, groups) {
  const top = groups?.[0];
  if (!top || !top.items?.length) return '';
  return `<div class="build-section">
    <div class="build-section-title">
      <span>${esc(title)}</span>
      <span class="mono">WR ${pct(top.winRate, 1)} · Pick ${pct(top.pickRate, 1)}</span>
    </div>
    <div class="items-strip">
      ${top.items
        .map(
          (it) => `<div class="item-chip" title="${esc(it.plaintext || it.name)}">
          ${it.iconUrl ? `<img src="${esc(it.iconUrl)}" alt="" />` : ''}
          <span>${esc(it.name)}</span>
        </div>`
        )
        .join('')}
    </div>
  </div>`;
}

function renderSkillSection(skillMastery, compact) {
  if (!skillMastery) return '';
  const priorityHtml = (skillMastery.priority || [])
    .map((k) => `<span class="skill-key ${esc(k)}">${esc(k)}</span>`)
    .join('<span class="muted">›</span>');

  const levelsHtml = !compact && skillMastery.order?.length
    ? `<div class="skill-levels">
        ${skillMastery.order
          .slice(0, 15)
          .map(
            (k, idx) => `<div class="skill-lvl-box">
            <span class="skill-lvl-num">${idx + 1}</span>
            <span class="skill-key ${esc(k)}" style="border:none;background:transparent;width:auto;height:auto;">${esc(k)}</span>
          </div>`
          )
          .join('')}
      </div>`
    : '';

  return `<div class="build-section">
    <div class="build-section-title">
      <span>Orden de Habilidades</span>
      <span class="mono">WR ${pct(skillMastery.winRate ?? (skillMastery.play ? skillMastery.win / skillMastery.play : 0), 1)}</span>
    </div>
    <div class="skill-priority">${priorityHtml}</div>
    ${levelsHtml}
  </div>`;
}

function renderTeamTacticalSummaryHtml(teamBriefing) {
  if (!teamBriefing) return '';

  const { compStrategy, members, inGame, inChampSelect, gameTimeLabel, hasTeamData } = teamBriefing;
  const isLive = Boolean(inGame);
  const statusPill = isLive
    ? `<span class="tactical-live-pill">● Partida en Vivo ${gameTimeLabel ? `(${esc(gameTimeLabel)})` : ''}</span>`
    : inChampSelect
    ? `<span class="tactical-live-pill" style="border-color:rgba(200,170,110,0.5);color:#f1db9a;background:rgba(200,170,110,0.15);">● Selección de Campeón</span>`
    : `<span class="tactical-live-pill" style="border-color:rgba(63,208,212,0.4);color:#8df8fb;background:rgba(63,208,212,0.1);">Lectura de Equipo</span>`;

  const strategyHtml = compStrategy
    ? `<div class="tactical-comp-strategy">
        <div class="tactical-strategy-body">
          <div class="tactical-strategy-title">
            <span>${esc(compStrategy.title)}</span>
            <span class="tactical-archetype-badge emerald" style="margin-left:6px;font-size:10.5px;">${esc(compStrategy.badge)}</span>
          </div>
          <div class="tactical-strategy-plan">${esc(compStrategy.plan)}</div>
        </div>
      </div>`
    : '';

  const membersHtml = (members || [])
    .map((m) => {
      const isMe = m.isMe;
      const champ = m.champion;
      const iconHtml = champ?.iconUrl
        ? `<img class="tactical-champ-icon" src="${esc(champ.iconUrl)}" alt="${esc(champ.name)}" />`
        : `<div class="tactical-champ-empty-icon">?</div>`;

      const laneTendencyHtml = m.laneTendency
        ? `<div class="tactical-lane-tendency ${esc(m.laneTendency.badgeColor || 'blue')}">
            <span>${esc(m.laneTendency.text)}</span>
          </div>`
        : '';

      return `<div class="tactical-role-card ${isMe ? 'is-me' : ''}">
        <div>
          <div class="tactical-role-header">
            ${iconHtml}
            <div class="tactical-role-names">
              <div class="tactical-role-tagline">
                <span>${esc(m.roleLabel)}</span>
                ${isMe ? '<span class="tactical-me-badge">TÚ</span>' : ''}
              </div>
              <div class="tactical-champ-name">${esc(champ?.name || 'Por seleccionar')}</div>
            </div>
          </div>
          <div style="margin-top:8px;margin-bottom:6px;">
            <span class="tactical-archetype-badge ${esc(m.badgeColor || 'neutral')}">${esc(m.archetype)}</span>
          </div>
          <div class="tactical-behavior-text">${esc(m.behavior)}</div>
        </div>
        ${laneTendencyHtml}
      </div>`;
    })
    .join('');

  return `
    <div class="panel team-tactical-card">
      <div class="tactical-header-row">
        <div class="tactical-title-group">
          <h2 class="tactical-main-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--hex);"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
            Resumen Táctico de tu Equipo
          </h2>
          ${statusPill}
        </div>
        <span class="muted" style="font-size:12px;">Lectura de ganks, rotaciones y tendencias de línea</span>
      </div>
      ${strategyHtml}
      <div class="tactical-grid">
        ${membersHtml}
      </div>
    </div>
  `;
}

function renderBuildDetailHtml(detail, { compact }) {
  const { champion, role, stats, matchup, build, hardMatchups, goodMatchups, patch } = detail;
  const spellsGroup = build?.summonerSpells?.[0];

  const matchupBlock = matchup
    ? `<div class="matchup-callout">
        <div class="matchup-callout-top">
          <span><strong>Vs ${esc(matchup.opponent.name)}</strong> (${esc(ROLE_LABELS[role] || role)})</span>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
            ${matchup.winRate !== null ? `<span class="mono ${wrClass(matchup.winRate)}"><strong>${pct(matchup.winRate, 2)} WR</strong> (${matchup.play.toLocaleString()})</span>` : ''}
            ${advBadgeHtml(matchup.soloKillAdvantage, 'Solo Kill 1v1')}
            ${advBadgeHtml(matchup.laneAdvantage, 'Línea')}
          </div>
        </div>
        ${matchup.tip ? `<div class="tip-box"><strong>Tip OP.GG:</strong> ${esc(matchup.tip)}</div>` : ''}
      </div>`
    : '';

  if (compact) {
    return `
      <div class="preview-header">
        <div class="preview-champ-id">
          <img src="${esc(champion.iconUrl)}" alt="${esc(champion.name)}" />
          <div>
            <h3>${esc(champion.name)}</h3>
            <div class="metric-sub">${esc(ROLE_LABELS[role] || role)} · Parche ${esc(patch)} · WR ${pct(stats?.winRate, 1)}</div>
          </div>
        </div>
        <button class="ghost on" onclick="chooseMyChampion(${champion.id}, true)">Fijar en Mi Campeón</button>
      </div>
      ${matchupBlock}
      <div class="build-section">
        <div class="build-section-title" style="align-items:center;">
          <span>Mejores Runas</span>
          ${build?.runes?.[0] ? `<button class="ghost on" style="padding:3px 9px;font-size:11.5px;" onclick="importRunesToClient(this, 'preview')">Pegar Runas a LoL</button>` : ''}
        </div>
        ${renderRunesSection(build, champion.name, 'preview')}
      </div>
      ${spellsGroup ? `<div class="build-section">
        <div class="build-section-title"><span>Hechizos de Invocador</span><span class="mono">WR ${pct(spellsGroup.winRate, 1)}</span></div>
        <div class="items-strip">
          ${spellsGroup.spells.map((s) => `<div class="item-chip">${s.iconUrl ? `<img src="${esc(s.iconUrl)}" alt="" />` : ''}<span>${esc(s.name)}</span></div>`).join('')}
        </div>
      </div>` : ''}
      ${renderItemGroup('Iniciales', build?.starterItems)}
      ${renderItemGroup('Botas', build?.boots)}
      ${renderItemGroup('Core Build (3 Objetos)', build?.coreItems)}
      ${renderSkillSection(build?.skillMastery, true)}
    `;
  }

  // Full dedicated "Mi Campeón" tab layout
  const situational = build?.situationalItems || [];
  return `
    <div class="panel my-champ-hero">
      <div class="my-champ-hero-left">
        <div class="mvphex-sm"><img src="${esc(champion.iconUrl)}" alt="${esc(champion.name)}" /></div>
        <div>
          <h1>${esc(champion.name)} <span class="tier-badge tier-${stats?.tier || 3}">Tier ${esc(stats?.tierLabel || 'A')}</span></h1>
          <div class="muted">${esc(ROLE_LABELS[role] || role)} · Parche ${esc(patch)} ${matchup ? `· Build optimizada vs ${esc(matchup.opponent.name)}` : '· Build estándar del parche'}</div>
        </div>
      </div>
      <div class="my-champ-stats-row">
        <div class="stat-pill-box">
          <div class="micro-label">Win Rate</div>
          <div class="val ${wrClass(stats?.winRate)}">${pct(stats?.winRate, 2)}</div>
        </div>
        <div class="stat-pill-box">
          <div class="micro-label">Pick Rate</div>
          <div class="val">${pct(stats?.pickRate, 1)}</div>
        </div>
        <div class="stat-pill-box">
          <div class="micro-label">Ban Rate</div>
          <div class="val">${pct(stats?.banRate, 1)}</div>
        </div>
        <div class="stat-pill-box">
          <div class="micro-label">KDA</div>
          <div class="val">${Number(stats?.kda || 0).toFixed(2)}</div>
        </div>
      </div>
    </div>

    ${matchupBlock}

    ${renderTeamTacticalSummaryHtml(detail.teamBriefing)}

    <div class="my-champ-two-col">
      <div class="panel my-champ-card">
        <div class="build-section">
          <div class="build-section-title" style="align-items:center;">
            <span>Runas Óptimas (OP.GG)</span>
            ${build?.runes?.[0] ? `<button class="ghost on" style="padding:4px 11px;font-size:12px;" onclick="importRunesToClient(this, 'mychamp')">Pegar Runas a LoL</button>` : ''}
          </div>
          ${renderRunesSection(build, champion.name, 'mychamp')}
        </div>

        ${spellsGroup ? `<div class="build-section">
          <div class="build-section-title"><span>Hechizos de Invocador</span><span class="mono">WR ${pct(spellsGroup.winRate, 1)}</span></div>
          <div class="items-strip">
            ${spellsGroup.spells.map((s) => `<div class="item-chip">${s.iconUrl ? `<img src="${esc(s.iconUrl)}" alt="" />` : ''}<span>${esc(s.name)}</span></div>`).join('')}
          </div>
        </div>` : ''}

        ${renderSkillSection(build?.skillMastery, false)}
      </div>

      <div class="panel my-champ-card">
        ${renderItemGroup('Objetos Iniciales', build?.starterItems)}
        ${renderItemGroup('Botas Recomendadas', build?.boots)}
        ${renderItemGroup('Core Build Principal', build?.coreItems)}

        ${situational.length ? `<div class="build-section">
          <div class="build-section-title"><span>Objetos Más Populares / Situacionales</span></div>
          <div class="items-strip">
            ${situational.map((s) => {
              const it = s.items?.[0];
              if (!it) return '';
              return `<div class="item-chip" title="${esc(it.name)} — WR ${pct(s.winRate, 1)}">
                ${it.iconUrl ? `<img src="${esc(it.iconUrl)}" alt="" />` : ''}
                <span>${esc(it.name)} <strong class="mono ${wrClass(s.winRate)}">${pct(s.winRate, 0)}</strong></span>
              </div>`;
            }).join('')}
          </div>
        </div>` : ''}

        <div class="build-section">
          <div class="build-section-title"><span>Matchups Destacados (${esc(ROLE_LABELS[role] || role)})</span></div>
          <div class="matchups-mini-list">
            <div>
              <div class="micro-label" style="margin-bottom:5px;">Fuerte Contra</div>
              ${(goodMatchups || []).map((m) => `
                <div class="mini-matchup-row">
                  <div class="mini-matchup-row-left"><img src="${esc(m.iconUrl)}" alt="" /><span>${esc(m.name)}</span></div>
                  <span class="mono metric-good">${pct(m.winRate, 1)}</span>
                </div>`).join('')}
            </div>
            <div>
              <div class="micro-label" style="margin-bottom:5px;">Counters Difíciles</div>
              ${(hardMatchups || []).map((m) => `
                <div class="mini-matchup-row">
                  <div class="mini-matchup-row-left"><img src="${esc(m.iconUrl)}" alt="" /><span>${esc(m.name)}</span></div>
                  <span class="mono metric-bad">${pct(m.winRate, 1)}</span>
                </div>`).join('')}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ==================== DATABASE & POOL VIEW ====================
function renderDatabaseView() {
  const statsEl = document.getElementById('activeSeasonStats');
  if (state.activeSeason) {
    const dt = new Date(state.activeSeason.updatedAt).toLocaleString('es-ES');
    statsEl.innerHTML = `
      <div class="stat-box"><div class="stat-box-label">Parche / Season</div><div class="stat-box-val">${esc(state.activeSeason.patch)}</div></div>
      <div class="stat-box"><div class="stat-box-label">Última Actualización</div><div class="stat-box-val" style="font-size:12.5px;">${esc(dt)}</div></div>
      <div class="stat-box"><div class="stat-box-label">Campeones / Líneas</div><div class="stat-box-val">${state.activeSeason.laneEntriesCount || 0}</div></div>
      <div class="stat-box"><div class="stat-box-label">Matchups en Caché</div><div class="stat-box-val">${(state.activeSeason.matchupsCount || 0).toLocaleString()}</div></div>
    `;
  } else {
    statsEl.innerHTML = `<div class="stat-box"><div class="stat-box-label">Estado</div><div class="stat-box-val">Sin descargar</div></div>`;
  }

  const savedEl = document.getElementById('savedSeasonsList');
  if (!state.seasons.length) {
    savedEl.innerHTML = '<p class="muted">Aún no hay archivos de season guardados localmente.</p>';
  } else {
    savedEl.innerHTML = state.seasons
      .map((s) => {
        const isActive = state.activeSeason?.patch === s.patch;
        return `<div class="season-row ${isActive ? 'active' : ''}">
          <div>
            <strong>Parche ${esc(s.patch)}</strong>
            <div class="metric-sub">${s.matchupsCount.toLocaleString()} matchups · ${new Date(s.updatedAt).toLocaleDateString('es-ES')}</div>
          </div>
          ${isActive ? '<span class="adv-tag adv-me">Activa</span>' : `<button class="ghost" data-switch-season="${esc(s.patch)}">Usar</button>`}
        </div>`;
      })
      .join('');
  }

  renderPoolGrid();
}

function buildPoolItemsHtml(query, poolSet) {
  const q = String(query || '').trim().toLowerCase();
  const list = q ? state.champions.filter((c) => c.name.toLowerCase().includes(q)) : state.champions;
  return list
    .map(
      (c) => `<div class="pool-item ${poolSet.has(c.id) ? 'in-pool' : ''}" data-pool-champ="${c.id}">
        <img src="${esc(c.iconUrl)}" alt="" />
        <span>${esc(c.name)}</span>
      </div>`
    )
    .join('');
}

function renderPoolGrid() {
  const poolSet = new Set((state.config?.myPool || []).map(Number));
  document.getElementById('poolCountLabel').textContent = String(poolSet.size);
  document.getElementById('poolGrid').innerHTML = buildPoolItemsHtml(state.poolSearchQuery, poolSet);

  const draftCountEl = document.getElementById('draftPoolCountLabel');
  if (draftCountEl) draftCountEl.textContent = String(poolSet.size);

  const draftGridEl = document.getElementById('draftPoolGrid');
  if (draftGridEl) draftGridEl.innerHTML = buildPoolItemsHtml(state.draftPoolSearchQuery, poolSet);

  const miniRowEl = document.getElementById('draftPoolMiniRow');
  if (miniRowEl) {
    const selected = [...poolSet].map((id) => state.championsById.get(id)).filter(Boolean);
    miniRowEl.innerHTML = selected.length
      ? selected
          .map(
            (c) => `<button type="button" class="draft-pool-chip" data-pool-champ="${c.id}" title="Quitar de Mi Champion Pool">
              <img src="${esc(c.iconUrl)}" alt="" />
              <span>${esc(c.name)}</span>
              <span class="muted">×</span>
            </button>`
          )
          .join('')
      : '<span class="muted" style="font-size:11.5px;">Sin campeones en tu pool — pulsa <strong>Elegir</strong> para añadir.</span>';
  }
}

function syncSettingsInputs() {
  if (!state.config) return;
  document.getElementById('cfgLcuEnabled').checked = Boolean(state.config.lcuEnabled);
  document.getElementById('cfgAutoFocusTab').checked = Boolean(state.config.autoFocusMyChampTab);
  document.getElementById('cfgLockfilePath').value = state.config.lcuLockfilePath || '';
  document.getElementById('cfgOverlayAutoInGame').checked = state.config.overlayAutoInGame !== false;
  document.getElementById('cfgOverlayLocked').checked = state.config.overlayLocked !== false;
  document.getElementById('cfgOverlayDemo').checked = Boolean(state.config.overlayDemo);

  const sc = Number(state.config.overlayScale ?? 1.0);
  const op = Number(state.config.overlayOpacity ?? 0.68);
  document.getElementById('cfgOverlayScale').value = String(sc);
  document.getElementById('overlayScaleLabel').textContent = `${Math.round(sc * 100)}% (${Math.round(236 * sc)}×${Math.round(178 * sc)})`;
  document.getElementById('cfgOverlayOpacity').value = String(op);
  document.getElementById('overlayOpacityLabel').textContent = `${Math.round(op * 100)}%`;
  document.getElementById('cfgOverlayX').value = state.config.overlayX ?? '';
  document.getElementById('cfgOverlayY').value = state.config.overlayY ?? '';
}

async function refreshOverlayStatus() {
  try {
    const st = await apiJson('/api/overlay/status');
    renderOverlayButton(st);
  } catch {
    renderOverlayButton({ running: false, autoInGame: true });
  }
}

function renderOverlayButton(st) {
  const btn = document.getElementById('overlayToggleBtn');
  const ind = document.getElementById('overlayIndicator');
  const txt = document.getElementById('overlayBtnText');
  if (!btn || !ind || !txt) return;

  const running = Boolean(st?.running);
  const autoInGame = st?.autoInGame !== false;
  const demo = Boolean(st?.demo);

  btn.classList.toggle('on', running || autoInGame);
  if (running) {
    ind.className = 'dot in-champ-select';
    txt.textContent = demo ? 'Overlay: Vista Previa' : 'Overlay: En Partida';
  } else if (autoInGame) {
    ind.className = 'dot online';
    txt.textContent = 'Overlay: Auto';
  } else {
    ind.className = 'dot';
    txt.textContent = 'Overlay: OFF';
  }
}

async function togglePoolChampion(championId) {
  const current = new Set((state.config?.myPool || []).map(Number));
  if (current.has(championId)) current.delete(championId);
  else current.add(championId);

  const res = await apiJson('/api/config', {
    method: 'POST',
    body: JSON.stringify({ myPool: Array.from(current) })
  });
  state.config = res.config;
  renderPoolGrid();
  renderDraftControls();
  refreshRecommendations();
}

// ==================== SYNC ENGINE ====================
function attachSyncStream() {
  const banner = document.getElementById('syncBanner');
  const stageEl = document.getElementById('syncStageLabel');
  const pctEl = document.getElementById('syncPercentLabel');
  const fillEl = document.getElementById('syncFill');
  const syncBtns = [document.getElementById('fullSyncBtn'), document.getElementById('emptyDbSyncBtn'), document.getElementById('quickSyncBtn')];

  banner.classList.remove('hidden');
  syncBtns.forEach((b) => b && (b.disabled = true));

  if (syncEventSource) syncEventSource.close();
  syncEventSource = new EventSource('/api/sync/events');

  syncEventSource.onmessage = async (e) => {
    const evt = JSON.parse(e.data);
    stageEl.textContent = evt.message || 'Sincronizando...';
    pctEl.textContent = `${evt.percent || 0}%`;
    fillEl.style.width = `${evt.percent || 0}%`;

    if (evt.stage === 'done' || evt.stage === 'error') {
      syncEventSource.close();
      syncEventSource = null;
      syncBtns.forEach((b) => b && (b.disabled = false));
      setTimeout(() => banner.classList.add('hidden'), 2500);
      if (evt.stage === 'done') {
        await bootstrap();
      }
    }
  };
}

async function startSeasonSync() {
  try {
    attachSyncStream();
    await apiJson('/api/sync/start', { method: 'POST' });
  } catch (err) {
    alert(err.message);
  }
}

// ==================== CHAMPION PICKER MODAL ====================
function openChampionPicker(context) {
  state.pickerContext = context;
  const titles = {
    enemyLaner: `Elegir Posible Rival (${ROLE_LABELS[state.draft.myRole]})`,
    ally: 'Elegir Campeón Aliado',
    myChampion: 'Elegir Tu Campeón'
  };
  document.getElementById('pickerModalTitle').textContent = titles[context.type] || 'Elegir Campeón';
  document.getElementById('pickerSearchInput').value = '';
  renderPickerGrid('');
  document.getElementById('champPickerModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('pickerSearchInput').focus(), 20);
}

function closeChampionPicker() {
  document.getElementById('champPickerModal').classList.add('hidden');
  state.pickerContext = null;
}

function renderPickerGrid(query) {
  const q = query.trim().toLowerCase();
  const rolePool = state.laneChampionIds[state.draft.myRole];
  let list = state.champions;

  // Put champions played in the current lane first when picking enemyLaner or myChampion
  if (!q && (state.pickerContext?.type === 'enemyLaner' || state.pickerContext?.type === 'myChampion') && rolePool?.length) {
    const roleSet = new Set(rolePool);
    list = [...state.champions].sort((a, b) => {
      const aIn = roleSet.has(a.id) ? 0 : 1;
      const bIn = roleSet.has(b.id) ? 0 : 1;
      return aIn - bIn || a.name.localeCompare(b.name);
    });
  }

  if (q) {
    list = list.filter((c) => c.name.toLowerCase().includes(q) || c.enName?.toLowerCase().includes(q));
  }

  document.getElementById('pickerGrid').innerHTML = list
    .slice(0, 120)
    .map(
      (c) => `<button class="picker-item" data-pick-champ="${c.id}">
        <img src="${esc(c.iconUrl)}" alt="${esc(c.name)}" />
        <span>${esc(c.name)}</span>
      </button>`
    )
    .join('');
}

let cloudUpdateInfo = null;

async function checkCloudUpdates(isManual = false) {
  const banner = document.getElementById('cloudUpdateBanner');
  const textEl = document.getElementById('cloudUpdateText');
  const manualLink = document.getElementById('cloudUpdateManualLink');
  const manualStatus = document.getElementById('manualUpdateCheckStatus');
  const manualBtn = document.getElementById('manualCheckUpdateBtn');

  if (isManual && manualStatus) {
    manualStatus.textContent = 'Consultando GitHub...';
    if (manualBtn) manualBtn.disabled = true;
  }

  try {
    const res = await apiJson('/api/update/check');
    cloudUpdateInfo = res;
    if (document.getElementById('cfgAppBuildLabel')) {
      document.getElementById('cfgAppBuildLabel').textContent = `v${res.currentVersion || '2.1.0'}`;
    }

    if (res.updateAvailable) {
      if (banner && textEl) {
        textEl.textContent = `Nueva versión v${res.remoteVersion} disponible: ${res.title || res.changelog || 'Nuevas mejoras'}`;
        if (manualLink && res.installerUrl) {
          manualLink.href = res.installerUrl;
        }
        banner.classList.remove('hidden');
      }
      if (manualStatus) {
        manualStatus.innerHTML = `<strong style="color:var(--hex);">¡Nueva versión v${res.remoteVersion} disponible!</strong>`;
      }
    } else {
      if (banner) banner.classList.add('hidden');
      if (isManual && manualStatus) {
        manualStatus.textContent = `✓ Ya tienes la última versión instalada (v${res.currentVersion}).`;
      }
    }
  } catch (err) {
    if (isManual && manualStatus) {
      manualStatus.textContent = `Error al consultar: ${err.message}`;
    }
  } finally {
    if (isManual && manualBtn) manualBtn.disabled = false;
  }
}

async function applyCloudUpdate() {
  const btn = document.getElementById('applyUpdateBtn');
  if (!btn) return;
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Descargando e instalando...';

  try {
    await apiJson('/api/update/apply', {
      method: 'POST',
      body: JSON.stringify({ zipUrl: cloudUpdateInfo?.zipUrl || '' })
    });
    btn.textContent = '✓ ¡Actualizado! Reiniciando...';
    setTimeout(() => {
      window.location.reload();
    }, 1500);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = origText;
    alert(`Error al actualizar: ${err.message}\n\nPuedes descargar el instalador manualmente desde GitHub.`);
  }
}

// ==================== EVENT WIRING ====================
function bindEvents() {
  // Cloud auto-update events
  document.getElementById('applyUpdateBtn')?.addEventListener('click', applyCloudUpdate);
  document.getElementById('dismissUpdateBtn')?.addEventListener('click', () => {
    document.getElementById('cloudUpdateBanner')?.classList.add('hidden');
  });
  document.getElementById('manualCheckUpdateBtn')?.addEventListener('click', () => {
    checkCloudUpdates(true);
  });

  // Top tabs
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // LCU quick toggle
  document.getElementById('lcuStatusPill').addEventListener('click', async () => {
    const next = !state.config?.lcuEnabled;
    const res = await apiJson('/api/config', {
      method: 'POST',
      body: JSON.stringify({ lcuEnabled: next })
    });
    state.config = res.config;
    syncSettingsInputs();
    renderTopBar();
  });

  // Role selector
  document.getElementById('roleSelector').addEventListener('click', (e) => {
    const btn = e.target.closest('.role-pill');
    if (!btn) return;
    state.draft.myRole = btn.dataset.role;
    state.opggLane = btn.dataset.role;
    const opggTabs = document.getElementById('opggLaneTabs');
    if (opggTabs) {
      opggTabs.querySelectorAll('.opgg-tab').forEach((t) => {
        t.classList.toggle('on', t.dataset.lane === state.opggLane);
      });
    }
    renderDraftControls();
    refreshRecommendations();
    if (state.draft.myChampionId) loadMyChampionTab(state.draft.myChampionId);
  });

  // Draft slot buttons
  document.getElementById('enemyLanerBtn').addEventListener('click', () => openChampionPicker({ type: 'enemyLaner' }));
  document.getElementById('clearEnemyLanerBtn').addEventListener('click', () => selectEnemyLaner(null));

  document.getElementById('myChampDraftBtn').addEventListener('click', () => openChampionPicker({ type: 'myChampion' }));
  document.getElementById('clearMyChampBtn').addEventListener('click', () => {
    state.draft.myChampionId = null;
    renderTopBar();
    renderDraftControls();
    refreshRecommendations();
  });

  document.getElementById('onlyPoolToggle').addEventListener('change', (e) => {
    state.onlyPool = e.target.checked;
    refreshRecommendations();
  });

  document.getElementById('resetDraftBtn').addEventListener('click', () => {
    state.draft.enemyLanerId = null;
    state.draft.allies = [];
    state.draft.enemies = [];
    state.draft.bans = [];
    state.draft.myChampionId = null;
    state.manualEnemyOverride = false;
    state.manualModeChosen = false;
    state.mode = 'patch_wr';
    renderTopBar();
    renderDraftControls();
    refreshRecommendations();
  });

  // Promote detected enemy to enemyLaner
  document.getElementById('otherEnemiesList').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-promote-enemy]');
    if (!btn) return;
    selectEnemyLaner(Number(btn.dataset.promoteEnemy));
  });

  // OP.GG Lane Tabs
  const opggTabs = document.getElementById('opggLaneTabs');
  if (opggTabs) {
    opggTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.opgg-tab');
      if (!tab) return;
      opggTabs.querySelectorAll('.opgg-tab').forEach((t) => t.classList.remove('on'));
      tab.classList.add('on');
      state.opggLane = tab.dataset.lane || 'all';
      if (state.opggLane !== 'all') {
        state.draft.myRole = state.opggLane;
        document.querySelectorAll('#roleSelector .role-pill').forEach((btn) => {
          btn.classList.toggle('on', btn.dataset.role === state.draft.myRole);
        });
      }
      refreshRecommendations();
    });
  }

  // Candidate search
  document.getElementById('candidateSearchInput').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderRecommendationsList();
  });

  // Candidate row interactions
  document.getElementById('candidatesList').addEventListener('click', (e) => {
    const starBtn = e.target.closest('[data-toggle-pool]');
    if (starBtn) {
      e.stopPropagation();
      togglePoolChampion(Number(starBtn.dataset.togglePool));
      return;
    }

    const chooseBtn = e.target.closest('[data-choose-my-champ]');
    if (chooseBtn) {
      e.stopPropagation();
      chooseMyChampion(Number(chooseBtn.dataset.chooseMyChamp), true);
      return;
    }

    const row = e.target.closest('.opgg-row, .cand-row');
    if (row) {
      selectPreviewChampion(Number(row.dataset.candId));
    }
  });

  // Double click row to fix as my champion
  document.getElementById('candidatesList').addEventListener('dblclick', (e) => {
    const row = e.target.closest('.opgg-row, .cand-row');
    if (!row) return;
    const cid = Number(row.dataset.candId);
    if (cid) {
      chooseMyChampion(cid, true);
    }
  });

  // Counter strip card clicks
  document.getElementById('enemyCountersStrip').addEventListener('click', (e) => {
    const chooseBtn = e.target.closest('[data-counter-choose]');
    if (chooseBtn) {
      e.stopPropagation();
      chooseMyChampion(Number(chooseBtn.dataset.counterChoose), true);
      return;
    }
    const card = e.target.closest('[data-counter-champ]');
    if (card) {
      selectPreviewChampion(Number(card.dataset.counterChamp));
    }
  });

  // Picker modal
  document.getElementById('closePickerModalBtn').addEventListener('click', closeChampionPicker);
  document.getElementById('champPickerModal').addEventListener('click', (e) => {
    if (e.target.id === 'champPickerModal') closeChampionPicker();
  });
  document.getElementById('pickerSearchInput').addEventListener('input', (e) => {
    renderPickerGrid(e.target.value);
  });
  document.getElementById('pickerGrid').addEventListener('click', async (e) => {
    const item = e.target.closest('[data-pick-champ]');
    if (!item || !state.pickerContext) return;
    const champId = Number(item.dataset.pickChamp);
    const ctx = state.pickerContext;
    closeChampionPicker();

    if (ctx.type === 'enemyLaner') {
      selectEnemyLaner(champId);
    } else if (ctx.type === 'ally') {
      const idx = ctx.slotIndex ?? state.draft.allies.length;
      state.draft.allies[idx] = { championId: champId, role: null };
      state.draft.allies = state.draft.allies.filter(Boolean);
      renderDraftControls();
      refreshRecommendations();
    } else if (ctx.type === 'myChampion') {
      await chooseMyChampion(champId, true);
    }
  });

  // Sync buttons
  document.getElementById('quickSyncBtn').addEventListener('click', startSeasonSync);
  document.getElementById('fullSyncBtn').addEventListener('click', startSeasonSync);
  document.getElementById('emptyDbSyncBtn').addEventListener('click', startSeasonSync);

  // Saved seasons switch
  document.getElementById('savedSeasonsList').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-switch-season]');
    if (!btn) return;
    await apiJson('/api/seasons/switch', {
      method: 'POST',
      body: JSON.stringify({ patch: btn.dataset.switchSeason })
    });
    await bootstrap();
  });

  // Settings
  document.getElementById('cfgLcuEnabled').addEventListener('change', async (e) => {
    const res = await apiJson('/api/config', {
      method: 'POST',
      body: JSON.stringify({ lcuEnabled: e.target.checked })
    });
    state.config = res.config;
    renderTopBar();
  });

  document.getElementById('cfgAutoFocusTab').addEventListener('change', async (e) => {
    const res = await apiJson('/api/config', {
      method: 'POST',
      body: JSON.stringify({ autoFocusMyChampTab: e.target.checked })
    });
    state.config = res.config;
  });

  document.getElementById('saveLcuPathBtn').addEventListener('click', async () => {
    const val = document.getElementById('cfgLockfilePath').value.trim();
    const res = await apiJson('/api/config', {
      method: 'POST',
      body: JSON.stringify({ lcuLockfilePath: val })
    });
    state.config = res.config;
  });

  // Pool toggle & filter (Seasons & Datos + Draft & Picks)
  document.getElementById('poolSearchInput').addEventListener('input', (e) => {
    state.poolSearchQuery = e.target.value;
    renderPoolGrid();
  });
  const onPoolChampClick = (e) => {
    const item = e.target.closest('[data-pool-champ]');
    if (!item) return;
    togglePoolChampion(Number(item.dataset.poolChamp));
  };
  document.getElementById('poolGrid').addEventListener('click', onPoolChampClick);
  document.getElementById('draftPoolGrid')?.addEventListener('click', onPoolChampClick);
  document.getElementById('draftPoolMiniRow')?.addEventListener('click', onPoolChampClick);

  document.getElementById('draftPoolSearchInput')?.addEventListener('input', (e) => {
    state.draftPoolSearchQuery = e.target.value;
    renderPoolGrid();
  });
  document.getElementById('toggleDraftPoolBtn')?.addEventListener('click', () => {
    const picker = document.getElementById('draftPoolPicker');
    const btn = document.getElementById('toggleDraftPoolBtn');
    if (!picker || !btn) return;
    const opening = picker.classList.toggle('hidden') === false;
    btn.textContent = opening ? 'Listo' : 'Elegir';
    if (opening) document.getElementById('draftPoolSearchInput')?.focus();
  });

  // Solo/Duo History Form
  document.getElementById('soloDuoForm').addEventListener('submit', (e) => {
    e.preventDefault();
    runSoloDuoAnalysis();
  });

  // Overlay Controls
  document.getElementById('overlayToggleBtn').addEventListener('click', async () => {
    try {
      const st = await apiJson('/api/overlay/status');
      if (st.demo) {
        await apiJson('/api/config', { method: 'POST', body: JSON.stringify({ overlayDemo: false }) });
        document.getElementById('cfgOverlayDemo').checked = false;
      } else {
        const nextAuto = !st.autoInGame;
        const res = await apiJson('/api/config', {
          method: 'POST',
          body: JSON.stringify({ overlayAutoInGame: nextAuto })
        });
        state.config = res.config;
        document.getElementById('cfgOverlayAutoInGame').checked = nextAuto;
      }
      await refreshOverlayStatus();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('cfgOverlayAutoInGame').addEventListener('change', async (e) => {
    const res = await apiJson('/api/config', {
      method: 'POST',
      body: JSON.stringify({ overlayAutoInGame: e.target.checked })
    });
    state.config = res.config;
    await refreshOverlayStatus();
  });

  document.getElementById('cfgOverlayLocked').addEventListener('change', async (e) => {
    const res = await apiJson('/api/config', {
      method: 'POST',
      body: JSON.stringify({ overlayLocked: e.target.checked })
    });
    state.config = res.config;
  });

  document.getElementById('cfgOverlayDemo').addEventListener('change', async (e) => {
    const res = await apiJson('/api/config', {
      method: 'POST',
      body: JSON.stringify({ overlayDemo: e.target.checked })
    });
    state.config = res.config;
    await refreshOverlayStatus();
  });

  document.getElementById('cfgOverlayScale').addEventListener('input', (e) => {
    const sc = Number(e.target.value);
    document.getElementById('overlayScaleLabel').textContent = `${Math.round(sc * 100)}% (${Math.round(236 * sc)}×${Math.round(178 * sc)})`;
  });
  document.getElementById('cfgOverlayScale').addEventListener('change', async (e) => {
    const res = await apiJson('/api/config', {
      method: 'POST',
      body: JSON.stringify({ overlayScale: Number(e.target.value) })
    });
    state.config = res.config;
  });

  document.getElementById('cfgOverlayOpacity').addEventListener('input', (e) => {
    const op = Number(e.target.value);
    document.getElementById('overlayOpacityLabel').textContent = `${Math.round(op * 100)}%`;
  });
  document.getElementById('cfgOverlayOpacity').addEventListener('change', async (e) => {
    const res = await apiJson('/api/config', {
      method: 'POST',
      body: JSON.stringify({ overlayOpacity: Number(e.target.value) })
    });
    state.config = res.config;
  });

  document.getElementById('applyOverlayPosBtn').addEventListener('click', async () => {
    const xVal = document.getElementById('cfgOverlayX').value.trim();
    const yVal = document.getElementById('cfgOverlayY').value.trim();
    const payload = {};
    if (xVal !== '') payload.overlayX = Number(xVal);
    if (yVal !== '') payload.overlayY = Number(yVal);
    const res = await apiJson('/api/config', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    state.config = res.config;
    syncSettingsInputs();
  });

  document.getElementById('resetOverlayPosBtn').addEventListener('click', async () => {
    const res = await apiJson('/api/config', {
      method: 'POST',
      body: JSON.stringify({ overlayResetPos: true, overlayScale: 1.0, overlayOpacity: 0.68 })
    });
    state.config = res.config;
    syncSettingsInputs();
  });

  // TORNEO BLITZ controls (Sorteo + Sync + Registro OP.GG)
  async function triggerTorneoDraw() {
    const btns = [document.getElementById('drawTorneoBtn'), document.getElementById('drawTorneoCardBtn')].filter(Boolean);
    btns.forEach((b) => { b.disabled = true; });
    try {
      const snap = await apiJson('/api/tournament/draw', { method: 'POST', body: '{}' });
      renderTournamentView(snap);
    } catch (err) {
      alert(err.message);
    } finally {
      btns.forEach((b) => { b.disabled = false; });
    }
  }
  document.getElementById('drawTorneoBtn')?.addEventListener('click', triggerTorneoDraw);
  document.getElementById('drawTorneoCardBtn')?.addEventListener('click', triggerTorneoDraw);

  async function postTorneoControl(endpoint, payload = {}) {
    try {
      const snap = await apiJson(endpoint, { method: 'POST', body: JSON.stringify(payload) });
      renderTournamentView(snap);
    } catch (err) {
      alert(err.message);
      refreshTournamentState(false);
    }
  }
  document.getElementById('torneoResizeSelect')?.addEventListener('change', (e) => {
    postTorneoControl('/api/tournament/resize', { size: Number(e.target.value) });
  });
  document.getElementById('startTorneoBtn')?.addEventListener('click', () => {
    postTorneoControl('/api/tournament/start');
  });
  document.getElementById('pauseTorneoBtn')?.addEventListener('click', () => {
    const endpoint = state.lastTournamentSnap?.paused ? '/api/tournament/resume' : '/api/tournament/pause';
    postTorneoControl(endpoint);
  });

  document.getElementById('refreshTorneoBtn').addEventListener('click', () => refreshTournamentState(true));

  document.getElementById('torneoRegisterForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('torneoRegBtn');
    const msgEl = document.getElementById('torneoRegMsg');
    const teamName = document.getElementById('regTeamName').value.trim();
    const region = document.getElementById('regRegionSelect')?.value || 'LAN';
    const players = [...document.querySelectorAll('#torneoRegisterForm .reg-player')]
      .map((i) => i.value.trim())
      .filter(Boolean);

    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = 'Verificando en OP.GG...';
    if (msgEl) msgEl.textContent = 'Comprobando que todas las cuentas existan en OP.GG...';
    try {
      const snap = await apiJson('/api/tournament/register', {
        method: 'POST',
        body: JSON.stringify({ teamName, players, region })
      });
      document.getElementById('regTeamName').value = '';
      if (msgEl) msgEl.innerHTML = `<span class="metric-good">Equipo "${esc(teamName)}" verificado e inscrito.</span>`;
      renderTournamentView(snap);
    } catch (err) {
      if (msgEl) msgEl.innerHTML = `<span class="metric-bad">${esc(err.message)}</span>`;
      else alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  });

  // ROAD TO event handlers
  document.getElementById('refreshRoadToBtn')?.addEventListener('click', () => refreshRoadToState(true, true));

  document.getElementById('roadToRegisterForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('roadToRegBtn');
    const msgEl = document.getElementById('roadToRegMsg');
    const riotId = document.getElementById('roadToRiotIdInput').value.trim();
    const region = document.getElementById('roadToRegionSelect').value;

    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Analizando OP.GG...';
    if (msgEl) msgEl.textContent = 'Verificando cuenta y seasons anteriores en OP.GG...';
    try {
      const snap = await apiJson('/api/roadto/register', {
        method: 'POST',
        body: JSON.stringify({ riotId, region })
      });
      const pl = snap.registeredPlacement;
      if (msgEl && pl) {
        msgEl.innerHTML = `<span class="metric-good">Inscrito en <strong>${esc(pl.categoryName)}</strong> · Peak referencia: ${esc(pl.referencePeakLabel)} (${esc(pl.previousSummary)})</span>`;
      }
      renderRoadToView(snap);
    } catch (err) {
      if (msgEl) msgEl.innerHTML = `<span class="metric-bad">${esc(err.message)}</span>`;
      else alert(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  document.querySelectorAll('.roadto-cat-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.roadToFilter = btn.dataset.rtcat || 'all';
      document.querySelectorAll('.roadto-cat-tab').forEach((b) => b.classList.toggle('on', b === btn));
      if (state.lastRoadToSnap) renderRoadToView(state.lastRoadToSnap);
    });
  });

  document.getElementById('dismissAvisoBtn')?.addEventListener('click', () => {
    const banner = document.getElementById('globalAvisoBanner');
    if (banner?.dataset.sig) {
      sessionStorage.setItem('dismissed_aviso_sig', banner.dataset.sig);
    }
    banner?.classList.add('hidden');
  });
}

// ==================== SOLO/DUO HISTORY & COACHING ====================
function syncSoloDuoInputs() {
  const acct = state.config?.riotAccount;
  if (acct?.gameName && acct?.tagLine) {
    const input = document.getElementById('riotIdInput');
    const reg = document.getElementById('regionSelect');
    if (input && !input.value.trim()) input.value = `${acct.gameName}#${acct.tagLine}`;
    if (reg && acct.region && [...reg.options].some((o) => o.value === acct.region)) {
      reg.value = acct.region;
    }
  }
}

async function runSoloDuoAnalysis() {
  const raw = document.getElementById('riotIdInput').value.trim();
  const region = document.getElementById('regionSelect').value;
  const out = document.getElementById('soloDuoResults');
  const btn = document.getElementById('analyzeSoloDuoBtn');

  const hashIdx = raw.lastIndexOf('#');
  if (hashIdx <= 0 || hashIdx === raw.length - 1) {
    out.innerHTML = `<div class="rbanner warn"><div class="rbanner-info"><div class="rbanner-title">Formato inválido</div><div class="rbanner-sub">Escribe tu Riot ID completo con #, por ejemplo: <strong>Nombre#LAN</strong> o <strong>Faker#KR1</strong></div></div></div>`;
    return;
  }

  const gameName = raw.slice(0, hashIdx).trim();
  const tagLine = raw.slice(hashIdx + 1).trim();

  btn.disabled = true;
  out.innerHTML = `<div class="panel loading-state">Analizando tus partidas de Clasificatoria Solo/Duo en OP.GG y comparando contra tus rivales de línea...</div>`;

  try {
    const data = await apiJson('/api/soloduo-analysis', {
      method: 'POST',
      body: JSON.stringify({ gameName, tagLine, region })
    });
    renderSoloDuoResults(data);
  } catch (err) {
    out.innerHTML = `<div class="rbanner warn"><div class="rbanner-info"><div class="rbanner-title">No se pudo analizar</div><div class="rbanner-sub">${esc(err.message)}</div></div></div>`;
  } finally {
    btn.disabled = false;
  }
}

function renderSoloDuoResults(data) {
  const out = document.getElementById('soloDuoResults');
  const { summoner, scannedTotalMatches, soloDuoCount, primaryRole, summary, advice, seasonChampions, matches } = data;

  if (!soloDuoCount) {
    out.innerHTML = `<div class="rbanner warn"><div class="rbanner-info"><div class="rbanner-title">Sin partidas Solo/Duo recientes (${esc(summoner.gameName)}#${esc(summoner.tagLine)})</div><div class="rbanner-sub">Se revisaron las últimas ${scannedTotalMatches} partidas en ${esc(summoner.region)}, pero ninguna era Clasificatoria Solo/Duo (SOLORANKED).</div></div></div>`;
    return;
  }

  const rank = summoner.soloRank;
  const rankText = rank && rank.tier !== 'UNRANKED'
    ? `${rank.tier} ${rank.division || ''} · ${rank.lp} LP (${rank.win}V - ${rank.lose}D)`
    : 'Sin rango Solo/Duo en esta season';

  const sevLabels = {
    critical: 'Prioritario mejorar',
    warn: 'Pulir detalle',
    good: 'Punto fuerte'
  };

  const adviceHtml = advice
    .map(
      (a) => `<div class="advice-card ${esc(a.severity)}">
        <div class="advice-top">
          <span class="advice-area">${esc(a.area)}</span>
          <span class="advice-badge ${esc(a.severity)}">${esc(sevLabels[a.severity] || '')}</span>
        </div>
        <div class="advice-metric">${esc(a.metric)}</div>
        <div class="advice-target">${esc(a.target)}</div>
        <div class="advice-tip">${esc(a.tip)}</div>
      </div>`
    )
    .join('');

  const matchesHtml = matches
    .map((m) => {
      const resTag = m.win
        ? '<span class="rdelta pos">Victoria</span>'
        : '<span class="rdelta neg">Derrota</span>';
      const csDiffTxt = m.csDiff !== null
        ? `<span class="rdelta ${m.csDiff >= 0 ? 'pos' : 'neg'}">${m.csDiff >= 0 ? '+' : ''}${m.csDiff}</span>`
        : '';
      const lvlDiffTxt = m.levelDiff !== null
        ? `<span class="rdelta ${m.levelDiff >= 0 ? 'pos' : 'neg'}">${m.levelDiff >= 0 ? '+' : ''}${m.levelDiff} nv</span>`
        : '';

      return `<tr>
        <td>${resTag}<div class="metric-sub mono">${m.durationMin}m</div></td>
        <td>
          <div class="rplayer">
            ${m.championIcon ? `<img class="dav" src="${esc(m.championIcon)}" alt="" />` : ''}
            <div>
              <div>${esc(m.championName)}</div>
              <div class="metric-sub">${esc(m.position)}${m.opponentName ? ` vs ${esc(m.opponentName)}` : ''}</div>
            </div>
          </div>
        </td>
        <td class="mono">${m.kills}/${m.deaths}/${m.assists}<div class="metric-sub">KP ${(m.kp * 100).toFixed(0)}%</div></td>
        <td class="mono">${m.csPerMin} CS/m ${csDiffTxt}<div class="metric-sub">${m.cs} total</div></td>
        <td class="mono">Nv ${m.level} ${lvlDiffTxt}</td>
        <td class="mono">${m.wardsPlaced} wards<div class="metric-sub">${m.pinks} Pinks · ${m.wardsPerMin}/m</div></td>
        <td class="mono"><strong>${m.opScore ? m.opScore.toFixed(1) : '—'}</strong>${m.opRank ? `<div class="metric-sub">#${m.opRank}</div>` : ''}</td>
      </tr>`;
    })
    .join('');

  const seasonChampsHtml = seasonChampions.length
    ? `<div class="panel db-card" style="margin-bottom:14px;">
        <h3 class="sub-heading">Tus Campeones en Solo/Duo (Season)</h3>
        <div class="rtable-wrap" style="margin-bottom:0;">
          <table class="rtable">
            <thead><tr><th>Campeón</th><th>Partidas</th><th>Win Rate</th><th>KDA</th><th>CS/min</th><th>CS@10m</th><th>KP%</th><th>OP Score</th></tr></thead>
            <tbody>
              ${seasonChampions
                .map(
                  (c) => `<tr>
                    <td><strong>${esc(c.name)}</strong></td>
                    <td class="mono">${c.play} (${c.win}V-${c.lose}D)</td>
                    <td class="mono ${wrClass(c.winRate)}">${pct(c.winRate, 1)}</td>
                    <td class="mono">${c.kda}</td>
                    <td class="mono">${c.csPerMin}</td>
                    <td class="mono">${c.csAt10 ?? '—'}</td>
                    <td class="mono">${c.kp}%</td>
                    <td class="mono">${c.opScore}</td>
                  </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>`
    : '';

  out.innerHTML = `
    <div class="panel soloduo-header-card">
      <div class="my-champ-hero-left">
        ${summoner.profileIcon ? `<div class="mvphex-sm"><img src="${esc(summoner.profileIcon)}" alt="" /></div>` : ''}
        <div>
          <h2 class="section-heading" style="margin-bottom:2px;">${esc(summoner.gameName)}#${esc(summoner.tagLine)} · ${esc(summoner.region)}</h2>
          <div class="muted">${esc(rankText)} · Rol principal analizado: <strong>${esc(primaryRole)}</strong></div>
          <div class="metric-sub">Filtro estricto: <strong>${soloDuoCount} partidas Solo/Duo</strong> (de ${scannedTotalMatches} recientes; Flex/Normales/ARAM excluidas)</div>
        </div>
      </div>
      <div class="my-champ-stats-row">
        <div class="stat-pill-box"><div class="micro-label">WR Reciente</div><div class="val ${wrClass(summary.winRate)}">${pct(summary.winRate, 0)} (${summary.wins}V-${summary.losses}D)</div></div>
        <div class="stat-pill-box"><div class="micro-label">CS / min</div><div class="val">${summary.avgCsPerMin}</div></div>
        <div class="stat-pill-box"><div class="micro-label">Dif. Nivel</div><div class="val ${summary.avgLevelDiff >= 0 ? 'metric-good' : 'metric-bad'}">${summary.avgLevelDiff >= 0 ? '+' : ''}${summary.avgLevelDiff}</div></div>
        <div class="stat-pill-box"><div class="micro-label">KP Promedio</div><div class="val">${(summary.avgKp * 100).toFixed(0)}%</div></div>
        <div class="stat-pill-box"><div class="micro-label">Pinks / part</div><div class="val">${summary.avgPinks}</div></div>
      </div>
    </div>

    <h3 class="sub-heading">Diagnóstico de Mejora en Solo/Duo</h3>
    <div class="coaching-grid">${adviceHtml}</div>

    ${seasonChampsHtml}

    <h3 class="sub-heading">Últimas Partidas Solo/Duo Analizadas (${soloDuoCount})</h3>
    <div class="rtable-wrap">
      <table class="rtable">
        <thead>
          <tr>
            <th>Resultado</th>
            <th>Campeón / Matchup</th>
            <th>KDA / KP</th>
            <th>Farmeo (vs Rival)</th>
            <th>Nivel (vs Rival)</th>
            <th>Visión</th>
            <th>OP Score</th>
          </tr>
        </thead>
        <tbody>${matchesHtml}</tbody>
      </table>
    </div>
  `;
}

window.chooseMyChampion = chooseMyChampion;
window.switchView = switchView;

// ==================== TORNEO BLITZ (DISCORD + LOSER BRACKET) ====================
function syncDiscordInputs() {
  // Pre-fill first player slot, Road To riot ID & region with connected LoL Riot ID if empty
  const firstPlayer = document.querySelector('#torneoRegisterForm .reg-player');
  const regSel = document.getElementById('regRegionSelect');
  const rtInput = document.getElementById('roadToRiotIdInput');
  const rtSel = document.getElementById('roadToRegionSelect');
  const acct = state.config?.riotAccount;
  if (firstPlayer && !firstPlayer.value.trim() && acct?.gameName && acct?.tagLine) {
    firstPlayer.value = `${acct.gameName}#${acct.tagLine}`;
  }
  if (rtInput && !rtInput.value.trim() && acct?.gameName && acct?.tagLine) {
    rtInput.value = `${acct.gameName}#${acct.tagLine}`;
  }
  if (regSel && acct?.region && [...regSel.options].some((o) => o.value === acct.region)) {
    regSel.value = acct.region;
  }
  if (rtSel && acct?.region && [...rtSel.options].some((o) => o.value === acct.region)) {
    rtSel.value = acct.region;
  }
}

async function refreshTournamentState(showErrors = false) {
  try {
    const snap = await apiJson('/api/tournament/state');
    renderTournamentView(snap);
  } catch (err) {
    if (showErrors) {
      const sub = document.getElementById('torneoBannerSub');
      if (sub) sub.innerHTML = `<span class="metric-bad">${esc(err.message)}</span>`;
    }
  }
}

function syncGlobalAnnouncementBanner() {
  const banner = document.getElementById('globalAvisoBanner');
  const textEl = document.getElementById('globalAvisoText');
  const metaEl = document.getElementById('globalAvisoMeta');
  if (!banner || !textEl) return;

  const candidates = [state.torneoAnnouncement, state.roadToAnnouncement].filter((a) => a && a.text);
  if (!candidates.length) {
    banner.classList.add('hidden');
    return;
  }
  candidates.sort((a, b) => Number(b.atMs || 0) - Number(a.atMs || 0));
  const best = candidates[0];
  const sig = `${best.text}|${best.at || ''}`;
  if (sessionStorage.getItem('dismissed_aviso_sig') === sig) {
    banner.classList.add('hidden');
    return;
  }
  banner.dataset.sig = sig;
  textEl.textContent = best.text;
  if (metaEl) {
    metaEl.textContent = best.by ? `— ${best.by}` : '';
  }
  banner.classList.remove('hidden');
}

async function copyTorneoRoom(matchId, btnEl) {
  const m = state.lastTournamentSnap?.bracket?.matches?.[matchId];
  if (!m || !m.roomName) return;
  const copyTxt = m.roomPass ? `Sala: ${m.roomName} | Clave: ${m.roomPass}` : `Sala: ${m.roomName}`;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(copyTxt);
    } else {
      const ta = document.createElement('textarea');
      ta.value = copyTxt;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    if (btnEl) {
      const orig = btnEl.textContent;
      btnEl.textContent = '¡Copiado!';
      setTimeout(() => { btnEl.textContent = orig; }, 1400);
    }
  } catch {
    alert(copyTxt);
  }
}
window.copyTorneoRoom = copyTorneoRoom;

async function editTorneoRoom(matchId) {
  const m = state.lastTournamentSnap?.bracket?.matches?.[matchId];
  const nextName = prompt(`Nombre de la sala personalizada para ${matchId} (deja vacío para borrar):`, m?.roomName || `Torneo ${matchId}`);
  if (nextName === null) return;
  const cleanName = nextName.trim();
  let clear = false;
  let cleanPass = '';
  if (!cleanName) {
    if (!m?.roomName) return;
    if (!confirm(`¿Quitar sala y contraseña de ${matchId}?`)) return;
    clear = true;
  } else {
    const passAns = prompt(`Contraseña de la sala "${cleanName}" (opcional):`, m?.roomPass === 'Sin clave' ? '' : (m?.roomPass || ''));
    if (passAns === null) return;
    cleanPass = passAns.trim();
  }
  try {
    const snap = await apiJson('/api/tournament/room', {
      method: 'POST',
      body: JSON.stringify({ matchId, roomName: cleanName, roomPass: cleanPass, clear })
    });
    renderTournamentView(snap);
  } catch (err) {
    alert(err.message);
  }
}
window.editTorneoRoom = editTorneoRoom;

async function setTorneoMatchWinner(matchId, winnerName) {
  try {
    const snap = await apiJson('/api/tournament/winner', {
      method: 'POST',
      body: JSON.stringify({ matchId, winnerName })
    });
    renderTournamentView(snap);
  } catch (err) {
    alert(err.message);
  }
}
window.setTorneoMatchWinner = setTorneoMatchWinner;

async function dropTorneoTeam(teamName) {
  if (!confirm(`¿Dar de baja al equipo "${teamName}" del torneo?`)) return;
  try {
    const snap = await apiJson('/api/tournament/drop', {
      method: 'POST',
      body: JSON.stringify({ teamName })
    });
    renderTournamentView(snap);
  } catch (err) {
    alert(err.message);
  }
}
window.dropTorneoTeam = dropTorneoTeam;

function renderRosterChipsHtml(roster) {
  if (!Array.isArray(roster) || !roster.length) return '';
  return roster
    .map(
      (p) =>
        `<span class="roster-chip ${p.inLobby ? 'in' : 'out'}" title="${p.inLobby ? 'En sala personalizada' : 'Fuera de la sala'}"><span class="roster-dot"></span>${esc(p.name)}</span>`
    )
    .join('');
}

const TEAM_GLOW_PALETTE = [
  ['#5cf2ff', 'rgba(92, 242, 255, 0.55)'],
  ['#ffd166', 'rgba(255, 209, 102, 0.55)'],
  ['#5effa3', 'rgba(94, 255, 163, 0.55)'],
  ['#c792ff', 'rgba(199, 146, 255, 0.55)'],
  ['#ff857a', 'rgba(255, 133, 122, 0.55)'],
  ['#6cb6ff', 'rgba(108, 182, 255, 0.55)'],
  ['#ff85c8', 'rgba(255, 133, 200, 0.55)'],
  ['#b7f36b', 'rgba(183, 243, 107, 0.55)']
];

function getTeamColorStyle(teamName, teams = []) {
  if (!teamName) return '';
  const idx = (teams || []).findIndex((t) => String(t.name || '').toLowerCase() === String(teamName).toLowerCase());
  const pair = TEAM_GLOW_PALETTE[(idx >= 0 ? idx : teamName.length) % TEAM_GLOW_PALETTE.length];
  return `--team-color:${pair[0]};--team-glow:${pair[1]};`;
}

function computeClientMatchRemainingMs(readyAtMs, pauseIntervals = [], nowMs = Date.now()) {
  if (!readyAtMs) return null;
  let pausedTotal = 0;
  for (const iv of pauseIntervals || []) {
    if (!iv || iv.startMs == null) continue;
    const s = Math.max(iv.startMs, readyAtMs);
    const e = iv.endMs != null ? iv.endMs : nowMs;
    if (e > s) pausedTotal += e - s;
  }
  const elapsed = Math.max(0, nowMs - readyAtMs - pausedTotal);
  return Math.max(0, 30 * 60 * 1000 - elapsed);
}

function formatCountdownClock(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function updateTorneoTimers() {
  const snap = state.lastTournamentSnap;
  const pills = document.querySelectorAll('#torneoBracketContainer .match-timer-pill[data-ready-at]');
  if (!pills.length) return;
  const nowMs = Date.now();
  const pauseIntervals = snap?.pauseIntervals || [];
  const isPaused = Boolean(snap?.paused);
  pills.forEach((el) => {
    const readyAtMs = Number(el.dataset.readyAt);
    const rem = computeClientMatchRemainingMs(readyAtMs, pauseIntervals, nowMs);
    if (rem == null) return;
    el.classList.toggle('paused', isPaused);
    el.classList.toggle('due', !isPaused && rem <= 0);
    if (isPaused) {
      el.textContent = `⏸ ${formatCountdownClock(rem)}`;
    } else if (rem <= 0) {
      el.textContent = '⏱ ¡YA INICIA!';
    } else {
      el.textContent = `⏱ ${formatCountdownClock(rem)}`;
    }
  });
}

function renderMatchBoxHtml(m, canEditBracket = true, teamRosters = {}, activeLobbyMatchId = null, teams = [], snap = null) {
  if (!m) return '';
  const winA = m.winner && m.teamA && m.winner === m.teamA;
  const winB = m.winner && m.teamB && m.winner === m.teamB;
  const loseA = m.winner && m.teamA && m.winner !== m.teamA;
  const loseB = m.winner && m.teamB && m.winner !== m.teamB;
  const canPick = canEditBracket && Boolean(m.teamA && m.teamB);
  const rosterA = m.teamA ? (teamRosters[m.teamA] || []) : [];
  const rosterB = m.teamB ? (teamRosters[m.teamB] || []) : [];
  const inCountA = rosterA.filter((p) => p.inLobby).length;
  const inCountB = rosterB.filter((p) => p.inLobby).length;
  const isLobbyFocus = activeLobbyMatchId && activeLobbyMatchId === m.id && !m.winner;
  const showTimer = Boolean(snap?.started && !m.winner && m.teamA && m.teamB && m.readyAtMs);

  const teamALabel = m.teamA
    ? `<span class="team-name-glow" style="${getTeamColorStyle(m.teamA, teams)}">${esc(m.teamA)}</span>`
    : `<span class="muted">Por definir</span>`;
  const teamBLabel = m.teamB
    ? `<span class="team-name-glow" style="${getTeamColorStyle(m.teamB, teams)}">${esc(m.teamB)}</span>`
    : `<span class="muted">Por definir</span>`;

  return `<div class="match-card ${esc(m.bracketType)} ${isLobbyFocus ? 'in-lobby' : ''}">
    <div class="match-id-bar">
      <span>${esc(m.id)} ${isLobbyFocus ? '<span class="match-lobby-badge">· EN SALA</span>' : ''}</span>
      ${showTimer ? `<span class="match-timer-pill" data-ready-at="${Number(m.readyAtMs)}" title="Cuenta regresiva de 30 min para iniciar">${snap?.paused ? '⏸ 30:00' : '⏱ 30:00'}</span>` : `<span>${esc(m.roundLabel)}</span>`}
    </div>
    ${
      m.roomName
        ? `<div class="match-room-bar">
            <span class="match-room-info" title="${esc(m.roomName)} · ${esc(m.roomPass || 'Sin clave')}">🏠 <strong>${esc(m.roomName)}</strong>${m.roomPass ? ` · <span class="mono">${esc(m.roomPass)}</span>` : ''}</span>
            <div class="match-room-btns">
              <button class="ghost match-room-btn" onclick="copyTorneoRoom('${esc(m.id)}', this)">Copiar</button>
              ${m.canEditRoom ? `<button class="ghost match-room-btn" onclick="editTorneoRoom('${esc(m.id)}')" title="Editar sala y clave">✏</button>` : ''}
            </div>
          </div>`
        : m.canEditRoom
        ? `<div class="match-room-bar empty"><button class="ghost match-room-btn" onclick="editTorneoRoom('${esc(m.id)}')">🔑 Fijar Sala / Clave</button></div>`
        : ''
    }
    <div class="match-slot-wrap">
      <div class="match-slot ${winA ? 'win' : loseA ? 'lose' : ''}">
        <span>${teamALabel}${rosterA.length ? ` <span class="mono muted" style="font-size:11px;">(${inCountA}/${rosterA.length})</span>` : ''}</span>
        ${canPick && !winA ? `<button class="ghost match-win-btn" onclick="setTorneoMatchWinner('${esc(m.id)}', '${esc(m.teamA)}')">✓ Gana</button>` : ''}
      </div>
      ${rosterA.length ? `<div class="match-roster">${renderRosterChipsHtml(rosterA)}</div>` : ''}
    </div>
    <div class="match-slot-wrap">
      <div class="match-slot ${winB ? 'win' : loseB ? 'lose' : ''}">
        <span>${teamBLabel}${rosterB.length ? ` <span class="mono muted" style="font-size:11px;">(${inCountB}/${rosterB.length})</span>` : ''}</span>
        ${canPick && !winB ? `<button class="ghost match-win-btn" onclick="setTorneoMatchWinner('${esc(m.id)}', '${esc(m.teamB)}')">✓ Gana</button>` : ''}
      </div>
      ${rosterB.length ? `<div class="match-roster">${renderRosterChipsHtml(rosterB)}</div>` : ''}
    </div>
  </div>`;
}

function renderTorneoMvpTable(mvpLeaderboard = [], teams = []) {
  const bodyEl = document.getElementById('torneoMvpBody');
  if (!bodyEl) return;
  if (!Array.isArray(mvpLeaderboard) || !mvpLeaderboard.length) {
    bodyEl.innerHTML = '<p class="muted">Las estadísticas KDA, daño, CS y MVP aparecerán automáticamente cuando termine la primera partida del torneo.</p>';
    return;
  }
  bodyEl.innerHTML = `<div class="torneo-mvp-wrap">
    <table class="torneo-mvp-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Jugador</th>
          <th>Equipo</th>
          <th>V-D</th>
          <th>K / D / A</th>
          <th>KDA</th>
          <th>Daño Prom.</th>
          <th>CS Prom.</th>
          <th>MVP</th>
        </tr>
      </thead>
      <tbody>
        ${mvpLeaderboard
          .map(
            (p, idx) => `<tr class="${idx === 0 ? 'mvp-rank-1' : ''}">
              <td class="mono">${idx === 0 ? '👑 #1' : `#${idx + 1}`}</td>
              <td><strong>${esc(p.riotId)}</strong></td>
              <td>${p.teamName ? `<span class="team-name-glow" style="${getTeamColorStyle(p.teamName, teams)}">${esc(p.teamName)}</span>` : '<span class="muted">—</span>'}</td>
              <td class="mono">${p.wins}V - ${p.losses}D</td>
              <td class="mono">${p.kills}/${p.deaths}/${p.assists}</td>
              <td class="mono">${Number(p.kda || 0).toFixed(2)}</td>
              <td class="mono">${Number(p.avgDamage || 0).toLocaleString()}</td>
              <td class="mono">${Number(p.avgCs || 0)}</td>
              <td><span class="mvp-score-pill">${Number(p.mvpScore || 0).toFixed(1)}</span></td>
            </tr>`
          )
          .join('')}
      </tbody>
    </table>
  </div>`;
}

function renderTournamentView(snap) {
  state.lastTournamentSnap = snap;
  state.torneoAnnouncement = snap?.announcement || null;
  syncGlobalAnnouncementBanner();
  const navTab = document.getElementById('torneoNavTab');
  const banner = document.getElementById('torneoBanner');
  const titleEl = document.getElementById('torneoBannerTitle');
  const subEl = document.getElementById('torneoBannerSub');
  const countEl = document.getElementById('torneoTeamCount');
  const teamsEl = document.getElementById('torneoTeamsList');
  const bracketBox = document.getElementById('torneoBracketContainer');
  const drawBtn = document.getElementById('drawTorneoBtn');
  const drawCard = document.getElementById('torneoDrawCard');
  const drawCardTitle = document.getElementById('torneoDrawCardTitle');
  const drawCardSub = document.getElementById('torneoDrawCardSub');
  const drawCardBtn = document.getElementById('drawTorneoCardBtn');
  const resizeSel = document.getElementById('torneoResizeSelect');
  const startBtn = document.getElementById('startTorneoBtn');
  const pauseBtn = document.getElementById('pauseTorneoBtn');

  const discordAdminLocked = snap.source === 'discord' && snap.adminOnly !== false;
  const canDirectAdmin = !discordAdminLocked;
  const sourceTag = snap.source === 'discord' ? 'Discord Live' : 'Modo Local';
  const torneoBadge = document.getElementById('torneoNavBadge');
  if (torneoBadge) {
    if (snap.active && snap.teams) {
      torneoBadge.textContent = `${snap.teams.length}/${snap.size}`;
      torneoBadge.classList.remove('hidden');
    } else {
      torneoBadge.classList.add('hidden');
    }
  } else if (navTab) {
    navTab.textContent = snap.active ? `TORNEO BLITZ (${snap.teams.length}/${snap.size})` : 'TORNEO BLITZ';
  }

  if (!snap.active) {
    banner.className = 'rbanner torneo-status-banner';
    titleEl.className = 'torneo-status-hero closed';
    titleEl.textContent = 'NO HAY TORNEO ABIERTO';
    subEl.innerHTML = `Modo ${esc(sourceTag)} · El Admin abre las inscripciones en Discord escribiendo <span class="mono">!TORNEO ON 2</span>, <span class="mono">4</span>, <span class="mono">8</span> o <span class="mono">16</span>.`;
    countEl.textContent = '0/0';
    teamsEl.innerHTML = '<p class="muted">No hay torneo abierto en este momento.</p>';
    drawBtn?.classList.add('hidden');
    resizeSel?.classList.add('hidden');
    startBtn?.classList.add('hidden');
    pauseBtn?.classList.add('hidden');
    drawCard?.classList.add('hidden');
    bracketBox.classList.add('hidden');
    return;
  }

  const teamsFull = snap.teams.length >= snap.size;
  const isDrawn = Boolean(snap.drawn || (snap.bracket && Object.values(snap.bracket.matches || {}).some((m) => m.winner)));
  const lobbyCount = snap.lcuLobbyStatus?.detectedCount || 0;
  const lobbyTag = lobbyCount > 0
    ? ` · <span class="metric-good">Sala LoL: ${lobbyCount} en sala</span>`
    : ' · <span class="muted">Sala LoL: esperando</span>';

  banner.className = 'rbanner ok torneo-status-banner';
  if (snap.paused) {
    titleEl.className = 'torneo-status-hero paused';
    titleEl.textContent = `⏸ TORNEO PAUSADO · ${snap.size} EQUIPOS (${snap.teams.length}/${snap.size})`;
  } else if (snap.started) {
    titleEl.className = 'torneo-status-hero open';
    titleEl.textContent = `TORNEO EN CURSO · ${snap.size} EQUIPOS (${snap.teams.length}/${snap.size})`;
  } else if (isDrawn) {
    titleEl.className = 'torneo-status-hero open';
    titleEl.textContent = `LLAVES LISTAS (ESPERANDO INICIO) · ${snap.size} EQUIPOS (${snap.teams.length}/${snap.size})`;
  } else {
    titleEl.className = 'torneo-status-hero open';
    titleEl.textContent = `TORNEO ABIERTO PARA INSCRIPCIÓN · ${snap.size} EQUIPOS (${snap.teams.length}/${snap.size})`;
  }
  subEl.innerHTML = `Organizado por <strong>NGELX</strong> (${esc(sourceTag)})${lobbyTag} · Discord Admin: <span class="mono">!TORNEO 2/4/8/16</span> · <span class="mono">!TORNEO INICIAR</span> · <span class="mono">!TORNEO PAUSA</span> / <span class="mono">REANUDAR</span>.`;
  countEl.textContent = `${snap.teams.length}/${snap.size}`;

  if (resizeSel) {
    resizeSel.classList.toggle('hidden', !canDirectAdmin);
    resizeSel.value = String(snap.size);
  }
  if (startBtn) {
    startBtn.classList.toggle('hidden', !(canDirectAdmin && !snap.started && snap.teams.length >= 2));
  }
  if (pauseBtn) {
    pauseBtn.classList.toggle('hidden', !(canDirectAdmin && snap.started));
    pauseBtn.textContent = snap.paused ? '▶ Reanudar' : '⏸ Pausar';
    pauseBtn.classList.toggle('on', Boolean(snap.paused));
  }

  if (drawBtn) {
    if (teamsFull && !isDrawn) {
      drawBtn.classList.remove('hidden');
      drawBtn.disabled = false;
    } else {
      drawBtn.classList.add('hidden');
    }
  }

  const teamRosters = snap.teamRosters || {};

  if (!snap.teams.length) {
    teamsEl.innerHTML = '<p class="muted">Inscripción abierta — esperando equipos...</p>';
  } else {
    teamsEl.innerHTML = snap.teams
      .map((t, idx) => {
        const roster = teamRosters[t.name] || (t.players || []).map((p) => ({ name: p, inLobby: false }));
        const cStyle = getTeamColorStyle(t.name, snap.teams);
        return `<div class="torneo-team-card" style="border-left-color:var(--team-color,var(--hex));${cStyle}">
          <div class="torneo-team-title">
            <span><span class="muted">#${idx + 1}</span> <span class="team-name-glow" style="${cStyle}">${esc(t.name)}</span> <span class="mono muted" style="font-size:11px;">(${t.players.length}/5)</span></span>
            ${t.canDrop ? `<button class="ghost torneo-drop-btn" onclick="dropTorneoTeam('${esc(t.name)}')">Dar de baja</button>` : ''}
          </div>
          <div class="player-roster-chips">${renderRosterChipsHtml(roster)}</div>
        </div>`;
      })
      .join('');
  }

  // Pre-draw Sorteo card vs Live Bracket
  if (!isDrawn) {
    bracketBox.classList.add('hidden');
    if (drawCard) {
      drawCard.classList.remove('hidden');
      if (teamsFull) {
        drawCardTitle.textContent = `¡Equipos completos (${snap.teams.length}/${snap.size})!`;
        drawCardSub.textContent = 'Todos los equipos están verificados y listos. Dale a Sorteo para generar los cruces.';
        drawCardBtn.disabled = false;
        drawCardBtn.textContent = '🎲 Sorteo';
      } else {
        drawCardTitle.textContent = `Esperando equipos para el Sorteo (${snap.teams.length}/${snap.size})`;
        drawCardSub.textContent = `Faltan ${snap.size - snap.teams.length} equipo(s) por inscribirse (o el Admin puede escribir !TORNEO ${snap.teams.length >= 2 ? snap.teams.length : 4} en Discord para ajustar los cupos).`;
        drawCardBtn.disabled = true;
        drawCardBtn.textContent = `🎲 Sorteo (${snap.teams.length}/${snap.size})`;
      }
    }
    return;
  }

  drawCard?.classList.add('hidden');

  // Render Winners, Losers & Grand Final
  const b = snap.bracket;
  if (!b) {
    bracketBox.classList.add('hidden');
    return;
  }
  bracketBox.classList.remove('hidden');
  const canEditBracket = !discordAdminLocked;

  const wCard = document.getElementById('winnersBracketCard');
  const lCard = document.getElementById('losersBracketCard');
  if (wCard) wCard.classList.toggle('hidden', !(b.winnersRounds && b.winnersRounds.length));
  if (lCard) lCard.classList.toggle('hidden', !(b.losersRounds && b.losersRounds.length));

  document.getElementById('winnersBracketGrid').innerHTML = (b.winnersRounds || [])
    .map((roundIds, rIdx) => {
      const firstM = b.matches[roundIds[0]];
      return `<div class="bracket-round-col">
        <div class="bracket-round-title">${esc(firstM?.roundLabel || `Ronda ${rIdx + 1}`)}</div>
        ${roundIds.map((id) => renderMatchBoxHtml(b.matches[id], canEditBracket, teamRosters, snap.activeLobbyMatchId, snap.teams, snap)).join('')}
      </div>`;
    })
    .join('');

  document.getElementById('losersBracketGrid').innerHTML = (b.losersRounds || [])
    .map((roundIds, rIdx) => {
      const firstM = b.matches[roundIds[0]];
      return `<div class="bracket-round-col">
        <div class="bracket-round-title">${esc(firstM?.roundLabel || `Losers R${rIdx + 1}`)}</div>
        ${roundIds.map((id) => renderMatchBoxHtml(b.matches[id], canEditBracket, teamRosters, snap.activeLobbyMatchId, snap.teams, snap)).join('')}
      </div>`;
    })
    .join('');

  const gfMatch = b.matches[b.grandFinalId];
  document.getElementById('grandFinalBox').innerHTML = `
    <div class="bracket-round-col">
      <div class="bracket-round-title">${snap.size === 2 ? 'Duelo Final (2 Equipos)' : 'Gran Final'}</div>
      ${renderMatchBoxHtml(gfMatch, canEditBracket, teamRosters, snap.activeLobbyMatchId, snap.teams, snap)}
    </div>
    ${b.champion ? `<div class="torneo-champ-banner">🏆 Campeón del Torneo: <span class="team-name-glow" style="${getTeamColorStyle(b.champion, snap.teams)}">${esc(b.champion)}</span></div>` : ''}
  `;
  renderTorneoMvpTable(snap.mvpLeaderboard || [], snap.teams || []);
  updateTorneoTimers();
}

// ==================== ROAD TO LADDER VIEW ====================
async function refreshRoadToState(showErrors = false, forceRanks = false) {
  try {
    const snap = await apiJson(forceRanks ? '/api/roadto/state?refresh=1' : '/api/roadto/state');
    state.lastRoadToSnap = snap;
    renderRoadToView(snap);
  } catch (err) {
    if (showErrors) {
      const sub = document.getElementById('roadToBannerSub');
      if (sub) sub.innerHTML = `<span class="metric-bad">${esc(err.message)}</span>`;
    }
  }
}

async function jumpRoadToCategory(riotId) {
  try {
    const snap = await apiJson('/api/roadto/jump', {
      method: 'POST',
      body: JSON.stringify({ riotId })
    });
    state.lastRoadToSnap = snap;
    renderRoadToView(snap);
  } catch (err) {
    alert(err.message);
  }
}
window.jumpRoadToCategory = jumpRoadToCategory;

async function dropRoadToPlayer(riotId) {
  if (!confirm(`¿Salir de Road To con la cuenta "${riotId}"?`)) return;
  try {
    const snap = await apiJson('/api/roadto/drop', {
      method: 'POST',
      body: JSON.stringify({ riotId })
    });
    state.lastRoadToSnap = snap;
    renderRoadToView(snap);
  } catch (err) {
    alert(err.message);
  }
}
window.dropRoadToPlayer = dropRoadToPlayer;

function renderRoadToView(snap) {
  state.roadToAnnouncement = snap?.announcement || null;
  syncGlobalAnnouncementBanner();
  const navTab = document.getElementById('roadToNavTab');
  const banner = document.getElementById('roadToBanner');
  const titleEl = document.getElementById('roadToBannerTitle');
  const subEl = document.getElementById('roadToBannerSub');
  const countEl = document.getElementById('roadToPlayerCount');
  const gridEl = document.getElementById('roadToBoardsGrid');
  const dcMsgEl = document.getElementById('roadToDcStatusMsg');

  const totalCount = (snap.participants || []).length;
  const roadToBadge = document.getElementById('roadToNavBadge');
  if (roadToBadge) {
    if (snap.active && totalCount > 0) {
      roadToBadge.textContent = String(totalCount);
      roadToBadge.classList.remove('hidden');
    } else {
      roadToBadge.classList.add('hidden');
    }
  } else if (navTab) {
    navTab.textContent = snap.active ? `Road To (${totalCount})` : 'Road To';
  }
  if (countEl) countEl.textContent = String(totalCount);

  if (dcMsgEl && snap.source === 'discord' && snap.roadToChannelId) {
    dcMsgEl.innerHTML = `<span class="metric-good">Conectado al canal #road-to (${esc(snap.roadToChannelId)})</span>`;
  }

  if (!snap.active) {
    banner.className = 'rbanner torneo-status-banner';
    titleEl.className = 'torneo-status-hero closed';
    titleEl.textContent = 'NO HAY ROAD TO ACTIVO';
    subEl.innerHTML = 'El Admin inicia el evento en tu canal <span class="mono">#road-to</span> escribiendo <span class="mono">!ROADTO ON</span> (y lo cierra con <span class="mono">!ROADTO OFF</span>).';
    if (gridEl) gridEl.innerHTML = '<div class="panel db-card"><p class="muted">Cuando el Admin abra el Road To aparecerán aquí las tablas por categoría.</p></div>';
    return;
  }

  banner.className = 'rbanner ok torneo-status-banner';
  titleEl.className = 'torneo-status-hero open';
  titleEl.textContent = `ROAD TO ABIERTO${snap.title ? ` · ${snap.title}` : ''} (${totalCount} INSCRITOS)`;
  subEl.innerHTML = `Organizado por <strong>NGELX</strong> (${snap.source === 'discord' ? 'Discord #road-to' : 'Modo Local'}) · Meta: llegar lo más alto posible y saltar de categoría al llegar al tope.`;

  const activeFilter = state.roadToFilter || 'all';
  const cats = (snap.categories || []).filter((c) => activeFilter === 'all' || c.id === activeFilter);

  gridEl.innerHTML = cats
    .map((cat) => {
      const players = (snap.leaderboardByCategory && snap.leaderboardByCategory[cat.id]) || [];
      const rowsHtml = players.length
        ? players
            .map(
              (p, idx) => `<div class="rt-player-row ${p.reachedCap ? 'reached' : ''}">
                <div class="rt-player-top">
                  <div class="rt-player-id">
                    <span class="rt-pos">#${idx + 1}</span>
                    ${p.profileIcon ? `<img class="rt-avatar" src="${esc(p.profileIcon)}" alt="" />` : ''}
                    <div>
                      <div class="rt-riot-name">${esc(p.riotId)} <span class="mono muted" style="font-size:11px;">${esc(p.region)}</span></div>
                      ${Array.isArray(p.badges) && p.badges.length ? `<div class="rt-badges-row">${p.badges.map((b) => `<span class="rt-badge-pill tone-${esc(b.tone || 'wr')}">${esc(b.label)}</span>`).join('')}</div>` : ''}
                      <div class="rt-sub-meta">Previas: ${esc(p.previousSummary || 'Sin historial')} · Meta: ${esc(p.targetLabel || cat.targetLabel)}</div>
                    </div>
                  </div>
                  <div class="rt-rank-col">
                    <div class="rt-curr-rank">${esc(p.currentRankLabel)}</div>
                    <div class="rt-sub-meta">${p.wins}V - ${p.losses}D (${p.winRate}%)</div>
                  </div>
                </div>
                <div class="rt-prog-track"><div class="rt-prog-fill" style="width:${Number(p.progressPct || 0)}%;"></div></div>
                <div class="rt-player-footer">
                  <span class="rt-sub-meta">Progreso: <strong>${Number(p.progressPct || 0)}%</strong>${p.reachedCap ? ' · <strong class="metric-good">🏆 Tope alcanzado</strong>' : ''}</span>
                  <div class="torneo-actions">
                    ${p.canJump ? `<button class="ghost rt-jump-btn" onclick="jumpRoadToCategory('${esc(p.riotId)}')">⬆ Saltar a ${esc(p.nextCategoryName)}</button>` : ''}
                    ${p.canDrop ? `<button class="ghost torneo-drop-btn" onclick="dropRoadToPlayer('${esc(p.riotId)}')">Salir</button>` : ''}
                  </div>
                </div>
              </div>`
            )
            .join('')
        : '<p class="muted" style="font-size:12.5px;">Sin jugadores inscritos en esta categoría.</p>';

      return `<div class="panel rt-cat-card" style="--rt-c:${esc(cat.color)};">
        <div class="rt-cat-header">
          <div>
            <div class="rt-cat-title">${esc(cat.name)} (${players.length})</div>
            <div class="rt-cat-meta">Base: ${esc(cat.eligibleLabel)} · Meta: <strong>${esc(cat.targetLabel)}</strong></div>
          </div>
        </div>
        <div class="rt-players-list">${rowsHtml}</div>
      </div>`;
    })
    .join('');
}

bindEvents();
bootstrap();
setInterval(pollLcu, 1500);
setInterval(refreshOverlayStatus, 3000);
setInterval(updateTorneoTimers, 1000);
setInterval(() => {
  if (state.currentView === 'torneo' || state.config?.discord?.enabled) {
    refreshTournamentState(false);
  }
  if (state.currentView === 'roadto' || state.config?.discord?.enabled) {
    refreshRoadToState(false);
  }
}, 5000);
