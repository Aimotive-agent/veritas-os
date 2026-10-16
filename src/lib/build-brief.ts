// "Build …" requests: the project folder name and the brief Hermes gets, which asks it to work in a
// way the Studio can show (files through the file tools, servers in the background, a preview).

const FILLER = new Set(['a', 'an', 'the', 'me', 'my', 'for', 'to', 'that', 'which', 'with', 'of', 'and', 'please', 'build', 'create', 'make', 'some', 'simple', 'new', 'nice', 'cool', 'little', 'small', 'where', 'can', 'i', 'we', 'our', 'in', 'on'])

/** A short folder name from a request: "a website for a hair salon" -> "website-hair-salon". */
export function projectSlug(goal: string): string {
  const words = goal
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(word => word && !FILLER.has(word))

  return words.slice(0, 4).join('-').slice(0, 48).replace(/-+$/, '') || 'project'
}

/** The first free folder name: `name`, then `name-2`, `name-3`, … */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) {
    return name
  }

  for (let n = 2; ; n++) {
    const candidate = `${name}-${n}`

    if (!taken.has(candidate)) {
      return candidate
    }
  }
}

export function buildBrief(goal: string, folder: string): string {
  return [
    `Build this: ${goal}`,
    '',
    `Work in the current working directory, ${folder}, a new empty project folder. The user is watching you build in the Veritas OS Studio (file tree, the file you are writing, your terminal commands, and a live preview), often by voice.`,
    '',
    '- Start with a short todo list (todo tool), then work through it.',
    '- Write files with write_file and change them with patch, not shell heredocs or echo, so each file appears in the Studio as you write it.',
    '- Work in small, visible steps: the person only sees a file once a tool call finishes, and a huge write_file looks frozen for a minute. Keep each write_file under about 120 lines; for a bigger file write a solid first version, then add the remaining sections with patch.',
    '- Prefer the simplest thing that looks great: a static site (index.html, styles.css, script.js) unless the request needs a framework. Make it polished: real copy, a clear layout, responsive, accessible.',
    '- If you need a dev server (a framework, an API), scaffold non-interactively, start it with terminal background=true, then run os_ui action=run command=studio.preview args={"url": "<the local address>"}. A static site previews itself from index.html.',
    '- Keep progress notes to one short sentence. Finish with two sentences: what you built and how to ask for changes.'
  ].join('\n')
}
