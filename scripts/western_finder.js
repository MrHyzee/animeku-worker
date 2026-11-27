#!/usr/bin/env node

/**
 * ==============================================================================
 * ANIMEKU WESTERN ANIMATION SCENE FINDER (PSARIPS / NTb / FLUX / EZTV / APIBAY)
 * ==============================================================================
 * Pencari Sumber Otomatis untuk Kategori Animasi Barat ('western'):
 * - Sumber: Apibay Scene Indexer & EZTV API (dengan Cloudflare DoH 1.1.1.1 Bypass)
 * - Prioritas Grup: PSA (PSArips x265 10bit Sub Indo), NTb, FLUX, Archie, MeGusta, MiNX
 * - Mendukung format Single Episode (S01E01 / S02E01) maupun Season Complete Batch
 * ==============================================================================
 */

const https = require('https');
const { detectResolutionLadder } = require('./nyaa_finder');

const WESTERN_ALIAS_REGISTRY = {
  'arcane': { title: 'Arcane', imdb_id: '11126994', default_season: 1 },
  'arcane-season-2': { title: 'Arcane', imdb_id: '11126994', default_season: 2 },
  'invincible': { title: 'Invincible', imdb_id: '6741278', default_season: 1 },
  'x-men-97': { title: 'X-Men 97', imdb_id: '16026746', default_season: 1 },
  'rick-and-morty': { title: 'Rick and Morty', imdb_id: '2861424', default_season: 1 },
  'avatar-the-last-airbender': { title: 'Avatar The Last Airbender', imdb_id: '0417299', default_season: 1 },
  'the-legend-of-vox-machina': { title: 'The Legend of Vox Machina', imdb_id: '11247158', default_season: 1 },
  'castlevania-nocturne': { title: 'Castlevania Nocturne', imdb_id: '14833612', default_season: 1 },
  'blue-eye-samurai': { title: 'Blue Eye Samurai', imdb_id: '13309742', default_season: 1 },
  'cyberpunk-edgerunners': { title: 'Cyberpunk Edgerunners', imdb_id: '12590266', default_season: 1 },
  'what-if': { title: 'What If', imdb_id: '10168312', default_season: 1 },
};

const WESTERN_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
];

function buildWesternMagnet(infoHash, title) {
  if (!infoHash) return null;
  const tr = WESTERN_TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${infoHash.trim()}&dn=${encodeURIComponent(title || 'western')}${tr}`;
}

async function resolveHostViaDoH(hostname) {
  try {
    const res = await fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
      headers: { accept: 'application/dns-json' },
    });
    if (res.ok) {
      const data = await res.json();
      const ans = (data.Answer || []).find(a => a.type === 1 && a.data);
      if (ans) return ans.data;
    }
  } catch {
    // Ignore
  }
  return null;
}

async function fetchJsonWithDoH(urlStr) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(urlStr, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) return await res.json();
  } catch {
    // Fallback DoH lookup
  }

  const parsedUrl = new URL(urlStr);
  const ip = await resolveHostViaDoH(parsedUrl.hostname);
  if (!ip) throw new Error(`Gagal resolve DoH untuk ${parsedUrl.hostname}`);

  return new Promise((resolve, reject) => {
    const req = https.get(
      urlStr,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Host': parsedUrl.hostname,
        },
        servername: parsedUrl.hostname,
        timeout: 8000,
        lookup: (host, opts, cb) => {
          if (opts && opts.all) return cb(null, [{ address: ip, family: 4 }]);
          return cb(null, ip, 4);
        },
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { body += c; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b <= 0) return '0 MiB';
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MiB`;
}

function scoreWesternCandidate(rawItem, { season = 1, epNumber = null, mode = 'any' }) {
  const title = String(rawItem.title || rawItem.name || '').trim();
  const seeders = parseInt(rawItem.seeders || rawItem.seeds || '0', 10);
  const leechers = parseInt(rawItem.leechers || rawItem.peers || '0', 10);
  const infoHash = rawItem.info_hash || rawItem.hash;

  if (!title || seeders <= 0 || !infoHash || /^0+$/.test(infoHash)) return null;

  // Blacklist CAM / TS / Dub Rusia
  if (/\b(cam|hdcam|ts|telesync|rus|russian|french|spanish|german)\b/i.test(title) && !/\bmulti\b/i.test(title)) {
    return null;
  }

  const sPad = String(season).padStart(2, '0');
  const ePad = epNumber ? String(epNumber).padStart(2, '0') : null;

  const isBatch =
    new RegExp(`\\bS${sPad}\\b(?![._\\s-]*E\\d)`, 'i').test(title) ||
    /\b(complete|season\s*\d+|batch|full\s*season)\b/i.test(title);

  let matchedEp = null;
  const epMatch = title.match(/\bS0*(\d{1,2})[._\s-]*E0*(\d{1,3})\b/i) || title.match(/\b(\d{1,2})x0*(\d{1,3})\b/i);
  if (epMatch) {
    const sNum = parseInt(epMatch[1], 10);
    const eNum = parseInt(epMatch[2], 10);
    if (sNum !== season) return null;
    matchedEp = eNum;
  }

  if (epNumber !== null && epNumber !== undefined && !Number.isNaN(epNumber)) {
    if (!isBatch && matchedEp !== epNumber) return null;
  }

  if (mode === 'single' && isBatch) return null;
  if (mode === 'batch' && !isBatch) return null;

  let score = 0;
  const scoreBreakdown = [];

  // 1. Deteksi Grup Scene & Kualitas Encode (Prioritas PSArips x265 / NTb / FLUX / Multi-Sub Netflix/Disney+)
  let releaseGroup = 'Scene';
  let hasSubIndo = false;
  let subStrategy = 'smart_translate';

  if (/\b(PSA|PSArips)\b/i.test(title)) {
    releaseGroup = 'PSA';
    hasSubIndo = true;
    subStrategy = 'extract_indo';
    score += 55;
    scoreBreakdown.push('PSArips x265 10bit (Hemat Size + Multi-Sub Resmi) (+55)');
  } else if (/\b(NTb|FLUX|Archie|CasStudio|TEPES|successfulcrab)\b/i.test(title)) {
    const m = title.match(/\b(NTb|FLUX|Archie|CasStudio|TEPES|successfulcrab)\b/i);
    releaseGroup = m ? m[1] : 'WEB-DL';
    hasSubIndo = true;
    subStrategy = 'extract_indo';
    score += 50;
    scoreBreakdown.push(`Scene Official WEB-DL [${releaseGroup}] (Multi-Sub Indo) (+50)`);
  } else if (/\b(MeGusta|MiNX|FENiX|ELiTE|RARBG|GalaxyTV|BONE)\b/i.test(title)) {
    const m = title.match(/\b(MeGusta|MiNX|FENiX|ELiTE|RARBG|GalaxyTV|BONE)\b/i);
    releaseGroup = m ? m[1] : 'Scene-x265';
    score += 35;
    scoreBreakdown.push(`Scene Encode [${releaseGroup}] (+35)`);
  } else {
    score += 20;
    scoreBreakdown.push('Standard Western Rip (+20)');
  }

  if (/\b(x265|hevc|10bit)\b/i.test(title)) {
    score += 12;
    scoreBreakdown.push('HEVC x265 Hemat Storage (+12)');
  }

  // 2. Skor Resolusi
  const resLadder = detectResolutionLadder(title);
  score += resLadder.scoreBonus;
  scoreBreakdown.push(`Resolusi ${resLadder.sourceResolution} (+${resLadder.scoreBonus})`);

  // 3. Skor Tipe (Single vs Batch)
  if (mode === 'batch') {
    if (isBatch) {
      score += 40;
      scoreBreakdown.push('Paket Batch Season (+40)');
    }
  } else {
    if (!isBatch) {
      score += 25;
      scoreBreakdown.push(`Single Episode S${sPad}E${ePad || '01'} (+25)`);
    } else {
      score += 8;
      scoreBreakdown.push('Season Pack Fallback via --select-file (+8)');
    }
  }

  // 4. Skor Seeders
  if (seeders >= 25) {
    score += 15;
    scoreBreakdown.push(`Seeder Tinggi (${seeders}) (+15)`);
  } else if (seeders >= 5) {
    score += 10;
    scoreBreakdown.push(`Seeder Aktif (${seeders}) (+10)`);
  } else {
    score += 4;
    scoreBreakdown.push(`Seeder (${seeders}) (+4)`);
  }

  return {
    title,
    release_group: releaseGroup,
    type: isBatch ? 'batch' : 'single',
    season,
    episode_number: isBatch ? epNumber : matchedEp,
    has_sub_indo: hasSubIndo,
    sub_strategy: subStrategy,
    resolution: resLadder.sourceResolution,
    output_resolutions: resLadder.outputLadder,
    size: typeof rawItem.size === 'string' && rawItem.size.includes('iB') ? rawItem.size : formatBytes(rawItem.size || rawItem.size_bytes),
    seeders,
    leechers,
    info_hash: infoHash.toLowerCase(),
    magnet: rawItem.magnet_url || buildWesternMagnet(infoHash, title),
    score,
    score_breakdown: scoreBreakdown,
  };
}

async function searchWesternScene({
  queryOrSlug,
  animeRow = null,
  season = 1,
  epNumber = null,
  mode = 'any',
}) {
  const slugKey = String(queryOrSlug || '').toLowerCase().trim();
  const regInfo = WESTERN_ALIAS_REGISTRY[slugKey] || (animeRow && WESTERN_ALIAS_REGISTRY[animeRow.slug]);

  const baseTitle = regInfo?.title || animeRow?.title || queryOrSlug.replace(/-/g, ' ');
  const activeSeason = season || regInfo?.default_season || 1;
  const sPad = String(activeSeason).padStart(2, '0');
  const ePad = epNumber ? String(epNumber).padStart(2, '0') : null;

  const queries = [];
  if (ePad && mode !== 'batch') {
    queries.push(`${baseTitle} S${sPad}E${ePad}`);
  }
  queries.push(`${baseTitle} S${sPad}`);
  queries.push(baseTitle);

  const candidatesMap = new Map();

  // 1. Cari di EZTV API terlebih dahulu jika memiliki IMDb ID (Sangat cepat & akurat)
  if (regInfo?.imdb_id) {
    try {
      const eztvUrl = `https://eztvx.to/api/get-torrents?imdb_id=${regInfo.imdb_id}&limit=60`;
      const data = await fetchJsonWithDoH(eztvUrl);
      if (Array.isArray(data?.torrents)) {
        for (const t of data.torrents) {
          const scored = scoreWesternCandidate(t, { season: activeSeason, epNumber, mode });
          if (scored && !candidatesMap.has(scored.info_hash)) {
            candidatesMap.set(scored.info_hash, scored);
          }
        }
      }
    } catch {
      // Lanjut ke Apibay jika EZTV timeout
    }
  }

  // 2. Cari di Apibay Scene Indexer (Mendukung PSA, NTb, FLUX, MeGusta, GalaxyTV)
  if (candidatesMap.size < 3) {
    for (const q of queries.slice(0, 2)) {
      try {
        const apiUrl = `https://apibay.org/q.php?q=${encodeURIComponent(q)}`;
        const items = await fetchJsonWithDoH(apiUrl);
        if (Array.isArray(items)) {
          for (const item of items) {
            if (item.name === 'No results returned') continue;
            const scored = scoreWesternCandidate(item, { season: activeSeason, epNumber, mode });
            if (scored && !candidatesMap.has(scored.info_hash)) {
              candidatesMap.set(scored.info_hash, scored);
            }
          }
        }
        if (candidatesMap.size > 0) break;
      } catch {
        // Lanjut ke query berikutnya
      }
    }
  }

  const sorted = Array.from(candidatesMap.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.seeders - a.seeders;
  });

  return {
    query: queryOrSlug,
    anime_title: baseTitle,
    category: 'western',
    season: activeSeason,
    target_episode: epNumber,
    mode,
    aliases_tried: queries,
    matched_alias: sorted.length > 0 ? queries[0] : null,
    total_found: sorted.length,
    recommended: sorted[0] || null,
    single_candidates: sorted.filter(c => c.type === 'single').slice(0, 10),
    batch_candidates: sorted.filter(c => c.type === 'batch').slice(0, 6),
  };
}

module.exports = {
  searchWesternScene,
  scoreWesternCandidate,
  WESTERN_ALIAS_REGISTRY,
};
