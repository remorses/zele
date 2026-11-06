import React, { useContext, type ReactNode } from 'react'
import { Internals, cancelRender, continueRender, delayRender, interpolate, useCurrentFrame, useVideoConfig } from 'remotion'
import { cubicBezier, dspring } from 'egaki/video'

// Design tokens: near-black canvas, one sky-blue accent (zele.sh brand), serif + mono.
export const BG = '#08090b'
export const ACCENT = '#38bdf8'
export const ACCENT_SOFT = 'rgba(56, 189, 248, 0.14)'
export const FG = '#eceef1'
export const MUTED = '#7b828c'
export const LINE = 'rgba(255, 255, 255, 0.09)'
export const SERIF = '"Ivar Text", "Iowan Old Style", Georgia, serif'
export const SANS = '-apple-system, "SF Pro Display", "Helvetica Neue", sans-serif'
export const MONO = '"SF Mono", Menlo, ui-monospace, monospace'

const OUT = cubicBezier(0.16, 1, 0.3, 1)
const IN = cubicBezier(0.7, 0, 0.84, 0)

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v))
}

function round(v: number) {
  return Math.round(v * 1000) / 1000
}

/** Progress 0→1 between two times in seconds, eased. */
function useProgress(startSec: number, durSec: number, easing = OUT) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  return easing(clamp01((frame / fps - startSec) / durSec))
}

function useSeconds() {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  return frame / fps
}

function useSectionDuration() {
  const seq = useContext(Internals.SequenceContext)
  const { durationInFrames } = useVideoConfig()
  return seq?.durationInFrames ?? durationInFrames
}

// ---------------------------------------------------------------------------
// Global backdrop: dark canvas, drifting sky glow, dot grid, film grain.
// ---------------------------------------------------------------------------

const GRAIN = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(#n)' opacity='0.55'/></svg>`,
)}")`

export function Backdrop() {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const t = frame / fps
  const gx = 50 + Math.sin(t * 0.35) * 14
  const gy = 18 + Math.cos(t * 0.27) * 6
  return (
    <div style={{ position: 'absolute', inset: 0, background: BG, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `radial-gradient(60% 55% at ${gx}% ${gy}%, rgba(56,189,248,0.16), rgba(56,189,248,0) 70%)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: 'radial-gradient(rgba(255,255,255,0.10) 1.2px, transparent 1.3px)',
          backgroundSize: '44px 44px',
          backgroundPosition: `${round(-t * 6)}px ${round(-t * 10)}px`,
          maskImage: 'radial-gradient(70% 70% at 50% 45%, black, transparent 85%)',
          WebkitMaskImage: 'radial-gradient(70% 70% at 50% 45%, black, transparent 85%)',
        }}
      />
      <div style={{ position: 'absolute', inset: 0, backgroundImage: GRAIN, opacity: 0.07, mixBlendMode: 'overlay' }} />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'radial-gradient(120% 90% at 50% 50%, transparent 55%, rgba(0,0,0,0.65))',
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Scene: enter with blur/rise, exit with blur/push, slow camera drift.
// ---------------------------------------------------------------------------

export function Scene({ children, drift = 0.035, align = 'center' }: { children: ReactNode; drift?: number; align?: 'center' | 'top' }) {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const total = useSectionDuration()
  const enter = OUT(clamp01(frame / (0.7 * fps)))
  const exit = IN(clamp01((frame - (total - 0.4 * fps)) / (0.4 * fps)))
  const zoom = 1 + drift * (frame / total)
  const scale = round((0.94 + 0.06 * enter) * zoom * (1 + 0.04 * exit))
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: align === 'center' ? 'center' : 'flex-start',
        justifyContent: 'center',
        opacity: enter * (1 - exit),
        filter: `blur(${round(14 * (1 - enter) + 12 * exit)}px)`,
        transform: `translateY(${round(40 * (1 - enter) - 30 * exit)}px) scale(${scale})`,
        willChange: 'transform, filter, opacity',
      }}
    >
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

/** Masked word-by-word slide up. Wrap words in *stars* to color them with the accent. */
export function Words({ text, start = 0, size = 88, color = FG, font = SERIF, stagger = 0.06, weight = 400 }: {
  text: string
  start?: number
  size?: number
  color?: string
  font?: string
  stagger?: number
  weight?: number
}) {
  const t = useSeconds()
  const words = text.split(' ')
  return (
    <div style={{ fontFamily: font, fontSize: size, lineHeight: 1.12, color, fontWeight: weight, letterSpacing: '-0.02em', textAlign: 'center' }}>
      {words.map((raw, i) => {
        const accent = raw.startsWith('*')
        const word = raw.replace(/\*/g, '')
        const p = OUT(clamp01((t - start - i * stagger) / 0.75))
        return (
          <span key={i}>
            <span style={{ display: 'inline-block', overflow: 'hidden', verticalAlign: 'top', paddingBottom: '0.08em' }}>
              <span
                style={{
                  display: 'inline-block',
                  transform: `translateY(${round((1 - p) * 105)}%)`,
                  color: accent ? ACCENT : undefined,
                  fontStyle: accent ? 'italic' : undefined,
                }}
              >
                {word}
              </span>
            </span>
            {i < words.length - 1 ? ' ' : null}
          </span>
        )
      })}
    </div>
  )
}

export function Eyebrow({ index, label, start = 0 }: { index: string; label: string; start?: number }) {
  const p = useProgress(start, 0.6)
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        fontFamily: MONO,
        fontSize: 22,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: MUTED,
        opacity: p,
        transform: `translateY(${round((1 - p) * 16)}px)`,
      }}
    >
      <span style={{ color: ACCENT }}>{index}</span>
      <span style={{ width: round(48 * p), height: 1, background: LINE }} />
      <span>{label}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Hook + title
// ---------------------------------------------------------------------------

export function Hook() {
  const t = useSeconds()
  const strike = OUT(clamp01((t - 1.55) / 0.5))
  return (
    <Scene>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 28 }}>
        <Words text="Your agent can code, browse and deploy." size={76} color={MUTED} />
        <div style={{ position: 'relative' }}>
          <Words text="But it has no *inbox*." start={1.1} size={104} />
          <div
            style={{
              position: 'absolute',
              left: '50%',
              bottom: -14,
              height: 2,
              width: round(520 * strike),
              transform: 'translateX(-50%)',
              background: `linear-gradient(90deg, transparent, ${ACCENT}, transparent)`,
            }}
          />
        </div>
      </div>
    </Scene>
  )
}

export function Title() {
  const t = useSeconds()
  const { fps } = useVideoConfig()
  const frame = useCurrentFrame()
  const pop = dspring(frame, fps, 0.7, 0.25)
  const sub = OUT(clamp01((t - 0.6) / 0.7))
  const pills = ['read', 'send', 'watch', 'reply']
  return (
    <Scene drift={0.05}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 34 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 28, transform: `scale(${round(0.8 + 0.2 * pop)})` }}>
          <Envelope size={110} progress={clamp01(t / 0.9)} />
          <div style={{ fontFamily: SERIF, fontSize: 190, color: FG, letterSpacing: '-0.04em', lineHeight: 1 }}>zele</div>
        </div>
        <div style={{ fontFamily: SANS, fontSize: 40, color: MUTED, opacity: sub, transform: `translateY(${round((1 - sub) * 20)}px)` }}>
          Email for you <span style={{ color: FG }}>and your agents.</span>
        </div>
        <div style={{ display: 'flex', gap: 14 }}>
          {pills.map((p, i) => {
            const q = OUT(clamp01((t - 1.0 - i * 0.1) / 0.5))
            return (
              <div
                key={p}
                style={{
                  fontFamily: MONO,
                  fontSize: 24,
                  color: FG,
                  padding: '10px 22px',
                  borderRadius: 999,
                  border: `1px solid ${LINE}`,
                  background: 'rgba(255,255,255,0.03)',
                  opacity: q,
                  transform: `translateY(${round((1 - q) * 18)}px)`,
                }}
              >
                <span style={{ color: ACCENT }}>$ </span>zele mail {p}
              </div>
            )
          })}
        </div>
      </div>
    </Scene>
  )
}

/** Stroke-drawn envelope mark. */
export function Envelope({ size, progress }: { size: number; progress: number }) {
  const len = 400
  return (
    <svg width={size} height={size * 0.78} viewBox="0 0 128 100" fill="none">
      <rect x="4" y="4" width="120" height="92" rx="14" stroke={ACCENT} strokeWidth="6" strokeDasharray={len} strokeDashoffset={round(len * (1 - progress))} />
      <path
        d="M10 14 L64 56 L118 14"
        stroke={ACCENT}
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={160}
        strokeDashoffset={round(160 * (1 - clamp01(progress * 1.4 - 0.4)))}
      />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Architecture diagram: agent → zele → providers
// ---------------------------------------------------------------------------

type Provider = { label: string; logo?: string; y: number; accent?: boolean; note: string }

// Simple Icons paths (24x24), inlined so they render in exported frames.
const LOGO_PATHS: Record<string, string> = {
  gmail: 'M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z',
  outlook: 'M7.88 12.04q0 .45-.11.87-.1.41-.33.74-.22.33-.58.52-.37.2-.87.2t-.85-.2q-.35-.21-.57-.55-.22-.33-.33-.75-.1-.42-.1-.86t.1-.87q.1-.43.34-.76.22-.34.59-.54.36-.2.87-.2t.86.2q.35.21.57.55.22.34.31.77.1.43.1.88zM24 12v9.38q0 .46-.33.8-.33.32-.8.32H7.13q-.46 0-.8-.33-.32-.33-.32-.8V18H1q-.41 0-.7-.3-.3-.29-.3-.7V7q0-.41.3-.7Q.58 6 1 6h6.5V2.55q0-.44.3-.75.3-.3.75-.3h12.9q.44 0 .75.3.3.3.3.75V10.85l1.24.72h.01q.1.07.18.18.07.12.07.25zm-6-8.25v3h3v-3zm0 4.5v3h3v-3zm0 4.5v1.83l3.05-1.83zm-5.25-9v3h3.75v-3zm0 4.5v3h3.75v-3zm0 4.5v2.03l2.41 1.5 1.34-.8v-2.73zM9 3.75V6h2l.13.01.12.04v-2.3zM5.98 15.98q.9 0 1.6-.3.7-.32 1.19-.86.48-.55.73-1.28.25-.74.25-1.61 0-.83-.25-1.55-.24-.71-.71-1.24t-1.15-.83q-.68-.3-1.55-.3-.92 0-1.64.3-.71.3-1.2.85-.5.54-.75 1.3-.25.74-.25 1.63 0 .85.26 1.56.26.72.74 1.23.48.52 1.17.81.69.3 1.56.3zM7.5 21h12.39L12 16.08V17q0 .41-.3.7-.29.3-.7.3H7.5zm15-.13v-7.24l-5.9 3.54Z',
  imap: 'M4 3h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 10h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2zm2-7.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm0 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
}

const PROVIDERS: Provider[] = [
  { label: 'Gmail', logo: 'gmail', y: 170, note: 'OAuth' },
  { label: 'Outlook', logo: 'outlook', y: 330, note: 'OAuth' },
  { label: 'IMAP / SMTP', logo: 'imap', y: 490, note: 'any provider' },
  { label: '@zele.sh', y: 650, accent: true, note: 'free inboxes' },
]

function bezierPoint(p0: number[], p1: number[], p2: number[], p3: number[], t: number) {
  const u = 1 - t
  return [0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k])
}

export function Diagram() {
  const t = useSeconds()
  const W = 1640
  const H = 820
  const agent = { x: 230, y: 410 }
  const hub = { x: 820, y: 410 }
  const px = 1330

  const edges = PROVIDERS.map((p) => {
    const p0 = [hub.x + 150, hub.y]
    const p3 = [px - 150, p.y]
    const p1 = [p0[0] + 160, p0[1]]
    const p2 = [p3[0] - 160, p3[1]]
    return { p0, p1, p2, p3, d: `M${p0[0]} ${p0[1]} C${p1[0]} ${p1[1]} ${p2[0]} ${p2[1]} ${p3[0]} ${p3[1]}` }
  })

  const draw = (start: number) => OUT(clamp01((t - start) / 0.9))
  const node = (start: number) => OUT(clamp01((t - start) / 0.6))

  return (
    <Scene drift={0.04}>
      <div style={{ position: 'relative', width: W, height: H }}>
        <svg width={W} height={H} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
          <defs>
            <linearGradient id="edge" x1="0" x2="1">
              <stop offset="0" stopColor="rgba(255,255,255,0.35)" />
              <stop offset="1" stopColor="rgba(255,255,255,0.12)" />
            </linearGradient>
          </defs>
          <line
            x1={agent.x + 140}
            y1={agent.y}
            x2={hub.x - 150}
            y2={hub.y}
            stroke="url(#edge)"
            strokeWidth={2}
            strokeDasharray={400}
            strokeDashoffset={round(400 * (1 - draw(0.5)))}
          />
          {edges.map((e, i) => (
            <path
              key={i}
              d={e.d}
              stroke={PROVIDERS[i].accent ? ACCENT : 'url(#edge)'}
              strokeWidth={PROVIDERS[i].accent ? 2.5 : 2}
              fill="none"
              strokeDasharray={700}
              strokeDashoffset={round(700 * (1 - draw(1.2 + i * 0.15)))}
            />
          ))}
          {/* packets: requests flow out, mail flows back */}
          {t > 2.0 &&
            [0, 1, 2].map((k) => {
              const phase = ((t - 2.0) * 0.55 + k / 3) % 1
              const x = agent.x + 140 + (hub.x - 150 - agent.x - 140) * phase
              return <circle key={`a${k}`} cx={x} cy={agent.y} r={5} fill={ACCENT} opacity={Math.sin(phase * Math.PI)} />
            })}
          {t > 2.3 &&
            edges.map((e, i) =>
              [0, 1].map((k) => {
                const phase = ((t - 2.3) * 0.45 + k / 2 + i * 0.17) % 1
                const back = 1 - phase
                const [x, y] = bezierPoint(e.p0, e.p1, e.p2, e.p3, back)
                return (
                  <circle
                    key={`p${i}${k}`}
                    cx={x}
                    cy={y}
                    r={PROVIDERS[i].accent ? 6 : 4.5}
                    fill={PROVIDERS[i].accent ? ACCENT : FG}
                    opacity={Math.sin(phase * Math.PI) * 0.9}
                  />
                )
              }),
            )}
        </svg>

        <DiagramNode x={agent.x} y={agent.y} w={280} p={node(0.1)}>
          <div style={{ fontFamily: MONO, fontSize: 20, color: MUTED, letterSpacing: '0.06em' }}>AGENT</div>
          <div style={{ fontFamily: SANS, fontSize: 34, color: FG, marginTop: 6, whiteSpace: 'nowrap' }}>Claude, Codex</div>
        </DiagramNode>

        <DiagramNode x={hub.x} y={hub.y} w={300} p={node(0.6)} glow>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <Envelope size={46} progress={clamp01((t - 0.6) / 0.8)} />
            <div style={{ fontFamily: SERIF, fontSize: 60, color: FG, letterSpacing: '-0.03em' }}>zele</div>
          </div>
          <div style={{ fontFamily: MONO, fontSize: 19, color: MUTED, marginTop: 10 }}>CLI · SQLite cache · YAML</div>
        </DiagramNode>

        <div
          style={{
            position: 'absolute',
            left: (agent.x + hub.x) / 2,
            top: agent.y - 56,
            transform: 'translateX(-50%)',
            fontFamily: MONO,
            fontSize: 21,
            color: MUTED,
            opacity: node(1.0),
            whiteSpace: 'nowrap',
          }}
        >
          read · send · watch
        </div>

        {PROVIDERS.map((p, i) => (
          <DiagramNode key={p.label} x={px + 40} y={p.y} w={330} p={node(1.6 + i * 0.15)} accent={p.accent} row>
            {p.logo ? (
              <svg width={34} height={34} viewBox="0 0 24 24" fill={FG} fillRule="evenodd" opacity={0.85}>
                <path d={LOGO_PATHS[p.logo]} />
              </svg>
            ) : (
              <div style={{ width: 34, height: 34, borderRadius: 9, background: ACCENT, display: 'grid', placeItems: 'center', fontFamily: MONO, fontSize: 22, color: BG, fontWeight: 700 }}>@</div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontFamily: SANS, fontSize: 30, color: p.accent ? ACCENT : FG }}>{p.label}</div>
              <div style={{ fontFamily: MONO, fontSize: 17, color: MUTED }}>{p.note}</div>
            </div>
            {p.accent && (
              <div style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 15, color: BG, background: ACCENT, padding: '4px 10px', borderRadius: 6, letterSpacing: '0.08em' }}>NEW</div>
            )}
          </DiagramNode>
        ))}
      </div>
    </Scene>
  )
}

function DiagramNode({ x, y, w, p, children, glow, accent, row }: {
  x: number
  y: number
  w: number
  p: number
  children: ReactNode
  glow?: boolean
  accent?: boolean
  row?: boolean
}) {
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        transform: `translate(-50%, -50%) scale(${round(0.85 + 0.15 * p)})`,
        opacity: p,
        padding: row ? '18px 22px' : '26px 28px',
        borderRadius: 20,
        background: 'rgba(16,18,22,0.92)',
        border: `1px solid ${accent || glow ? 'rgba(56,189,248,0.45)' : LINE}`,
        boxShadow: glow || accent ? `0 0 80px ${ACCENT_SOFT}, inset 0 1px 0 rgba(255,255,255,0.06)` : 'inset 0 1px 0 rgba(255,255,255,0.05)',
        display: 'flex',
        flexDirection: row ? 'row' : 'column',
        alignItems: row ? 'center' : 'flex-start',
        gap: row ? 18 : 0,
      }}
    >
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Terminal with scripted, typed commands and highlighted YAML output.
// ---------------------------------------------------------------------------

export type TermStep =
  | { cmd: string; at: number; cps?: number }
  | { out: string; at: number; tone?: 'yaml' | 'hint' | 'ok' }
  | { spin: string; at: number; until: number; done?: string }

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Text between [[ and ]] renders in the accent color with a soft glow. */
function Highlighted({ text, base }: { text: string; base: string }) {
  const parts = text.split(/(\[\[.*?\]\])/g)
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('[[') ? (
          <span key={i} style={{ color: ACCENT, textShadow: `0 0 18px rgba(56,189,248,0.55)` }}>
            {part.slice(2, -2)}
          </span>
        ) : (
          <span key={i} style={{ color: base }}>
            {part}
          </span>
        ),
      )}
    </>
  )
}

function YamlLine({ line }: { line: string }) {
  if (line.trim().startsWith('#')) return <span style={{ color: MUTED }}>{line}</span>
  const m = line.match(/^(\s*-?\s*)([\w_]+)(:)(.*)$/)
  if (!m) return <Highlighted text={line} base={FG} />
  return (
    <>
      <span style={{ color: MUTED }}>{m[1]}</span>
      <span style={{ color: '#9fb3c8' }}>{m[2]}</span>
      <span style={{ color: MUTED }}>{m[3]}</span>
      <Highlighted text={m[4]} base={FG} />
    </>
  )
}

/** Colors flags and quoted strings inside a typed command. */
function CommandText({ text }: { text: string }) {
  const tokens = text.split(/(\s+)/)
  return (
    <>
      {tokens.map((tok, i) => {
        let color = FG
        if (i === 0) color = ACCENT
        else if (tok.startsWith('--')) color = '#c4b5fd'
        else if (/^['"]/.test(tok) || /['"]$/.test(tok)) color = '#86efac'
        return (
          <span key={i} style={{ color }}>
            {tok}
          </span>
        )
      })}
    </>
  )
}

export const INBOX_STEPS: TermStep[] = [
  { cmd: 'zele login zele --owner you@gmail.com', at: 1.0, cps: 40 },
  { spin: 'Reading the sign-in code from you@gmail.com', at: 2.05, until: 3.1, done: 'Signed in to zele.sh as you@gmail.com' },
  { out: '# no copy-paste: zele read the code from your Gmail', at: 3.2, tone: 'hint' },
  { cmd: 'zele inbox create signup-bot', at: 3.7, cps: 36 },
  { out: 'address: [[signup-bot@zele.sh]]\ninboxes_used: 1/10\nhint: zele mail list --account signup-bot@zele.sh', at: 4.65 },
]

export const VERIFY_STEPS: TermStep[] = [
  { cmd: "zele mail watch --account signup-bot@zele.sh --filter 'from:acme.dev'", at: 1.0, cps: 52 },
  { spin: 'Watching INBOX every 15s', at: 2.5, until: 4.3, done: 'New email after 14s' },
  {
    out: [
      '- account: signup-bot@zele.sh',
      '  from: Acme <hello@acme.dev>',
      '  subject: [[Your Acme code is 482913]]',
      '  thread_id: 19a3f2c8e1d0',
      '  elapsed: 14s',
    ].join('\n'),
    at: 4.4,
  },
  { out: '# agent types 482913 into acme.dev → account created', at: 5.6, tone: 'hint' },
]

export const SEND_STEPS: TermStep[] = [
  { cmd: 'zele mail read 18f0c2a9b4e1', at: 1.0, cps: 36 },
  {
    out: ['from: Dana <dana@acme.com>', 'subject: Intro call next week?', 'body: Does Tuesday afternoon work for you?'].join('\n'),
    at: 1.85,
  },
  { cmd: 'zele mail reply 18f0c2a9b4e1 --body "Tuesday 3pm works. Talk soon!"', at: 2.9, cps: 48 },
  { out: '✓ Reply sent to dana@acme.com', at: 4.45, tone: 'ok' },
  { out: "# Wait for the reply: zele mail watch --filter 'from:dana@acme.com'", at: 4.6, tone: 'hint' },
  { cmd: "zele mail watch --filter 'from:dana@acme.com' --timeout 259200", at: 5.3, cps: 48 },
  { spin: 'Watching INBOX every 15s, timeout 259200s', at: 6.6, until: 99 },
]

export function Terminal({ steps, title = 'agent — zsh', width = 1400, height = 600, fontSize = 26 }: {
  steps: TermStep[]
  title?: string
  width?: number
  height?: number
  fontSize?: number
}) {
  const t = useSeconds()
  const frame = useCurrentFrame()
  const lh = fontSize * 1.62

  const rows: ReactNode[] = []
  let cursorRow = -1
  const visible = steps.filter((s) => s.at <= t)
  visible.forEach((s, si) => {
    const isLast = si === visible.length - 1
    if ('cmd' in s) {
      const cps = s.cps ?? 34
      const n = Math.min(s.cmd.length, Math.floor((t - s.at) * cps))
      rows.push(
        <div key={`c${si}`} style={{ whiteSpace: 'pre' }}>
          <span style={{ color: ACCENT }}>❯ </span>
          <CommandText text={s.cmd.slice(0, n)} />
          {isLast && <Cursor frame={frame} />}
        </div>,
      )
      if (isLast) cursorRow = rows.length - 1
      return
    }
    if ('spin' in s) {
      const done = t >= s.until
      const glyph = done ? '✓' : SPINNER[Math.floor(t * 12) % SPINNER.length]
      rows.push(
        <div key={`s${si}`} style={{ whiteSpace: 'pre', color: MUTED }}>
          <span style={{ color: done ? '#86efac' : ACCENT }}>{glyph} </span>
          {done && s.done ? s.done : s.spin}
          {!done && <span>{'.'.repeat(1 + (Math.floor(t * 3) % 3))}</span>}
        </div>,
      )
      return
    }
    s.out.split('\n').forEach((line, li) => {
      const p = OUT(clamp01((t - s.at - li * 0.045) / 0.35))
      if (p <= 0) return
      rows.push(
        <div
          key={`o${si}-${li}`}
          style={{ whiteSpace: 'pre', opacity: p, transform: `translateY(${round((1 - p) * 10)}px)` }}
        >
          {s.tone === 'hint' ? (
            <span style={{ color: MUTED }}>{line}</span>
          ) : s.tone === 'ok' ? (
            <span style={{ color: '#86efac' }}>{line}</span>
          ) : (
            <YamlLine line={line} />
          )}
        </div>,
      )
    })
  })
  // Idle prompt after the last output so the cursor never disappears.
  const last = visible[visible.length - 1]
  const spinning = last && 'spin' in last && t < last.until
  if (last && !('cmd' in last) && !spinning) {
    rows.push(
      <div key="idle" style={{ whiteSpace: 'pre' }}>
        <span style={{ color: ACCENT }}>❯ </span>
        <Cursor frame={frame} />
      </div>,
    )
    cursorRow = rows.length - 1
  }

  const bodyPad = 34
  const maxRows = Math.floor((height - 64 - bodyPad * 2) / lh)
  const overflow = Math.max(0, rows.length - maxRows)
  const scroll = overflow * lh

  return (
    <div
      style={{
        width,
        height,
        borderRadius: 22,
        background: 'linear-gradient(180deg, rgba(22,24,29,0.96), rgba(13,14,17,0.96))',
        border: `1px solid ${LINE}`,
        boxShadow: `0 40px 120px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.02), 0 0 140px rgba(56,189,248,0.08), inset 0 1px 0 rgba(255,255,255,0.07)`,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ height: 64, display: 'flex', alignItems: 'center', padding: '0 24px', borderBottom: `1px solid ${LINE}`, position: 'relative' }}>
        <div style={{ display: 'flex', gap: 10 }}>
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ width: 14, height: 14, borderRadius: 99, background: 'rgba(255,255,255,0.13)' }} />
          ))}
        </div>
        <div style={{ position: 'absolute', left: 0, right: 0, textAlign: 'center', fontFamily: MONO, fontSize: 19, color: MUTED }}>{title}</div>
      </div>
      <div style={{ flex: 1, overflow: 'hidden', padding: bodyPad }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize,
            lineHeight: `${lh}px`,
            color: FG,
            transform: `translateY(${round(-scroll)}px)`,
          }}
          data-cursor-row={cursorRow}
        >
          {rows}
        </div>
      </div>
    </div>
  )
}

function Cursor({ frame }: { frame: number }) {
  const on = Math.floor(frame / 16) % 2 === 0
  return <span style={{ display: 'inline-block', width: '0.6em', height: '1.1em', verticalAlign: '-0.18em', marginLeft: 2, background: ACCENT, opacity: on ? 0.9 : 0.15 }} />
}

/** Terminal scene with a small eyebrow label and a headline above it. */
export function TerminalScene({ index, label, headline, steps, title, height = 600 }: {
  index: string
  label: string
  headline: string
  steps: TermStep[]
  title?: string
  height?: number
}) {
  const t = useSeconds()
  const tilt = OUT(clamp01((t - 0.15) / 1.1))
  return (
    <Scene drift={0.03}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22 }}>
        <Eyebrow index={index} label={label} />
        <Words text={headline} size={58} start={0.1} />
        <div style={{ perspective: 1800, marginTop: 18 }}>
          <div
            style={{
              transform: `rotateX(${round(14 * (1 - tilt))}deg) translateY(${round(60 * (1 - tilt))}px)`,
              opacity: tilt,
              transformOrigin: '50% 0%',
            }}
          >
            <Terminal steps={steps} title={title} height={height} />
          </div>
        </div>
      </div>
    </Scene>
  )
}

// ---------------------------------------------------------------------------
// Sign-up form on a fictional website, filled by the agent.
// ---------------------------------------------------------------------------

export function Signup({ email }: { email: string }) {
  const t = useSeconds()
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const cardIn = OUT(clamp01((t - 0.1) / 0.8))
  const typed = email.slice(0, Math.max(0, Math.floor((t - 1.0) * 26)))
  const pwd = Math.max(0, Math.min(12, Math.floor((t - 2.0) * 30)))
  const clickAt = 3.0
  const press = t > clickAt && t < clickAt + 0.18 ? 0.96 : 1
  const sent = OUT(clamp01((t - clickAt - 0.25) / 0.6))
  const pointer = OUT(clamp01((t - 2.35) / 0.6))
  const ptrX = round(interpolate(pointer, [0, 1], [520, 260]))
  const ptrY = round(interpolate(pointer, [0, 1], [640, 486]))
  const ring = clamp01((t - clickAt) / 0.5)
  const springIn = dspring(Math.max(0, frame - (clickAt + 0.2) * fps), fps, 0.6, 0.3)

  return (
    <Scene drift={0.04}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22 }}>
        <Eyebrow index="02" label="sign up anywhere" />
        <Words text="Use it on *any* website." size={58} start={0.1} />
        <div
          style={{
            marginTop: 18,
            width: 1100,
            height: 620,
            borderRadius: 22,
            overflow: 'hidden',
            border: `1px solid ${LINE}`,
            background: '#f6f5f2',
            boxShadow: '0 40px 120px rgba(0,0,0,0.6), 0 0 140px rgba(56,189,248,0.08)',
            opacity: cardIn,
            transform: `translateY(${round((1 - cardIn) * 50)}px)`,
            position: 'relative',
          }}
        >
          <div style={{ height: 58, background: '#ebe9e4', display: 'flex', alignItems: 'center', padding: '0 22px', gap: 10 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} style={{ width: 13, height: 13, borderRadius: 99, background: 'rgba(0,0,0,0.14)' }} />
            ))}
            <div style={{ marginLeft: 24, flex: 1, height: 34, borderRadius: 9, background: '#f6f5f2', display: 'flex', alignItems: 'center', padding: '0 16px', fontFamily: SANS, fontSize: 18, color: '#6b6b6b' }}>
              acme.dev/signup
            </div>
          </div>
          <div style={{ position: 'relative', height: 562 }}>
            {/* form state */}
            <div style={{ position: 'absolute', inset: 0, padding: '56px 0 0 140px', opacity: 1 - sent }}>
              <div style={{ fontFamily: SERIF, fontSize: 52, color: '#141414', letterSpacing: '-0.02em' }}>Create your account</div>
              <div style={{ fontFamily: SANS, fontSize: 21, color: '#777', marginTop: 8 }}>Start your 14-day trial. No card needed.</div>
              <Field label="Email" top={34} focused={t > 0.9 && t < 2.0}>
                <span style={{ color: '#141414' }}>{typed}</span>
                {t > 0.9 && t < 2.0 && <span style={{ display: 'inline-block', width: 2, height: 24, background: '#141414', marginLeft: 1, verticalAlign: -4, opacity: Math.floor(frame / 15) % 2 ? 0 : 1 }} />}
              </Field>
              <Field label="Password" top={20} focused={t >= 2.0 && t < clickAt}>
                <span style={{ color: '#141414', letterSpacing: 4 }}>{'•'.repeat(pwd)}</span>
              </Field>
              <div
                style={{
                  marginTop: 30,
                  width: 560,
                  height: 64,
                  borderRadius: 12,
                  background: '#141414',
                  color: 'white',
                  display: 'grid',
                  placeItems: 'center',
                  fontFamily: SANS,
                  fontSize: 22,
                  transform: `scale(${press})`,
                }}
              >
                Create account
              </div>
            </div>
            {/* sent state */}
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, opacity: sent }}>
              <div style={{ width: 92, height: 92, borderRadius: 99, background: '#141414', display: 'grid', placeItems: 'center', transform: `scale(${round(springIn)})` }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 7l8 6 8-6" />
                  <rect x="3" y="5" width="18" height="14" rx="2.5" />
                </svg>
              </div>
              <div style={{ fontFamily: SERIF, fontSize: 50, color: '#141414' }}>Check your inbox</div>
              <div style={{ fontFamily: SANS, fontSize: 23, color: '#777' }}>
                We sent a 6-digit code to <span style={{ color: '#141414', fontWeight: 600 }}>{email}</span>
              </div>
            </div>
            {/* agent pointer */}
            {t > 2.3 && sent < 1 && (
              <div style={{ position: 'absolute', left: ptrX, top: ptrY, opacity: 1 - sent }}>
                {ring > 0 && ring < 1 && (
                  <div
                    style={{
                      position: 'absolute',
                      left: -30,
                      top: -30,
                      width: 60,
                      height: 60,
                      borderRadius: 99,
                      border: `3px solid ${ACCENT}`,
                      transform: `scale(${round(0.3 + ring)})`,
                      opacity: 1 - ring,
                    }}
                  />
                )}
                <svg width="34" height="34" viewBox="0 0 24 24" style={{ filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.35))' }}>
                  <path d="M4 2l16 9.5-7 1.6L9.6 20z" fill="#141414" stroke="white" strokeWidth="1.4" strokeLinejoin="round" />
                </svg>
                <div style={{ position: 'absolute', left: 30, top: 26, fontFamily: MONO, fontSize: 15, color: 'white', background: ACCENT, padding: '3px 9px', borderRadius: 6, whiteSpace: 'nowrap' }}>agent</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </Scene>
  )
}

function Field({ label, top, focused, children }: { label: string; top: number; focused: boolean; children: ReactNode }) {
  return (
    <div style={{ marginTop: top }}>
      <div style={{ fontFamily: SANS, fontSize: 18, color: '#555', marginBottom: 8 }}>{label}</div>
      <div
        style={{
          width: 560,
          height: 60,
          borderRadius: 12,
          background: 'white',
          border: `1.5px solid ${focused ? ACCENT : '#dedbd4'}`,
          boxShadow: focused ? `0 0 0 4px rgba(56,189,248,0.18)` : 'none',
          display: 'flex',
          alignItems: 'center',
          padding: '0 18px',
          fontFamily: SANS,
          fontSize: 23,
        }}
      >
        {children}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Feature grid
// ---------------------------------------------------------------------------

const FEATURES = [
  { k: '10', title: 'Free addresses', desc: 'Permanent name@zele.sh inboxes, one per agent' },
  { k: 'R', title: 'Read & search', desc: 'from:  subject:  is:unread, across every account' },
  { k: 'S', title: 'Send & reply', desc: 'Gmail, Outlook, Fastmail, any IMAP/SMTP' },
  { k: 'W', title: 'Watch', desc: 'Blocks until the email arrives. No polling loops' },
  { k: 'Y', title: 'YAML output', desc: 'Pipe into yq, xargs, or straight into a prompt' },
  { k: 'C', title: 'Calendar too', desc: 'Events, free/busy and RSVP from the same CLI' },
]

export function Features() {
  const t = useSeconds()
  return (
    <Scene drift={0.035}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22 }}>
        <Eyebrow index="05" label="everything in one cli" />
        <Words text="Built for *agents*, nice for humans." size={58} start={0.1} />
        <div style={{ marginTop: 26, display: 'grid', gridTemplateColumns: 'repeat(3, 470px)', gap: 22 }}>
          {FEATURES.map((f, i) => {
            const p = OUT(clamp01((t - 0.5 - i * 0.09) / 0.7))
            return (
              <div
                key={f.title}
                style={{
                  height: 230,
                  borderRadius: 22,
                  padding: 32,
                  background: 'rgba(16,18,22,0.85)',
                  border: `1px solid ${i === 0 ? 'rgba(56,189,248,0.45)' : LINE}`,
                  boxShadow: i === 0 ? `0 0 80px ${ACCENT_SOFT}` : 'inset 0 1px 0 rgba(255,255,255,0.05)',
                  opacity: p,
                  transform: `translateY(${round((1 - p) * 40)}px) scale(${round(0.96 + 0.04 * p)})`,
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <div style={{ fontFamily: MONO, fontSize: 22, color: i === 0 ? ACCENT : MUTED }}>{String(i + 1).padStart(2, '0')}</div>
                <div style={{ marginTop: 'auto', fontFamily: SERIF, fontSize: 44, color: FG, letterSpacing: '-0.02em' }}>{f.title}</div>
                <div style={{ marginTop: 10, fontFamily: SANS, fontSize: 22, color: MUTED, lineHeight: 1.35 }}>{f.desc}</div>
              </div>
            )
          })}
        </div>
      </div>
    </Scene>
  )
}

// ---------------------------------------------------------------------------
// Outro
// ---------------------------------------------------------------------------

export function Outro() {
  const t = useSeconds()
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const pop = dspring(frame, fps, 0.8, 0.2)
  const cmd = 'npm i -g zele'
  const typed = cmd.slice(0, Math.max(0, Math.floor((t - 0.9) * 22)))
  const url = OUT(clamp01((t - 1.8) / 0.7))
  return (
    <Scene drift={0.06}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 40 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 30, transform: `scale(${round(0.85 + 0.15 * pop)})` }}>
          <Envelope size={120} progress={clamp01(t / 0.9)} />
          <div style={{ fontFamily: SERIF, fontSize: 210, color: FG, letterSpacing: '-0.04em', lineHeight: 1 }}>zele</div>
        </div>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 38,
            color: FG,
            padding: '20px 36px',
            borderRadius: 16,
            border: `1px solid ${LINE}`,
            background: 'rgba(16,18,22,0.9)',
            minWidth: 460,
          }}
        >
          <span style={{ color: ACCENT }}>❯ </span>
          <CommandText text={typed} />
          <Cursor frame={frame} />
        </div>
        <div style={{ fontFamily: SANS, fontSize: 34, color: MUTED, opacity: url, transform: `translateY(${round((1 - url) * 16)}px)` }}>
          free inboxes at <span style={{ color: ACCENT }}>zele.sh</span>
        </div>
      </div>
    </Scene>
  )
}

// Block rendering until the serif is loaded so exported frames never use the fallback font.
if (typeof document !== 'undefined') {
  const handle = delayRender('Ivar Text font')
  new FontFace('Ivar Text', 'url(/fonts/ivartext-regular.woff2) format("woff2")')
    .load()
    .then((font) => {
      document.fonts.add(font)
      continueRender(handle)
    })
    .catch((err) => cancelRender(err))
}
