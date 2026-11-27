#!/usr/bin/env node

/**
 * ==============================================================================
 * ANIMEKU NYAA.SI 4-LAYER SMART FINDER & SCORING ENGINE (WITH DoH 1.1.1.1 BYPASS)
 * ==============================================================================
 * 1. Multi-Alias Title Resolver (English, Romaji, Native, Synonym Registry)
 * 2. Cloudflare DoH (1.1.1.1) Direct TLS Fetcher (Tembus blokir DNS ISP Indonesia tanpa VPN)
 * 3. Regex Episode & Batch Filter (Single vs Batch Range, Anti-Junk NCOP/PV)
 * 4. Smart Scoring Engine (Prioritas Multi-Sub Indo +50 -> Clean Eng Sub +30, 4K/1080p/720p, Seeders)
 * ==============================================================================
 */

const https = require('https');

const NYAA_ALIAS_REGISTRY = {
  'solo-leveling': ['Solo Leveling', 'Ore dake Level Up na Ken'],
  'frieren': ['Sousou no Frieren', 'Frieren'],
  'frieren-beyond-journeys-end': ['Sousou no Frieren', 'Frieren'],
  'jujutsu-kaisen': ['Jujutsu Kaisen'],
  'demon-slayer': ['Kimetsu no Yaiba', 'Demon Slayer'],
  'kimetsu-no-yaiba': ['Kimetsu no Yaiba', 'Demon Slayer'],
  'one-piece': ['One Piece'],
  'kaiju-no-8': ['Kaijuu 8-gou', 'Kaiju No 8'],
  'dandadan': ['Dandadan', 'Dan Da Dan'],
  'bleach-tybw': ['Bleach Sennen Kessen-hen', 'Bleach Thousand-Year Blood War'],
  'chainsaw-man': ['Chainsaw Man'],
  'attack-on-titan': ['Shingeki no Kyojin', 'Attack on Titan'],
  'blue-lock': ['Blue Lock'],
  'wind-breaker': ['Wind Breaker'],
  'mashle': ['Mashle'],
  'apothecary-diaries': ['Kusuriya no Hitorigoto', 'The Apothecary Diaries'],
  'renegade-immortal': ['Xian Ni', 'Renegade Immortal', '仙逆'],
  'battle-through-the-heavens': ['Doupo Cangqiong', 'Battle Through the Heavens', '斗破苍穹', 'BTTH'],
  'btth': ['Doupo Cangqiong', 'Battle Through the Heavens', '斗破苍穹'],
  'soul-land': ['Douluo Dalu', 'Soul Land', '斗罗大陆'],
  'perfect-world': ['Wanmei Shijie', 'Perfect World', '完美世界'],
  'swallowed-star': ['Tunshi Xingkong', 'Swallowed Star', '吞噬星空'],
  'shrouding-the-heavens': ['Zhetian', 'Shrouding the Heavens', '遮天'],
  'a-will-eternal': ['Yi Nian Yong Heng', 'A Will Eternal', '一念永恒'],
};

const NYAA_TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
];

let cachedNyaaIp = null;

async function resolveNyaaIpViaDoH() {
  if (cachedNyaaIp) return cachedNyaaIp;
  try {
    const res = await fetch('https://1.1.1.1/dns-query?name=nyaa.si&type=A', {
      headers: { accept: 'application/dns-json' },
    });
    if (res.ok) {
      const data = await res.json();
      const ans = (data.Answer || []).find(a => a.type === 1 && a.data);
      if (ans) {
        cachedNyaaIp = ans.data;
        return cachedNyaaIp;
      }
    }
  } catch {
    // Fallback hardcoded Nyaa IP jika DoH gagal
  }
  cachedNyaaIp = '186.2.163.20';
  return cachedNyaaIp;
}

/**
 * Mengambil XML RSS Nyaa.si menggunakan DoH 1.1.1.1 agar bebas blokir DNS ISP lokal maupun berjalan di Vast.ai
 */
async function fetchNyaaRssWithDoH(rssUrl) {
  // Coba direct fetch terlebih dahulu (cepat di Vast.ai / GitHub Actions)
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const directRes = await fetch(rssUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (directRes.ok) {
      const txt = await directRes.text();
      if (txt.includes('<rss') || txt.includes('<item>')) return txt;
    }
  } catch {
    // Jika terblokir DNS ISP lokal, lanjut gunakan DoH custom lookup
  }

  const nyaaIp = await resolveNyaaIpViaDoH();
  return new Promise((resolve, reject) => {
    const req = https.get(
      rssUrl,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml',
          'Host': 'nyaa.si',
        },
        servername: 'nyaa.si',
        timeout: 8000,
        lookup: (hostname, opts, cb) => {
          if (opts && opts.all) {
            return cb(null, [{ address: nyaaIp, family: 4 }]);
          }
          return cb(null, nyaaIp, 4);
        },
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Nyaa HTTP ${res.statusCode}`));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve(body));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Nyaa DoH request timeout'));
    });
  });
}

function buildMagnetFromHash(infoHash, title) {
  if (!infoHash) return null;
  const trParams = NYAA_TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${infoHash.trim()}&dn=${encodeURIComponent(title || 'animeku')}${trParams}`;
}

function cleanAliasTitle(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[:!?'",.~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeXmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function detectResolutionLadder(rawText) {
  const text = String(rawText || '').toLowerCase();
  if (text.includes('2160p') || text.includes('4k') || text.includes('3840x2160')) {
    return {
      sourceResolution: '2160p',
      outputLadder: ['2160p', '1080p', '720p', '480p'],
      scoreBonus: 35,
    };
  }
  if (text.includes('1080p') || text.includes('1920x1080') || text.includes('fhd')) {
    return {
      sourceResolution: '1080p',
      outputLadder: ['1080p', '720p', '480p'],
      scoreBonus: 30,
    };
  }
  if (text.includes('720p') || text.includes('1280x720')) {
    return {
      sourceResolution: '720p',
      outputLadder: ['720p', '480p'],
      scoreBonus: 15,
    };
  }
  if (text.includes('480p') || text.includes('540p')) {
    return {
      sourceResolution: '480p',
      outputLadder: ['480p'],
      scoreBonus: 5,
    };
  }
  return {
    sourceResolution: '1080p',
    outputLadder: ['1080p', '720p', '480p'],
    scoreBonus: 20,
  };
}

function parseNyaaRssXml(xmlText) {
  if (!xmlText || typeof xmlText !== 'string') return [];
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xmlText)) !== null) {
    const block = match[1];
    const extractTag = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m ? decodeXmlEntities(m[1]) : '';
    };

    const title = extractTag('title');
    const torrentLink = extractTag('link');
    const guid = extractTag('guid');
    const pubDate = extractTag('pubDate');
    const seeders = parseInt(extractTag('nyaa:seeders') || '0', 10);
    const leechers = parseInt(extractTag('nyaa:leechers') || '0', 10);
    const downloads = parseInt(extractTag('nyaa:downloads') || '0', 10);
    const infoHash = extractTag('nyaa:infoHash');
    const categoryId = extractTag('nyaa:categoryId');
    const categoryLabel = extractTag('nyaa:category');
    const size = extractTag('nyaa:size');

    if (!title) continue;

    items.push({
      title,
      torrent_url: torrentLink,
      page_url: guid,
      pub_date: pubDate,
      seeders: Number.isNaN(seeders) ? 0 : seeders,
      leechers: Number.isNaN(leechers) ? 0 : leechers,
      downloads: Number.isNaN(downloads) ? 0 : downloads,
      info_hash: infoHash || null,
      magnet: buildMagnetFromHash(infoHash, title) || torrentLink,
      category_id: categoryId,
      category_label: categoryLabel,
      size,
    });
  }

  return items;
}

function parseNyaaTitleMetadata(title) {
  const raw = String(title || '');

  // 1. Deteksi Grup Rilis
  const groupMatch = raw.match(/^\[([^\]]+)\]/);
  const releaseGroup = groupMatch ? groupMatch[1].trim() : 'Unknown';

  // 2. Deteksi Batch & Rentang Episode terlebih dahulu
  let isBatch = /\[batch\]|\(batch\)|\bbatch\b|\bcomplete\b|\bfull\s*season\b|\bseason\s*0*\d+\b/i.test(raw) &&
    !/(?:-|\s)0*\d{1,3}\s*\[(?:1080p|720p)/i.test(raw);
  let batchRange = null;

  const rangeMatch = raw.match(/(?:-|\b|\s|_)0*(\d{1,3})\s*(?:~|-|to)\s*0*(\d{1,3})(?=\s*[\[\(_]|\s|End|$)/i);
  if (rangeMatch) {
    const startEp = parseInt(rangeMatch[1], 10);
    const endEp = parseInt(rangeMatch[2], 10);
    if (endEp > startEp && endEp - startEp <= 200 && startEp < 1900) {
      isBatch = true;
      batchRange = { start: startEp, end: endEp };
    }
  }

  if (isBatch && !batchRange && /\bseason\s*0*1\b/i.test(raw)) {
    batchRange = { start: 1, end: 26 };
  }

  // 3. Blacklist Non-Episode (Jika BUKAN paket Batch, tolak NCOP/NCED/PV/OST)
  const isStandaloneJunk = !isBatch && /\b(ncop|nced|creditless|pv|preview|cm|menu|ost|soundtrack|live\s*action)\b/i.test(raw);
  const isForeignOnlyDub = /\b(rus|russian|ita|italian|spa|spanish|esp|fra|french|ger|german)\b/i.test(raw) &&
    !/\b(multi|dual|tri)\b/i.test(raw);

  // 4. Deteksi Nomor Episode Single
  let episodeNumber = null;
  let isRecapHalf = false;
  if (!isBatch) {
    if (/-\s*\d+\.5\b/i.test(raw)) {
      isRecapHalf = true;
    }
    const epPatterns = [
      /-\s*0*(\d{1,4})(?:v\d)?\s*(?:\[|\(|「|-|$)/i,
      /\bS\d{1,2}\s*-\s*0*(\d{1,4})\b/i,
      /\bS\d{1,2}E0*(\d{1,4})\b/i,
      /\bEp(?:isode)?\.?\s*0*(\d{1,4})(?:v\d)?\b/i,
      /[_\s]0*(\d{1,3})(?:v\d)?[_\s]+\[(?:1080p|720p|2160p|4K|1920x1080)/i,
    ];
    for (const pat of epPatterns) {
      const m = raw.match(pat);
      if (m) {
        const parsed = parseInt(m[1], 10);
        if (parsed > 0 && parsed < 1900) {
          episodeNumber = parsed;
          break;
        }
      }
    }
  }

  // 5. Deteksi Status Subtitle (Prioritas Sub Indo / Multi-Sub)
  const hasMultiSubOrIndo =
    /multiple\s*subtitles?|multi[\s_-]*subs?|sub[\s_-]*indo|indonesian|subs?\s*malay/i.test(raw) ||
    /^(erai-raws|toonshub|anime time|varyg|b-global|muse)$/i.test(releaseGroup);

  const hasCleanEngSub =
    /^(subsplease|gm-team|bonobosubs|judas|ember|asw|horriblesubs|dkb|akihitosubs|trix|minidual|raze|yameii)$/i.test(releaseGroup) ||
    /eng(?:lish)?[\s_-]*subs?|esub|softsub|cr\s*web-dl/i.test(raw);

  const isRaw = (/\[raw\]|\braws\b/i.test(raw) || /koi-raws/i.test(releaseGroup)) && !hasMultiSubOrIndo && !hasCleanEngSub;
  const isV2 = /\d+v[234]\b|\bv[234]\b/i.test(raw);
  const resLadder = detectResolutionLadder(raw);

  return {
    releaseGroup,
    isJunk: isStandaloneJunk || isForeignOnlyDub || isRecapHalf,
    isBatch,
    batchRange,
    episodeNumber,
    hasMultiSubOrIndo,
    hasCleanEngSub,
    isRaw,
    isV2,
    resolution: resLadder.sourceResolution,
    outputResolutions: resLadder.outputLadder,
    resolutionScore: resLadder.scoreBonus,
  };
}

function scoreNyaaItem(item, { epNumber, mode = 'any' }) {
  const meta = parseNyaaTitleMetadata(item.title);
  if (meta.isJunk) return null;
  if (item.seeders <= 0) return null;
  if (meta.isRaw || item.category_id === '1_4') return null;

  if (epNumber !== null && epNumber !== undefined && !Number.isNaN(epNumber)) {
    if (!meta.isBatch) {
      if (meta.episodeNumber !== epNumber) return null;
    } else if (meta.batchRange) {
      if (epNumber < meta.batchRange.start || epNumber > meta.batchRange.end) return null;
    }
  }

  if (mode === 'single' && meta.isBatch) return null;
  if (mode === 'batch' && !meta.isBatch) return null;

  let score = 0;
  const scoreBreakdown = [];

  // 1. Skor Subtitle (Prioritas Utama: Multi-Sub Indo > Clean Eng Sub)
  let subStrategy = 'smart_translate';
  if (meta.hasMultiSubOrIndo) {
    score += 50;
    subStrategy = 'extract_indo';
    scoreBreakdown.push('Multi-Sub / Sub Indo (+50)');
  } else if (meta.hasCleanEngSub) {
    score += 30;
    subStrategy = 'smart_translate';
    scoreBreakdown.push('English Sub Bersih -> Smart Translate (+30)');
  } else {
    score += 20;
    subStrategy = 'smart_translate';
    scoreBreakdown.push('Subtitle Inggris Standar (+20)');
  }

  // 2. Skor Resolusi (4K > 1080p > 720p)
  score += meta.resolutionScore;
  scoreBreakdown.push(`Resolusi ${meta.resolution} (+${meta.resolutionScore})`);

  // 3. Skor Tipe (Single vs Batch)
  if (mode === 'batch') {
    if (meta.isBatch) {
      score += 40;
      scoreBreakdown.push('Paket Batch Season (+40)');
    }
  } else {
    if (!meta.isBatch) {
      score += 45;
      scoreBreakdown.push('Prioritas Utama Single Episode (+45)');
    } else {
      score -= 15;
      scoreBreakdown.push('Penalti Batch pada Single Episode Ingest (-15)');
    }
  }

  // 4. Skor Kesehatan Torrent (Seeders & Revisi v2)
  if (meta.isV2) {
    score += 10;
    scoreBreakdown.push('Revisi v2 (+10)');
  }

  // Bobot Seeder Ditingkatkan untuk Menghindari Dead / Low-Peer Torrent di Cloud
  if (item.seeders >= 50) {
    score += 45;
    scoreBreakdown.push(`Seeder Sangat Tinggi (${item.seeders}) (+45)`);
  } else if (item.seeders >= 20) {
    score += 30;
    scoreBreakdown.push(`Seeder Tinggi (${item.seeders}) (+30)`);
  } else if (item.seeders >= 8) {
    score += 15;
    scoreBreakdown.push(`Seeder Cukup (${item.seeders}) (+15)`);
  } else if (item.seeders >= 3) {
    score += 2;
    scoreBreakdown.push(`Seeder Rendah (${item.seeders}) (+2)`);
  } else {
    // Penalti torrent hampir mati (1-2 seeders) agar tidak dipilih otomatis
    score -= 25;
    scoreBreakdown.push(`Penalti Seeder Kritis (${item.seeders}) (-25)`);
  }

  return {
    ...item,
    release_group: meta.releaseGroup,
    type: meta.isBatch ? 'batch' : 'single',
    episode_number: meta.isBatch ? epNumber : meta.episodeNumber,
    batch_range: meta.batchRange,
    has_sub_indo: meta.hasMultiSubOrIndo,
    sub_strategy: subStrategy,
    resolution: meta.resolution,
    output_resolutions: meta.outputResolutions,
    score,
    score_breakdown: scoreBreakdown,
  };
}

async function searchNyaaLocalOrCloud({
  queryOrSlug,
  animeRow = null,
  epNumber = null,
  mode = 'any',
}) {
  const aliases = [];
  const slugKey = String(queryOrSlug || '').toLowerCase().trim();

  if (animeRow) {
    if (animeRow.title) aliases.push(cleanAliasTitle(animeRow.title));
    if (animeRow.title_japanese) {
      const cleanedJp = cleanAliasTitle(animeRow.title_japanese);
      if (cleanedJp && !aliases.includes(cleanedJp)) aliases.push(cleanedJp);
    }
    const reg = NYAA_ALIAS_REGISTRY[animeRow.slug];
    if (reg) {
      for (const a of reg) {
        if (!aliases.includes(a)) aliases.push(a);
      }
    }
  }

  if (NYAA_ALIAS_REGISTRY[slugKey]) {
    for (const a of NYAA_ALIAS_REGISTRY[slugKey]) {
      if (!aliases.includes(a)) aliases.push(a);
    }
  }

  const rawCleaned = cleanAliasTitle(queryOrSlug.replace(/-/g, ' '));
  if (rawCleaned && !aliases.includes(rawCleaned)) {
    aliases.push(rawCleaned);
  }

  const paddedEp = epNumber !== null && epNumber !== undefined && !Number.isNaN(epNumber)
    ? String(epNumber).padStart(2, '0')
    : null;

  let matchedAlias = null;
  const allCandidatesMap = new Map();

  for (const alias of aliases.slice(0, 3)) {
    const queriesToTry = [];
    if (paddedEp && mode !== 'batch') {
      queriesToTry.push(`${alias} ${paddedEp}`);
    }
    queriesToTry.push(alias);

    for (const q of queriesToTry) {
      const rssUrl = `https://nyaa.si/?page=rss&c=1_0&f=0&q=${encodeURIComponent(q)}`;
      try {
        const xml = await fetchNyaaRssWithDoH(rssUrl);
        const rawItems = parseNyaaRssXml(xml);

        for (const rawItem of rawItems) {
          const scored = scoreNyaaItem(rawItem, { epNumber, mode });
          if (scored) {
            const key = scored.info_hash || scored.title;
            if (!allCandidatesMap.has(key)) {
              allCandidatesMap.set(key, scored);
            }
          }
        }
      } catch {
        // Lanjut ke alias berikutnya
      }

      if (allCandidatesMap.size > 0) {
        matchedAlias = alias;
        break;
      }
    }

    if (allCandidatesMap.size > 0) break;
  }

  const sortedCandidates = Array.from(allCandidatesMap.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.seeders - a.seeders;
  });

  const singleCandidates = sortedCandidates.filter(c => c.type === 'single');
  const batchCandidates = sortedCandidates.filter(c => c.type === 'batch');

  return {
    query: queryOrSlug,
    anime_title: animeRow?.title || rawCleaned,
    category: animeRow?.category || 'anime',
    target_episode: epNumber,
    mode,
    aliases_tried: aliases,
    matched_alias: matchedAlias,
    total_found: sortedCandidates.length,
    recommended: sortedCandidates[0] || null,
    single_candidates: singleCandidates.slice(0, 10),
    batch_candidates: batchCandidates.slice(0, 6),
  };
}

module.exports = {
  searchNyaaLocalOrCloud,
  parseNyaaRssXml,
  parseNyaaTitleMetadata,
  scoreNyaaItem,
  detectResolutionLadder,
};
