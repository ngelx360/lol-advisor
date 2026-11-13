const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DATA_DIR = path.join(__dirname, '..', 'data');

function isDirWritable(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    const probe = path.join(dirPath, `.write_probe_${process.pid}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function copyIfMissing(srcFile, destFile) {
  try {
    if (!fs.existsSync(srcFile) || fs.existsSync(destFile)) return;
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    fs.copyFileSync(srcFile, destFile);
  } catch {
    // Non-fatal seed copy error
  }
}

function seedReadOnlyDataIfNeeded(targetDataRoot) {
  if (targetDataRoot === APP_DATA_DIR || !fs.existsSync(APP_DATA_DIR)) return;
  try {
    copyIfMissing(path.join(APP_DATA_DIR, 'config.json'), path.join(targetDataRoot, 'config.json'));
    copyIfMissing(path.join(APP_DATA_DIR, 'ddragon', 'assets.json'), path.join(targetDataRoot, 'ddragon', 'assets.json'));
    const bundledSeasonsDir = path.join(APP_DATA_DIR, 'seasons');
    if (fs.existsSync(bundledSeasonsDir)) {
      for (const file of fs.readdirSync(bundledSeasonsDir)) {
        if (file.endsWith('.json')) {
          copyIfMissing(path.join(bundledSeasonsDir, file), path.join(targetDataRoot, 'seasons', file));
        }
      }
    }
  } catch {
    // Non-fatal
  }
}

function resolveWritableDataRoot() {
  if (isDirWritable(APP_DATA_DIR)) {
    return APP_DATA_DIR;
  }
  const fallbackBase = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const userDataDir = path.join(fallbackBase, 'LoL Ranked Advisor', 'data');
  fs.mkdirSync(userDataDir, { recursive: true });
  seedReadOnlyDataIfNeeded(userDataDir);
  return userDataDir;
}

const DATA_ROOT = resolveWritableDataRoot();
const SEASONS_DIR = path.join(DATA_ROOT, 'seasons');
const CACHE_DIR = path.join(DATA_ROOT, 'cache');
const ICON_CACHE_DIR = path.join(CACHE_DIR, 'icons');
const MATCH_CACHE_DIR = path.join(CACHE_DIR, 'matches');
const DDRAGON_DIR = path.join(DATA_ROOT, 'ddragon');
const CONFIG_FILE = path.join(DATA_ROOT, 'config.json');
const TOURNAMENT_FILE = path.join(DATA_ROOT, 'tournament.json');
const ROADTO_FILE = path.join(DATA_ROOT, 'roadto.json');

module.exports = {
  APP_DATA_DIR,
  DATA_ROOT,
  SEASONS_DIR,
  CACHE_DIR,
  ICON_CACHE_DIR,
  MATCH_CACHE_DIR,
  DDRAGON_DIR,
  CONFIG_FILE,
  TOURNAMENT_FILE,
  ROADTO_FILE
};
