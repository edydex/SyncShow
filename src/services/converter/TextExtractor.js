/**
 * Text Extractor
 *
 * Extracts text from PPTX files using pptxtojson library.
 * Returns slide-level text for the singer screen feature.
 */

const fs = require('fs').promises;

class TextExtractor {
  constructor() {
    // pptxtojson will be required dynamically to handle potential import issues
    this.pptxtojson = null;
  }

  /**
   * Load the pptxtojson library
   */
  async loadLibrary() {
    if (!this.pptxtojson) {
      try {
        // Use the CJS build for CommonJS compatibility
        this.pptxtojson = require('pptxtojson/dist/index.cjs');
      } catch (e) {
        console.warn('pptxtojson not available, text extraction will return empty results');
        this.pptxtojson = null;
      }
    }
    return this.pptxtojson;
  }

  /**
   * Strip HTML tags and decode common HTML entities
   * @param {string} html - HTML string
   * @returns {string} Plain text
   */
  stripHtml(html) {
    if (!html || typeof html !== 'string') return '';

    // Replace </p> with newlines to preserve paragraph breaks
    let text = html.replace(/<\/p>/gi, '\n');

    // Remove all other HTML tags
    text = text.replace(/<[^>]*>/g, '');

    // Decode common HTML entities
    text = text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(code));

    return text.trim();
  }

  /**
   * Extract text from all elements in a slide
   * @param {Object} slide - Slide object from pptxtojson
   * @returns {string} Combined text from all elements
   */
  extractSlideText(slide) {
    const textParts = [];

    if (!slide || !slide.elements) {
      return '';
    }

    for (const element of slide.elements) {
      if (element.type === 'text' && element.content) {
        // pptxtojson returns HTML strings in content
        if (typeof element.content === 'string') {
          const plainText = this.stripHtml(element.content);
          if (plainText) {
            textParts.push(plainText);
          }
        } else if (Array.isArray(element.content)) {
          // Handle array format (fallback)
          for (const part of element.content) {
            if (part.text) {
              textParts.push(part.text.trim());
            }
          }
        }
      } else if (element.type === 'shape' && element.text) {
        // Handle shapes with text
        const plainText = this.stripHtml(element.text);
        if (plainText) {
          textParts.push(plainText);
        }
      }
    }

    return textParts.filter(t => t.length > 0).join('\n');
  }

  /**
   * Find the first meaningful line of text (longer than 2 characters)
   * @param {string} text - Full text content
   * @returns {string} First meaningful line
   */
  findFirstLine(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 2);
    return lines.length > 0 ? lines[0] : '';
  }

  /**
   * Extract text from a PPTX file
   * @param {string} pptxPath - Path to PPTX file
   * @returns {Promise<Array<{text: string, firstLine: string}>>}
   */
  async extract(pptxPath) {
    const lib = await this.loadLibrary();

    if (!lib) {
      // Return empty results if library not available
      return [];
    }

    try {
      // Read the PPTX file
      const buffer = await fs.readFile(pptxPath);

      // Parse with pptxtojson
      const result = await lib.parse(buffer);

      if (!result || !result.slides) {
        return [];
      }

      // Extract text from each slide
      return result.slides.map(slide => {
        const text = this.extractSlideText(slide);
        const firstLine = this.findFirstLine(text);
        return { text, firstLine };
      });
    } catch (e) {
      console.error('Error extracting text from PPTX:', e.message);
      return [];
    }
  }
}

module.exports = TextExtractor;
