#!/usr/bin/env bash
# Two-stage WebM pipeline:
#   1) re-encode to VP9 with streaming-friendly bitrate + GOP
#   2) remux with `-dash 1` so Cues land at the front of the file, which
#      lets <video> seek with a single Range request instead of scanning
#      to the end of the file first.
#
# Usage (inside the container):
#   transcode <input> <output> [target_mbps] [preset]
#
# preset:
#   fast      -deadline realtime -cpu-used 5    (~6-8x faster, OK quality)
#   balanced  -deadline good     -cpu-used 4    (~2-3x faster, good quality) [default]
#   quality   -deadline good     -cpu-used 1    (slow, archival quality)
#
# libvpx-vp9 is single-threaded-ish; even on a beefy CPU 4K60 in
# `quality` mode runs at ~0.15x realtime. Use `fast` for iteration.
set -euo pipefail

input="${1:?Usage: transcode <input> <output> [target_mbps] [fast|balanced|quality]}"
output="${2:?Usage: transcode <input> <output> [target_mbps] [fast|balanced|quality]}"
target_mbps="${3:-16}"
preset="${4:-balanced}"
max_mbps="$(( target_mbps * 3 / 2 ))"
buf_mbps="$(( target_mbps * 2 ))"

case "$preset" in
  fast)     speed_args=(-deadline realtime -cpu-used 5) ;;
  balanced) speed_args=(-deadline good     -cpu-used 4) ;;
  quality)  speed_args=(-deadline good     -cpu-used 1) ;;
  *) echo "Unknown preset '$preset' (expected fast|balanced|quality)" >&2; exit 1 ;;
esac

threads="$(nproc)"
tmp="$(mktemp --suffix=.webm)"
trap 'rm -f "$tmp"' EXIT

echo ">> Pass 1: VP9 transcode @ ${target_mbps} Mbps (cap ${max_mbps} Mbps), preset=$preset"
ffmpeg -hide_banner -y -i "$input" \
  -vf "format=yuv420p" \
  -c:v libvpx-vp9 \
  -b:v "${target_mbps}M" -maxrate "${max_mbps}M" -bufsize "${buf_mbps}M" \
  "${speed_args[@]}" \
  -row-mt 1 -tile-columns 4 -threads "$threads" \
  -g 120 -keyint_min 120 \
  -c:a libopus -b:a 128k \
  -f webm "$tmp"

echo ">> Pass 2: remux with Cues at front (-dash 1)"
ffmpeg -hide_banner -y -i "$tmp" -c copy -f webm -dash 1 "$output"

echo ">> Done: $output"
