# Video Compressor 1.3.1

Bugfix release for reliable GPU encoding and tight file-size limits.

### Fixes
- NVIDIA/AMD hardware detection no longer fails on the startup probe (test frame was too small for NVENC/AMF).
- Long videos can reach tight size limits (e.g. ~2 hour 720p → 200 MB) by automatically lowering audio bitrate when needed.
- More aggressive size retries (up to 4) with a lower safe video bitrate floor.
- Added 48/64 kbps audio options for speech-heavy content.

### Requirements
- Windows
- FFmpeg and FFprobe installed separately.

### Installation
Download `Video-Compressor-1.3.1-Setup.exe` and run the installer.

Note: This release is currently unsigned, so Windows SmartScreen may display a warning.
