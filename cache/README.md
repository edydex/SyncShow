# SyncDisplay Cache Directory

This folder stores converted JPEG images from PowerPoint presentations.

## Structure
- `russian/` - Russian presentation slides
- `english/` - English presentation slides

Each folder contains:
- `slide_001.jpg` - Full resolution slides (1920x1080)
- `slide_001_thumb.jpg` - Thumbnail images (300px width)
- `metadata.json` - Slide text and metadata

## Notes
- This folder can be safely deleted to clear cache
- Images are regenerated when presentations are imported
- Approximately 1-3 MB per slide
