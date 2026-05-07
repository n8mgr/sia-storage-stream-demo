# Streaming-friendly WebM transcoder for the video-stream demo.
#
# jrottenberg/ffmpeg ships ffmpeg compiled with libvpx-vp9 + libopus, so we
# don't have to fight with whatever ffmpeg is on the host. The image is
# Ubuntu-based and supports linux/amd64 and linux/arm64 (Apple Silicon).
FROM jrottenberg/ffmpeg:7.1-ubuntu2404

WORKDIR /work

COPY transcode.sh /usr/local/bin/transcode
RUN chmod +x /usr/local/bin/transcode

ENTRYPOINT ["/usr/local/bin/transcode"]
