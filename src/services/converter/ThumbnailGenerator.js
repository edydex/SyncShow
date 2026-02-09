/**
 * Thumbnail Generator
 *
 * Generates thumbnail images from slide JPEGs using sharp.
 */

const path = require('path');
const fs = require('fs').promises;
const sharp = require('sharp');

class ThumbnailGenerator {
  constructor(options = {}) {
    this.options = {
      width: options.thumbnailWidth || 300,
      quality: options.thumbnailQuality || 85,
      ...options
    };
  }

  /**
   * Generate a thumbnail for a single slide
   * @param {string} slidePath - Path to slide JPEG
   * @param {string} thumbPath - Path for output thumbnail
   */
  async generateThumbnail(slidePath, thumbPath) {
    await sharp(slidePath)
      .resize(this.options.width, null, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: this.options.quality })
      .toFile(thumbPath);
  }

  /**
   * Generate thumbnails for all slides in a directory
   * @param {string} slideDir - Directory containing slide JPEGs
   * @returns {Promise<number>} Number of thumbnails generated
   */
  async generateAll(slideDir) {
    const files = await fs.readdir(slideDir);

    // Find all slide images (exclude existing thumbnails)
    const slideFiles = files.filter(f =>
      f.startsWith('slide_') &&
      f.endsWith('.jpg') &&
      !f.includes('_thumb')
    ).sort();

    for (const slideFile of slideFiles) {
      const slidePath = path.join(slideDir, slideFile);
      const thumbFile = slideFile.replace('.jpg', '_thumb.jpg');
      const thumbPath = path.join(slideDir, thumbFile);

      await this.generateThumbnail(slidePath, thumbPath);
    }

    return slideFiles.length;
  }
}

module.exports = ThumbnailGenerator;
