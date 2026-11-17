# Video Compressor 1.3.2

Startup reliability fix.

### Fixes
- App window is forced to show if Chromium never emits `ready-to-show` (common on hybrid NVIDIA/AMD laptops).
- Only one app instance is allowed; a second click focuses the existing window instead of spawning hidden processes.
- Hardware acceleration is disabled on Windows to avoid GPU-init hangs that left the UI invisible.
- Shortcut restore and temp cleanup no longer delay the first window paint.

### Requirements
- Windows
- FFmpeg and FFprobe installed separately.

### Installation
Download `Video-Compressor-1.3.2-Setup.exe` and run the installer.

Note: This release is currently unsigned, so Windows SmartScreen may display a warning.
