// Tests for htmlToMarkdown email rendering.
// Uses inline snapshots to capture how real-world email HTML is converted.

import { expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { htmlToMarkdown, renderEmailBody, replyParser } from './output.js'

const htmlFixtureDir = fileURLToPath(new URL('./test-fixtures/email-html', import.meta.url))
const htmlSnapshotDir = fileURLToPath(new URL('./test-fixtures/email-html-snapshots', import.meta.url))

// ---------------------------------------------------------------------------
// Simple HTML
// ---------------------------------------------------------------------------

test('simple inline tags', () => {
  expect(htmlToMarkdown('<p>Hello <b>bold</b> and <em>italic</em> world</p>')).toMatchInlineSnapshot(`"Hello **bold** and *italic* world"`)
})

test('headings and paragraphs', () => {
  expect(htmlToMarkdown('<h1>Title</h1><p>Paragraph one.</p><h2>Subtitle</h2><p>Paragraph two.</p>')).toMatchInlineSnapshot(`
    "# Title

    Paragraph one.

    ## Subtitle

    Paragraph two."
  `)
})

test('links', () => {
  expect(htmlToMarkdown('<p>Visit <a href="https://example.com">our site</a> today.</p>')).toMatchInlineSnapshot(`"Visit [our site](https://example.com) today."`)
})

test('unordered list', () => {
  expect(htmlToMarkdown('<ul><li>One</li><li>Two</li><li>Three</li></ul>')).toMatchInlineSnapshot(`
    "* One
    * Two
    * Three"
  `)
})

test('ordered list', () => {
  expect(htmlToMarkdown('<ol><li>First</li><li>Second</li><li>Third</li></ol>')).toMatchInlineSnapshot(`
    "1. First
    2. Second
    3. Third"
  `)
})

// ---------------------------------------------------------------------------
// Email-specific: tracking pixels
// ---------------------------------------------------------------------------

test('strips 1x1 tracking pixels', () => {
  expect(htmlToMarkdown('<p>Hello</p><img src="https://track.example.com/pixel.gif" width="1" height="1"><p>World</p>')).toMatchInlineSnapshot(`
    "Hello

    World"
  `)
})

test('strips beacon/tracker images by URL', () => {
  expect(htmlToMarkdown('<p>Content</p><img src="https://analytics.example.com/beacon?id=123">')).toMatchInlineSnapshot(`"Content"`)
})

// ---------------------------------------------------------------------------
// Email-specific: image alt text
// ---------------------------------------------------------------------------

test('replaces images with alt text placeholder', () => {
  expect(htmlToMarkdown('<img src="https://example.com/logo.png" alt="Company Logo">')).toMatchInlineSnapshot(`"[image: Company Logo]"`)
})

test('strips images without alt text', () => {
  expect(htmlToMarkdown('<p>Before</p><img src="https://example.com/spacer.png"><p>After</p>')).toMatchInlineSnapshot(`
    "Before

    After"
  `)
})

// ---------------------------------------------------------------------------
// Email-specific: layout tables
// ---------------------------------------------------------------------------

test('unwraps layout table with width attribute', () => {
  expect(htmlToMarkdown(`
    <table width="600" cellpadding="0" cellspacing="0">
      <tr><td>
        <h1>Welcome</h1>
        <p>This is inside a layout table.</p>
      </td></tr>
    </table>
  `)).toMatchInlineSnapshot(`
    "# Welcome

    This is inside a layout table."
  `)
})

test('unwraps nested layout tables', () => {
  expect(htmlToMarkdown(`
    <table width="600" align="center">
      <tr><td>
        <table width="100%">
          <tr><td>Column 1</td></tr>
        </table>
        <table width="100%">
          <tr><td>Column 2</td></tr>
        </table>
      </td></tr>
    </table>
  `)).toMatchInlineSnapshot(`
    "Column 1

    Column 2"
  `)
})

test('unwraps table with role=presentation', () => {
  expect(htmlToMarkdown(`
    <table role="presentation">
      <tr><td><p>Presented content</p></td></tr>
    </table>
  `)).toMatchInlineSnapshot(`"Presented content"`)
})

// ---------------------------------------------------------------------------
// Email-specific: hidden elements
// ---------------------------------------------------------------------------

test('strips display:none elements', () => {
  expect(htmlToMarkdown('<div style="display:none">Hidden</div><p>Visible</p>')).toMatchInlineSnapshot(`"Visible"`)
})

test('strips mso-hide:all elements', () => {
  expect(htmlToMarkdown('<span style="mso-hide:all">MSO only</span><p>Regular</p>')).toMatchInlineSnapshot(`"Regular"`)
})

test('strips preheader spans', () => {
  expect(htmlToMarkdown('<span class="preheader">Preview text here</span><p>Email body</p>')).toMatchInlineSnapshot(`"Email body"`)
})

// ---------------------------------------------------------------------------
// Email-specific: quoted replies
// ---------------------------------------------------------------------------

test('strips Gmail quoted reply blocks', () => {
  expect(htmlToMarkdown(`
    <p>This is my reply.</p>
    <div class="gmail_quote">
      <p>On Mon, Jan 1 2026, someone wrote:</p>
      <blockquote><p>Original message here</p></blockquote>
    </div>
  `)).toMatchInlineSnapshot(`"This is my reply."`)
})

test('strips Gmail extra blocks', () => {
  expect(htmlToMarkdown(`
    <p>Reply text.</p>
    <div class="gmail_extra">
      <div class="gmail_quote">
        <p>Quoted content</p>
      </div>
    </div>
  `)).toMatchInlineSnapshot(`"Reply text."`)
})

test('strips Outlook blockquote type=cite', () => {
  expect(htmlToMarkdown(`
    <p>My response.</p>
    <blockquote type="cite">
      <p>Original text being quoted</p>
    </blockquote>
  `)).toMatchInlineSnapshot(`"My response."`)
})

// ---------------------------------------------------------------------------
// Email-specific: Outlook conditional comments
// ---------------------------------------------------------------------------

test('strips Outlook conditional comments', () => {
  expect(htmlToMarkdown(`
    <p>Normal content</p>
    <![if mso]><table><tr><td>MSO only</td></tr></table><![endif]>
    <p>More content</p>
  `)).toMatchInlineSnapshot(`
    "Normal content

    More content"
  `)
})

// ---------------------------------------------------------------------------
// Email-specific: style/script/head tags
// ---------------------------------------------------------------------------

test('strips style tags', () => {
  expect(htmlToMarkdown('<style>.foo { color: red; }</style><p>Content</p>')).toMatchInlineSnapshot(`"Content"`)
})

test('strips script tags', () => {
  expect(htmlToMarkdown('<script>alert("xss")</script><p>Safe content</p>')).toMatchInlineSnapshot(`"Safe content"`)
})

// ---------------------------------------------------------------------------
// Real-world: Google security alert (simplified)
// ---------------------------------------------------------------------------

test('Google security alert email', () => {
  expect(htmlToMarkdown(`
    <table width="100%" style="min-width:348px" border="0" cellspacing="0" cellpadding="0">
      <tr><td>
        <table align="center" border="0" cellspacing="0" cellpadding="0" width="600">
          <tr><td>
            <img src="https://accounts.google.com/logo.png" alt="Google" width="75" height="24">
          </td></tr>
          <tr><td>
            <h2>You allowed Thunderbird access to your Google Account</h2>
            <p>user@gmail.com</p>
            <p>If you didn't allow Thunderbird, someone else may be trying to access your account.</p>
            <p><a href="https://myaccount.google.com/alert">Check activity</a></p>
          </td></tr>
          <tr><td>
            <p style="font-size:11px;color:#777">
              © 2026 Google Ireland Ltd., Gordon House, Barrow Street, Dublin 4, Ireland
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  `)).toMatchInlineSnapshot(`
    "[image: Google]

    ## You allowed Thunderbird access to your Google Account

    user@gmail.com

    If you didn't allow Thunderbird, someone else may be trying to access your account.

    [Check activity](https://myaccount.google.com/alert)

    © 2026 Google Ireland Ltd., Gordon House, Barrow Street, Dublin 4, Ireland"
  `)
})

// ---------------------------------------------------------------------------
// Real-world: Stripe receipt (simplified)
// ---------------------------------------------------------------------------

test('Stripe receipt email', () => {
  expect(htmlToMarkdown(`
    <table width="600" align="center" cellpadding="0" cellspacing="0" border="0">
      <tr><td>
        <table width="100%" border="0" cellpadding="0">
          <tr><td><h2>Receipt from X</h2></td></tr>
          <tr><td><p><strong>$16.00</strong></p></td></tr>
          <tr><td><p>Paid February 9, 2026</p></td></tr>
        </table>
        <table width="100%" border="0" cellpadding="0">
          <tr><td>Receipt number</td><td>2383-9009-8737</td></tr>
          <tr><td>Payment method</td><td>Mastercard - 8441</td></tr>
        </table>
        <table width="100%" border="0" cellpadding="0">
          <tr><td>X Premium Plus</td><td>$40.00</td></tr>
          <tr><td>Discount (60% off)</td><td>-$24.00</td></tr>
          <tr><td><strong>Total</strong></td><td><strong>$16.00</strong></td></tr>
        </table>
        <p>Questions? <a href="https://help.x.com">Visit support</a></p>
      </td></tr>
    </table>
  `)).toMatchInlineSnapshot(`
    "## Receipt from X

    **$16.00**

    Paid February 9, 2026

    Receipt number

    2383-9009-8737

    Payment method

    Mastercard - 8441

    X Premium Plus

    $40.00

    Discount (60% off)

    -$24.00

    **Total**

    **$16.00**

    Questions? [Visit support](https://help.x.com)"
  `)
})

// ---------------------------------------------------------------------------
// Real-world: newsletter with CTA buttons
// ---------------------------------------------------------------------------

test('newsletter with headings and CTAs', () => {
  expect(htmlToMarkdown(`
    <table width="600" align="center" cellpadding="0" cellspacing="0">
      <tr><td>
        <p>Hi there,</p>
        <p>We've launched a new <strong>AI Assistant</strong>.</p>
        <table width="100%" cellpadding="0"><tr><td>
          <a href="https://app.example.com/try" style="background:#007bff;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px">Try it now</a>
        </td></tr></table>
        <h3>Getting started</h3>
        <p>Click the button above to begin.</p>
        <ul>
          <li>Search by meaning</li>
          <li>Summarize articles</li>
          <li>Organize bookmarks</li>
        </ul>
        <p><a href="https://example.com/unsubscribe">Unsubscribe</a></p>
      </td></tr>
    </table>
  `)).toMatchInlineSnapshot(`
    "Hi there,

    We've launched a new **AI Assistant**.

    [Try it now](https://app.example.com/try)

    ### Getting started

    Click the button above to begin.

    * Search by meaning
    * Summarize articles
    * Organize bookmarks

    [Unsubscribe](https://example.com/unsubscribe)"
  `)
})

// ---------------------------------------------------------------------------
// Combined: hidden + tracking + layout in one email
// ---------------------------------------------------------------------------

test('combined email noise removal', () => {
  expect(htmlToMarkdown(`
    <span class="preheader" style="display:none">Preview: Check out our deals!</span>
    <img src="https://track.example.com/open?id=abc" width="1" height="1">
    <table width="600" align="center" cellpadding="0" cellspacing="0">
      <tr><td>
        <div style="display:none">Hidden duplicate content</div>
        <h1>Big Sale!</h1>
        <p>Everything is <b>50% off</b> today.</p>
        <p><a href="https://shop.example.com">Shop now</a></p>
      </td></tr>
    </table>
    <img src="https://pixel.example.com/beacon" width="0" height="0">
  `)).toMatchInlineSnapshot(`
    "# Big Sale!

    Everything is **50% off** today.

    [Shop now](https://shop.example.com)"
  `)
})

// ---------------------------------------------------------------------------
// HTML encoded entities
// ---------------------------------------------------------------------------

test('numeric entity &#39; (apostrophe)', () => {
  expect(htmlToMarkdown('<p>It&#39;s a beautiful day</p>')).toMatchInlineSnapshot(`"It's a beautiful day"`)
})

test('numeric entity &#34; (double quote)', () => {
  expect(htmlToMarkdown('<p>She said &#34;hello&#34; to me</p>')).toMatchInlineSnapshot(`"She said "hello" to me"`)
})

test('named entity &amp;', () => {
  expect(htmlToMarkdown('<p>Tom &amp; Jerry</p>')).toMatchInlineSnapshot(`"Tom & Jerry"`)
})

test('named entity &lt; and &gt;', () => {
  expect(htmlToMarkdown('<p>Use &lt;div&gt; for layout</p>')).toMatchInlineSnapshot(`"Use <div> for layout"`)
})

test('named entity &nbsp;', () => {
  expect(htmlToMarkdown('<p>Hello&nbsp;World</p>')).toMatchInlineSnapshot(`"Hello World"`)
})

test('hex entity &#x27; (apostrophe)', () => {
  expect(htmlToMarkdown('<p>It&#x27;s working</p>')).toMatchInlineSnapshot(`"It's working"`)
})

test('mixed entities in real email subject', () => {
  expect(htmlToMarkdown('<p>Your order #1234 &mdash; &#34;Premium Plan&#34; isn&#39;t ready</p>')).toMatchInlineSnapshot(`"Your order #1234 — "Premium Plan" isn't ready"`)
})

test('entities inside links', () => {
  expect(htmlToMarkdown('<a href="https://example.com?foo=1&amp;bar=2">Click &amp; Go</a>')).toMatchInlineSnapshot(`"[Click & Go](https://example.com?foo=1&bar=2)"`)
})

test('entities inside layout tables', () => {
  expect(htmlToMarkdown(`
    <table width="600">
      <tr><td><p>You&#39;ve been selected for a &quot;special&quot; offer!</p></td></tr>
    </table>
  `)).toMatchInlineSnapshot(`"You've been selected for a "special" offer!"`)
})

// ---------------------------------------------------------------------------
// renderEmailBody: plain text pass-through
// ---------------------------------------------------------------------------

test('renderEmailBody passes through plain text', () => {
  expect(renderEmailBody('Hello, this is plain text.\n\nSecond paragraph.', 'text/plain')).toMatchInlineSnapshot(`
    "Hello, this is plain text.

    Second paragraph."
  `)
})

test('renderEmailBody converts HTML', () => {
  expect(renderEmailBody('<p>Hello <b>world</b></p>', 'text/html')).toMatchInlineSnapshot(`"Hello **world**"`)
})

// ---------------------------------------------------------------------------
// Quoted reply stripping via replyParser (plain text only)
// ---------------------------------------------------------------------------

test('strips plain text reply with > quotes and On...wrote header', () => {
  expect(replyParser.parseReply(`Thanks for the update! I'll review the PR today.

Let me know if you need anything else.

On Mon, Feb 10, 2026 at 10:30 AM John Smith <john@example.com> wrote:
> Hey team,
>
> I just pushed the fix for the login bug. The PR is ready for review.
>
> Best,
> John`)).toMatchInlineSnapshot(`
  "Thanks for the update! I'll review the PR today.

  Let me know if you need anything else.
  "
`)
})

test('strips plain text reply with German locale (Am...schrieb)', () => {
  expect(replyParser.parseReply(`Danke für die Information, ich schaue es mir an.

Am 10. Februar 2026 um 14:00 schrieb Max Müller <max@example.de>:
> Hallo,
>
> Hier ist der aktuelle Stand des Projekts.
>
> Grüße,
> Max`)).toMatchInlineSnapshot(`
  "Danke für die Information, ich schaue es mir an.
  "
`)
})

test('strips plain text reply with French locale (Le...écrit)', () => {
  expect(replyParser.parseReply(`Merci pour la mise à jour, je vais vérifier.

Le 10 février 2026 à 15:00, Pierre Dupont <pierre@example.fr> a écrit :
> Bonjour,
>
> Voici les dernières modifications.
>
> Cordialement,
> Pierre`)).toMatchInlineSnapshot(`
  "Merci pour la mise à jour, je vais vérifier.
  "
`)
})

test('strips plain text forwarded message block', () => {
  expect(replyParser.parseReply(`FYI see below.

---------- Forwarded message ----------
From: Alice <alice@example.com>
Date: Mon, Feb 10, 2026
Subject: Budget update
To: Bob <bob@example.com>

> The budget has been approved for Q2.
> Please proceed with the hiring plan.`)).toMatchInlineSnapshot(`
  "FYI see below.

  ---------- Forwarded message ----------
  From: Alice <alice@example.com>
  Date: Mon, Feb 10, 2026
  Subject: Budget update
  To: Bob <bob@example.com>"
`)
})

test('strips plain text "Sent from my iPhone" signature', () => {
  expect(replyParser.parseReply(`Sure, I'll be there at 3pm.

Sent from my iPhone`)).toMatchInlineSnapshot(`
  "Sure, I'll be there at 3pm.
  "
`)
})

test('strips plain text -- signature separator', () => {
  expect(replyParser.parseReply(`Let me know when you're free to discuss.

-- 
John Smith
Senior Engineer
Acme Corp`)).toMatchInlineSnapshot(`
  "Let me know when you're free to discuss.
  "
`)
})

test('preserves plain text email with no quotes or signatures', () => {
  expect(replyParser.parseReply(`Hey team,

Just a reminder that the sprint review is tomorrow at 2pm.
Please prepare your demo.

Thanks,
Alice`)).toMatchInlineSnapshot(`
  "Hey team,

  Just a reminder that the sprint review is tomorrow at 2pm.
  Please prepare your demo.

  Thanks,
  Alice"
`)
})

test('strips multi-level nested > quotes', () => {
  expect(replyParser.parseReply(`Got it, thanks!

On Tue, Feb 11, 2026 at 9:00 AM Bob <bob@example.com> wrote:
> Sounds good.
>
> On Mon, Feb 10, 2026 at 5:00 PM Alice <alice@example.com> wrote:
>> Can we push the deadline to Friday?
>>
>> Thanks,
>> Alice`)).toMatchInlineSnapshot(`
  "Got it, thanks!
  "
`)
})

// -- HTML --

test('strips Gmail HTML quoted reply (gmail_quote class)', () => {
  expect(renderEmailBody(`
    <div dir="ltr">
      <p>Thanks for the update! I'll review the PR today.</p>
      <p>Let me know if you need anything else.</p>
    </div>
    <div class="gmail_quote">
      <div dir="ltr" class="gmail_attr">
        On Mon, Feb 10, 2026 at 10:30 AM John Smith &lt;john@example.com&gt; wrote:<br>
      </div>
      <blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">
        <div dir="ltr">
          <p>Hey team,</p>
          <p>I just pushed the fix for the login bug. The PR is ready for review.</p>
          <p>Best,<br>John</p>
        </div>
      </blockquote>
    </div>
  `, 'text/html')).toMatchInlineSnapshot(`
    "Thanks for the update! I'll review the PR today.

    Let me know if you need anything else."
  `)
})

test('Outlook HTML reply: divRplyFwdMsg stripped, plain blockquote preserved', () => {
  // Turndown strips divRplyFwdMsg but plain <blockquote> (no type=cite) is preserved
  // as > prefixed text. This is intentional to avoid false positives.
  expect(renderEmailBody(`
    <html><body>
    <div>
      <p>Sounds good, I'll join the call at 3pm.</p>
    </div>
    <hr>
    <div id="divRplyFwdMsg">
      <p><b>From:</b> Sarah Connor &lt;sarah@skynet.com&gt;<br>
      <b>Sent:</b> Monday, February 10, 2026 9:00 AM<br>
      <b>To:</b> Kyle Reese &lt;kyle@resistance.org&gt;<br>
      <b>Subject:</b> Meeting today</p>
    </div>
    <blockquote>
      <p>Hi Kyle,</p>
      <p>Can we meet at 3pm to discuss the timeline?</p>
      <p>Thanks,<br>Sarah</p>
    </blockquote>
    </body></html>
  `, 'text/html')).toMatchInlineSnapshot(`
    "Sounds good, I'll join the call at 3pm.

    ***

    > Hi Kyle,
    >
    > Can we meet at 3pm to discuss the timeline?
    >
    > Thanks,\\
    > Sarah"
  `)
})

test('strips Outlook HTML reply with appendonsend div', () => {
  expect(renderEmailBody(`
    <div>
      <p>I agree with the proposal.</p>
    </div>
    <div id="appendonsend"></div>
    <hr style="display:inline-block;width:98%">
    <div id="divRplyFwdMsg">
      <p><b>From:</b> Boss &lt;boss@corp.com&gt;<br>
      <b>Sent:</b> Tuesday, Feb 11, 2026 8:00 AM</p>
    </div>
    <blockquote type="cite">
      <p>Team, please review the attached proposal and share your thoughts.</p>
    </blockquote>
  `, 'text/html')).toMatchInlineSnapshot(`
    "I agree with the proposal.

    ***"
  `)
})

test('plain blockquote without attributes becomes > in markdown (turndown only)', () => {
  // Turndown converts <blockquote> to > prefixed text. Without the reply parser,
  // the quoted content is preserved — this is correct for HTML emails because
  // intentional blockquotes (article quotes, GitHub notifications) should survive.
  expect(renderEmailBody(`
    <div>
      <p>Looks good to me, ship it!</p>
    </div>
    <blockquote>
      <p>Here's the updated design mockup for the landing page.</p>
      <p>Let me know what you think.</p>
    </blockquote>
  `, 'text/html')).toMatchInlineSnapshot(`
    "Looks good to me, ship it!

    > Here's the updated design mockup for the landing page.
    >
    > Let me know what you think."
  `)
})

test('strips Apple Mail HTML reply', () => {
  expect(renderEmailBody(`
    <div>I'll take a look this afternoon.</div>
    <div><br></div>
    <div>
      <blockquote type="cite">
        <div>On Feb 10, 2026, at 11:00 AM, Dave &lt;dave@example.com&gt; wrote:</div>
        <div><br></div>
        <div>Can you review the latest commit? I fixed the memory leak.</div>
      </blockquote>
    </div>
  `, 'text/html')).toMatchInlineSnapshot(`"I'll take a look this afternoon."`)
})

test('preserves HTML email with no quoted content', () => {
  expect(renderEmailBody(`
    <div dir="ltr">
      <p>Hey everyone,</p>
      <p>Just a reminder that the sprint review is tomorrow at 2pm.</p>
      <p>Please prepare your demo.</p>
    </div>
  `, 'text/html')).toMatchInlineSnapshot(`
    "Hey everyone,

    Just a reminder that the sprint review is tomorrow at 2pm.

    Please prepare your demo."
  `)
})

test('preserves newsletter HTML (no quotes to strip)', () => {
  expect(renderEmailBody(`
    <table width="600" align="center" cellpadding="0" cellspacing="0" border="0">
      <tr><td>
        <h2>Weekly Update</h2>
        <p>Here are this week's highlights:</p>
        <ul>
          <li>Feature A launched</li>
          <li>Bug fix for issue #123</li>
          <li>New team member onboarded</li>
        </ul>
        <p>Read more at <a href="https://example.com/blog">our blog</a>.</p>
      </td></tr>
    </table>
  `, 'text/html')).toMatchInlineSnapshot(`
    "## Weekly Update

    Here are this week's highlights:

    * Feature A launched
    * Bug fix for issue #123
    * New team member onboarded

    Read more at [our blog](https://example.com/blog)."
  `)
})

test('Gmail HTML with Sent from signature in reply (turndown strips quote)', () => {
  // Turndown strips gmail_quote div. The gmail_signature div is not stripped by
  // turndown (it's not a quote), so "Sent from my iPhone" survives in the markdown.
  expect(renderEmailBody(`
    <div dir="ltr">
      <p>OK I'll handle it.</p>
      <br>
      <div class="gmail_signature">Sent from my iPhone</div>
    </div>
    <div class="gmail_quote">
      <div class="gmail_attr">On Feb 10, 2026 at 3pm, Boss &lt;boss@work.com&gt; wrote:</div>
      <blockquote class="gmail_quote">
        <p>Please send the report by EOD.</p>
      </blockquote>
    </div>
  `, 'text/html')).toMatchInlineSnapshot(`
    "OK I'll handle it.

    Sent from my iPhone"
  `)
})

test('HTML reply with Original Message separator', () => {
  expect(renderEmailBody(`
    <div>
      <p>Thanks, received.</p>
    </div>
    <div>
      <p>----- Original Message -----</p>
      <p><b>From:</b> noreply@service.com<br>
      <b>To:</b> user@example.com<br>
      <b>Subject:</b> Your order has shipped</p>
      <p>Your order #12345 has been shipped and will arrive by Friday.</p>
    </div>
  `, 'text/html')).toMatchInlineSnapshot(`
    "Thanks, received.

    \\----- Original Message -----

    **From:** noreply@service.com\\
    **To:** user@example.com\\
    **Subject:** Your order has shipped

    Your order #12345 has been shipped and will arrive by Friday."
  `)
})

// ---------------------------------------------------------------------------
// renderEmailBody preserves everything (forwarding path uses this)
// replyParser.parseReply strips quotes (TUI display uses this)
// ---------------------------------------------------------------------------

test('renderEmailBody preserves quotes, replyParser strips them', () => {
  const body = `Thanks!

On Mon, Feb 10, 2026 at 10:30 AM John <john@example.com> wrote:
> Original message here.`

  const rendered = renderEmailBody(body, 'text/plain')
  const stripped = replyParser.parseReply(rendered)

  // renderEmailBody: full content preserved (for forwarding path)
  expect(rendered).toContain('Original message here.')
  // replyParser: only the reply (for TUI display)
  expect(stripped).not.toContain('Original message here.')
})

// ---------------------------------------------------------------------------
// Thread simulation: the core doubling bug
// ---------------------------------------------------------------------------

test('thread detail: two messages do not double content', () => {
  const msg1Body = `<div dir="ltr"><p>Hey team, I just pushed the fix. PR is ready for review.</p></div>`
  const msg2Body = `
    <div dir="ltr">
      <p>Looks good, approved!</p>
    </div>
    <div class="gmail_quote">
      <div class="gmail_attr">On Mon, Feb 10 at 10:30 AM John &lt;john@example.com&gt; wrote:</div>
      <blockquote class="gmail_quote">
        <div dir="ltr"><p>Hey team, I just pushed the fix. PR is ready for review.</p></div>
      </blockquote>
    </div>
  `
  const rendered1 = renderEmailBody(msg1Body, 'text/html')
  const rendered2 = renderEmailBody(msg2Body, 'text/html')

  expect(rendered1).toMatchInlineSnapshot(`"Hey team, I just pushed the fix. PR is ready for review."`)
  expect(rendered2).toMatchInlineSnapshot(`"Looks good, approved!"`)

  const combined = `${rendered1}\n\n---\n\n${rendered2}`
  const occurrences = combined.split('I just pushed the fix').length - 1
  expect(occurrences).toBe(1)
})

test('thread detail: 3-message thread with plain text', () => {
  // Simulates TUI pipeline: renderEmailBody + replyParser for plain text
  const render = (body: string) => replyParser.parseReply(renderEmailBody(body, 'text/plain'))

  const msg1 = render('Can we meet tomorrow at 2pm?')
  const msg2 = render(`Yes, 2pm works for me.

On Mon, Feb 10, 2026 at 9:00 AM Alice <alice@example.com> wrote:
> Can we meet tomorrow at 2pm?`)
  const msg3 = render(`Great, I'll book the room.

On Mon, Feb 10, 2026 at 9:15 AM Bob <bob@example.com> wrote:
> Yes, 2pm works for me.
>
> On Mon, Feb 10, 2026 at 9:00 AM Alice <alice@example.com> wrote:
>> Can we meet tomorrow at 2pm?`)

  expect(msg1).toMatchInlineSnapshot(`"Can we meet tomorrow at 2pm?"`)
  expect(msg2).toMatchInlineSnapshot(`
    "Yes, 2pm works for me.
    "
  `)
  expect(msg3).toMatchInlineSnapshot(`
    "Great, I'll book the room.
    "
  `)

  const combined = [msg1, msg2, msg3].join('\n---\n')
  const meetOccurrences = combined.split('Can we meet tomorrow').length - 1
  expect(meetOccurrences).toBe(1)
  const worksOccurrences = combined.split('2pm works for me').length - 1
  expect(worksOccurrences).toBe(1)
})

// ---------------------------------------------------------------------------
// Edge cases: false positives (content that looks like quotes but isn't)
// ---------------------------------------------------------------------------

test('preserves plain text with > in shell commands', () => {
  const body = `Here's how to redirect output:

echo "hello" > output.txt
cat file.txt | grep error > errors.log
ls -la 2>&1 > /dev/null`
  expect(replyParser.parseReply(body)).toMatchInlineSnapshot(`
    "Here's how to redirect output:

    echo "hello" > output.txt
    cat file.txt | grep error > errors.log
    ls -la 2>&1 > /dev/null"
  `)
})

test('preserves plain text with > in code snippets', () => {
  const body = `The comparison operators in Python:

if x > 10:
    print("large")
elif x > 5:
    print("medium")

Also note that >> is the right shift operator.`
  expect(replyParser.parseReply(body)).toMatchInlineSnapshot(`
    "The comparison operators in Python:

    if x > 10:
        print("large")
    elif x > 5:
        print("medium")

    Also note that >> is the right shift operator."
  `)
})

test('preserves plain text with markdown blockquotes', () => {
  const body = `Here's a good quote from the docs:

> Note: This API is experimental and may change.

Make sure to pin the version.`
  expect(replyParser.parseReply(body)).toMatchInlineSnapshot(`
    "Here's a good quote from the docs:
    Make sure to pin the version."
  `)
})

test('preserves HTML with intentional blockquote (article content)', () => {
  // Without reply parser on HTML, intentional blockquotes are preserved
  expect(renderEmailBody(`
    <div>
      <p>Great article! Here's the key takeaway:</p>
      <blockquote>
        <p>The best code is the code you don't have to write.</p>
      </blockquote>
      <p>I totally agree with this.</p>
    </div>
  `, 'text/html')).toMatchInlineSnapshot(`
    "Great article! Here's the key takeaway:

    > The best code is the code you don't have to write.

    I totally agree with this."
  `)
})

// ---------------------------------------------------------------------------
// Edge cases: auto-generated emails
// ---------------------------------------------------------------------------

test('preserves GitHub notification email (blockquote content survives)', () => {
  // Without reply parser on HTML, the blockquoted PR comment is preserved
  expect(renderEmailBody(`
    <div>
      <p><strong>@alice</strong> commented on pull request <a href="https://github.com/org/repo/pull/42">#42</a>:</p>
      <blockquote>
        <p>LGTM! One minor nit on line 15.</p>
      </blockquote>
      <p>You are receiving this because you were mentioned.</p>
      <p><a href="https://github.com/org/repo/pull/42#issuecomment-123">View it on GitHub</a></p>
    </div>
  `, 'text/html')).toMatchInlineSnapshot(`
    "**@alice** commented on pull request [#42](https://github.com/org/repo/pull/42):

    > LGTM! One minor nit on line 15.

    You are receiving this because you were mentioned.

    [View it on GitHub](https://github.com/org/repo/pull/42#issuecomment-123)"
  `)
})

test('preserves CI/build notification email', () => {
  expect(replyParser.parseReply(`Build #1234 PASSED for branch main.

Changes:
- fix: resolve memory leak in worker pool
- chore: update dependencies

View build: https://ci.example.com/builds/1234`)).toMatchInlineSnapshot(`
  "Build #1234 PASSED for branch main.

  Changes:
  - fix: resolve memory leak in worker pool
  - chore: update dependencies

  View build: https://ci.example.com/builds/1234"
`)
})

// ---------------------------------------------------------------------------
// Edge cases: mailing list and legal footers
// ---------------------------------------------------------------------------

test('handles mailing list footer with -- separator', () => {
  expect(replyParser.parseReply(`The next meeting is on Thursday at 3pm.

Please RSVP by Tuesday.

-- 
community-list mailing list
community-list@example.org
https://lists.example.org/listinfo/community-list`)).toMatchInlineSnapshot(`
  "The next meeting is on Thursday at 3pm.

  Please RSVP by Tuesday.
  "
`)
})

test('preserves email with legal disclaimer (not a signature pattern)', () => {
  expect(replyParser.parseReply(`Please find the contract attached.

CONFIDENTIALITY NOTICE: This email and any attachments are for the exclusive and
confidential use of the intended recipient. If you are not the intended recipient,
please do not read, distribute, or take action based on this message.`)).toMatchInlineSnapshot(`
  "Please find the contract attached.

  CONFIDENTIALITY NOTICE: This email and any attachments are for the exclusive and
  confidential use of the intended recipient. If you are not the intended recipient,
  please do not read, distribute, or take action based on this message."
`)
})

// ---------------------------------------------------------------------------
// Edge cases: short emails and degenerate inputs
// ---------------------------------------------------------------------------

test('preserves one-liner email', () => {
  expect(replyParser.parseReply('OK')).toMatchInlineSnapshot(`"OK"`)
})

test('preserves one-word reply with signature', () => {
  expect(replyParser.parseReply(`Thanks!

Sent from my iPhone`)).toMatchInlineSnapshot(`
  "Thanks!
  "
`)
})

test('handles empty string', () => {
  expect(replyParser.parseReply('')).toMatchInlineSnapshot(`""`)
})

test('handles email that is only a signature', () => {
  expect(replyParser.parseReply(`-- 
John Smith
CEO, Acme Corp
john@acme.com`)).toMatchInlineSnapshot(`
  "-- 
  John Smith
  CEO, Acme Corp
  john@acme.com"
`)
})

test('handles email that is only quoted text', () => {
  expect(replyParser.parseReply(`> This was the original message.
> It had multiple lines.
> But no new content was added.`)).toMatchInlineSnapshot(`""`)
})

// ---------------------------------------------------------------------------
// Edge cases: CJK reply headers
// ---------------------------------------------------------------------------

test('strips Chinese reply header (在...写道)', () => {
  expect(replyParser.parseReply(`收到，我会处理。

在 2026年2月10日 下午3:00, 张三 <zhang@example.com> 写道：
> 请查看附件中的报告。`)).toMatchInlineSnapshot(`
  "收到，我会处理。
  "
`)
})

test('strips Japanese reply header (のメッセージ)', () => {
  expect(replyParser.parseReply(`了解しました。

2026/02/10 15:00、田中太郎 <tanaka@example.jp> のメッセージ:
> 来週の会議について確認です。`)).toMatchInlineSnapshot(`
  "了解しました。
  "
`)
})

test('strips Korean reply header (작성)', () => {
  expect(replyParser.parseReply(`네, 알겠습니다.

2026.02.10 오후 3:00 김철수 <kim@example.kr> 작성:
> 내일 미팅 시간을 확인해 주세요.`)).toMatchInlineSnapshot(`
  "네, 알겠습니다.
  "
`)
})

test('safe real-world HTML fixtures produce stable markdown file snapshots', async () => {
  fs.mkdirSync(htmlSnapshotDir, { recursive: true })

  const fixtureFiles = fs
    .readdirSync(htmlFixtureDir)
    .filter((file) => file.endsWith('.html'))
    .sort()

  for (const fixtureFile of fixtureFiles) {
    const html = fs.readFileSync(path.join(htmlFixtureDir, fixtureFile), 'utf-8')
    const markdown = htmlToMarkdown(html)
    const snapshotFile = path.join(htmlSnapshotDir, `${fixtureFile}.md`)

    expect(markdown, `no raw entity refs: ${fixtureFile}`).not.toMatch(/&#\d+;|&#x[0-9a-f]+;|&(nbsp|amp|quot|lt|gt);/i)
    expect(markdown, `no zero-width chars: ${fixtureFile}`).not.toMatch(/[\u200B\u200C\u200D\uFEFF]/)

    await expect(markdown, `fixture: ${fixtureFile}`).toMatchFileSnapshot(snapshotFile)
  }
})
