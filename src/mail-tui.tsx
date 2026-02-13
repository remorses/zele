// Termcast email extension — browse and read emails in a Raycast-like TUI.
// Uses List with detail view, sections for date grouping, infinite scroll via
// useCachedPromise pagination, and a dropdown for account selection.
// Reuses existing GmailClient, auth, and email-to-markdown conversion from the CLI.
//
// gaxios (used by googleapis) checks `typeof window !== 'undefined'` to decide whether
// to use window.fetch or import('node-fetch'). Termcast provides a window global (for
// the Raycast UI runtime) but without fetch. gaxios sees window exists → tries
// window.fetch → gets undefined → "fetchImpl is not a function". Fix: ensure
// window.fetch is set to the native Bun fetch.
const globalWithWindow = globalThis as unknown as {
  window?: { fetch?: typeof globalThis.fetch }
}
if (
  typeof globalThis.fetch === 'function' &&
  typeof globalWithWindow.window?.fetch !== 'function'
) {
  globalWithWindow.window = {
    ...globalWithWindow.window,
    fetch: globalThis.fetch,
  }
}

import {
  Action,
  ActionPanel,
  Color,
  Detail,
  Form,
  Icon,
  List,
  showToast,
  Toast,
  useNavigation,
  showFailureToast,
} from 'termcast'
import { useTerminalDimensions } from '@opentui/react'
import { useCachedPromise } from '@termcast/utils'
import { useState, useMemo, useCallback, useEffect } from 'react'

import {
  getClients,
  getClient,
  listAccounts,
  login,
  logout,
  type AuthStatus,
} from './auth.js'
import type { GmailClient, ThreadListItem, ThreadData } from './gmail-client.js'
import { AuthError, ApiError, isTruthy } from './api-utils.js'
import {
  renderEmailBody,
  replyParser,
  formatDate,
  formatSender,
} from './output.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 25
const MIN_PAGE_SIZE = 10
const VISIBLE_ROWS_OFFSET = 6

/** Spacing mode for the mail list. 'relaxed' renders each item as 3 lines. */
const LIST_SPACING_MODE: 'default' | 'relaxed' = 'relaxed'
const LINES_PER_ITEM = LIST_SPACING_MODE === 'relaxed' ? 3 : 1

const ACCOUNT_COLORS = [
  Color.Blue,
  Color.Green,
  Color.Purple,
  Color.Orange,
  Color.Magenta,
]

const ADD_ACCOUNT = '__add_account__'
const MANAGE_ACCOUNTS = '__manage_accounts__'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function accountColor(email: string): string {
  let hash = 0
  for (const c of email) hash = ((hash << 5) - hash + c.charCodeAt(0)) | 0
  return ACCOUNT_COLORS[Math.abs(hash) % ACCOUNT_COLORS.length]!
}

/** Classify a date string into a section bucket. */
function dateSection(dateStr: string): string {
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return 'Older'

  const now = new Date()
  const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000)
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)
  const weekAgo = new Date(today.getTime() - 7 * 86400000)
  const monthAgo = new Date(today.getTime() - 30 * 86400000)

  if (date >= tenMinutesAgo) return 'Last 10 Minutes'
  if (date >= oneHourAgo) return 'Last Hour'
  if (date >= today) return 'Today'
  if (date >= yesterday) return 'Yesterday'
  if (date >= weekAgo) return 'This Week'
  if (date >= monthAgo) return 'This Month'
  return 'Older'
}

const SECTION_ORDER = [
  'Last 10 Minutes',
  'Last Hour',
  'Today',
  'Yesterday',
  'This Week',
  'This Month',
  'Older',
]

function threadStatusIcon(thread: ThreadListItem & { starred?: boolean }): {
  source: (typeof Icon)[keyof typeof Icon]
  tintColor: string
} {
  const unread = thread.unread
  const starred = thread.labelIds?.includes('STARRED') ?? false

  if (unread && starred) return { source: Icon.Star, tintColor: Color.Red }
  if (unread) return { source: Icon.CircleFilled, tintColor: Color.Yellow }
  if (starred) return { source: Icon.Star, tintColor: Color.Orange }
  return { source: Icon.Circle, tintColor: Color.SecondaryText }
}

/** Extended thread item with account info. */
interface ThreadItem extends ThreadListItem {
  account: string
}

type MailCursor =
  | { mode: 'single'; nextPageToken?: string }
  | { mode: 'multi'; nextByAccount: Record<string, string | null> }

function getPageSizeFromTerminalHeight(rows?: number): number {
  if (typeof rows !== 'number' || rows <= 0) return DEFAULT_PAGE_SIZE
  const visibleRows = rows - VISIBLE_ROWS_OFFSET
  const itemCount = Math.floor(visibleRows / LINES_PER_ITEM)
  return Math.max(MIN_PAGE_SIZE, itemCount)
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

function useAccounts() {
  return useCachedPromise(async () => {
    const accounts = await listAccounts()
    return accounts
  }, [])
}

// ---------------------------------------------------------------------------
// Account Dropdown
// ---------------------------------------------------------------------------

function AccountDropdown({
  accounts,
  value,
  onChange,
  onAdded,
  onRemoved,
}: {
  accounts: { email: string; appId: string }[]
  value: string
  onChange: (value: string) => void
  onAdded?: (email: string) => void | Promise<void>
  onRemoved?: (email: string) => void | Promise<void>
}) {
  const { push } = useNavigation()

  return (
    <List.Dropdown
      tooltip='Account'
      value={value}
      onChange={(newValue) => {
        if (newValue === ADD_ACCOUNT) {
          push(<AddAccount onAdded={onAdded} />)
          return
        }
        if (newValue === MANAGE_ACCOUNTS) {
          push(<ManageAccounts onAdded={onAdded} onRemoved={onRemoved} />)
          return
        }
        onChange(newValue)
      }}
    >
      <List.Dropdown.Item title='All Accounts' value='all' icon={Icon.Globe} />
      <List.Dropdown.Section title='Accounts'>
        {accounts.map((a) => (
          <List.Dropdown.Item
            key={a.email}
            title={a.email}
            value={a.email}
            icon={{
              source: Icon.Person,
              tintColor: accountColor(a.email),
            }}
          />
        ))}
      </List.Dropdown.Section>
      <List.Dropdown.Section title='Manage Accounts'>
        <List.Dropdown.Item
          title='Add Account'
          value={ADD_ACCOUNT}
          icon={Icon.Plus}
        />
        <List.Dropdown.Item
          title='Manage Accounts'
          value={MANAGE_ACCOUNTS}
          icon={Icon.Gear}
        />
      </List.Dropdown.Section>
    </List.Dropdown>
  )
}

// ---------------------------------------------------------------------------
// Add Account (interactive login)
// ---------------------------------------------------------------------------

function AddAccount({
  onAdded,
}: {
  onAdded?: (email: string) => void | Promise<void>
}) {
  const { pop } = useNavigation()
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [didAutoStart, setDidAutoStart] = useState(false)

  const handleLogin = async () => {
    if (isLoggingIn) return

    setIsLoggingIn(true)
    const result = await login(undefined, {
      openBrowser: true,
      allowManualCodeEntry: false,
      showInstructions: false,
    })
    setIsLoggingIn(false)

    if (result instanceof Error) {
      await showFailureToast(result, { title: 'Failed to add account' })
      return
    }

    await onAdded?.(result.email)
    await showToast({
      style: Toast.Style.Success,
      title: `Added ${result.email}`,
    })
    pop()
  }

  useEffect(() => {
    if (didAutoStart) return
    setDidAutoStart(true)
    void handleLogin()
  }, [didAutoStart])

  return (
    <Detail
      navigationTitle='Add Account'
      markdown={
        `# Add Account\n\n` +
        `The browser opens automatically for Google sign-in.\n\n` +
        `Complete login in the browser, then come back here. ` +
        `This screen waits for the localhost callback and will finish automatically.`
      }
      actions={
        <ActionPanel>
          <Action
            title={isLoggingIn ? 'Waiting for Login...' : 'Open Browser Again'}
            icon={Icon.Globe}
            onAction={handleLogin}
          />
        </ActionPanel>
      }
    />
  )
}

// ---------------------------------------------------------------------------
// Manage Accounts
// ---------------------------------------------------------------------------

function ManageAccounts({
  onAdded,
  onRemoved,
}: {
  onAdded?: (email: string) => void | Promise<void>
  onRemoved?: (email: string) => void | Promise<void>
}) {
  const accounts = useAccounts()

  const handleAdded = async (email: string) => {
    await accounts.revalidate()
    await onAdded?.(email)
  }

  const handleRemoved = async (email: string) => {
    const result = await logout(email)
    if (result instanceof Error) {
      await showFailureToast(result, {
        title: `Failed to remove ${email}`,
      })
      return
    }

    await accounts.revalidate()
    await onRemoved?.(email)
    await showToast({
      style: Toast.Style.Success,
      title: `Removed ${email}`,
    })
  }

  return (
    <List navigationTitle='Manage Accounts' isLoading={accounts.isLoading}>
      {accounts.data?.map((a: AuthStatus) => (
        <List.Item
          key={`${a.email}-${a.appId}`}
          title={a.email}
          icon={{
            source: Icon.Person,
            tintColor: accountColor(a.email),
          }}
          accessories={[
            {
              tag: {
                value: a.appId.slice(0, 12) + '...',
                color: Color.SecondaryText,
              },
            },
          ]}
          actions={
            <ActionPanel>
              <Action.CopyToClipboard title='Copy Email' content={a.email} />
              <Action
                title='Logout Account'
                icon={Icon.Trash}
                onAction={() => handleRemoved(a.email)}
              />
            </ActionPanel>
          }
        />
      ))}
      <List.Item
        key='add-account'
        title='Add Account'
        icon={Icon.Plus}
        actions={
          <ActionPanel>
            <Action.Push
              title='Add Account'
              target={<AddAccount onAdded={handleAdded} />}
            />
          </ActionPanel>
        }
      />
    </List>
  )
}

// ---------------------------------------------------------------------------
// Compose Form (unified: reply, reply all, forward)
// ---------------------------------------------------------------------------

type ComposeMode =
  | { type: 'reply'; threadId: string; replyAll?: boolean }
  | { type: 'forward'; threadId: string }

interface ComposeFormProps {
  mode: ComposeMode
  initialAccount: string
  accounts: AuthStatus[]
  onSent?: () => void
}

function ComposeForm({ mode, initialAccount, accounts, onSent }: ComposeFormProps) {
  const { pop } = useNavigation()
  const [isLoading, setIsLoading] = useState(false)
  const [selectedAccount, setSelectedAccount] = useState(initialAccount)

  const navigationTitle =
    mode.type === 'forward'
      ? 'Forward'
      : mode.replyAll
        ? 'Reply All'
        : 'Reply'

  const bodyPlaceholder =
    mode.type === 'forward'
      ? 'Add a message (optional)...'
      : 'Type your reply...'

  const handleSubmit = async (values: { to?: string; body?: string }) => {
    // Validate based on mode
    if (mode.type === 'forward' && !values.to?.trim()) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Recipient is required',
      })
      return
    }
    if (mode.type !== 'forward' && !values.body?.trim()) {
      await showToast({
        style: Toast.Style.Failure,
        title: 'Message is required',
      })
      return
    }

    setIsLoading(true)
    const { client } = await getClient([selectedAccount])

    let result: Error | unknown
    if (mode.type === 'forward') {
      const recipients = (values.to ?? '')
        .split(',')
        .map((e) => ({ email: e.trim() }))
        .filter((e) => e.email)
      result = await client.forwardThread({
        threadId: mode.threadId,
        to: recipients,
        body: values.body || undefined,
      })
    } else {
      result = await client.replyToThread({
        threadId: mode.threadId,
        body: values.body ?? '',
        replyAll: mode.replyAll,
      })
    }

    setIsLoading(false)

    if (result instanceof Error) {
      await showFailureToast(result, {
        title: mode.type === 'forward' ? 'Failed to forward' : 'Failed to send reply',
      })
      return
    }

    const successTitle =
      mode.type === 'forward'
        ? `Forwarded to ${values.to}`
        : 'Reply sent'
    await showToast({ style: Toast.Style.Success, title: successTitle })
    onSent?.()
    pop()
  }

  return (
    <Form
      isLoading={isLoading}
      navigationTitle={navigationTitle}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title={mode.type === 'forward' ? 'Forward' : 'Send Reply'}
            onSubmit={handleSubmit}
          />
        </ActionPanel>
      }
    >
      {accounts.length > 1 && (
        <Form.Dropdown
          id='account'
          title='From'
          value={selectedAccount}
          onChange={(v) => setSelectedAccount(Array.isArray(v) ? v[0] ?? initialAccount : v)}
        >
          {accounts.map((a) => (
            <Form.Dropdown.Item
              key={a.email}
              value={a.email}
              title={a.email}
            />
          ))}
        </Form.Dropdown>
      )}
      {mode.type === 'forward' && (
        <Form.TextField
          id='to'
          title='To'
          placeholder='recipient@example.com'
        />
      )}
      <Form.TextArea
        id='body'
        title='Message'
        placeholder={bodyPlaceholder}
      />
    </Form>
  )
}

// ---------------------------------------------------------------------------
// Thread Detail (full thread view, pushed via Enter)
// ---------------------------------------------------------------------------

function ThreadDetail({
  threadId,
  account,
  accounts,
  revalidate,
}: {
  threadId: string
  account: string
  accounts: AuthStatus[]
  revalidate: () => void
}) {
  const thread = useCachedPromise(
    async (tid: string, acct: string) => {
      const { client } = await getClient([acct])
      const result = await client.getThread({ threadId: tid })
      if (result instanceof Error) throw result
      return result.parsed
    },
    [threadId, account],
  )

  if (thread.isLoading || !thread.data) {
    return <Detail markdown='' navigationTitle='Loading...' />
  }

  const t = thread.data
  const messages = t.messages

  // Build markdown: each message as a section with compact heading
  // Prefer text/plain + email-reply-parser for clean quote stripping.
  // Fall back to HTML → turndown when no text body is available.
  const parts = messages.map((msg) => {
    const senderName = msg.from.name || msg.from.email
    const heading = `### ${senderName} — ${formatDate(msg.date)}`

    const attachmentLine =
      msg.attachments.length > 0
        ? `📎 ${msg.attachments.map((a) => `${a.filename} (${formatSize(a.size)})`).join(', ')}`
        : null

    let body: string
    if (msg.textBody) {
      body = replyParser.parseReply(msg.textBody)
    } else {
      body = renderEmailBody(msg.body, msg.mimeType)
    }

    return [heading, attachmentLine, '', body]
      .filter((l) => l !== null)
      .join('\n')
  })

  const markdown = `# ${t.subject}\n\n---\n\n` + parts.join('\n\n---\n\n')

  // Collect unique participants
  const participants = new Map<string, string>()
  for (const msg of messages) {
    participants.set(msg.from.email, msg.from.name || msg.from.email)
    for (const r of msg.to) participants.set(r.email, r.name || r.email)
  }

  const labels = [...new Set(messages.flatMap((m) => m.labelIds))]
    .filter(
      (l): l is string => typeof l === 'string' && !l.startsWith('Label_'),
    ) // skip internal IDs
    .slice(0, 10)

  const latestMsg = messages[messages.length - 1]!

  return (
    <Detail
      navigationTitle={t.subject}
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label
            title='From'
            text={formatSender(latestMsg.from)}
          />
          <Detail.Metadata.Label
            title='To'
            text={latestMsg.to.map((r) => r.name || r.email).join(', ')}
          />
          {latestMsg.cc && latestMsg.cc.length > 0 && (
            <Detail.Metadata.Label
              title='Cc'
              text={latestMsg.cc.map((r) => r.name || r.email).join(', ')}
            />
          )}
          <Detail.Metadata.Label title='Date' text={latestMsg.date} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label
            title='Messages'
            text={String(t.messageCount)}
          />
          <Detail.Metadata.Label
            title='Participants'
            text={[...participants.values()].join(', ')}
          />
          {labels.length > 0 && (
            <Detail.Metadata.TagList title='Labels'>
              {labels.map((l) => (
                <Detail.Metadata.TagList.Item
                  key={l}
                  text={l}
                  color={labelColor(l)}
                />
              ))}
            </Detail.Metadata.TagList>
          )}
          <Detail.Metadata.Separator />
          <Detail.Metadata.Label title='Thread ID' text={t.id} />
          <Detail.Metadata.Label title='Account' text={account} />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          <ActionPanel.Section title='Reply & Forward'>
            <Action.Push
              title='Reply'
              icon={Icon.Reply}
              shortcut={{ modifiers: ['ctrl'], key: 'r' }}
              target={
                <ComposeForm
                  mode={{ type: 'reply', threadId }}
                  initialAccount={account}
                  accounts={accounts}
                  onSent={revalidate}
                />
              }
            />
            <Action.Push
              title='Reply All'
              icon={Icon.Reply}
              shortcut={{
                modifiers: ['ctrl', 'shift'],
                key: 'r',
              }}
              target={
                <ComposeForm
                  mode={{ type: 'reply', threadId, replyAll: true }}
                  initialAccount={account}
                  accounts={accounts}
                  onSent={revalidate}
                />
              }
            />
            <Action.Push
              title='Forward'
              icon={Icon.Forward}
              shortcut={{ modifiers: ['ctrl'], key: 'f' }}
              target={
                <ComposeForm
                  mode={{ type: 'forward', threadId }}
                  initialAccount={account}
                  accounts={accounts}
                  onSent={revalidate}
                />
              }
            />
          </ActionPanel.Section>
          <ActionPanel.Section title='Copy'>
            <Action.CopyToClipboard title='Copy Thread ID' content={t.id} />
            <Action.CopyToClipboard title='Copy Subject' content={t.subject} />
            {latestMsg && (
              <Action.CopyToClipboard
                title='Copy Email Body'
                content={renderEmailBody(latestMsg.body, latestMsg.mimeType)}
              />
            )}
          </ActionPanel.Section>
        </ActionPanel>
      }
    />
  )
}

// ---------------------------------------------------------------------------
// Main Command
// ---------------------------------------------------------------------------

export default function Command() {
  const [selectedAccount, setSelectedAccount] = useState('all')
  const [searchText, setSearchText] = useState('')
  const [isShowingDetail, setIsShowingDetail] = useState(true)
  const [selectedThreads, setSelectedThreads] = useState<string[]>([])
  const [activeMutations, setActiveMutations] = useState(0)
  const isMutating = activeMutations > 0
  const { height: terminalRows } = useTerminalDimensions()

  /** Wrap async mutation calls to track global loading state. */
  const withMutation = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    setActiveMutations((n) => n + 1)
    try {
      return await fn()
    } finally {
      setActiveMutations((n) => n - 1)
    }
  }, [])
  const pageSize = getPageSizeFromTerminalHeight(terminalRows)

  const accounts = useAccounts()
  const accountList = accounts.data ?? []

  // Fetch threads with pagination
  const {
    data: threads,
    isLoading,
    pagination,
    revalidate,
  } = useCachedPromise(
    (query: string, account: string) => {
      return async ({ cursor }: { page: number; cursor?: MailCursor }) => {
        const accountFilter = account === 'all' ? undefined : [account]
        const clients = await getClients(accountFilter)

        // Single selected account: standard cursor pagination.
        if (account !== 'all') {
          const pageToken =
            cursor?.mode === 'single' ? cursor.nextPageToken : undefined
          const { email, client } = clients[0]!
          const result = await client.listThreads({
            query: query || undefined,
            maxResults: pageSize,
            pageToken: pageToken || undefined,
          })
          if (result instanceof Error) {
            await showFailureToast(result, {
              title: 'Failed to fetch emails',
            })
            return { data: [] as ThreadItem[], hasMore: false }
          }
          const data: ThreadItem[] = result.threads.map((t) => ({
            ...t,
            account: email,
          }))
          return {
            data,
            hasMore: !!result.nextPageToken,
            cursor: {
              mode: 'single',
              nextPageToken: result.nextPageToken ?? undefined,
            } satisfies MailCursor,
          }
        }

        // Multi-account: keep one token per account and merge sorted pages.
        const previousByAccount =
          cursor?.mode === 'multi' ? cursor.nextByAccount : {}

        const results = await Promise.all(
          clients.map(async ({ email, client }) => {
            // null means this account is exhausted and should not be fetched anymore.
            if (previousByAccount[email] === null) {
              return {
                email,
                result: null as null,
                nextPageToken: null as string | null,
              }
            }

            const result = await client.listThreads({
              query: query || undefined,
              maxResults: pageSize,
              pageToken: previousByAccount[email] ?? undefined,
            })
            if (result instanceof Error) {
              return {
                email,
                result: null as null,
                nextPageToken: null as string | null,
              }
            }
            return {
              email,
              result,
              nextPageToken: result.nextPageToken ?? null,
            }
          }),
        )

        const successfulResults = results
          .map((r) => (r.result ? { email: r.email, result: r.result } : null))
          .filter(isTruthy)

        const merged: ThreadItem[] = successfulResults
          .flatMap(({ email, result }) =>
            result.threads.map((t) => ({ ...t, account: email })),
          )
          .sort(
            (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
          )

        const nextByAccount: Record<string, string | null> = {}
        for (const { email, nextPageToken } of results) {
          nextByAccount[email] = nextPageToken
        }

        const hasMore = Object.values(nextByAccount).some(
          (token) => token !== null,
        )

        return {
          data: merged,
          hasMore,
          cursor: {
            mode: 'multi',
            nextByAccount,
          } satisfies MailCursor,
        }
      }
    },
    [searchText, selectedAccount, pageSize],
    { keepPreviousData: true },
  )

  const handleAccountAdded = useCallback(
    async (email: string) => {
      await accounts.revalidate()
      setSelectedAccount(email)
      await revalidate()
    },
    [accounts, revalidate],
  )

  const handleAccountRemoved = useCallback(
    async (email: string) => {
      await accounts.revalidate()
      if (selectedAccount === email) {
        setSelectedAccount('all')
      }
      await revalidate()
    },
    [accounts, revalidate, selectedAccount],
  )

  const allThreads = threads ?? []

  // Group threads into sections
  const sections = useMemo(() => {
    const groups = new Map<string, ThreadItem[]>()
    for (const section of SECTION_ORDER) groups.set(section, [])

    for (const thread of allThreads) {
      const section = dateSection(thread.date)
      const list = groups.get(section)
      if (list) list.push(thread)
    }

    return SECTION_ORDER.map((name) => ({
      name,
      threads: groups.get(name) ?? [],
    })).filter((s) => s.threads.length > 0)
  }, [allThreads])

  const multiAccount = accountList.length > 1

  // Selection helpers
  const toggleSelection = useCallback((threadId: string) => {
    setSelectedThreads((prev) =>
      prev.includes(threadId)
        ? prev.filter((id) => id !== threadId)
        : [...prev, threadId],
    )
  }, [])

  // Bulk actions
  const handleBulkAction = useCallback(
    async (
      actionName: string,
      fn: (client: GmailClient, ids: string[]) => Promise<void | Error>,
    ) => {
      if (selectedThreads.length === 0) return

      await withMutation(async () => {
        // Group selected threads by account
        const byAccount = new Map<string, string[]>()
        for (const tid of selectedThreads) {
          const thread = allThreads.find((t: ThreadItem) => t.id === tid)
          if (!thread) continue
          const list = byAccount.get(thread.account) ?? []
          list.push(tid)
          byAccount.set(thread.account, list)
        }

        for (const [acct, ids] of byAccount) {
          const { client } = await getClient([acct])
          const result = await fn(client, ids)
          if (result instanceof Error) {
            await showFailureToast(result, {
              title: `Failed to ${actionName}`,
            })
            return
          }
        }

        await showToast({
          style: Toast.Style.Success,
          title: `${actionName}: ${selectedThreads.length} thread(s)`,
        })
        setSelectedThreads([])
        revalidate()
      })
    },
    [selectedThreads, allThreads, revalidate, withMutation],
  )

  return (
    <List
      isLoading={isLoading || accounts.isLoading || isMutating}
      isShowingDetail={isShowingDetail}
      spacingMode={LIST_SPACING_MODE}
      searchBarPlaceholder='Search emails...'
      onSearchTextChange={setSearchText}
      throttle
      pagination={pagination ? { ...pagination, pageSize } : undefined}
      searchBarAccessory={
        accountList.length > 0 ? (
          <AccountDropdown
            accounts={accountList}
            value={selectedAccount}
              onChange={setSelectedAccount}
              onAdded={handleAccountAdded}
              onRemoved={handleAccountRemoved}
            />
        ) : undefined
      }
    >
      {sections.map((section) => (
        <List.Section key={section.name} title={section.name}>
          {section.threads.map((thread) => {
            const isSelected = selectedThreads.includes(thread.id)
            const hasSelection = selectedThreads.length > 0

            // Icon: selection mode or status
            const icon = hasSelection
              ? {
                  source: isSelected ? Icon.CheckCircle : Icon.Circle,
                  tintColor: isSelected ? Color.Blue : Color.SecondaryText,
                }
              : threadStatusIcon(thread)

            // Accessories
            const accessories: Array<{
              text?: string
              tag?: string | { value: string; color?: string }
              icon?: string | null
            }> = []
            if (thread.messageCount > 1) {
              accessories.push({
                tag: {
                  value: String(thread.messageCount),
                  color: Color.SecondaryText,
                },
              })
            }
            if (multiAccount || selectedAccount === 'all') {
              accessories.push({
                tag: {
                  value: thread.account.split('@')[0] ?? thread.account,
                  color: accountColor(thread.account),
                },
              })
            }
            accessories.push({ text: formatDate(thread.date) })

            // Detail panel: latest message body as markdown
            const detail = isShowingDetail ? (
              <List.Item.Detail
                markdown={`# ${thread.subject}\n\n${thread.snippet}`}
                metadata={
                  <List.Item.Detail.Metadata>
                    <List.Item.Detail.Metadata.Label
                      title='From'
                      text={formatSender(thread.from)}
                    />
                    <List.Item.Detail.Metadata.Label
                      title='Date'
                      text={thread.date}
                    />
                    <List.Item.Detail.Metadata.Separator />
                    {thread.labelIds.length > 0 && (
                      <List.Item.Detail.Metadata.TagList title='Labels'>
                        {thread.labelIds
                          .filter((l) => !l.startsWith('Label_'))
                          .slice(0, 8)
                          .map((l) => (
                            <List.Item.Detail.Metadata.TagList.Item
                              key={l}
                              text={l}
                              color={labelColor(l)}
                            />
                          ))}
                      </List.Item.Detail.Metadata.TagList>
                    )}
                    <List.Item.Detail.Metadata.Separator />
                    <List.Item.Detail.Metadata.Label
                      title='Messages'
                      text={String(thread.messageCount)}
                    />
                    <List.Item.Detail.Metadata.Label
                      title='Thread ID'
                      text={thread.id}
                    />
                    {multiAccount && (
                      <List.Item.Detail.Metadata.Label
                        title='Account'
                        text={thread.account}
                      />
                    )}
                  </List.Item.Detail.Metadata>
                }
              />
            ) : undefined

            return (
              <List.Item
                key={`${thread.account}-${thread.id}`}
                title={thread.subject || '(no subject)'}
                subtitle={formatSender(thread.from)}
                icon={icon}
                accessories={accessories}
                keywords={[
                  thread.from.email,
                  thread.from.name ?? '',
                  thread.account,
                ]}
                detail={detail}
                actions={
                  <ActionPanel>
                    {hasSelection ? (
                      // ─────────────────────────────────────────────
                      // SELECTION MODE
                      // ─────────────────────────────────────────────
                      <>
                        <ActionPanel.Section title='Selection'>
                          <Action
                            title={isSelected ? 'Deselect Thread' : 'Select Thread'}
                            icon={isSelected ? Icon.Circle : Icon.CheckCircle}
                            shortcut={{ modifiers: ['ctrl'], key: 'x' }}
                            onAction={() => toggleSelection(thread.id)}
                          />
                          <Action
                            title={`Archive ${selectedThreads.length} Selected`}
                            icon={Icon.Tray}
                            onAction={() =>
                              handleBulkAction('Archived', (c, ids) =>
                                c.archive({ threadIds: ids }),
                              )
                            }
                          />
                          <Action
                            title={`Mark ${selectedThreads.length} as Read`}
                            icon={Icon.Eye}
                            onAction={() =>
                              handleBulkAction('Marked as read', (c, ids) =>
                                c.markAsRead({ threadIds: ids }),
                              )
                            }
                          />
                          <Action
                            title={`Star ${selectedThreads.length} Selected`}
                            icon={Icon.Star}
                            onAction={() =>
                              handleBulkAction('Starred', (c, ids) =>
                                c.star({ threadIds: ids }),
                              )
                            }
                          />
                          <Action
                            title={`Trash ${selectedThreads.length} Selected`}
                            icon={Icon.Trash}
                            onAction={() =>
                              handleBulkAction('Trashed', async (c, ids) => {
                                for (const id of ids) {
                                  await c.trash({ threadId: id })
                                }
                              })
                            }
                          />
                          <Action
                            title='Deselect All'
                            icon={Icon.XMarkCircle}
                            onAction={() => setSelectedThreads([])}
                          />
                        </ActionPanel.Section>
                        <ActionPanel.Section>
                          <Action
                            title='Refresh'
                            icon={Icon.ArrowClockwise}
                            shortcut={{ modifiers: ['ctrl', 'shift'], key: 'r' }}
                            onAction={() => revalidate()}
                          />
                          <Action
                            title='Toggle Detail'
                            icon={Icon.Sidebar}
                            shortcut={{ modifiers: ['ctrl'], key: 'd' }}
                            onAction={() => setIsShowingDetail((v) => !v)}
                          />
                        </ActionPanel.Section>
                      </>
                    ) : (
                      // ─────────────────────────────────────────────
                      // NORMAL MODE
                      // ─────────────────────────────────────────────
                      <>
                        <ActionPanel.Section>
                          <Action.Push
                            title='Open Thread'
                            icon={Icon.Eye}
                            target={
                              <ThreadDetail
                                threadId={thread.id}
                                account={thread.account}
                                accounts={accountList}
                                revalidate={revalidate}
                              />
                            }
                          />
                          <Action
                            title='Select Thread'
                            icon={Icon.CheckCircle}
                            shortcut={{ modifiers: ['ctrl'], key: 'x' }}
                            onAction={() => toggleSelection(thread.id)}
                          />
                          <Action
                            title={thread.unread ? 'Mark as Read' : 'Mark as Unread'}
                            icon={thread.unread ? Icon.Eye : Icon.EyeDisabled}
                            shortcut={{ modifiers: ['ctrl'], key: 'u' }}
                            onAction={() => withMutation(async () => {
                              const { client } = await getClient([thread.account])
                              const result = thread.unread
                                ? await client.markAsRead({ threadIds: [thread.id] })
                                : await client.markAsUnread({ threadIds: [thread.id] })
                              if (result instanceof Error) {
                                await showFailureToast(result)
                                return
                              }
                              await showToast({
                                style: Toast.Style.Success,
                                title: thread.unread ? 'Marked as read' : 'Marked as unread',
                              })
                              revalidate()
                            })}
                          />
                          <Action
                            title='Archive'
                            icon={Icon.Tray}
                            shortcut={{ modifiers: ['ctrl'], key: 'e' }}
                            onAction={() => withMutation(async () => {
                              const { client } = await getClient([thread.account])
                              const result = await client.archive({ threadIds: [thread.id] })
                              if (result instanceof Error) {
                                await showFailureToast(result)
                                return
                              }
                              await showToast({
                                style: Toast.Style.Success,
                                title: 'Archived',
                              })
                              revalidate()
                            })}
                          />
                          <Action
                            title={thread.labelIds.includes('STARRED') ? 'Unstar' : 'Star'}
                            icon={Icon.Star}
                            shortcut={{ modifiers: ['ctrl'], key: 's' }}
                            onAction={() => withMutation(async () => {
                              const { client } = await getClient([thread.account])
                              const isStarred = thread.labelIds.includes('STARRED')
                              const result = isStarred
                                ? await client.unstar({ threadIds: [thread.id] })
                                : await client.star({ threadIds: [thread.id] })
                              if (result instanceof Error) {
                                await showFailureToast(result)
                                return
                              }
                              await showToast({
                                style: Toast.Style.Success,
                                title: isStarred ? 'Unstarred' : 'Starred',
                              })
                              revalidate()
                            })}
                          />
                        </ActionPanel.Section>
                        <ActionPanel.Section title='Reply & Forward'>
                          <Action.Push
                            title='Reply'
                            icon={Icon.Reply}
                            shortcut={{ modifiers: ['ctrl'], key: 'r' }}
                            target={
                              <ComposeForm
                                mode={{ type: 'reply', threadId: thread.id }}
                                initialAccount={thread.account}
                                accounts={accountList}
                                onSent={revalidate}
                              />
                            }
                          />
                          <Action.Push
                            title='Reply All'
                            icon={Icon.Reply}
                            shortcut={{ modifiers: ['ctrl', 'shift'], key: 'r' }}
                            target={
                              <ComposeForm
                                mode={{ type: 'reply', threadId: thread.id, replyAll: true }}
                                initialAccount={thread.account}
                                accounts={accountList}
                                onSent={revalidate}
                              />
                            }
                          />
                          <Action.Push
                            title='Forward'
                            icon={Icon.Forward}
                            shortcut={{ modifiers: ['ctrl'], key: 'f' }}
                            target={
                              <ComposeForm
                                mode={{ type: 'forward', threadId: thread.id }}
                                initialAccount={thread.account}
                                accounts={accountList}
                                onSent={revalidate}
                              />
                            }
                          />
                        </ActionPanel.Section>
                        <ActionPanel.Section title='Copy'>
                          <Action.CopyToClipboard
                            title='Copy Thread ID'
                            content={thread.id}
                          />
                          <Action.CopyToClipboard
                            title='Copy Subject'
                            content={thread.subject}
                          />
                          <Action.CopyToClipboard
                            title='Copy Sender Email'
                            content={thread.from.email}
                          />
                        </ActionPanel.Section>
                        <ActionPanel.Section>
                          <Action
                            title='Trash'
                            icon={Icon.Trash}
                            shortcut={{ modifiers: ['ctrl'], key: 'backspace' }}
                            onAction={() => withMutation(async () => {
                              const { client } = await getClient([thread.account])
                              await client.trash({ threadId: thread.id })
                              await showToast({
                                style: Toast.Style.Success,
                                title: 'Trashed',
                              })
                              revalidate()
                            })}
                          />
                        </ActionPanel.Section>
                        <ActionPanel.Section>
                          <Action
                            title='Refresh'
                            icon={Icon.ArrowClockwise}
                            shortcut={{ modifiers: ['ctrl', 'shift'], key: 'r' }}
                            onAction={() => revalidate()}
                          />
                          <Action
                            title='Toggle Detail'
                            icon={Icon.Sidebar}
                            shortcut={{ modifiers: ['ctrl'], key: 'd' }}
                            onAction={() => setIsShowingDetail((v) => !v)}
                          />
                        </ActionPanel.Section>
                      </>
                    )}
                  </ActionPanel>
                }
              />
            )
          })}
        </List.Section>
      ))}
    </List>
  )
}

// ---------------------------------------------------------------------------
// Label color mapping
// ---------------------------------------------------------------------------

function labelColor(label: string): string {
  switch (label) {
    case 'INBOX':
      return Color.Blue
    case 'STARRED':
      return Color.Yellow
    case 'IMPORTANT':
      return Color.Orange
    case 'SENT':
      return Color.Green
    case 'DRAFT':
      return Color.Purple
    case 'SPAM':
      return Color.Red
    case 'TRASH':
      return Color.Red
    case 'UNREAD':
      return Color.Orange
    default:
      return Color.SecondaryText
  }
}

// ---------------------------------------------------------------------------
// Size formatting
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}
