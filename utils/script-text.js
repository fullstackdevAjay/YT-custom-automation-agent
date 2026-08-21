// Shared section-variant text extraction. A script section is shaped one of:
// { content: string[] | string }, { steps: [{title, description, tip}] },
// { items: [{number, title, description, impact}] }, { points: string[] }.
// Used by TTS formatting, SRT captions, slide rendering, and Shorts generation
// so the variant-handling logic exists in exactly one place.

function extractSectionLines(section = {}) {
  if (Array.isArray(section.content)) {
    return section.content
      .filter(line => typeof line === 'string' && !line.startsWith('['))
      .map(line => line.trim())
      .filter(Boolean);
  }

  if (typeof section.content === 'string') {
    return [section.content.trim()].filter(Boolean);
  }

  if (Array.isArray(section.steps)) {
    return section.steps.map(step => `${step.title}. ${step.description}`.trim());
  }

  if (Array.isArray(section.items)) {
    return section.items.map(item => `Number ${item.number}: ${item.title}. ${item.description}`.trim());
  }

  if (Array.isArray(section.points)) {
    return section.points.map(point => String(point).trim()).filter(Boolean);
  }

  return [];
}

function extractSectionText(section = {}) {
  return extractSectionLines(section).join(' ').trim();
}

module.exports = { extractSectionLines, extractSectionText };
