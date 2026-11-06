# Video Compressor 1.3.0

This release introduces a major performance and reliability improvement.

### Performance
- Added NVIDIA NVENC, AMD AMF and Intel QSV hardware encoding support.
- Automatic encoder selection based on available hardware.
- Adaptive concurrency for faster batch processing.
- Improved job scheduling: lighter videos are processed first.
- Optimized encoding presets and batch throughput.

### Reliability
- Improved parallel output-file handling.
- More reliable cancellation of individual jobs and batches.
- Improved FFmpeg error reporting.
- Automatic cleanup of stale temporary files.
- More robust handling of failed compression jobs.
- Improved validation of output files and size limits.

### User experience
- Redesigned Windows 11 / Fluent interface.
- Light, dark and system themes.
- Improved batch queue and runtime information.
- Compression history and persistent settings.

### Requirements
- Windows
- FFmpeg and FFprobe installed separately.

### Installation
Download `Video-Compressor-1.3.0-Setup.exe` and run the installer.

Note: This release is currently unsigned, so Windows SmartScreen may display a warning.
