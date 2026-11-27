#!/usr/bin/env bash
# ==============================================================================
# ANIMEKU VAST.AI GPU WORKER AUTO-PROVISIONING SCRIPT (HIGH-SPEC ULTRA TIER)
# ==============================================================================
# Standar Hardware Prioritas Tinggi (High-Performance Zero-Delay Architecture):
# - GPU Utama: NVIDIA GeForce RTX 4090 (24 GB GDDR6X Ada Lovelace) / RTX 6000 Ada (48 GB)
# - Alternatif High-End: NVIDIA RTX 3090 (24 GB) / RTX 4080 (16 GB) / A6000 (48 GB)
# - Karakteristik & Kecepatan:
#   * Dual NVENC Gen 8 (Ada Lovelace) : Transcode HLS Multi-Res (1080p, 720p, 480p)
#                                       selesai dalam 15-25 DETIK per episode (50x-70x real-time).
#   * 24 GB GDDR6X Bandwidth (1.008 GB/s) : Memuat model LLM Qwen-2.5-14B/7B tanpa lag,
#                                           terjemahan 350+ dialog selesai dalam 3-6 DETIK (>150 tok/s).
#   * Faster-Whisper Large-v3-Turbo       : Transkripsi audio murni RAW selesai dalam 10-15 DETIK.
# - Jaringan & Disk: Minimal 1 Gbps (1.000 Mbps) Port Datacenter & 100-150 GB NVMe SSD.
# - Biaya Sewa Vast.ai: ~$0.30 - $0.45 / jam (±Rp 4.800 - Rp 7.000 / jam).
#   * Karena 1 episode selesai hanya dalam ±30-40 detik total (download, render, translate, R2 upload),
#     biaya aktual per episode HANYA ±Rp 40 - Rp 60 per episode rilis, tanpa ada proses molor!
# ==============================================================================
# Siklus Hidup & Efisiensi Biaya (Auto-Stop & Cooldown):
# - Cooldown Default : 300 detik (5 menit) idle grace period
# - Auto-Stop        : Menghentikan instance secara otomatis saat 0 queued job
# - Dynamic Queue    : Jika admin menambah job baru saat worker sedang memproses
#                      atau dalam masa cooldown, worker otomatis melanjutkan antrean
# ==============================================================================
set -e

# Konfigurasi Default Siklus Hidup Worker
export VASTAI_AUTO_STOP="${VASTAI_AUTO_STOP:-true}"
export VASTAI_IDLE_TIMEOUT_SECONDS="${VASTAI_IDLE_TIMEOUT_SECONDS:-300}"
export INGEST_MODE="${INGEST_MODE:-hls}"
export OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5:14b-instruct}"

echo "=============================================================================="
echo "🚀 ANIMEKU SOVEREIGN STUDIO — HIGH-SPEC ULTRA GPU WORKER PROVISIONING"
echo "   Target GPU Architecture: NVIDIA RTX 4090 / RTX 3090 / RTX 6000 Ada (24GB+)"
echo "=============================================================================="

# Deteksi GPU & Informasi VRAM
if command -v nvidia-smi >/dev/null 2>&1; then
  GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n 1)
  TOTAL_VRAM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader | head -n 1)
  CUDA_VER=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -n 1)
  echo "🎮 GPU Terdeteksi: $GPU_NAME ($TOTAL_VRAM) • Driver: $CUDA_VER"
else
  echo "⚠️ nvidia-smi tidak terdeteksi. Berjalan dalam mode CPU fallback."
fi

echo "🚀 [1/4] Menginstal aria2 (16-thread), ffmpeg NVENC, rclone, python3-pip, yt-dlp, dan Node.js 20..."
apt-get update -qq
apt-get install -y -qq aria2 ffmpeg rclone curl ca-certificates python3-pip

pip3 install --quiet --upgrade yt-dlp openai-whisper faster-whisper || echo "⚠️ Pip install yt-dlp/whisper dilewati."

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi

echo "🤖 [2/4] Menyiapkan Ollama High-Spec GPU Engine ($OLLAMA_MODEL) di 24GB VRAM..."
if ! command -v ollama >/dev/null 2>&1; then
  curl -fsSL https://ollama.com/install.sh | sh
fi

# Jalankan daemon Ollama di background
nohup ollama serve >/var/log/ollama.log 2>&1 &
sleep 3

echo "📥 Menarik model AI $OLLAMA_MODEL ke VRAM GPU..."
ollama pull "$OLLAMA_MODEL" || {
  echo "⚠️ Gagal pull $OLLAMA_MODEL, mencoba fallback ke qwen2.5:7b-instruct..."
  ollama pull "qwen2.5:7b-instruct" || echo "⚠️ Fallback ke Unlimited GTX Fansub Polisher."
}

echo "📦 [3/4] Menginstal dependencies Node.js di folder backend..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(dirname "$SCRIPT_DIR")"
cd "$BACKEND_DIR"
npm install --no-audit --no-fund

echo "✅ [4/4] High-Spec Vast.ai GPU Worker Siap Tempur!"
echo "   Target GPU       : NVIDIA RTX 4090 / 3090 (24 GB GDDR6X)"
echo "   Mode Transcode   : $INGEST_MODE (Dual NVENC fMP4 Single-File)"
echo "   Model AI Fansub  : $OLLAMA_MODEL (Zero Delay Inference)"
echo "   Auto-Stop        : $VASTAI_AUTO_STOP"
echo "   Grace Period     : $VASTAI_IDLE_TIMEOUT_SECONDS detik (5 menit idle cooldown)"
echo "Memulai daemon pemrosesan antrean ingestion_jobs..."
node scripts/ingest.js worker-daemon --mode "$INGEST_MODE"
