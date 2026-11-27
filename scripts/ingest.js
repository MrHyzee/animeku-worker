#!/usr/bin/env node

/**
 * ==============================================================================
 * ANIMEKU VIDEO & SUBTITLE INGESTION PIPELINE CLI (VAST.AI GPU / R2 / HETZNER)
 * ==============================================================================
 * Fitur Utama:
 * 1. Nyaa.si 4-Layer Smart Search (Prioritas Multi-Sub Indo -> Eng Sub, Single & Batch)
 * 2. Selective Batch Rolling Loop (aria2c --bt-metadata-only & --select-file=N)
 * 3. Subtitle Extractor (ffprobe/ffmpeg) + Animeku Smart Fansub Unlimited AI Translator
 * 4. Multi-Resolution HLS fMP4 Single-File Transcoder (GPU NVENC / CPU Fallback: 4K/1080p/720p/480p)
 * 5. Multi-Storage Adapter (STORAGE_DRIVER = r2 [Testing] | hetzner [Production])
 * 6. Vast.ai Worker Daemon (Auto-poll antrean ingestion_jobs & Auto-Stop saat selesai)
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const {
  translateSubtitleContent,
  injectAnimekuSignatureToExistingAss,
} = require('./smart_translator');
const {
  searchNyaaLocalOrCloud,
} = require('./nyaa_finder');
const {
  searchWesternScene,
  WESTERN_ALIAS_REGISTRY,
} = require('./western_finder');
const {
  autoDiscoverNewSeries,
} = require('./discover_series');

// ==============================================================================
// KONFIGURASI CLOUDFLARE D1 & MULTI-STORAGE (R2 TESTING <-> HETZNER PROD)
// ==============================================================================
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '';
const DATABASE_ID = process.env.CF_DATABASE_ID || '';
const API_TOKEN = process.env.CF_API_TOKEN || '';

const STORAGE_DRIVER = (process.env.STORAGE_DRIVER || 'r2').toLowerCase(); // 'r2' | 'hetzner'
const WORKER_BASE_URL = (process.env.WORKER_BASE_URL || 'https://animeku-api.riansupriyanto11.workers.dev').replace(/\/+$/, '');
const MEDIA_BASE_URL = (
  process.env.MEDIA_BASE_URL ||
  (STORAGE_DRIVER === 'hetzner' ? 'https://media.animeku.app' : `${WORKER_BASE_URL}/media`)
).replace(/\/+$/, '');

// Kredensial R2 / Hetzner S3
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY || '';
const R2_SECRET_KEY = process.env.R2_SECRET_KEY || '';
const BUCKET_NAME = process.env.R2_BUCKET_NAME || 'animekuapp-media';

const HETZNER_RCLONE_REMOTE = process.env.HETZNER_RCLONE_REMOTE || 'hetzner:/home/media';
const HETZNER_S3_ENDPOINT = process.env.HETZNER_S3_ENDPOINT || '';

const s3 = new S3Client({
  region: 'auto',
  endpoint: STORAGE_DRIVER === 'hetzner' && HETZNER_S3_ENDPOINT
    ? HETZNER_S3_ENDPOINT
    : `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.HETZNER_ACCESS_KEY || R2_ACCESS_KEY,
    secretAccessKey: process.env.HETZNER_SECRET_KEY || R2_SECRET_KEY,
  },
  maxAttempts: 5,
});

// ==============================================================================
// HELPER DATABASE D1 & STORAGE ADAPTER
// ==============================================================================
async function executeD1Query(sql, params = []) {
  if (!API_TOKEN) {
    return [];
  }
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    });
    const data = await res.json();
    if (!data.success) {
      console.warn(`⚠️ D1 Query Warning: ${JSON.stringify(data.errors || data.messages)}`);
      return [];
    }
    return data.result?.[0]?.results || [];
  } catch (err) {
    console.warn(`⚠️ D1 Query Network Warning: ${err.message}`);
    return [];
  }
}

async function getAnimeDetails(slugOrId, options = {}) {
  // 1. Jika jobData sudah disertakan dari worker daemon (/next)
  if (options.jobData && options.jobData.anime_title) {
    const j = options.jobData;
    return {
      id: j.anime_id || j.anime_slug || slugOrId,
      title: j.anime_title,
      title_japanese: j.title_japanese || j.anime_title,
      slug: j.anime_slug || slugOrId,
      category: j.category || 'anime',
      genres: Array.isArray(j.anime_genres) ? JSON.stringify(j.anime_genres) : (j.anime_genres || '[]'),
      poster_url: j.poster_url || '',
      banner_url: j.banner_url || '',
    };
  }

  // 2. Jika animeData eksplisit disertakan
  if (options.animeData && options.animeData.title) {
    return options.animeData;
  }

  // 3. Ambil dari Worker API (Bebas Token API Cloudflare)
  try {
    const res = await fetch(`${WORKER_BASE_URL}/api/v1/anime/${encodeURIComponent(slugOrId)}`);
    const json = await res.json();
    if (json.success && json.data) {
      const a = json.data;
      return {
        id: a.id || a.slug || slugOrId,
        title: a.title,
        title_japanese: a.title_japanese || a.title,
        slug: a.slug || slugOrId,
        category: a.category || 'anime',
        genres: Array.isArray(a.genres) ? JSON.stringify(a.genres) : (a.genres || '[]'),
        poster_url: a.poster_url || '',
        banner_url: a.banner_url || '',
      };
    }
  } catch (_) {}

  // 4. Fallback ke query D1 langsung jika API_TOKEN tersedia
  if (API_TOKEN) {
    try {
      const rows = await executeD1Query(
        'SELECT id, title, title_japanese, slug, category, genres, poster_url, banner_url FROM animes WHERE slug = ? OR id = ?',
        [slugOrId, slugOrId]
      );
      if (rows && rows.length > 0) return rows[0];
    } catch (_) {}
  }

  // 5. Default fallback objek
  return {
    id: slugOrId,
    title: slugOrId,
    title_japanese: slugOrId,
    slug: slugOrId,
    category: 'anime',
    genres: '[]',
    poster_url: '',
    banner_url: '',
  };
}

async function reportJobProgress(jobId, { status, percent, log = null, streamUrl = null, subIndoUrl = null }) {
  if (!jobId) return;
  try {
    const updateBody = {
      status,
      progress_percent: percent,
    };
    if (log) updateBody.logs = log;
    if (streamUrl) updateBody.stream_url = streamUrl;
    if (subIndoUrl) updateBody.sub_indo_url = subIndoUrl;

    await fetch(`${WORKER_BASE_URL}/api/v1/ingestion/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updateBody),
    });
  } catch (err) {
    // Non-blocking report error
  }
}

async function getBufferFromPathOrUrl(source) {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    console.log(`🌐 Mengunduh sumber dari remote: ${source}`);
    const res = await fetch(source);
    if (!res.ok) throw new Error(`HTTP Error ${res.status}: Gagal mengunduh ${source}`);
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } else {
    const resolvedPath = path.resolve(source);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File lokal tidak ditemukan: ${resolvedPath}`);
    }
    return fs.readFileSync(resolvedPath);
  }
}

function getContentTypeByExt(key) {
  if (key.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (key.endsWith('.m4s')) return 'video/iso.segment';
  if (key.endsWith('.ts')) return 'video/mp2t';
  if (key.endsWith('.mkv')) return 'video/x-matroska';
  if (key.endsWith('.webm')) return 'video/webm';
  if (key.endsWith('.ass')) return 'text/x-ssa; charset=utf-8';
  if (key.endsWith('.srt')) return 'text/plain; charset=utf-8';
  if (key.endsWith('.vtt')) return 'text/vtt; charset=utf-8';
  return 'video/mp4';
}

/**
 * Multi-Storage Upload Adapter (Mendukung Cloudflare R2 saat Tes & Hetzner Storage Box saat Prod)
 */
async function uploadToStorage(key, bufferOrFilePath, customContentType = null) {
  const contentType = customContentType || getContentTypeByExt(key);
  const isFilePath = typeof bufferOrFilePath === 'string';

  let fileSizeStr = '';
  if (isFilePath) {
    const stat = fs.statSync(bufferOrFilePath);
    fileSizeStr = `${(stat.size / (1024 * 1024)).toFixed(2)} MB`;
  } else {
    fileSizeStr = `${(bufferOrFilePath.length / 1024).toFixed(1)} KB`;
  }

  console.log(`☁️  [${STORAGE_DRIVER.toUpperCase()}] Mengunggah -> ${key} (${fileSizeStr})...`);

  if (STORAGE_DRIVER === 'hetzner' && !HETZNER_S3_ENDPOINT) {
    // Upload ke Hetzner Storage Box via rclone (SFTP / WebDAV)
    let tmpFile = isFilePath ? bufferOrFilePath : null;
    if (!tmpFile) {
      tmpFile = path.join(os.tmpdir(), `animeku_upload_${Date.now()}_${path.basename(key)}`);
      fs.writeFileSync(tmpFile, bufferOrFilePath);
    }
    try {
      execFileSync('rclone', ['copyto', tmpFile, `${HETZNER_RCLONE_REMOTE}/${key}`], { stdio: 'inherit' });
    } finally {
      if (!isFilePath && tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  } else {
    // Upload via S3 API (Cloudflare R2 atau Hetzner S3 Object Storage)
    if (STORAGE_DRIVER === 'r2' && (!R2_ACCESS_KEY || !R2_SECRET_KEY)) {
      throw new Error('Kredensial Cloudflare R2 belum diset! Harap isi R2_ACCESS_KEY dan R2_SECRET_KEY di form Cell 2 atau tambahkan ke Colab Secrets.');
    }
    // Gunakan Buffer penuh agar AWS SDK v3 dapat me-retry otomatis jika koneksi stale setelah proses transcode panjang
    const bodyBuffer = isFilePath ? fs.readFileSync(bufferOrFilePath) : bufferOrFilePath;
    const putParams = {
      Bucket: BUCKET_NAME,
      Key: key,
      Body: bodyBuffer,
      ContentType: contentType,
    };

    let attempts = 0;
    while (attempts < 5) {
      try {
        attempts++;
        await s3.send(new PutObjectCommand(putParams));
        break;
      } catch (err) {
        console.warn(`⚠️ Gagal unggah ${key} (Percobaan ${attempts}/5): ${err.message}`);
        if (attempts >= 5) throw err;
        await new Promise(r => setTimeout(r, 2000 * attempts));
      }
    }
  }

  const publicUrl = `${MEDIA_BASE_URL}/${key}`;
  console.log(`✅ Berhasil diunggah: ${publicUrl}`);
  return publicUrl;
}

// ==============================================================================
// DETEKSI TOOLS EKSTERNAL (FFMPEG, FFPROBE, ARIA2C, GPU NVENC)
// ==============================================================================
function hasCommand(cmd) {
  let res = spawnSync('which', [cmd], { encoding: 'utf8' });
  if (res.status === 0) return true;

  // Auto-install ffmpeg & ffprobe jika di Linux runner (GitHub Actions / Vast.ai)
  if ((cmd === 'ffmpeg' || cmd === 'ffprobe') && process.platform === 'linux') {
    try {
      console.log(`📦 [AUTO-INSTALL] ${cmd} tidak ditemukan, memasang via apt-get...`);
      execFileSync('sudo', ['apt-get', 'update', '-qq'], { stdio: 'inherit' });
      execFileSync('sudo', ['apt-get', 'install', '-y', '-qq', 'ffmpeg'], { stdio: 'inherit' });
      res = spawnSync('which', [cmd], { encoding: 'utf8' });
      return res.status === 0;
    } catch (_) {
      return false;
    }
  }
  return false;
}

let cachedNvencAvailable = null;
function hasNvidiaNvenc() {
  if (cachedNvencAvailable !== null) return cachedNvencAvailable;
  if (!hasCommand('nvidia-smi')) {
    cachedNvencAvailable = false;
    return false;
  }
  const smi = spawnSync('nvidia-smi', [], { encoding: 'utf8' });
  if (smi.status !== 0) {
    cachedNvencAvailable = false;
    return false;
  }

  let enc = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  if (enc.stdout && enc.stdout.includes('h264_nvenc')) {
    cachedNvencAvailable = true;
    return true;
  }

  // Jika runner memiliki GPU NVIDIA tapi binary FFmpeg belum mendukung NVENC (misal di Ubuntu / Colab):
  // Otomatis unduh & pasang pre-compiled BtbN FFmpeg NVENC Static ke /usr/local/bin!
  if (process.platform === 'linux') {
    try {
      console.log('⚡ [AUTO-UPGRADE] Terdeteksi GPU NVIDIA tapi FFmpeg saat ini belum mendukung NVENC.');
      console.log('⚡ Mengunduh & memasang BtbN FFmpeg NVENC Hardware Transcoder...');
      execFileSync('bash', ['-c', `
        set -e
        mkdir -p /tmp/ffmpeg_btbn
        cd /tmp/ffmpeg_btbn
        wget -q -O ffmpeg.tar.xz https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz
        tar -xf ffmpeg.tar.xz --strip-components=1
        sudo cp bin/ffmpeg /usr/local/bin/ffmpeg
        sudo cp bin/ffprobe /usr/local/bin/ffprobe
        sudo chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe
        cd /
        rm -rf /tmp/ffmpeg_btbn
      `], { stdio: 'inherit' });

      enc = spawnSync('/usr/local/bin/ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
      cachedNvencAvailable = Boolean(enc.stdout && enc.stdout.includes('h264_nvenc'));
      if (cachedNvencAvailable) {
        console.log('✅ [AUTO-UPGRADE] FFmpeg NVENC GPU Hardware Acceleration BERHASIL DIAKTIFKAN!');
      }
      return cachedNvencAvailable;
    } catch (e) {
      console.warn('⚠️ Gagal auto-upgrade BtbN FFmpeg NVENC:', e.message);
    }
  }

  cachedNvencAvailable = false;
  return false;
}

// ==============================================================================
// EKSTRAKSI SUBTITLE (.MKV) + ANIMEKU SMART FANSUB AUTO-TRANSLATE
// ==============================================================================
async function extractAndProcessSubtitleFromVideo(videoFilePath, {
  category = 'anime',
  animeSlug,
  animeTitle,
  genres = [],
  epNumber,
  workDir,
}) {
  if (!hasCommand('ffprobe') || !hasCommand('ffmpeg')) {
    console.log('⚠️  ffprobe/ffmpeg tidak terdeteksi di sistem, melewati ekstraksi subtitle internal.');
    return { hasSubIndo: true, subType: 'embedded', subIndoPath: null, subEngPath: null };
  }

  console.log('🔍 Memindai track subtitle di dalam video dengan ffprobe...');
  let streams = [];
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-select_streams', 's',
      videoFilePath,
    ], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    streams = parsed.streams || [];
  } catch (e) {
    console.warn(`⚠️  Gagal membaca stream subtitle: ${e.message}`);
  }

  if (streams.length === 0) {
    console.log('ℹ️  Video tidak memiliki embedded subtitle track.');
    // Cek apakah Faster-Whisper / Whisper CLI tersedia (di Vast.ai GPU Server) untuk transkripsi otomatis dari Audio
    const whisperBin = hasCommand('faster-whisper') ? 'faster-whisper' : (hasCommand('whisper') ? 'whisper' : null);
    if (whisperBin) {
      console.log(`🎙️  Menjalankan AI Audio Transcription (${whisperBin} GPU) untuk menghasilkan subtitle dari audio...`);
      const outSrtPath = path.join(workDir, `ep-${epNumber}.en.srt`);
      const outIndoPath = path.join(workDir, `ep-${epNumber}.id.ass`);
      try {
        execFileSync(whisperBin, [
          videoFilePath,
          '--task', 'translate',
          '--model', process.env.WHISPER_MODEL || 'large-v3-turbo',
          '--output_format', 'srt',
          '--output_dir', workDir,
        ], { stdio: 'inherit' });
        const generatedSrt = fs.readdirSync(workDir).find(f => f.endsWith('.srt'));
        if (generatedSrt) {
          const fullSrt = path.join(workDir, generatedSrt);
          fs.renameSync(fullSrt, outSrtPath);
          const rawSrt = fs.readFileSync(outSrtPath, 'utf8');
          const translated = await translateSubtitleContent(rawSrt, {
            format: 'srt',
            category,
            genres,
            animeTitle: animeTitle || animeSlug,
          });
          fs.writeFileSync(outIndoPath, translated.content, 'utf8');
          return {
            hasSubIndo: true,
            subType: 'external',
            subIndoPath: outIndoPath,
            subEngPath: outSrtPath,
            strategyUsed: 'whisper_gpu_transcribed_and_translated',
          };
        }
      } catch (wErr) {
        console.warn(`⚠️  Whisper transcription dilewati: ${wErr.message}`);
      }
    }
    return { hasSubIndo: false, subType: 'embedded', subIndoPath: null, subEngPath: null };
  }

  // Cari track Bahasa Indonesia (ind / id / may / title "indonesian")
  let indoStream = null;
  let engStream = null;

  for (const s of streams) {
    const lang = (s.tags?.language || '').toLowerCase();
    const title = (s.tags?.title || '').toLowerCase();

    if (!indoStream && (lang === 'ind' || lang === 'id' || lang === 'may' || title.includes('indonesi') || title.includes('indo'))) {
      indoStream = s;
    }
    if (!engStream && (lang === 'eng' || lang === 'en' || title.includes('english'))) {
      engStream = s;
    }
  }

  if (!engStream && !indoStream) {
    engStream = streams[0];
  }

  const outIndoPath = path.join(workDir, `ep-${epNumber}.id.ass`);
  const outEngPath = path.join(workDir, `ep-${epNumber}.en.ass`);

  // KASUS A: Sudah ada Track Sub Indo Bawaan (Misal Erai-raws Multi-Sub)
  if (indoStream) {
    console.log(`✅ Ditemukan Track Subtitle Indonesia Bawaan (Stream #${indoStream.index}, Codec: ${indoStream.codec_name})`);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', videoFilePath, '-map', `0:${indoStream.index}`, outIndoPath]);

    // Suntikkan Signature Opening Credit Animeku Studio
    const rawIndo = fs.readFileSync(outIndoPath, 'utf8');
    fs.writeFileSync(outIndoPath, injectAnimekuSignatureToExistingAss(rawIndo), 'utf8');

    // Ikut ekstrak track Inggris sebagai cadangan arsip jika ada
    if (engStream) {
      try {
        execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', videoFilePath, '-map', `0:${engStream.index}`, outEngPath]);
      } catch {
        // Ignore
      }
    }

    return {
      hasSubIndo: true,
      subType: 'external',
      subIndoPath: outIndoPath,
      subEngPath: fs.existsSync(outEngPath) ? outEngPath : null,
      strategyUsed: 'extracted_native_indo',
    };
  }

  // KASUS B: Tidak ada Sub Indo -> Ekstrak Sub Inggris lalu Jalankan Animeku Smart Fansub Engine!
  console.log(`🌐 Track Sub Indo tidak ditemukan. Mengekstrak Track Inggris (Stream #${engStream.index}) untuk Smart Translate...`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', videoFilePath, '-map', `0:${engStream.index}`, outEngPath]);

  const rawEngAss = fs.readFileSync(outEngPath, 'utf8');
  console.log(`🎭 Menjalankan Animeku Smart Fansub Engine (.en.ass -> .id.ass)...`);
  const translated = await translateSubtitleContent(rawEngAss, {
    format: 'ass',
    category,
    genres,
    animeTitle: animeTitle || animeSlug,
  });

  fs.writeFileSync(outIndoPath, translated.content, 'utf8');
  console.log(`✨ Smart Translate Selesai! (${translated.stats.total_lines_translated} dialog, ${translated.stats.tl_notes_injected} TL Notes, Engine: ${translated.stats.engine_used})`);

  return {
    hasSubIndo: true,
    subType: 'external',
    subIndoPath: outIndoPath,
    subEngPath: outEngPath,
    strategyUsed: `smart_translated_${translated.stats.engine_used}`,
  };
}

// ==============================================================================
// TRANSCODER MULTI-RESOLUTION HLS fMP4 SINGLE-FILE (4K / 1080p / 720p / 480p)
// ==============================================================================
function getVideoHeight(videoFilePath) {
  if (!hasCommand('ffprobe')) return 1080;
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=height',
      '-of', 'csv=p=0',
      videoFilePath,
    ], { encoding: 'utf8' }).trim();
    const h = parseInt(out, 10);
    return Number.isNaN(h) || h <= 0 ? 1080 : h;
  } catch {
    return 1080;
  }
}

function buildMultiResHlsFmp4(videoFilePath, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const sourceHeight = getVideoHeight(videoFilePath);
  const useGpu = hasNvidiaNvenc();

  // Aturan No-Upscale Resolution Ladder
  const allTiers = [
    { name: '2160p', width: 3840, height: 2160, bitrate: '12000k', maxrate: '14000k', bufsize: '20000k', bandwidth: 13500000 },
    { name: '1080p', width: 1920, height: 1080, bitrate: '4200k',  maxrate: '5000k',  bufsize: '7500k',  bandwidth: 4800000 },
    { name: '720p',  width: 1280, height: 720,  bitrate: '2200k',  maxrate: '2600k',  bufsize: '4000k',  bandwidth: 2500000 },
    { name: '480p',  width: 854,  height: 480,  bitrate: '1050k',  maxrate: '1300k',  bufsize: '2000k',  bandwidth: 1200000 },
  ];

  let activeTiers = allTiers.filter(t => t.height <= sourceHeight + 120);
  if (activeTiers.length === 0) {
    activeTiers = [allTiers[allTiers.length - 1]];
  }

  console.log(`🎬 Memulai Konversi Multi-Resolution HLS fMP4 Single-File (${useGpu ? 'GPU NVIDIA NVENC' : 'CPU libx264'})`);
  console.log(`   Resolusi Sumber: ${sourceHeight}p -> Output Ladder: [${activeTiers.map(t => t.name).join(', ')}]`);

  const absVideoPath = path.resolve(videoFilePath);

  for (const tier of activeTiers) {
    const playlistName = `${tier.name}.m3u8`;
    const segmentFileName = `${tier.name}.m4s`;

    const vCodecArgs = useGpu
      ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'fastdecode', '-crf', '23', '-threads', '0'];

    const args = [
      '-y', '-v', 'warning',
      '-i', absVideoPath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-vf', `scale=-2:${tier.height}`,
      ...vCodecArgs,
      '-b:v', tier.bitrate,
      '-maxrate', tier.maxrate,
      '-bufsize', tier.bufsize,
      '-pix_fmt', 'yuv420p',
      '-g', '48',
      '-keyint_min', '48',
      '-sc_threshold', '0',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ac', '2',
      '-af', 'aresample=async=1:first_pts=0',
      '-max_muxing_queue_size', '2048',
      '-f', 'hls',
      '-hls_time', '6',
      '-hls_list_size', '0',
      '-hls_segment_type', 'fmp4',
      '-hls_flags', 'single_file',
      '-hls_fmp4_init_filename', segmentFileName,
      '-hls_segment_filename', segmentFileName,
      playlistName,
    ];

    console.log(`   ⚙️  Merender stream ${tier.name} (${segmentFileName})...`);
    execFileSync('ffmpeg', args, { cwd: outputDir, stdio: 'inherit' });
  }

  // Bangun Master Playlist (master.m3u8)
  const masterLines = ['#EXTM3U', '#EXT-X-VERSION:7'];
  for (const tier of activeTiers) {
    masterLines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${tier.bandwidth},RESOLUTION=${tier.width}x${tier.height},NAME="${tier.name}"`,
      `${tier.name}.m3u8`
    );
  }

  const masterPath = path.join(outputDir, 'master.m3u8');
  fs.writeFileSync(masterPath, masterLines.join('\n') + '\n', 'utf8');
  console.log(`✅ Master HLS Playlist siap: ${masterPath}`);

  const outputFiles = fs.readdirSync(outputDir).map(f => path.join(outputDir, f));
  console.log(`📋 File HLS yang dihasilkan (${outputFiles.length} file):`);
  outputFiles.forEach(f => {
    const s = fs.statSync(f);
    console.log(`   • ${path.basename(f)} (${(s.size / (1024 * 1024)).toFixed(2)} MB)`);
  });

  return {
    masterPath,
    tiers: activeTiers.map(t => t.name),
    files: outputFiles,
  };
}

// ==============================================================================
// SELECTIVE BATCH & SINGLE TORRENT DOWNLOADER (ARIA2C)
// ==============================================================================
function selectEpisodeFileIndexFromTorrent(torrentFilePath, targetEpNumber) {
  const out = execFileSync('aria2c', ['--show-files', torrentFilePath], { encoding: 'utf8' });
  const lines = out.split('\n');
  const candidates = [];

  for (const line of lines) {
    // Format aria2c --show-files: "  1|./[Erai-raws] Solo Leveling - 01 [1080p].mkv"
    const m = line.match(/^\s*(\d+)\|(.+\.(?:mkv|mp4|webm))$/i);
    if (!m) continue;
    const fileIndex = parseInt(m[1], 10);
    const filePath = m[2].trim();
    const baseName = path.basename(filePath);

    if (/\b(ncop|nced|pv|preview|cm|menu)\b/i.test(baseName)) continue;

    candidates.push({ fileIndex, filePath, baseName });
  }

  const padded = String(targetEpNumber).padStart(2, '0');
  const epRegexes = [
    // 1. Format S01E02 / S02E02 (paling spesifik)
    new RegExp(`\\bS\\d+E0*${targetEpNumber}(?:v\\d)?\\b`, 'i'),
    // 2. Format Episode 02 / Ep. 02
    new RegExp(`\\b(?:ep|episode)\\.?\\s*0*${targetEpNumber}(?:v\\d)?\\b`, 'i'),
    // 3. Format " - 02 " atau " 02 [1080p]" (abaikan S02 season)
    new RegExp(`(?<!S\\d{0,2})(?:-\\s*|\\s+)0*${targetEpNumber}(?:v\\d)?(?=\\s*[\\[\\(._]|$)`, 'i'),
    // 4. Standalone padded number (bukan bagian dari S02)
    new RegExp(`(?<![a-zA-Z0-9])0*${padded}(?:v\\d)?(?![a-zA-Z0-9])`),
  ];

  for (const reg of epRegexes) {
    const found = candidates.find(c => reg.test(c.baseName));
    if (found) return found;
  }

  // Fallback berdasarkan urutan jika jumlah file sesuai
  if (targetEpNumber >= 1 && targetEpNumber <= candidates.length) {
    return candidates[targetEpNumber - 1];
  }
  return candidates[0] || null;
}

function downloadFromNyaaWithAria2(magnetOrUrl, { isBatch = false, targetEpNumber = 1, downloadDir }) {
  fs.mkdirSync(downloadDir, { recursive: true });

  // JALUR KHUSUS DONGHUA TENCENT VIDEO / WETV SVIP (yt-dlp)
  if (/v\.qq\.com|wetv\.vip|bilibili\.com/i.test(magnetOrUrl)) {
    if (!hasCommand('yt-dlp')) {
      throw new Error('Tool "yt-dlp" belum terinstal untuk ekstraksi Tencent Video SVIP. Jalankan: pip install yt-dlp');
    }
    console.log(`🇨🇳 Mengekstrak sumber Donghua langsung dari Tencent/WeTV via yt-dlp...`);
    const cookiesFile = process.env.TENCENT_COOKIES_PATH || path.join(__dirname, '..', 'tencent_cookies.txt');
    const ytArgs = [
      '-f', 'bestvideo+bestaudio/best',
      '--merge-output-format', 'mkv',
      '--write-subs',
      '--sub-langs', 'id,en,zh.*',
      '--embed-subs',
      '-o', path.join(downloadDir, `ep-${targetEpNumber}.%(ext)s`),
    ];
    if (fs.existsSync(cookiesFile)) {
      console.log(`🍪 Menggunakan file cookies SVIP: ${cookiesFile}`);
      ytArgs.push('--cookies', cookiesFile);
    }
    ytArgs.push(magnetOrUrl);
    execFileSync('yt-dlp', ytArgs, { stdio: 'inherit' });
  } else {
    if (!hasCommand('aria2c')) {
      throw new Error('Tool "aria2c" belum terinstal. Jalankan: brew install aria2 (macOS) atau apt-get install -y aria2 (Ubuntu/Vast.ai)');
    }

    if (!isBatch) {
      console.log(`⬇️  Mengunduh Single Episode via aria2c (TCP Tracker Booster + Direct Torrent)...`);
      
      let targetFileOrMagnet = magnetOrUrl;
      const hashMatch = magnetOrUrl.match(/urn:btih:([a-fA-F0-9]{40})/i);
      if (hashMatch) {
        const infoHash = hashMatch[1].toUpperCase();
        const torrentCachePath = path.join(downloadDir, `${infoHash}.torrent`);
        if (!fs.existsSync(torrentCachePath)) {
          console.log(`⚡ Mengunduh file .torrent resmi untuk bypass limit DHT Google Colab...`);
          try {
            execFileSync('curl', [
              '-sL',
              '-A', 'Mozilla/5.0',
              '--max-time', '10',
              `https://itorrents.org/torrent/${infoHash}.torrent`,
              '-o', torrentCachePath
            ]);
            if (fs.existsSync(torrentCachePath) && fs.statSync(torrentCachePath).size > 200) {
              console.log(`✅ File .torrent resmi didapatkan (${(fs.statSync(torrentCachePath).size / 1024).toFixed(1)} KB)! Memulai download langsung...`);
              targetFileOrMagnet = torrentCachePath;
            }
          } catch (_) {}
        } else {
          targetFileOrMagnet = torrentCachePath;
        }
      }

      const tcpTrackers = [
        'http://nyaa.tracker.wf:7777/announce',
        'http://tracker.opentrackr.org:1337/announce',
        'http://p4p.arenabg.com:1337/announce',
        'http://open.acgnxtracker.com:80/announce',
        'https://tracker.tamersunion.org:443/announce',
        'http://tracker.rensite.net:80/announce',
        'http://tracker.files.fm:6969/announce'
      ].join(',');

      execFileSync('aria2c', [
        '-d', downloadDir,
        '-x', '16',
        '-s', '16',
        '-j', '16',
        '--seed-time=0',
        '--summary-interval=3',
        '--file-allocation=none',
        '--bt-stop-timeout=120',
        '--bt-tracker-connect-timeout=5',
        '--bt-tracker-timeout=10',
        '--bt-tracker=' + tcpTrackers,
        '--enable-dht=true',
        '--bt-save-metadata=true',
        targetFileOrMagnet,
      ], { stdio: 'inherit' });
    } else {
      console.log(`📦 Sumber bertipe BATCH! Mengambil metadata daftar file terlebih dahulu (--bt-metadata-only)...`);
      const metaDir = path.join(downloadDir, '_meta');
      fs.mkdirSync(metaDir, { recursive: true });

      execFileSync('aria2c', [
        '-d', metaDir,
        '--bt-metadata-only=true',
        '--bt-save-metadata=true',
        '--bt-stop-timeout=180',
        '--seed-time=0',
        '--enable-dht=true',
        magnetOrUrl,
      ], { stdio: 'inherit' });

      const torrentFile = fs.readdirSync(metaDir).find(f => f.endsWith('.torrent'));
      if (!torrentFile) {
        throw new Error('Gagal mendapatkan file metadata .torrent dari magnet Batch.');
      }

      const fullTorrentPath = path.join(metaDir, torrentFile);
      const selected = selectEpisodeFileIndexFromTorrent(fullTorrentPath, targetEpNumber);
      if (!selected) {
        throw new Error(`Tidak ditemukan file video untuk Episode ${targetEpNumber} di dalam paket Batch.`);
      }

      let selectedBaseName = selected.baseName;
      console.log(`🎯 Selective Batch Download: Memilih File Index #${selected.fileIndex} -> "${selected.baseName}"`);
      execFileSync('aria2c', [
        '-d', downloadDir,
        '-x', '16',
        '-s', '16',
        '-j', '16',
        '--file-allocation=none',
        '--seed-time=0',
        '--summary-interval=5',
        '--bt-stop-timeout=300',
        `--select-file=${selected.fileIndex}`,
        fullTorrentPath,
      ], { stdio: 'inherit' });
    }
  }

  // Temukan file video yang valid di dalam downloadDir
  const findVideosRecursive = (dir) => {
    let results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== '_meta') {
        results = results.concat(findVideosRecursive(full));
      } else if (/\.(mkv|mp4|webm)$/i.test(entry.name)) {
        results.push({ path: full, size: fs.statSync(full).size });
      }
    }
    return results;
  };

  const videos = findVideosRecursive(downloadDir);
  if (videos.length === 0) {
    throw new Error('File video (.mkv/.mp4) tidak ditemukan setelah proses download selesai.');
  }

  // Filter file yang ukurannya valid (> 20 MB) agar tidak membaca sparse empty file
  const validVideos = videos.filter(v => v.size > 20 * 1024 * 1024).sort((a, b) => b.size - a.size);
  if (validVideos.length > 0) {
    return validVideos[0].path;
  }
  return videos.sort((a, b) => b.size - a.size)[0].path;
}

// ==============================================================================
// COMMAND 1: SEARCH NYAA.SI (4-LAYER SMART FINDER)
// ==============================================================================
async function handleSearchNyaa(options) {
  const animeSlug = options.anime || options.slug || options.q;
  const ep = options.ep || options.episode || '';
  const epNumber = ep !== '' ? parseInt(ep, 10) : null;
  const mode = options.mode || 'any';

  if (!animeSlug) {
    console.error('❌ Parameter --anime <slug/judul> wajib diisi! Contoh: --anime solo-leveling --ep 1');
    process.exit(1);
  }

  console.log(`\n🔍 Mencari di Nyaa.si (4-Layer Smart Search + DoH 1.1.1.1): "${animeSlug}" ${ep ? `Episode ${ep}` : ''} [Mode: ${mode}]...`);

  // Cari data alias anime di D1 terlebih dahulu
  const slugKey = String(animeSlug).toLowerCase().trim();
  const rows = await executeD1Query(
    'SELECT id, title, title_japanese, slug, category FROM animes WHERE slug = ? OR id = ? OR LOWER(title) = ?',
    [slugKey, slugKey, slugKey]
  ).catch(() => []);

  const animeRow = rows[0] || null;
  const isWestern =
    options.category === 'western' ||
    animeRow?.category === 'western' ||
    Boolean(WESTERN_ALIAS_REGISTRY[slugKey]);

  const d = isWestern
    ? await searchWesternScene({
        queryOrSlug: animeSlug,
        animeRow,
        season: options.season ? parseInt(options.season, 10) : 1,
        epNumber,
        mode,
      })
    : await searchNyaaLocalOrCloud({
        queryOrSlug: animeSlug,
        animeRow,
        epNumber,
        mode,
      });
  console.log('----------------------------------------------------------------------');
  console.log(`Anime          : ${d.anime_title} (${d.category.toUpperCase()})`);
  console.log(`Alias Dicoba   : ${d.aliases_tried.join(' | ')}`);
  console.log(`Alias Cocok    : ${d.matched_alias || '-'}`);
  console.log(`Total Kandidat : ${d.total_found} torrent aktif`);
  console.log('----------------------------------------------------------------------');

  if (d.recommended) {
    const r = d.recommended;
    console.log(`\n🥇 REKOMENDASI #1 TERBAIK (SKOR: ${r.score} POIN):`);
    console.log(`   Judul Rilis  : ${r.title}`);
    console.log(`   Grup & Tipe  : [${r.release_group}] • ${r.type.toUpperCase()} ${r.batch_range ? `(Ep ${r.batch_range.start}-${r.batch_range.end})` : ''}`);
    console.log(`   Resolusi     : ${r.resolution} -> Output HLS Ladder: [${r.output_resolutions.join(', ')}]`);
    console.log(`   Strategi Sub : ${r.has_sub_indo ? '✅ ADA SUB INDO BAWAAN (Extract Indo)' : '🎭 ENGLISH SUB -> ANIMEKU SMART FANSUB TRANSLATE'}`);
    console.log(`   Ukuran & Seed: ${r.size} • ${r.seeders} Seeders`);
    console.log(`   Rincian Skor : ${r.score_breakdown.join(' | ')}`);
  } else {
    console.log('\n⚠️  Tidak ditemukan torrent yang memenuhi syarat.');
  }

  if (d.single_candidates?.length > 1) {
    console.log(`\n📋 Kandidat Single Lainnya (${d.single_candidates.length}):`);
    for (const c of d.single_candidates.slice(0, 5)) {
      console.log(`   • [${c.score} pts] ${c.title} (${c.size}, ⬆️ ${c.seeders})`);
    }
  }
  if (d.batch_candidates?.length > 0) {
    console.log(`\n📦 Kandidat Paket Batch (${d.batch_candidates.length}):`);
    for (const c of d.batch_candidates.slice(0, 4)) {
      console.log(`   • [${c.score} pts] ${c.title} (${c.size}, ⬆️ ${c.seeders})`);
    }
  }
  console.log('');
  return d;
}

// ==============================================================================
// COMMAND 2: AUTO-INGEST 1 EPISODE DARI NYAA.SI (SINGLE ATAU SELECTIVE BATCH)
// ==============================================================================
async function handleAutoIngestNyaa(options) {
  const animeSlug = options.anime || options.slug;
  const epNumber = parseInt(options.ep || options.episode || '1', 10);
  const mode = (options.mode || 'hls').toLowerCase(); // 'hls' | 'direct'
  const isDryRun = !!options['dry-run'];
  const jobId = options['job-id'] || options.jobId || options.job_id || process.env.JOB_ID || null;

  if (!animeSlug) {
    console.log('🤖 Parameter --anime kosong. Mengalihkan otomatis ke Worker Daemon untuk mengklaim job dari Admin Panel...');
    return handleWorkerDaemon({ once: true, ...options });
  }

  // 1. Dapatkan metadata anime (prioritas: jobData -> Worker API -> D1 query)
  const anime = await getAnimeDetails(animeSlug, options);
  const genres = (() => {
    try {
      return typeof anime.genres === 'string' ? JSON.parse(anime.genres || '[]') : (anime.genres || []);
    } catch {
      return [];
    }
  })();

  await reportJobProgress(jobId, { status: 'downloading', percent: 10, log: `Memulai download episode ${epNumber} untuk ${anime.title}` });

  // 2. Cari kandidat terbaik di Nyaa.si jika magnet tidak diberikan langsung
  let candidate = null;
  let candidateMagnet = options.magnet || options.url;
  if (candidateMagnet && candidateMagnet.includes('9ad49d790050e74ca815e1e9d4056dbbee27a52d') && epNumber !== 1) {
    console.log(`⚠️ Magnet job terdeteksi preset generik Ep 1. Mencari rujukan torrent resmi Episode ${epNumber} secara live di Nyaa.si...`);
    candidateMagnet = null;
  }

  if (candidateMagnet) {
    candidate = {
      title: options.title || `${anime.title} - Episode ${epNumber}`,
      magnet: candidateMagnet,
      type: options.batch ? 'batch' : 'single',
      resolution: '1080p',
      output_resolutions: ['1080p', '720p', '480p'],
      sub_strategy: 'extract_indo',
    };
  } else {
    const searchData = await handleSearchNyaa({ anime: anime.slug, ep: epNumber, mode: 'any' });
    candidate = searchData.recommended;
    if (!candidate) {
      await reportJobProgress(jobId, { status: 'failed', percent: 0, log: `Tidak ditemukan sumber di Nyaa.si untuk ${anime.title} Episode ${epNumber}` });
      throw new Error(`Tidak ditemukan sumber di Nyaa.si untuk ${anime.title} Episode ${epNumber}`);
    }
  }

  if (isDryRun) {
    console.log(`✅ [DRY-RUN] Kandidat terpilih siap diproses ke [${STORAGE_DRIVER.toUpperCase()}] dalam mode [${mode.toUpperCase()}].`);
    return;
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `animeku_${anime.slug}_ep${epNumber}_`));
  try {
    await reportJobProgress(jobId, { status: 'downloading', percent: 25, log: `Mengunduh video via aria2c: ${candidate.title}` });

    // 3. Download Video via aria2c (Single atau Selective File dari Batch)
    const videoFilePath = downloadFromNyaaWithAria2(candidate.magnet, {
      isBatch: candidate.type === 'batch',
      targetEpNumber: epNumber,
      downloadDir: path.join(workDir, 'dl'),
    });
    console.log(`✅ Video berhasil diunduh: ${videoFilePath}`);

    await reportJobProgress(jobId, { status: 'extracting_sub', percent: 50, log: `Video berhasil diunduh. Mengekstrak subtitle & audio stream...` });

    // 4. Ekstrak Subtitle Indo / Smart Translate jika hanya Sub Inggris
    const subResult = await extractAndProcessSubtitleFromVideo(videoFilePath, {
      category: anime.category,
      animeSlug: anime.slug,
      animeTitle: anime.title,
      genres,
      epNumber,
      workDir,
    });

    await reportJobProgress(jobId, { status: 'uploading', percent: 65, log: `Mengunggah subtitle ke ${STORAGE_DRIVER.toUpperCase()}...` });

    // 5. Upload Subtitle (.id.ass & .en.ass) ke Storage (Standarisasi: Di dalam folder episode)
    const basePrefix = `${anime.category}/${anime.slug}/ep-${epNumber}`;
    let subIndoUrl = null;
    const availableSubs = ['id'];
    if (subResult.subIndoPath && fs.existsSync(subResult.subIndoPath)) {
      const subIndoKey = `${basePrefix}/sub.id.ass`;
      subIndoUrl = await uploadToStorage(subIndoKey, subResult.subIndoPath);
    }
    if (subResult.subEngPath && fs.existsSync(subResult.subEngPath)) {
      const subEngKey = `${basePrefix}/sub.en.ass`;
      await uploadToStorage(subEngKey, subResult.subEngPath);
      availableSubs.push('en');
    }

    await reportJobProgress(jobId, { status: mode === 'hls' ? 'transcoding' : 'uploading', percent: 75, log: `Memproses encoding video (${mode.toUpperCase()})...` });

    // 6. Konversi Multi-Resolution HLS fMP4 Single-File atau Direct Upload (Dengan Circuit-Breaker Fallback)
    let streamUrl = '';
    if (mode === 'hls' && hasCommand('ffmpeg')) {
      try {
        const hlsDir = path.join(workDir, 'hls');
        const hlsBuild = buildMultiResHlsFmp4(videoFilePath, hlsDir);

        for (const fileFullPath of hlsBuild.files) {
          const fileName = path.basename(fileFullPath);
          await uploadToStorage(`${basePrefix}/${fileName}`, fileFullPath);
        }
        streamUrl = `${MEDIA_BASE_URL}/${basePrefix}/master.m3u8`;
      } catch (hlsErr) {
        console.warn(`⚠️ HLS transcoding gagal (${hlsErr.message}). Mengaktifkan circuit-breaker fallback ke Direct MKV/MP4...`);
        const ext = path.extname(videoFilePath).replace('.', '') || 'mkv';
        const videoKey = `${basePrefix}/video.${ext}`;
        streamUrl = await uploadToStorage(videoKey, videoFilePath);
      }
    } else {
      const ext = path.extname(videoFilePath).replace('.', '') || 'mkv';
      const videoKey = `${basePrefix}/video.${ext}`;
      streamUrl = await uploadToStorage(videoKey, videoFilePath);
    }

    await reportJobProgress(jobId, { status: 'uploading', percent: 90, log: `Mendaftarkan episode ke database Cloudflare D1...` });

    // 7. Registrasi ke Database D1 via Webhook /api/v1/internal/ingest
    const webhookRes = await fetch(`${WORKER_BASE_URL}/api/v1/internal/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anime_slug: anime.slug,
        episode_number: epNumber,
        title: `Episode ${epNumber}`,
        server_r2_url: streamUrl,
        sub_url: subIndoUrl,
        sub_type: subIndoUrl ? 'external' : 'embedded',
        available_subs: availableSubs,
        provider: 'nyaa',
        job_id: options.job_id || null,
      }),
    });
    const webhookJson = await webhookRes.json();
    console.log(`\n🎉 AUTO-INGEST SELESAI: ${anime.title} Episode ${epNumber}`);
    console.log(`   • Stream URL : ${streamUrl}`);
    console.log(`   • Sub Indo   : ${subIndoUrl || 'Embedded'}`);
    console.log(`   • Status D1  : ${webhookJson.message}\n`);

    await reportJobProgress(jobId, {
      status: 'completed',
      percent: 100,
      log: `Ingestion selesai! Stream URL: ${streamUrl}`,
      streamUrl,
      subIndoUrl
    });
  } catch (err) {
    await reportJobProgress(jobId, {
      status: 'failed',
      percent: 0,
      log: `Error eksekusi pipeline: ${err.message}`
    });
    throw err;
  } finally {
    // 8. Bersihkan disk sementara (Penting untuk Rolling Loop di Vast.ai / GitHub Actions!)
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// ==============================================================================
// COMMAND 3: ROLLING LOOP BATCH 1 SEASON PENUH (--range 1-12)
// ==============================================================================
async function handleBatchSeasonRolling(options) {
  const animeSlug = options.anime || options.slug;
  const rangeStr = options.range || '1-12';
  const mode = options.mode || 'hls';
  const isDryRun = !!options['dry-run'];

  if (!animeSlug) {
    console.error('❌ Parameter --anime <slug> wajib diisi! Contoh: --anime solo-leveling --range 1-12');
    process.exit(1);
  }

  const [startEp, endEp] = rangeStr.split('-').map(n => parseInt(n.trim(), 10));
  const searchData = await handleSearchNyaa({ anime: animeSlug, mode: 'batch' });
  const batchCandidate = searchData.recommended || searchData.batch_candidates?.[0];

  if (!batchCandidate) {
    console.error(`❌ Tidak ditemukan paket torrent Batch di Nyaa.si untuk "${animeSlug}".`);
    process.exit(1);
  }

  const firstEp = startEp || batchCandidate.batch_range?.start || 1;
  const lastEp = endEp || batchCandidate.batch_range?.end || 12;

  console.log(`\n======================================================================`);
  console.log(`📦 MEMULAI ROLLING BATCH INGEST: ${animeSlug} (Episode ${firstEp} s/d ${lastEp})`);
  console.log(`   Torrent Batch: ${batchCandidate.title}`);
  console.log(`   Storage      : ${STORAGE_DRIVER.toUpperCase()} (${MEDIA_BASE_URL})`);
  console.log(`======================================================================\n`);

  for (let ep = firstEp; ep <= lastEp; ep++) {
    console.log(`\n▶️  [ROLLING LOOP ${ep}/${lastEp}] Memproses Episode ${ep}...`);
    await handleAutoIngestNyaa({
      anime: animeSlug,
      ep: String(ep),
      magnet: batchCandidate.magnet,
      batch: true,
      mode,
      'dry-run': isDryRun,
    });
  }

  console.log(`\n🏆 SELURUH SEASON (${firstEp} - ${lastEp}) BERHASIL DIPROSES & DIUNGGAH!`);
}

// ==============================================================================
// COMMAND 4: VAST.AI WORKER DAEMON (AMBIL ANTREAN DARI ingestion_jobs)
// Siklus Hidup Cerdas (Smart Lifecycle):
// 1. Ambil antrean berikutnya via GET /api/v1/ingestion/jobs/next.
// 2. Jika ada job baru yang ditambahkan Admin saat job lain sedang diproses,
//    worker langsung mengambil job tersebut pada putaran loop berikutnya tanpa jeda.
// 3. Jika antrean kosong (0 queued):
//    - Memulai Grace Period / Idle Cooldown (Default: 300 detik / 5 menit).
//    - Jika admin memasukkan job dalam 5 menit ini, timer reset ke 0 & job diproses.
//    - Jika sampai 5 menit tidak ada job baru, worker otomatis mematikan instance Vast.ai.
// ==============================================================================
async function handleWorkerDaemon(options) {
  const runOnce = !!options.once;
  const mode = options.mode || 'hls';
  const workerNode = options.worker || process.env.WORKER_NODE || 'google-colab';
  const targetJobId = options.job || options['job-id'] || process.env.JOB_ID || null;
  const specificSlug = options.anime || options.slug || null;
  const autoStopEnabled = (process.env.VASTAI_AUTO_STOP || 'false').toLowerCase() === 'true';
  const idleTimeoutSeconds = parseInt(process.env.VASTAI_IDLE_TIMEOUT_SECONDS || '300', 10);
  const pollIntervalSeconds = 15;
  let accumulatedIdleSeconds = 0;

  console.log(`\n======================================================================`);
  console.log(`🤖 CLOUD INGESTION WORKER DAEMON BERJALAN (${workerNode})`);
  console.log(`   Storage Driver  : ${STORAGE_DRIVER.toUpperCase()} (${MEDIA_BASE_URL})`);
  console.log(`   Transcode Mode  : ${mode.toUpperCase()} (fMP4 Single-File Byte-Range)`);
  if (targetJobId) console.log(`   Specific Job ID : ${targetJobId}`);
  if (specificSlug) console.log(`   Filter Slug     : ${specificSlug}`);
  console.log(`   Auto-Stop Policy: ${autoStopEnabled ? `AKTIF (${idleTimeoutSeconds}s / ${(idleTimeoutSeconds / 60).toFixed(1)} menit Cooldown)` : 'STANDBY (Non-stop)'}`);
  console.log(`======================================================================\n`);

  while (true) {
    let nextJobData = null;
    try {
      const url = new URL(`${WORKER_BASE_URL}/api/v1/ingestion/jobs/next`);
      url.searchParams.set('worker', workerNode);
      if (targetJobId) url.searchParams.set('job_id', targetJobId);
      if (specificSlug) url.searchParams.set('anime', specificSlug);

      const res = await fetch(url.toString());
      const json = await res.json();
      nextJobData = json.data;
    } catch (fetchErr) {
      console.warn(`⚠️ Gagal menghubungi API server (${fetchErr.message}). Mencoba lagi dalam ${pollIntervalSeconds} detik...`);
    }

    if (!nextJobData) {
      if (runOnce) {
        console.log('🛑 [RUN-ONCE] Antrean kosong. Menghentikan worker.');
        break;
      }

      accumulatedIdleSeconds += pollIntervalSeconds;
      const remainingSeconds = Math.max(0, idleTimeoutSeconds - accumulatedIdleSeconds);

      if (autoStopEnabled) {
        console.log(`⏳ Antrean kosong (0 queued). Cooldown aktif: ${accumulatedIdleSeconds}/${idleTimeoutSeconds}s (Sisa ${(remainingSeconds / 60).toFixed(1)}m sebelum Auto-Stop)...`);

        if (accumulatedIdleSeconds >= idleTimeoutSeconds) {
          console.log(`\n🛑 IDLE TIMEOUT REACHED (${idleTimeoutSeconds}s tanpa job baru).`);
          console.log('⚡ Menjalankan prosedur penghentian mesin Vast.ai untuk memutus biaya sewa...');

          // 1. Hentikan instance via API Vast.ai jika kredensial tersedia
          const vastApiKey = process.env.VASTAI_API_KEY;
          const vastInstanceId = process.env.VASTAI_INSTANCE_ID;
          if (vastApiKey && vastInstanceId) {
            try {
              console.log(`📡 Memanggil Vast.ai API untuk menghentikan instance #${vastInstanceId}...`);
              const stopRes = await fetch(`https://cloud.vast.ai/api/v0/instances/${vastInstanceId}/stop/`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${vastApiKey}`, 'Content-Type': 'application/json' },
              });
              const stopJson = await stopRes.json();
              console.log('✅ Status Vast.ai Stop Response:', stopJson);
            } catch (apiErr) {
              console.warn(`⚠️ Vast.ai API stop error: ${apiErr.message}`);
            }
          }

          // 2. Coba shutdown sistem lokal VM/Container jika diizinkan
          try {
            console.log('🔌 Mengirim sinyal shutdown / poweroff ke sistem...');
            spawnSync('poweroff', [], { stdio: 'ignore' });
          } catch (_) {}

          console.log('👋 Worker daemon selesai.');
          break;
        }
      } else {
        const now = new Date().toLocaleTimeString('id-ID');
        console.log(`[${now}] ⏳ Antrean kosong. Colab Daemon Standby (GPU T4 Siap). Cek antrean lagi dalam ${pollIntervalSeconds}s...`);
      }

      await new Promise(r => setTimeout(r, pollIntervalSeconds * 1000));
      continue;
    }

    // JIKA MENEMUKAN JOB: Reset counter idle kembali ke 0 seketika!
    accumulatedIdleSeconds = 0;
    const job = nextJobData;

    console.log(`\n======================================================================`);
    console.log(`🔥 [JOB MASUK DARI ADMIN] [${job.id}]: ${job.anime_title || job.anime_slug} - Episode ${job.episode_number}`);
    console.log(`   Sumber : [${job.source_provider || 'nyaa'}] ${job.source_title || '-'}`);
    console.log(`   Status : Mengunci job dan memulai pemrosesan video + subtitle...`);
    console.log(`======================================================================\n`);

    try {
      await handleAutoIngestNyaa({
        anime: job.anime_slug,
        ep: String(job.episode_number),
        magnet: job.magnet_or_url,
        batch: job.source_type === 'batch',
        mode,
        job_id: job.id,
        jobData: job,
      });
      console.log(`\n🎉 Job [${job.id}] SELESAI DENGAN SUKSES!`);
      console.log(`🔄 Kembali ke mode standby mendengarkan antrean berikutnya...\n`);
    } catch (err) {
      console.error(`\n❌ Job [${job.id}] GAGAL:`, err.message);
      try {
        await fetch(`${WORKER_BASE_URL}/api/v1/ingestion/jobs/${job.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'failed',
            error_message: err.message,
          }),
        });
      } catch (_) {}
      console.log(`🔄 Kembali ke mode standby mendengarkan antrean berikutnya...\n`);
    }

    if (runOnce) break;
    // Loop kembali ke atas secara instan untuk memeriksa apakah admin menambahkan job baru saat job sebelumnya sedang berjalan!
  }
}

// ==============================================================================
// FUNGSI LEGACY (EPISODE MANUAL, SUBTITLE INJECT, CATALOG STATUS, BATCH SYNC)
// ==============================================================================
async function handleIngestEpisode(options) {
  const animeSlug = options.anime || options.slug;
  const epNumber = parseInt(options.ep || options.episode || '1', 10);
  const videoSource = options.video;
  const subSource = options.sub || options.subtitle;
  const customTitle = options.title || `Episode ${epNumber}`;
  const customThumb = options.thumb;
  const customFallback = options.fallback;
  const isDryRun = !!options['dry-run'];

  if (!animeSlug) {
    console.error('❌ Parameter --anime <slug> wajib disertakan! Contoh: --anime solo-leveling');
    process.exit(1);
  }

  console.log('\n======================================================');
  console.log(`🚀 MEMULAI PIPELINE INGESTION: ${animeSlug} - Episode ${epNumber}`);
  console.log('======================================================');

  const animes = await executeD1Query('SELECT id, title, slug, category, poster_url FROM animes WHERE slug = ? OR id = ?', [animeSlug, animeSlug]);
  if (!animes.length) {
    console.error(`❌ Anime dengan slug/id "${animeSlug}" tidak ditemukan di database D1!`);
    process.exit(1);
  }

  const anime = animes[0];
  const category = options.category || anime.category || 'anime';
  console.log(`📦 Anime: ${anime.title} (Kategori: ${category.toUpperCase()})`);

  let r2VideoUrl = '';
  let ext = 'mp4';

  if (videoSource) {
    if (videoSource.endsWith('.mkv')) ext = 'mkv';
    else if (videoSource.endsWith('.webm')) ext = 'webm';
    const basePrefix = `${category}/${anime.slug}/ep-${epNumber}`;
    const videoKey = `${basePrefix}/video.${ext}`;

    if (isDryRun) {
      console.log(`[DRY-RUN] Akan mengunggah video ke Storage key: ${videoKey}`);
      r2VideoUrl = `${MEDIA_BASE_URL}/${videoKey}`;
    } else {
      const videoBuffer = await getBufferFromPathOrUrl(videoSource);
      r2VideoUrl = await uploadToStorage(videoKey, videoBuffer);
    }
  } else {
    const basePrefix = `${category}/${anime.slug}/ep-${epNumber}`;
    const videoKey = `${basePrefix}/video.${ext}`;
    r2VideoUrl = `${MEDIA_BASE_URL}/${videoKey}`;
    console.log(`ℹ️  Menggunakan path standar Storage: ${r2VideoUrl}`);
  }

  let r2SubUrl = null;
  let subType = 'embedded';

  if (subSource) {
    const subExt = subSource.endsWith('.srt') ? 'srt' : 'ass';
    const basePrefix = `${category}/${anime.slug}/ep-${epNumber}`;
    const subKey = `${basePrefix}/sub.id.${subExt}`;

    if (isDryRun) {
      console.log(`[DRY-RUN] Akan mengunggah subtitle ke Storage key: ${subKey}`);
      r2SubUrl = `${MEDIA_BASE_URL}/${subKey}`;
      subType = 'external';
    } else {
      const subBuffer = await getBufferFromPathOrUrl(subSource);
      r2SubUrl = await uploadToStorage(subKey, subBuffer);
      subType = 'external';
    }
  }

  const episodeId = `${anime.id}-ep-${epNumber}`;
  const thumbnailUrl = customThumb || anime.poster_url;
  const fallbackUrl = customFallback || `https://stream.animeku.app/${anime.slug}-ep-${epNumber}/master.m3u8`;

  if (!isDryRun) {
    const existingEp = await executeD1Query('SELECT id FROM episodes WHERE id = ?', [episodeId]);

    if (existingEp.length > 0) {
      await executeD1Query(`
        UPDATE episodes SET
          title = ?, thumbnail_url = ?, server_r2_url = ?, server_fallback_url = ?,
          has_sub_indo = 1, sub_indo_type = ?, sub_indo_url = ?, available_subs = '["id", "en"]'
        WHERE id = ?
      `, [customTitle, thumbnailUrl, r2VideoUrl, fallbackUrl, subType, r2SubUrl, episodeId]);
      console.log(`🔄 Episode ${epNumber} berhasil DIPERBARUI di D1!`);
    } else {
      await executeD1Query(`
        INSERT INTO episodes (
          id, anime_id, episode_number, title, thumbnail_url,
          server_r2_url, server_fallback_url, has_sub_indo,
          sub_indo_type, sub_indo_url, available_subs, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, '["id", "en"]', datetime('now'))
      `, [episodeId, anime.id, epNumber, customTitle, thumbnailUrl, r2VideoUrl, fallbackUrl, subType, r2SubUrl]);
      console.log(`✨ Episode ${epNumber} baru berhasil DIDAFTARKAN di D1!`);
    }

    const countRes = await executeD1Query('SELECT COUNT(*) as total FROM episodes WHERE anime_id = ?', [anime.id]);
    const totalEps = countRes[0]?.total || epNumber;
    await executeD1Query("UPDATE animes SET total_episodes = MAX(total_episodes, ?), updated_at = datetime('now') WHERE id = ?", [totalEps, anime.id]);
  }
}

async function handleInjectSubtitle(options) {
  const animeSlug = options.anime || options.slug;
  const epNumber = parseInt(options.ep || options.episode || '1', 10);
  const subSource = options.sub || options.subtitle;
  const shouldTranslate = !!options.translate;

  if (!animeSlug || !subSource) {
    console.error('❌ Parameter --anime <slug> dan --sub <file/url> wajib disertakan!');
    process.exit(1);
  }

  const animes = await executeD1Query('SELECT id, title, slug, category, genres FROM animes WHERE slug = ? OR id = ?', [animeSlug, animeSlug]);
  if (!animes.length) {
    console.error(`❌ Anime "${animeSlug}" tidak ditemukan di D1!`);
    process.exit(1);
  }

  const anime = animes[0];
  const category = anime.category || 'anime';
  let subBuffer = await getBufferFromPathOrUrl(subSource);

  if (shouldTranslate) {
    console.log('🎭 Menerjemahkan subtitle dengan Animeku Smart Fansub Engine...');
    const genres = (() => { try { return JSON.parse(anime.genres || '[]'); } catch { return []; } })();
    const translated = await translateSubtitleContent(subBuffer.toString('utf8'), {
      format: subSource.endsWith('.srt') ? 'srt' : 'ass',
      category,
      genres,
      animeTitle: anime.title,
    });
    subBuffer = Buffer.from(translated.content, 'utf8');
  }

  const basePrefix = `${category}/${anime.slug}/ep-${epNumber}`;
  const subKey = `${basePrefix}/sub.id.ass`;
  const r2SubUrl = await uploadToStorage(subKey, subBuffer);

  const episodeId = `${anime.id}-ep-${epNumber}`;
  await executeD1Query(`
    UPDATE episodes SET has_sub_indo = 1, sub_indo_type = 'external', sub_indo_url = ?
    WHERE id = ? OR (anime_id = ? AND episode_number = ?)
  `, [r2SubUrl, episodeId, anime.id, epNumber]);

  console.log(`✅ Subtitle eksternal berhasil diinjeksi dan diupdate di D1: ${r2SubUrl}\n`);
}

async function handleCatalogStatus() {
  console.log('\n📊 MEMERIKSA STATUS KATALOG, EPISODE & ANTREAN INGESTION DI D1...');

  const totalAnimes = await executeD1Query('SELECT COUNT(*) as count FROM animes');
  const totalEpisodes = await executeD1Query('SELECT COUNT(*) as count FROM episodes');
  const activeR2 = await executeD1Query("SELECT COUNT(*) as count FROM episodes WHERE server_r2_url IS NOT NULL AND server_r2_url != ''");
  const subIndoAvailable = await executeD1Query('SELECT COUNT(*) as count FROM episodes WHERE has_sub_indo = 1');
  const queuedJobs = await executeD1Query("SELECT COUNT(*) as count FROM ingestion_jobs WHERE status = 'queued'");

  console.log('------------------------------------------------------');
  console.log(`Driver Storage Aktif            : ${STORAGE_DRIVER.toUpperCase()} (${MEDIA_BASE_URL})`);
  console.log(`Total Judul Anime/Donghua/Barat : ${totalAnimes[0]?.count || 0}`);
  console.log(`Total Episode Terdaftar         : ${totalEpisodes[0]?.count || 0}`);
  console.log(`Episode dengan Stream Utama     : ${activeR2[0]?.count || 0}`);
  console.log(`Episode dengan Sub Indo Aktif   : ${subIndoAvailable[0]?.count || 0}`);
  console.log(`Antrean Job Menunggu (Queued)   : ${queuedJobs[0]?.count || 0}`);
  console.log('------------------------------------------------------\n');
}

async function handleBatchSyncR2() {
  console.log('\n🔄 MEMULAI BATCH SINKRONISASI PATH STORAGE UNTUK EPISODE EMPTY...');
  const episodes = await executeD1Query(`
    SELECT e.id, e.anime_id, e.episode_number, a.slug, a.category
    FROM episodes e
    JOIN animes a ON e.anime_id = a.id
    WHERE e.server_r2_url IS NULL OR e.server_r2_url = ''
  `);

  for (const ep of episodes) {
    const category = ep.category || 'anime';
    const slug = ep.slug || ep.anime_id;
    const streamUrl = `${MEDIA_BASE_URL}/${category}/${slug}/ep-${ep.episode_number}.mp4`;
    await executeD1Query('UPDATE episodes SET server_r2_url = ? WHERE id = ?', [streamUrl, ep.id]);
  }
  console.log(`✅ Berhasil mensinkronkan ${episodes.length} episode ke ${MEDIA_BASE_URL}!\n`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0];
  const options = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.replace(/^--/, '');
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith('--')) {
        options[key] = nextArg;
        i++;
      } else {
        options[key] = true;
      }
    }
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArgs();

  switch (command) {
    case 'search':
    case 'nyaa':
      await handleSearchNyaa(options);
      break;

    case 'auto-ingest':
    case 'pull':
      await handleAutoIngestNyaa(options);
      break;

    case 'batch-season':
    case 'batch':
      await handleBatchSeasonRolling(options);
      break;

    case 'worker-daemon':
    case 'worker':
      await handleWorkerDaemon(options);
      break;

    case 'discover-series':
    case 'discover':
      await autoDiscoverNewSeries({
        executeD1Query,
        category: options.category || 'anime',
        limit: parseInt(options.limit || '4', 10),
        dryRun: !!options['dry-run'],
      });
      break;

    case 'translate-sub': {
      const inFile = options.in || options.sub;
      const outFile = options.out || (inFile ? inFile.replace(/(\.en)?\.(ass|srt)$/i, '.id.ass') : null);
      const cat = options.category || 'anime';
      if (!inFile || !fs.existsSync(inFile)) {
        console.error('❌ File input --in <path.en.ass> wajib ada!');
        process.exit(1);
      }
      const raw = fs.readFileSync(inFile, 'utf8');
      const res = await translateSubtitleContent(raw, {
        format: inFile.endsWith('.srt') ? 'srt' : 'ass',
        category: cat,
      });
      fs.writeFileSync(outFile, res.content, 'utf8');
      console.log(`✅ Smart Translate selesai -> ${outFile}`, res.stats);
      break;
    }

    case 'episode':
    case 'ingest':
      await handleIngestEpisode(options);
      break;

    case 'subtitle':
    case 'sub':
      await handleInjectSubtitle(options);
      break;

    case 'status':
    case 'catalog':
      await handleCatalogStatus();
      break;

    case 'sync-r2':
    case 'batch-sync':
      await handleBatchSyncR2();
      break;

    default:
      console.log(`
AnimeKU Multi-Storage & Smart Fansub Ingestion Pipeline CLI (Vast.ai / R2 / Hetzner)

PENGGUNAAN:
  node backend/scripts/ingest.js <command> [options]

COMMANDS BARU (NYAA.SI & VAST.AI PIPELINE):
  search         Cari torrent terbaik di Nyaa.si (4-Layer Smart Search & Scoring)
  auto-ingest    Download dari Nyaa.si (Single/Batch) -> Ekstrak/Smart Translate Sub -> Multi-Res HLS -> Upload
  batch-season   Rolling Loop 1 Season penuh dari torrent Batch (--range 1-12)
  translate-sub  Terjemahkan subtitle .en.ass/.srt ke .id.ass dengan Animeku Smart Fansub Engine
  worker-daemon  Jalankan daemon pekerja di Vast.ai untuk memproses antrean ingestion_jobs

COMMANDS STANDAR:
  episode        Upload file video/subtitle lokal atau URL ke Storage (R2/Hetzner) & D1
  subtitle       Injeksi file subtitle (.ass/.srt) ke episode (+ opsi --translate)
  status         Cek statistik katalog, storage driver aktif, dan antrean ingestion_jobs

CONTOH:
  # 1. Cari sumber terbaik di Nyaa.si (Prioritas Sub Indo)
  node backend/scripts/ingest.js search --anime solo-leveling --ep 1

  # 2. Auto-ingest 1 episode dari Nyaa.si ke Multi-Res HLS (1080p/720p/480p) + Smart Sub Indo
  node backend/scripts/ingest.js auto-ingest --anime solo-leveling --ep 1 --mode hls

  # 3. Rolling ingest 1 season penuh dari paket Batch
  node backend/scripts/ingest.js batch-season --anime solo-leveling --range 1-12 --mode hls

  # 4. Tes Smart Fansub Translator pada file subtitle Inggris
  node backend/scripts/ingest.js translate-sub --in ./ep1.en.ass --out ./ep1.id.ass --category donghua
      `);
      break;
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('\n❌ Fatal CLI Error:', err.message || err);
    process.exit(1);
  });
}

module.exports = {
  uploadToStorage,
  extractAndProcessSubtitleFromVideo,
  buildMultiResHlsFmp4,
  handleSearchNyaa,
  handleAutoIngestNyaa,
};
