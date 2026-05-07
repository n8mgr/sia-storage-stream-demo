# tools/transcode

Containerised ffmpeg pipeline that turns any video into a streaming-friendly
4K-ish WebM (VP9 + Opus, Cues at the front of the file).

## Build

```bash
cd tools/transcode
docker build -t sia-transcode .
```

## Run

Mount the directory containing your input file and point at it with absolute
paths *inside* the container:

```bash
docker run --rm \
  -v "$HOME/Downloads:/work" \
  sia-transcode \
  /work/bbb_out.webm /work/bbb_4k_vp9.webm
```

Optional third argument is the target bitrate in Mbps (default `16`):

```bash
# 1080p-class file, drop the bitrate
docker run --rm -v "$HOME/Downloads:/work" sia-transcode \
  /work/in.mp4 /work/out.webm 8
```

## What it does

1. **Re-encode** to VP9 + Opus, capping wire bitrate so a 60 Mbps line has
   headroom for the multi-host fan-out. Keyframe every 2 s at 60 fps so
   seeks land quickly.
2. **Remux** with `-dash 1` so the Matroska Cues element is written at the
   start of the file. This is what makes browser seek snappy — without it
   the player has to fetch the tail of the file before it can map seek
   positions to byte offsets.

## Why a container

`libvpx-vp9` isn't compiled into every host's `ffmpeg` (especially minimal
homebrew variants), and `-dash 1` semantics differ slightly across ffmpeg
versions. Pinning to `jrottenberg/ffmpeg:7.1-ubuntu2404` removes both
variables.
