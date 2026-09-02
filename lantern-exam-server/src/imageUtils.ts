/**
 * Helper to convert standard Google Drive sharing weights or open URLs
 * into raw direct direct-embed image streams via the googleusercontent service.
 */
export function getDirectImageUrl(url: string | undefined): string {
  if (!url) return '';
  const trimmed = url.trim();

  // Match if it's a google drive domain link
  if (trimmed.includes('drive.google.com')) {
    // 1. Check for standard /file/d/FILE_ID/... format
    const dMatch = trimmed.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (dMatch && dMatch[1]) {
      return `https://lh3.googleusercontent.com/d/${dMatch[1]}`;
    }
    
    // 2. Check for alternative query parameter format id=FILE_ID
    const idMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idMatch && idMatch[1]) {
      return `https://lh3.googleusercontent.com/d/${idMatch[1]}`;
    }
  }
  return trimmed;
}
