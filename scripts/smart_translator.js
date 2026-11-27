#!/usr/bin/env node

/**
 * ==============================================================================
 * ANIMEKU SMART FANSUB ENGINE (UNLIMITED 3-ENGINE AI SUBTITLE TRANSLATOR)
 * ==============================================================================
 * Fitur Utama:
 * 1. AST Tag-Preserving (.ass / .srt): Mengunci semua tag {\pos...}, {\fad...}, \N
 * 2. 100% Unlimited 3-Engine Auto-Switch:
 *    - Engine 1: Local GPU Ollama di Vast.ai (qwen2.5:7b-instruct / 14b) -> 100% Unlimited
 *    - Engine 2: Free Cloud LLM API Rotation (Gemini 2.5 Flash Free Tier)
 *    - Engine 3: Unlimited Google GTX Batch + Animeku Fansub Polisher Engine (0 API Key)
 * 3. Genre-Adaptive Persona:
 *    - Donghua Kultivasi/Wuxia (Epik, Persilatan: Tetua, Sekte, Ranah, Bocah Tengik)
 *    - Anime Action/Dark Fantasy (Tajam, Sinematik, Istilah Hunter/Dungeon/Mana dijaga)
 *    - Anime Comedy/Slice of Life (Gaul Natural, Ekspresif, Lisan Indonesia)
 *    - Western Animation (Slang Modern & Sinematik Barat)
 * 4. Ciri Khas Visual Eksklusif "Animeku Studio":
 *    - Signature Opening Credit: "✦ Takarir Resmi oleh Animeku Studio ✦"
 *    - Auto Translator Notes ([Catatan: ...]) di bagian atas layar ({\an8})
 *    - Climax / Skill Emphasis Styling ({\b1\blur1.2}) pada teriakan jurus pamungkas
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');

// ==============================================================================
// 1. KAMUS ISTILAH, CATATAN FANSUB ([TL NOTE]) & POLISHER PER GENRE
// ==============================================================================
const FANSUB_TL_NOTES = [
  {
    trigger: /\b(courting death|seeking death)\b/i,
    category: 'donghua',
    note: 'Catatan: "Courting Death" (找死) — Ungkapan khas kultivator saat meremehkan lawan yang nekat menantang maut.',
  },
  {
    trigger: /\b(heavenly flame|sky fire|fenghuo|yihuo)\b/i,
    category: 'donghua',
    note: 'Catatan: "Api Langit" (異火) — Api purba langkah di dunia kultivasi dengan daya hancur dahsyat.',
  },
  {
    trigger: /\b(nascent soul|yuan ying)\b/i,
    category: 'donghua',
    note: 'Catatan: "Ranah Jiwa Murni (Nascent Soul)" — Tahap kultivasi tingkat tinggi di mana jiwa spiritual terbentuk.',
  },
  {
    trigger: /\b(golden core|jin dan|core formation)\b/i,
    category: 'donghua',
    note: 'Catatan: "Ranah Inti Emas (Golden Core)" — Tahap pemadatan energi spiritual menjadi inti kekuatan di Dantian.',
  },
  {
    trigger: /\b(qi condensation|foundation establishment)\b/i,
    category: 'donghua',
    note: 'Catatan: "Tahap Pondasi Spiritual" — Gerbang awal seorang kultivator melampaui fisik manusia fana.',
  },
  {
    trigger: /\b(heavenly tribulation|lightning tribulation)\b/i,
    category: 'donghua',
    note: 'Catatan: "Petir Kesengsaraan Langit" — Ujian petir ilahi yang harus dihadapi kultivator saat menembus ranah baru.',
  },
  {
    trigger: /\b(arise)\b/i,
    category: 'anime',
    note: 'Catatan: "Bangkitlah (Arise)" — Perintah ekstraksi bayangan milik Sang Raja Bayangan (Shadow Monarch).',
  },
  {
    trigger: /\b(domain expansion|ryoiki tenkai)\b/i,
    category: 'anime',
    note: 'Catatan: "Perluasan Wilayah (Domain Expansion)" — Teknik puncak manipulasi ruang kutukan dengan serangan pasti kena.',
  },
  {
    trigger: /\b(dungeon break)\b/i,
    category: 'anime',
    note: 'Catatan: "Dungeon Break" — Kondisi darurat saat gerbang dungeon gagal ditutup dan monster menyerbu dunia luar.',
  },
];

// Kamus Polisher Anti-Kaku (Mengubah kalimat harfiah robot menjadi diksi khas Fansub Animeku)
const DONGHUA_POLISH_RULES = [
  [/\b(?:kamu|anda|kau)\s+(?:sedang\s+)?(?:mencari|mendekati|mengundang)\s+kematian\b/gi, 'Cari mati kau'],
  [/\b(?:mencari|mendekati)\s+kematian\b/gi, 'cari mati'],
  [/\bpenatua\b/gi, 'Tetua'],
  [/\borang tua itu\b/gi, 'Tetua itu'],
  [/\bsaudara magang senior\b/gi, 'Kakak Senior'],
  [/\bsaudara magang junior\b/gi, 'Adik Junior'],
  [/\bsaudari magang senior\b/gi, 'Kakak Senior'],
  [/\bsaudari magang junior\b/gi, 'Adik Junior'],
  [/\brekan taois\b/gi, 'Rekan Daois'],
  [/\benergi spiritual(?:nya)?\b/gi, (m) => m.toLowerCase().endsWith('nya') ? 'Aura Spiritualnya' : 'Aura Spiritual'],
  [/\bpemurnian qi\b/gi, 'Pemurnian Qi'],
  [/\bapi surgawi\b/gi, 'Api Langit'],
  [/\balam\s+(inti\s+emas|jiwa\s+murni|kaisar|dewa|kultivasi)\b/gi, 'Ranah $1'],
  [/\bjunior yang (?:tidak|tak) tahu malu\b/gi, 'bocah tengik tak tahu malu'],
  [/\banak nakal\b/gi, 'bocah tengik'],
  [/\bbajingan kecil\b/gi, 'bocah tengik'],
  [/\bapakah Anda baik-baik saja\b/gi, 'Apa kau baik-baik saja'],
  [/\bSaya tidak menyangka\b/gi, 'Tak kusangka'],
  [/\bSaya akan membunuh Anda\b/gi, 'Akan kuhabisi kau'],
  [/\bAnda tidak punya pilihan\b/gi, 'Kau tak punya pilihan lagi'],
];

const ANIME_ACTION_POLISH_RULES = [
  [/\bapakah kamu baik-baik saja\b/gi, 'Kau tak apa-apa'],
  [/\bapakah Anda baik-baik saja\b/gi, 'Kau baik-baik saja'],
  [/\bapa yang sedang terjadi di sini\b/gi, 'Apa-apaan yang terjadi di sini'],
  [/\btidak mungkin!\b/gi, 'Mustahil!'],
  [/\bini tidak mungkin\b/gi, 'Mustahil'],
  [/\bkekuatan sihir\b/gi, 'tekanan mana'],
  [/\benergi sihir\b/gi, 'energi mana'],
  [/\bSaya tidak akan memaafkan Anda\b/gi, 'Takkan kumaafkan kau'],
  [/\bSaya akan mengalahkan Anda\b/gi, 'Akan kukalahkan kau'],
  [/\bJangan meremehkan saya\b/gi, 'Jangan remehkan aku'],
  [/\bMenyingkirlah dari jalanku\b/gi, 'Minggir dari hadapanku'],
  [/\bSialan kamu\b/gi, 'Keparat kau'],
];

const ANIME_COMEDY_POLISH_RULES = [
  [/\bapakah kamu serius\?/gi, 'Yang bener aja?!'],
  [/\bJangan bercanda dengan saya\b/gi, 'Jangan bercanda deh'],
  [/\bTunggu sebentar\b/gi, 'Bentar dulu'],
  [/\bApa yang kamu lakukan\?/gi, 'Lagi ngapain sih kamu?'],
  [/\bSaya sangat lelah\b/gi, 'Capek banget rasanya'],
];

function detectPersona(category = 'anime', genres = []) {
  const cat = String(category || 'anime').toLowerCase();
  const genreStr = (Array.isArray(genres) ? genres.join(' ') : String(genres || '')).toLowerCase();

  if (cat === 'donghua' || genreStr.includes('cultivation') || genreStr.includes('martial') || genreStr.includes('wuxia')) {
    return 'donghua_cultivation';
  }
  if (cat === 'western') {
    return 'western_cinematic';
  }
  if (genreStr.includes('comedy') || genreStr.includes('slice of life') || genreStr.includes('romance') || genreStr.includes('school')) {
    return 'anime_comedy';
  }
  return 'anime_action';
}

function getPersonaInstruction(persona) {
  switch (persona) {
    case 'donghua_cultivation':
      return `Gunakan gaya bahasa Fansub Donghua Kultivasi/Wuxia Indonesia yang epik, berwibawa, dan mengalir tajam. Gunakan diksi: "Tetua" (Elder), "Sekte" (Sect), "Ranah" (Realm), "Leluhur" (Ancestor), "Rekan Daois" (Fellow Daoist), "Kakak Senior/Adik Junior", dan "Cari mati kau, bocah tengik!" (Courting death). Hindari kata kaku seperti "Anda" untuk musuh (gunakan "Kau").`;
    case 'anime_comedy':
      return `Gunakan gaya bahasa Fansub Anime Comedy/Slice of Life Indonesia yang natural, ekspresif, luwes, dan enak dibaca anak muda (gunakan partikel seperti "deh", "dong", "kok", "lho", "Astaga", "Yang bener aja?!"). Jangan kaku seperti buku pelajaran.`;
    case 'western_cinematic':
      return `Gunakan gaya bahasa terjemahan sinematik Barat (seperti Netflix/Disney+ Indonesia resmi namun tetap hidup), adaptasikan idiom bahasa Inggris ke padanan emosi bahasa Indonesia yang natural.`;
    case 'anime_action':
    default:
      return `Gunakan gaya bahasa Fansub Anime Action/Dark Fantasy Indonesia yang tajam, hype, dan sinematik. Pertahankan istilah ikonik seperti Dungeon, Hunter, Rank-S, Guild, Mana, Skill, Domain Expansion, Senpai, -san, -sama. Gunakan "Aku/Kau" saat pertarungan agar terasa intens.`;
  }
}

function applyAnimekuFansubPolisher(translatedText, originalEngText, persona) {
  let out = String(translatedText || '').trim();
  const orig = String(originalEngText || '').trim();

  // 1. Terapkan aturan diksi sesuai persona
  if (persona === 'donghua_cultivation') {
    for (const [regex, replacement] of DONGHUA_POLISH_RULES) {
      out = out.replace(regex, replacement);
    }
  } else if (persona === 'anime_comedy') {
    for (const [regex, replacement] of ANIME_COMEDY_POLISH_RULES) {
      out = out.replace(regex, replacement);
    }
  } else {
    for (const [regex, replacement] of ANIME_ACTION_POLISH_RULES) {
      out = out.replace(regex, replacement);
    }
  }

  // 2. Pertahankan istilah ikonik yang sering salah diterjemahkan mesin
  if (/\bDungeon\b/i.test(orig) && /\bpenjara bawah tanah\b/i.test(out)) {
    out = out.replace(/\bpenjara bawah tanah\b/gi, 'Dungeon');
  }
  if (/\bHunter\b/i.test(orig) && /\bpemburu\b/i.test(out)) {
    out = out.replace(/\bpemburu\b/gi, 'Hunter');
  }
  if (/\bGuild\b/i.test(orig) && /\bserikat\b/i.test(out)) {
    out = out.replace(/\bserikat\b/gi, 'Guild');
  }
  const cleanOrigAlpha = orig.replace(/\{[^}]*\}/g, '').replace(/[^a-zA-Z]/g, '').toLowerCase();
  if (cleanOrigAlpha === 'arise') {
    out = 'Bangkitlah!';
  }

  // 3. Climax / Skill Emphasis Styling: jika teriakan pendek berenergi tinggi (! / ?!)
  const plainNoTags = out.replace(/\{[^}]*\}/g, '').trim();
  const isSkillShout =
    plainNoTags.endsWith('!') &&
    plainNoTags.length >= 4 &&
    plainNoTags.length <= 32 &&
    (/(!{2,}|\bBangkitlah|\bJurus|\bTeknik|\bApi\s+Langit|\bDomain\s+Expansion|\bBankai|\bRasengan|\bSerangan)/i.test(plainNoTags) ||
      orig === orig.toUpperCase());

  if (isSkillShout && !out.startsWith('{\\b1')) {
    out = `{\\b1}${out}{\\b0}`;
  }

  return out;
}

// ==============================================================================
// 2. AST TAG-PRESERVING MASKER UNTUK FILE .ASS
// ==============================================================================
function maskAssText(rawAssText) {
  const tags = [];
  // Lindungi tag {\...}
  let masked = String(rawAssText || '').replace(/\{[^}]*\}/g, (match) => {
    const idx = tags.length;
    tags.push(match);
    return `[[T${idx}]]`;
  });
  // Lindungi line break \N dan \n
  masked = masked.replace(/\\N/g, ' [[BR]] ').replace(/\\n/g, ' [[br]] ');
  return { masked: masked.trim(), tags };
}

function unmaskAssText(translatedMasked, tags) {
  let restored = String(translatedMasked || '');
  // Kembalikan line break
  restored = restored
    .replace(/\s*\[\[\s*BR\s*\]\]\s*/gi, '\\N')
    .replace(/\s*\[\[\s*br\s*\]\]\s*/g, '\\n');

  // Kembalikan tag {\...}
  restored = restored.replace(/\[\[\s*T(\d+)\s*\]\]/gi, (_, idxStr) => {
    const idx = parseInt(idxStr, 10);
    return tags[idx] !== undefined ? tags[idx] : '';
  });

  // Jika ada tag pembuka di awal asli yang hilang saat terjemahan, pasang kembali di depan
  for (let i = 0; i < tags.length; i++) {
    if (!restored.includes(tags[i]) && i === 0) {
      restored = `${tags[0]}${restored}`;
    }
  }

  return restored.trim();
}

// ==============================================================================
// 3. KONVERSI .SRT KE .ASS STANDAR STUDIO ANIMEKU
// ==============================================================================
function convertSrtToAss(srtContent, animeTitle = 'Animeku Series') {
  const header = `[Script Info]
; Script generated by Animeku Smart Fansub Engine
Title: ${animeTitle} - Takarir Indonesia Resmi Animeku Studio
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Plus Jakarta Sans,54,&H00FFFFFF,&H000000FF,&H00140E0A,&H80000000,-1,0,0,0,100,100,0,0,1,2.8,1.2,2,40,40,46,1
Style: AnimekuSign,Plus Jakarta Sans,30,&H0080E5FF,&H000000FF,&H00140E0A,&H80000000,-1,0,0,0,100,100,0.5,0,1,2.0,0.8,8,40,40,32,1
Style: AnimekuNote,Plus Jakarta Sans,32,&H0080E5FF,&H000000FF,&H00140E0A,&H96000000,-1,0,0,0,100,100,0,0,1,2.2,1.0,8,50,50,36,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const blocks = String(srtContent || '').replace(/\r\n/g, '\n').split(/\n\s*\n/);
  const events = [];

  const toAssTime = (srtTime) => {
    // 00:01:23,450 -> 0:01:23.45
    const m = String(srtTime || '').trim().match(/(\d+):(\d{2}):(\d{2})[,.](\d{2,3})/);
    if (!m) return '0:00:00.00';
    const h = parseInt(m[1], 10);
    const min = m[2];
    const sec = m[3];
    const cs = m[4].slice(0, 2).padEnd(2, '0');
    return `${h}:${min}:${sec}.${cs}`;
  };

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;
    const timeLineIdx = lines.findIndex(l => l.includes('-->'));
    if (timeLineIdx === -1) continue;

    const [startRaw, endRaw] = lines[timeLineIdx].split('-->');
    const textLines = lines.slice(timeLineIdx + 1).join('\\N').replace(/<\/?[^>]+(>|$)/g, '');
    if (!textLines.trim()) continue;

    events.push(`Dialogue: 0,${toAssTime(startRaw)},${toAssTime(endRaw)},Default,,0,0,0,,${textLines}`);
  }

  return header + events.join('\n') + '\n';
}

// ==============================================================================
// 4. 3-ENGINE UNLIMITED TRANSLATION PROVIDERS
// ==============================================================================

/**
 * ENGINE 1: Local GPU Ollama (Vast.ai) — 100% Unlimited Tanpa API Key
 */
async function tryTranslateWithOllama(linesBatch, persona, contextPrev = []) {
  const ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  const ollamaModel = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18000);

  try {
    const payload = linesBatch.map((text, idx) => ({ id: idx, text }));
    const prompt = `${getPersonaInstruction(persona)}
Terjemahkan array dialog subtitle berikut dari Bahasa Inggris ke Bahasa Indonesia yang natural dan tidak kaku.
Pertahankan placeholder seperti [[T0]], [[T1]], dan [[BR]] persis pada tempatnya.
Konteks dialog sebelumnya: ${JSON.stringify(contextPrev.slice(-4))}

Input JSON:
${JSON.stringify(payload)}

Balas HANYA dalam format JSON Array murni: [{"id": 0, "text": "..."}]`;

    const res = await fetch(`${ollamaHost}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
        prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0.3 },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    const parsed = JSON.parse(data.response);
    const arr = Array.isArray(parsed) ? parsed : (parsed.translations || parsed.items || parsed.data);
    if (!Array.isArray(arr) || arr.length !== linesBatch.length) return null;

    return arr.map((item, i) => String(item.text || linesBatch[i]));
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

/**
 * ENGINE 2: Free Cloud LLM API (Gemini 2.5 Flash Free Tier dengan Multi-Key Rotation)
 */
let geminiKeyCursor = 0;
async function tryTranslateWithGemini(linesBatch, persona, contextPrev = []) {
  const rawKeys = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  const keys = rawKeys.split(',').map(k => k.trim()).filter(Boolean);
  if (keys.length === 0) return null;

  const apiKey = keys[geminiKeyCursor % keys.length];
  geminiKeyCursor++;

  try {
    const payload = linesBatch.map((text, idx) => ({ id: idx, text }));
    const prompt = `${getPersonaInstruction(persona)}
Terjemahkan array JSON subtitle berikut ke Bahasa Indonesia ala Fansub profesional (luwes, tidak kaku).
Wajib pertahankan token [[T0]], [[T1]], [[BR]] apa adanya.
Konteks sebelumnya: ${JSON.stringify(contextPrev.slice(-4))}

Input:
${JSON.stringify(payload)}`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.3,
          },
        }),
      }
    );

    if (!res.ok) return null;
    const data = await res.json();
    const textOut = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textOut) return null;

    const parsed = JSON.parse(textOut);
    if (!Array.isArray(parsed) || parsed.length !== linesBatch.length) return null;
    return parsed.map((item, i) => String(item.text || linesBatch[i]));
  } catch {
    return null;
  }
}

/**
 * ENGINE 3: 100% Unlimited Google GTX Batch + Animeku Fansub Polisher (Tanpa API Key Sama Sekali)
 */
async function translateWithUnlimitedGtxBatch(linesBatch) {
  if (!linesBatch.length) return [];
  // Gabungkan dengan pemisah unik baris agar 1 HTTP call bisa menerjemahkan 40-50 baris sekaligus!
  const separator = '\n ||| \n';
  const joined = linesBatch.join(separator);

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=id&dt=t&q=${encodeURIComponent(joined)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
    });

    if (!res.ok) throw new Error(`GTX HTTP ${res.status}`);
    const data = await res.json();
    const fullTranslated = (data?.[0] || []).map(chunk => chunk?.[0] || '').join('');
    const splitParts = fullTranslated.split(/\s*\|\|\|\s*/);

    if (splitParts.length === linesBatch.length) {
      return splitParts.map(s => s.trim());
    }
  } catch {
    // Jika batch gabung gagal, fallback per-baris secara paralel
  }

  // Fallback paralel per item
  return Promise.all(
    linesBatch.map(async (line) => {
      if (!line.trim()) return line;
      try {
        const u = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=id&dt=t&q=${encodeURIComponent(line)}`;
        const r = await fetch(u);
        if (!r.ok) return line;
        const d = await r.json();
        return (d?.[0] || []).map(c => c?.[0] || '').join('').trim() || line;
      } catch {
        return line;
      }
    })
  );
}

// ==============================================================================
// 5. MAIN SMART FANSUB TRANSLATOR FUNCTION
// ==============================================================================
async function translateSubtitleContent(rawContent, options = {}) {
  const {
    format = 'ass',
    category = 'anime',
    genres = [],
    animeTitle = 'Animeku Series',
    batchSize = 40,
  } = options;

  const persona = detectPersona(category, genres);
  let assContent = rawContent;

  if (format === 'srt' || (!rawContent.includes('[Events]') && rawContent.includes('-->'))) {
    assContent = convertSrtToAss(rawContent, animeTitle);
  }

  // Pastikan Style AnimekuSign & AnimekuNote tersedia di blok [V4+ Styles]
  if (assContent.includes('[V4+ Styles]') && !assContent.includes('Style: AnimekuSign')) {
    assContent = assContent.replace(
      /(\[V4\+ Styles\][\s\S]*?Format:[^\n]*\n)/i,
      `$1Style: AnimekuSign,Plus Jakarta Sans,28,&H0080E5FF,&H000000FF,&H00140E0A,&H80000000,-1,0,0,0,100,100,0.5,0,1,2.0,0.8,8,40,40,28,1\nStyle: AnimekuNote,Plus Jakarta Sans,28,&H0080E5FF,&H000000FF,&H00140E0A,&H96000000,-1,0,0,0,100,100,0,0,1,2.2,1.0,8,50,50,34,1\n`
    );
  }

  const lines = assContent.replace(/\r\n/g, '\n').split('\n');
  const dialogueIndices = [];
  const dialogueEntries = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('Dialogue:')) {
      // Format: Dialogue: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
      const parts = line.split(',');
      if (parts.length >= 10) {
        const prefix = parts.slice(0, 9).join(',');
        const startTime = parts[1].trim();
        const endTime = parts[2].trim();
        const styleName = parts[3].trim();
        const rawText = parts.slice(9).join(',');

        // Jangan terjemahkan baris karaoke/typesetting gambar vektor (\p1)
        if (/\\p[1-9]/.test(rawText) || !rawText.replace(/\{[^}]*\}/g, '').trim()) {
          continue;
        }

        const { masked, tags } = maskAssText(rawText);
        dialogueIndices.push(i);
        dialogueEntries.push({
          lineIndex: i,
          prefix,
          startTime,
          endTime,
          styleName,
          rawText,
          masked,
          tags,
        });
      }
    }
  }

  let activeEngine = 'unlimited_gtx_fansub_polisher';
  const contextWindow = [];
  const injectedNotes = new Set();
  const extraNoteDialogues = [];

  // Proses per batch
  for (let b = 0; b < dialogueEntries.length; b += batchSize) {
    const chunk = dialogueEntries.slice(b, b + batchSize);
    const maskedTexts = chunk.map(c => c.masked);

    // Urutan Auto-Switch: 1. Ollama GPU Vast.ai -> 2. Gemini Free Rotation -> 3. Unlimited GTX + Polisher
    let translatedChunk = await tryTranslateWithOllama(maskedTexts, persona, contextWindow);
    if (translatedChunk) {
      activeEngine = 'vastai_ollama_local_gpu';
    } else {
      translatedChunk = await tryTranslateWithGemini(maskedTexts, persona, contextWindow);
      if (translatedChunk) {
        activeEngine = 'gemini_flash_free_tier';
      } else {
        translatedChunk = await translateWithUnlimitedGtxBatch(maskedTexts);
        activeEngine = 'unlimited_gtx_fansub_polisher';
      }
    }

    for (let j = 0; j < chunk.length; j++) {
      const entry = chunk[j];
      const rawTranslated = translatedChunk[j] || entry.masked;

      // Unmask tag {\...} & \N
      const unmasked = unmaskAssText(rawTranslated, entry.tags);

      // Poles dengan kamus diksi Animeku Smart Fansub & Skill Emphasis
      const polished = applyAnimekuFansubPolisher(unmasked, entry.rawText, persona);

      // Simpan ke context window
      contextWindow.push(polished.replace(/\{[^}]*\}/g, ''));
      if (contextWindow.length > 10) contextWindow.shift();

      // Update baris Dialogue
      lines[entry.lineIndex] = `${entry.prefix},${polished}`;

      // Cek apakah dialog mengandung istilah yang layak diberi [TL Note] di atas layar (maks 1 catatan per baris)
      for (const noteRule of FANSUB_TL_NOTES) {
        if (!injectedNotes.has(noteRule.note) && noteRule.trigger.test(entry.rawText)) {
          injectedNotes.add(noteRule.note);
          extraNoteDialogues.push(
            `Dialogue: 1,${entry.startTime},${entry.endTime},AnimekuNote,,0,0,0,,{\\fad(350,350)\\an8}[${noteRule.note}]`
          );
          break;
        }
      }
    }
  }

  // Suntikkan Signature Opening Credit "✦ Takarir Resmi oleh Animeku Studio ✦" & Auto TL Notes
  const signatureLine = `Dialogue: 1,0:00:04.00,0:00:10.50,AnimekuSign,,0,0,0,,{\\fad(600,600)\\an8\\b1}✦ Takarir Resmi oleh Animeku Studio ✦`;
  const eventsHeaderIdx = lines.findIndex(l => l.trim().startsWith('[Events]'));
  if (eventsHeaderIdx !== -1) {
    const insertPos = Math.min(eventsHeaderIdx + 2, lines.length);
    lines.splice(insertPos, 0, signatureLine, ...extraNoteDialogues);
  } else {
    lines.push(signatureLine, ...extraNoteDialogues);
  }

  return {
    content: lines.join('\n'),
    stats: {
      total_lines_translated: dialogueEntries.length,
      tl_notes_injected: extraNoteDialogues.length,
      persona_used: persona,
      engine_used: activeEngine,
    },
  };
}

/**
 * Menyuntikkan Signature Credit Animeku ke file Sub Indo bawaan (.id.ass)
 */
function injectAnimekuSignatureToExistingAss(rawAssContent) {
  let content = String(rawAssContent || '');
  if (content.includes('Takarir Resmi oleh Animeku Studio')) return content;

  if (content.includes('[V4+ Styles]') && !content.includes('Style: AnimekuSign')) {
    content = content.replace(
      /(\[V4\+ Styles\][\s\S]*?Format:[^\n]*\n)/i,
      `$1Style: AnimekuSign,Plus Jakarta Sans,28,&H0080E5FF,&H000000FF,&H00140E0A,&H80000000,-1,0,0,0,100,100,0.5,0,1,2.0,0.8,8,40,40,28,1\n`
    );
  }

  const sig = `Dialogue: 1,0:00:04.00,0:00:10.50,AnimekuSign,,0,0,0,,{\\fad(600,600)\\an8\\b1}✦ Takarir Resmi oleh Animeku Studio ✦`;
  if (content.includes('[Events]')) {
    content = content.replace(/(\[Events\][\s\S]*?Format:[^\n]*\n)/i, `$1${sig}\n`);
  }
  return content;
}

// Eksekusi via CLI langsung jika dipanggil mandiri
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const inFile = args[0];
    const outFile = args[1] || (inFile ? inFile.replace(/(\.en)?\.(ass|srt)$/i, '.id.ass') : null);
    const category = args[2] || 'anime';

    if (!inFile || !fs.existsSync(inFile)) {
      console.log('Penggunaan: node backend/scripts/smart_translator.js <input.en.ass/.srt> [output.id.ass] [anime|donghua|western]');
      process.exit(1);
    }

    console.log(`🎭 Memulai Animeku Smart Fansub Engine untuk: ${inFile} (Kategori: ${category})...`);
    const raw = fs.readFileSync(inFile, 'utf8');
    const ext = path.extname(inFile).replace('.', '').toLowerCase();
    const res = await translateSubtitleContent(raw, { format: ext, category });
    fs.writeFileSync(outFile, res.content, 'utf8');
    console.log(`✅ Selesai! Disimpan ke: ${outFile}`);
    console.log(`📊 Statistik:`, JSON.stringify(res.stats, null, 2));
  })();
}

module.exports = {
  translateSubtitleContent,
  injectAnimekuSignatureToExistingAss,
  convertSrtToAss,
  detectPersona,
  applyAnimekuFansubPolisher,
};
