// Output formatting utilities for gtui CLI.
// Handles JSON mode, table rendering (cli-table3), date formatting,
// HTML-to-markdown email conversion (turndown), and stderr hints.
// Follows gogcli pattern: data to stdout, hints/progress to stderr.

import Table from 'cli-table3'
import TurndownService from 'turndown'
import pc from 'picocolors'

// ---------------------------------------------------------------------------
// Turndown instance (HTML → Markdown)
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

// Strip <style> and <head> tags
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
// HTML → Markdown conversion
// ---------------------------------------------------------------------------

export function htmlToMarkdown(html: string): string {
  // Pre-clean: remove common email noise
  const cleaned = html
    .replace(/<!\-\-[\s\S]*?\-\->/g, '') // HTML comments
    .replace(/<o:p>[\s\S]*?<\/o:p>/gi, '') // Outlook tags

  const md = turndown.turndown(cleaned)

  // Post-clean: collapse excessive blank lines
  return md.replace(/\n{3,}/g, '\n\n').trim()
}

// ---------------------------------------------------------------------------
// Email body rendering (auto-detect HTML vs plain text)
// ---------------------------------------------------------------------------

export function renderEmailBody(body: string, mimeType: string): string {
  if (mimeType === 'text/html') {
    return htmlToMarkdown(body)
  }
  return body.trim()
}

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n')
}

// ---------------------------------------------------------------------------
// Table output
// ---------------------------------------------------------------------------

export interface TableOptions {
  head: string[]
  rows: (string | number)[][]
  colWidths?: number[]
  colAligns?: Array<'left' | 'center' | 'right'>
}

export function printTable({ head, rows, colWidths, colAligns }: TableOptions): void {
  // NOTE: cli-table3 crashes if colWidths/colAligns are explicitly `undefined`
  // (it treats the key as present but skips auto-compute). Only spread when defined.
  const table = new Table({
    head: head.map((h) => pc.bold(pc.cyan(h))),
    ...(colWidths ? { colWidths } : {}),
    ...(colAligns ? { colAligns } : {}),
    style: {
      head: [],
      border: [],
      compact: false,
    },
    chars: {
      top: '─',
      'top-mid': '┬',
      'top-left': '┌',
      'top-right': '┐',
      bottom: '─',
      'bottom-mid': '┴',
      'bottom-left': '└',
      'bottom-right': '┘',
      left: '│',
      'left-mid': '├',
      mid: '─',
      'mid-mid': '┼',
      right: '│',
      'right-mid': '┤',
      middle: '│',
    },
  })

  for (const row of rows) {
    table.push(row.map(String))
  }

  process.stdout.write(table.toString() + '\n')
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
// Sender formatting
// ---------------------------------------------------------------------------

export function formatSender(sender: { name?: string; email: string }): string {
  if (sender.name && sender.name !== sender.email) {
    return sender.name
  }
  return sender.email
}

export function formatSenderFull(sender: { name?: string; email: string }): string {
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
  if (item.starred) parts.push(pc.yellow('★'))
  if (item.unread) parts.push(pc.blue('●'))
  return parts.join(' ')
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 1) + '…'
}

// ---------------------------------------------------------------------------
// Stderr hints (following gogcli pattern: data to stdout, hints to stderr)
// ---------------------------------------------------------------------------

export function hint(msg: string): void {
  process.stderr.write(pc.dim(`# ${msg}`) + '\n')
}

export function success(msg: string): void {
  process.stderr.write(pc.green(msg) + '\n')
}

export function error(msg: string): void {
  process.stderr.write(pc.red(msg) + '\n')
}

// ---------------------------------------------------------------------------
// Pagination hint
// ---------------------------------------------------------------------------

export function printNextPageHint(nextPageToken: string | null): void {
  if (nextPageToken) {
    hint(`Next page: --page ${nextPageToken}`)
  }
}
