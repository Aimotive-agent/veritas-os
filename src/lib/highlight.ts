import type { HighlighterCore, ThemedToken } from 'shiki/core'

// Syntax colouring for the Studio's code view. Shiki is loaded on first use with the JavaScript
// regex engine (no WASM, no eval) and only the languages a website or small app needs.

const THEME = 'github-dark-default'
const MAX_CHARS = 400_000

const LANGS = {
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  astro: () => import('shiki/langs/astro.mjs')
} as const

type Lang = keyof typeof LANGS

const BY_EXTENSION: Record<string, Lang> = {
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  yml: 'yaml',
  yaml: 'yaml',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro'
}

export function languageFor(path: string): Lang | null {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''

  return BY_EXTENSION[extension] ?? null
}

let highlighter: Promise<HighlighterCore> | null = null
const loaded = new Set<Lang>()

async function core(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, theme] = await Promise.all([import('shiki/core'), import('shiki/engine/javascript'), import('shiki/themes/github-dark-default.mjs')])

    return createHighlighterCore({ themes: [theme.default], langs: [], engine: createJavaScriptRegexEngine() })
  })()

  return highlighter
}

/** Coloured tokens per line, or null when the language is unknown or the file too big to colour. */
export async function highlightLines(code: string, path: string): Promise<ThemedToken[][] | null> {
  const lang = languageFor(path)

  if (!lang || code.length > MAX_CHARS) {
    return null
  }

  const instance = await core()

  if (!loaded.has(lang)) {
    await instance.loadLanguage((await LANGS[lang]()).default)
    loaded.add(lang)
  }

  return instance.codeToTokens(code, { lang, theme: THEME }).tokens
}
