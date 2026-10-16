// File types the Veritas OS viewer can show inside the OS (Chromium renders them natively: its PDF
// viewer, images, plain text and media). Anything else is shown in Files instead of leaving the OS.

export const VIEWABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico',
  '.avif',
  '.txt',
  '.md',
  '.markdown',
  '.log',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.ini',
  '.conf',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.h',
  '.cpp',
  '.css',
  '.sh',
  '.zsh',
  '.sql',
  '.mp4',
  '.webm',
  '.mov',
  '.m4v',
  '.mp3',
  '.wav',
  '.m4a',
  '.ogg',
  '.flac'
])

export function extensionOf(filePath: string): string {
  const match = /(\.[^./\\]+)$/.exec(filePath)

  return match ? match[1].toLowerCase() : ''
}

export function isViewable(filePath: string): boolean {
  return VIEWABLE_EXTENSIONS.has(extensionOf(filePath))
}
