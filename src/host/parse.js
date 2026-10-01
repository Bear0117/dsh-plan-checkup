/**
 * Split a plan's markdown into steps.
 *
 * Strategies, tried in order: top-level ordered list items, `##`/`###` sections,
 * top-level bullets, and finally the whole plan as one step. Nested items,
 * paragraphs and code blocks belong to the step above them. Lines inside code
 * fences are never read as list items or headings.
 * @module dsh-plan-checkup/parse
 */

const FENCE = /^(\s*)(`{3,}|~{3,})/
const ORDERED = /^( *)(\d{1,4})[.)]\s+(.*)$/
const BULLET = /^( *)[-*+]\s+(.*)$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const INLINE_CODE = /`([^`\n]+)`/g
const MAX_COMMANDS = 20

/** @typedef {{ index: number, text: string, firstLine: string, section: string | null, commands: string[], truncated: boolean, checked: boolean }} Step */
/** @typedef {{ title: string | null, intro: string, strategy: 'ordered' | 'headings' | 'bullets' | 'whole', steps: Step[], totalSteps: number }} ParsedPlan */

function indentOf(line) {
  const match = /^[ \t]*/.exec(line)
  return match === null ? 0 : match[0].replace(/\t/g, '    ').length
}

/** Strip emphasis, checkbox markers and trailing punctuation noise for a one-line label. */
function cleanLabel(text) {
  return text
    .replace(/^\[[ xX]\]\s+/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function fenceMap(lines) {
  const inFence = new Array(lines.length).fill(false)
  let open = null
  for (let i = 0; i < lines.length; i += 1) {
    const match = FENCE.exec(lines[i])
    if (open !== null) {
      inFence[i] = true
      if (match !== null && match[2][0] === open[0] && match[2].length >= open.length) open = null
    } else if (match !== null) {
      inFence[i] = true
      open = match[2]
    }
  }
  return inFence
}

function commandsOf(lines, inFenceFlags) {
  const commands = []
  let fenceOpen = false
  for (let i = 0; i < lines.length && commands.length < MAX_COMMANDS; i += 1) {
    const line = lines[i]
    if (inFenceFlags[i]) {
      const marker = FENCE.test(line)
      if (marker) {
        fenceOpen = !fenceOpen
        continue
      }
      if (fenceOpen && line.trim() !== '') commands.push(line.trim())
      continue
    }
    for (const match of line.matchAll(INLINE_CODE)) {
      if (commands.length >= MAX_COMMANDS) break
      commands.push(match[1].trim())
    }
  }
  return commands
}

/**
 * Collect the lines of one list-item step, stopping at a heading or at a new
 * top-level paragraph that follows a blank line.
 */
function listItemRegion(lines, inFence, start, end, markerIndent) {
  const region = [start]
  for (let j = start + 1; j < end; j += 1) {
    const line = lines[j]
    if (inFence[j]) {
      region.push(j)
      continue
    }
    if (HEADING.test(line)) break
    if (line.trim() === '') {
      region.push(j)
      continue
    }
    if (indentOf(line) > markerIndent) {
      region.push(j)
      continue
    }
    // Lazy continuation: an unindented line directly under text stays with the item.
    if (lines[j - 1] !== undefined && lines[j - 1].trim() !== '' && !ORDERED.test(line) && !BULLET.test(line)) {
      region.push(j)
      continue
    }
    break
  }
  while (region.length > 1 && lines[region[region.length - 1]].trim() === '') region.pop()
  return region
}

function sectionBefore(lines, inFence, index, titleIndex) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (i === titleIndex || inFence[i]) continue
    const heading = HEADING.exec(lines[i])
    if (heading !== null) return cleanLabel(heading[2])
  }
  return null
}

function buildStep(lines, inFence, region, firstText, section, stepChars) {
  const body = region.slice(1).map(i => lines[i])
  const indents = body.filter(line => line.trim() !== '').map(indentOf)
  const dedent = indents.length === 0 ? 0 : Math.min(...indents)
  const textLines = [firstText, ...body.map(line => line.slice(Math.min(dedent, indentOf(line))))]
  let text = textLines.join('\n').trim()
  let truncated = false
  if (text.length > stepChars) {
    text = `${text.slice(0, stepChars - 1)}…`
    truncated = true
  }
  const flags = region.map(i => inFence[i])
  return {
    text,
    firstLine: cleanLabel(firstText.split('\n')[0]) || cleanLabel(text.split('\n')[0]),
    section,
    commands: commandsOf([firstText, ...body], [false, ...flags.slice(1)]),
    truncated,
  }
}

/**
 * @param {string} markdown - the `plan` argument of `exit_plan_mode`.
 * @param {{ maxSteps: number, stepChars: number }} limits
 * @returns {ParsedPlan}
 */
export function parsePlan(markdown, limits) {
  const source = String(markdown ?? '').replace(/\r\n?/g, '\n')
  const lines = source.split('\n')
  const inFence = fenceMap(lines)

  let title = null
  let titleIndex = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (inFence[i]) continue
    const heading = HEADING.exec(lines[i])
    if (heading !== null && heading[1].length === 1) {
      title = cleanLabel(heading[2])
      titleIndex = i
      break
    }
  }

  const ordered = []
  const bullets = []
  const headings = { 2: [], 3: [] }
  for (let i = 0; i < lines.length; i += 1) {
    if (inFence[i] || i === titleIndex) continue
    const line = lines[i]
    const heading = HEADING.exec(line)
    if (heading !== null) {
      if (heading[1].length === 2 || heading[1].length === 3) headings[heading[1].length].push(i)
      continue
    }
    const orderedMatch = ORDERED.exec(line)
    if (orderedMatch !== null) {
      ordered.push({ line: i, indent: orderedMatch[1].length, text: orderedMatch[3] })
      continue
    }
    const bulletMatch = BULLET.exec(line)
    if (bulletMatch !== null) bullets.push({ line: i, indent: bulletMatch[1].length, text: bulletMatch[2] })
  }

  const topLevel = items => {
    if (items.length === 0) return []
    const min = Math.min(...items.map(item => item.indent))
    return items.filter(item => item.indent === min)
  }

  /** @type {Array<Omit<Step, 'index' | 'checked'>>} */
  let raw = []
  let strategy = 'whole'
  let firstBoundary = lines.length

  const fromItems = items => {
    const starts = items.map(item => item.line)
    return items.map((item, k) => {
      const end = k + 1 < starts.length ? starts[k + 1] : lines.length
      const region = listItemRegion(lines, inFence, item.line, end, item.indent)
      return buildStep(lines, inFence, region, item.text, sectionBefore(lines, inFence, item.line, titleIndex), limits.stepChars)
    })
  }

  const orderedTop = topLevel(ordered)
  const bulletTop = topLevel(bullets)
  const headingLevel = headings[2].length >= 2 ? 2 : headings[3].length >= 2 ? 3 : null

  if (orderedTop.length >= 2) {
    strategy = 'ordered'
    raw = fromItems(orderedTop)
    firstBoundary = orderedTop[0].line
  } else if (headingLevel !== null) {
    strategy = 'headings'
    const starts = headings[headingLevel]
    raw = starts.map((start, k) => {
      const end = k + 1 < starts.length ? starts[k + 1] : lines.length
      const region = []
      for (let i = start; i < end; i += 1) region.push(i)
      while (region.length > 1 && lines[region[region.length - 1]].trim() === '') region.pop()
      const heading = HEADING.exec(lines[start])
      return buildStep(lines, inFence, region, heading === null ? lines[start] : heading[2], null, limits.stepChars)
    })
    firstBoundary = starts[0]
  } else if (bulletTop.length >= 2) {
    strategy = 'bullets'
    raw = fromItems(bulletTop)
    firstBoundary = bulletTop[0].line
  } else {
    const bodyStart = titleIndex + 1
    const bodyLines = lines.slice(bodyStart)
    let text = bodyLines.join('\n').trim()
    if (text === '') text = title ?? ''
    let truncated = false
    if (text.length > limits.stepChars) {
      text = `${text.slice(0, limits.stepChars - 1)}…`
      truncated = true
    }
    const firstNonEmpty = bodyLines.find(line => line.trim() !== '' && !FENCE.test(line)) ?? title ?? ''
    raw = [{
      text,
      firstLine: cleanLabel(firstNonEmpty.replace(/^#+\s+/, '')),
      section: null,
      commands: commandsOf(bodyLines, inFence.slice(bodyStart)),
      truncated,
    }]
  }

  const introLines = []
  if (strategy !== 'whole') {
    for (let i = titleIndex + 1; i < firstBoundary; i += 1) {
      if (inFence[i] || HEADING.test(lines[i])) continue
      introLines.push(lines[i])
    }
  }
  const intro = introLines.join('\n').trim().slice(0, 400)

  const steps = raw.map((step, k) => ({ index: k + 1, ...step, checked: k < limits.maxSteps }))
  return { title, intro, strategy, steps, totalSteps: steps.length }
}
