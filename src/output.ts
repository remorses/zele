// Output formatting utilities for zele CLI.
// Handles YAML output with TTY-aware coloring, date formatting,
// HTML-to-markdown email conversion (turndown), and stderr hints.
// Follows gogcli pattern: data to stdout, hints/progress to stderr.
//
// All structured data is output as YAML (js-yaml). In TTY mode, keys are
// colored cyan and values are left at the terminal default. In non-TTY mode,
// colors are disabled so piped output is plain, machine-parseable YAML.
// Line wrapping is set to Infinity (no folding) everywhere.

import yaml from 'js-yaml'
import TurndownService from 'turndown'
import { remark } from 'remark'
import pc from 'picocolors'
import EmailReplyParser from 'email-reply-parser'

// ---------------------------------------------------------------------------
// TTY detection (used for coloring + wrapping decisions)
// ---------------------------------------------------------------------------

const isTTY = process.stdout.isTTY ?? false

// ---------------------------------------------------------------------------
// Turndown instance (HTML -> Markdown)
// ---------------------------------------------------------------------------

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})

// Strip tracking pixels and tiny images
turndown.addRule('tracking-pixels', {
  filter: (node) => {
    if (node.nodeName !== 'IMG') return false
    const width = node.getAttribute('width')
    const height = node.getAttribute('height')
    if ((width === '1' || width === '0') && (height === '1' || height === '0')) return true
    const src = node.getAttribute('src') ?? ''
    if (src.includes('track') || src.includes('pixel') || src.includes('beacon')) return true
    return false
  },
  replacement: () => '',
})

// Strip <style>, <head>, <script> tags
turndown.addRule('strip-style', {
  filter: ['style', 'head', 'script'],
  replacement: () => '',
})

// Simplify images to [image: alt]
turndown.addRule('images', {
  filter: 'img',
  replacement: (_content, node) => {
    const alt = node.getAttribute('alt') ?? ''
    return alt ? `[image: ${alt}]` : ''
  },
})

// ---------------------------------------------------------------------------
// Email-specific turndown rules
// Email HTML heavily relies on layout tables. These are not data tables —
// they're used for positioning (like a 600px centered wrapper). We unwrap
// them so only the cell content survives as markdown.
// ---------------------------------------------------------------------------

// Strip common quoted-reply wrappers from Gmail/Outlook.
turndown.addRule('quoted-replies', {
  filter: (node) => {
    const hasClass = (name: string) => {
      const cls = node.getAttribute('class') ?? ''
      return new RegExp(`(^|\\s)${name}(\\s|$)`).test(cls)
    }

    if (node.nodeName === 'DIV') {
      if (hasClass('gmail_quote') || hasClass('gmail_extra')) return true
      const id = node.getAttribute('id') ?? ''
      if (id === 'appendonsend' || id === 'divRplyFwdMsg') return true
    }
    if (node.nodeName === 'BLOCKQUOTE') {
      const type = node.getAttribute('type') ?? ''
      if (type === 'cite') return true
    }
    return false
  },
  replacement: () => '',
})

// Unwrap layout tables: tables used for email layout (width, align, role="presentation")
// just pass through their text content instead of rendering as markdown tables.
turndown.addRule('layout-tables', {
  filter: (node) => {
    if (node.nodeName !== 'TABLE') return false
    const role = (node.getAttribute('role') ?? '').toLowerCase()
    if (role === 'presentation') return true

    // Heuristic: tables with explicit width or align are almost always layout
    const width = node.getAttribute('width') ?? ''
    const align = node.getAttribute('align') ?? ''
    if (width || align) return true

    // Tables with cellpadding/cellspacing/border="0" are layout tables
    const border = (node.getAttribute('border') ?? '').trim()
    const cellpadding = node.getAttribute('cellpadding') ?? ''
    const cellspacing = node.getAttribute('cellspacing') ?? ''
    if (border === '0' || cellpadding || cellspacing) return true

    return false
  },
  replacement: (content) => {
    // _content already has the inner text converted by turndown
    return content
  },
})

// Strip hidden/preheader elements.
turndown.addRule('hidden-elements', {
  filter: (node) => {
    const style = node.getAttribute('style') ?? ''
    if (/display\s*:\s*none/i.test(style)) return true
    if (/mso-hide\s*:\s*all/i.test(style)) return true
    if (node.hasAttribute('hidden')) return true

    const cls = node.getAttribute('class') ?? ''
    if (/(^|\s)preheader(\s|$)/.test(cls)) return true
    if (/(^|\s)preview-text(\s|$)/.test(cls)) return true

    return false
  },
  replacement: () => '',
})

// ---------------------------------------------------------------------------
// HTML -> Markdown conversion
// ---------------------------------------------------------------------------

export function htmlToMarkdown(html: string): string {
  // Pre-clean: remove common email noise
  const cleaned = html
    .replace(/<!\-\-[\s\S]*?\-\->/g, '') // HTML comments
    .replace(/<o:p>[\s\S]*?<\/o:p>/gi, '') // Outlook tags
    .replace(/<!\[if[\s\S]*?<!\[endif\]>/gi, '') // Outlook conditional comments

  let md = turndown.turndown(cleaned)

  // Replace non-breaking/zero-width spaces before remark sees them
  md = md.replace(/[\u00A0\u200B\u200C\u200D\uFEFF]/g, ' ')

  // Parse and re-serialize through remark for stable, normalized markdown.
  // This collapses whitespace, fixes list indentation, and validates structure.
  const normalized = remark().processSync(md).toString()

  // Remark escapes certain characters for markdown safety. Undo escapes that
  // hurt readability in terminal output:
  // - brackets: only for our synthetic [image: ...] placeholders
  // - ampersands: only inside link destination parens (URL readability)
  return normalized
    .replace(/\\\[image:/g, '[image:')
    .replace(/\(([^\n)]*)\)/g, (whole, inner: string) => {
      if (!/(https?:\/\/|mailto:)/i.test(inner)) return whole
      return `(${inner.replace(/\\&/g, '&')})`
    })
    .trim()
}

// ---------------------------------------------------------------------------
// Email body rendering (auto-detect HTML vs plain text)
// ---------------------------------------------------------------------------

export function renderEmailBody(body: string, mimeType: string): string {
  if (mimeType === 'text/html') return htmlToMarkdown(body)
  return body.trim()
}

// ---------------------------------------------------------------------------
// Quoted reply stripping (email-reply-parser)
// ---------------------------------------------------------------------------

export const replyParser = new EmailReplyParser()

// ---------------------------------------------------------------------------
// YAML output
// ---------------------------------------------------------------------------

/**
 * Colorize a YAML string for TTY output.
 * List dashes are cyan, keys are dimmed, values stay at terminal default.
 */
function colorizeYaml(yamlStr: string): string {
  return yamlStr.replace(
    /^(\s*)(- )?([\w_][\w_ ]*?)(:)/gm,
    (_match, indent, dash, key, colon) => {
      const prefix = dash ? `${indent}${pc.cyan(dash)}` : indent
      return `${prefix}${pc.dim(key)}${pc.dim(colon)}`
    },
  )
}

/** Print any value as YAML to stdout. */
export function printYaml(data: unknown): void {
  const str = yaml.dump(data, {
    lineWidth: Infinity,
    noRefs: true,
    quotingType: "'",
    sortKeys: false,
  })

  process.stdout.write(isTTY ? colorizeYaml(str) : str)
}

/**
 * Print a list of items as YAML with optional pagination.
 * Output shape:
 *   items:
 *     - key: value
 *   next_page: "token"
 */
export function printList(
  items: Record<string, unknown>[],
  opts?: { nextPage?: string | null },
): void {
  const doc: Record<string, unknown> = { items }
  if (opts?.nextPage) {
    doc.next_page = opts.nextPage
  }
  printYaml(doc)
}

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

export function formatDate(dateStr: string): string {
  if (!dateStr) return ''

  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return dateStr

  const now = Date.now()
  const diffMs = now - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  if (diffDays < 365) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// ---------------------------------------------------------------------------
// Calendar event time formatting
// ---------------------------------------------------------------------------

/**
 * Format event start/end times for display.
 * Same day: "Feb 10, 2:00 - 3:00 PM"
 * Different days: "Feb 10, 2:00 PM - Feb 11, 10:00 AM"
 * All-day single: "Feb 10"
 * All-day multi: "Feb 10 - Feb 12"
 */
export function formatEventTime(start: string, end: string, allDay = false): { start: string; end: string } {
  if (allDay) {
    const startDate = new Date(start + 'T00:00:00')
    const endDate = new Date(end + 'T00:00:00')
    // Calendar API uses exclusive end date for all-day events
    endDate.setDate(endDate.getDate() - 1)

    const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

    if (startDate.getTime() === endDate.getTime()) {
      const s = fmt(startDate)
      return { start: s, end: s }
    }
    return { start: fmt(startDate), end: fmt(endDate) }
  }

  const startDate = new Date(start)
  const endDate = new Date(end)

  const timeOpts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }
  const dateTimeOpts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }

  const sameDay = startDate.toDateString() === endDate.toDateString()

  if (sameDay) {
    const dateStr = startDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    const startTime = startDate.toLocaleTimeString(undefined, timeOpts)
    const endTime = endDate.toLocaleTimeString(undefined, timeOpts)
    return {
      start: `${dateStr}, ${startTime}`,
      end: endTime,
    }
  }

  return {
    start: startDate.toLocaleString(undefined, dateTimeOpts),
    end: endDate.toLocaleString(undefined, dateTimeOpts),
  }
}

// ---------------------------------------------------------------------------
// Sender formatting
// ---------------------------------------------------------------------------

export function formatSender(sender: { name?: string; email: string }): string {
  if (sender.name && sender.name !== sender.email) {
    return `${sender.name} <${sender.email}>`
  }
  return sender.email
}

// ---------------------------------------------------------------------------
// Status indicators
// ---------------------------------------------------------------------------

export function formatFlags(item: { unread?: boolean; starred?: boolean }): string {
  const parts: string[] = []
  if (item.starred) parts.push('starred')
  if (item.unread) parts.push('unread')
  return parts.join(', ')
}

// ---------------------------------------------------------------------------
// Stderr hints (following gogcli pattern: data to stdout, hints to stderr)
// ---------------------------------------------------------------------------

export function hint(msg: string): void {
  console.error(pc.dim(`# ${msg}`))
}

export function success(msg: string): void {
  console.error(pc.green(msg))
}

export function error(msg: string): void {
  console.error(pc.red(msg))
}

// ---------------------------------------------------------------------------
// Centralized command error handler (errore pattern)
// ---------------------------------------------------------------------------

import { AuthError } from './api-utils.js'

/** Handle any error from a client method in a command context.
 *  Prints a user-friendly message to stderr and exits.
 *  AuthError gets a "Try: zele login" hint; all others print their message. */
export function handleCommandError(err: Error): never {
  if (err instanceof AuthError) {
    error(`${err.message}. Try: zele login`)
  } else {
    error(err.message)
  }
  process.exit(1)
}
