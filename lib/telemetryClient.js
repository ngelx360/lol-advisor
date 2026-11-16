// lib/telemetryClient.js - Anonymous heartbeat telemetry client for LoL Advisor
const os = require('os');
const crypto = require('crypto');
const syncEngine = require('./syncEngine');

const DEFAULT_BRIDGE_URL = 'https://lol-advisor.ngelx360.workers.dev';
const PING_INTERVAL_MS = 60 * 1000; // 60 seconds heartbeat
const INITIAL_DELAY_MS = 3500; // 3.5s after boot

let activeTimer = null;
let startTime = Date.now();
let cachedStatus = {
  onlineNow: 1,
  todayDau: 1,
  lastPingAt: 0,
  clientId: '',
  lastStatus: 'idle',
  lastError: null
};

function getMachineFingerprint() {
  try {
    const raw = `${os.hostname()}:${os.userInfo().username}`;
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 10);
  } catch {
    return 'host';
  }
}

/**
 * Gets or creates a persistent, anonymous installation UUID unique to each physical machine.
 */
function getOrCreateClientId() {
  try {
    const config = syncEngine.loadConfig();
    const baseId = (config.anonymousClientId && typeof config.anonymousClientId === 'string')
      ? config.anonymousClientId
      : (crypto.randomUUID ? crypto.randomUUID() : `usr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
    if (!config.anonymousClientId) {
      syncEngine.saveConfig({ anonymousClientId: baseId });
    }
    const fp = getMachineFingerprint();
    if (!baseId.endsWith(`_${fp}`)) {
      return `${baseId}_${fp}`;
    }
    return baseId;
  } catch {
    return `anon_${Date.now()}`;
  }
}

/**
 * Sends an anonymous heartbeat ping to the Cloudflare Worker.
 */
async function sendPing({ appBuild = '2.2.2', bridgeUrl = '', region = '' } = {}) {
  const config = syncEngine.loadConfig();
  const url = String(bridgeUrl || config.discord?.bridgeUrl || DEFAULT_BRIDGE_URL).trim().replace(/\/+$/, '');
  const reg = String(region || config.riotAccount?.region || config.region || 'LAN').toUpperCase();
  const cid = getOrCreateClientId();
  const sessionMinutes = Math.max(0, Math.round((Date.now() - startTime) / 60000));

  const payload = {
    clientId: cid,
    version: String(appBuild || '2.2.2'),
    region: reg,
    sessionMinutes
  };

  try {
    const res = await fetch(`${url}/api/telemetry/ping`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `LoLAdvisor-Client/${payload.version}`
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(6000)
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    cachedStatus = {
      onlineNow: Number(data.onlineNow) || 1,
      todayDau: Number(data.todayDau) || 1,
      lastPingAt: Date.now(),
      clientId: cid,
      lastStatus: 'ok',
      lastError: null
    };
    return cachedStatus;
  } catch (err) {
    cachedStatus = {
      ...cachedStatus,
      lastPingAt: Date.now(),
      clientId: cid,
      lastStatus: 'error',
      lastError: err?.message || 'Error de conexión'
    };
    return cachedStatus;
  }
}

/**
 * Starts the background heartbeat timer.
 */
function startTelemetry({ appBuild = '2.2.2' } = {}) {
  if (activeTimer) return;
  startTime = Date.now();

  // Initial delay
  setTimeout(() => {
    sendPing({ appBuild }).catch(() => {});
  }, INITIAL_DELAY_MS);

  activeTimer = setInterval(() => {
    sendPing({ appBuild }).catch(() => {});
  }, PING_INTERVAL_MS);

  if (activeTimer.unref) {
    activeTimer.unref();
  }
}

/**
 * Stops background telemetry timer.
 */
function stopTelemetry() {
  if (activeTimer) {
    clearInterval(activeTimer);
    activeTimer = null;
  }
}

/**
 * Returns the latest known telemetry status.
 */
function getTelemetryStatus() {
  return {
    ...cachedStatus,
    clientId: cachedStatus.clientId || getOrCreateClientId()
  };
}

module.exports = {
  getOrCreateClientId,
  sendPing,
  startTelemetry,
  stopTelemetry,
  getTelemetryStatus
};
