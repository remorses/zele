/**
 * Homepage hero: two-line H1 over the ASCII video background used by playwriter.dev.
 * The H1 text must match the index.mdx `title` (Holocron skips its injected H1 when <Above> exists).
 */
'use client'

import { useEffect, useState } from 'react'
import { VideoBackgroundShader } from '@holocron.so/vite/mdx'

const HERO_FONT = "'IvarText', serif"
const GITHUB_URL = 'https://github.com/remorses/zele'

function GithubIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' fill='currentColor'>
      <path d='M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z' />
    </svg>
  )
}

// canvasClassName opacity does not work: the shader sets inline opacity once ready. Dim via the wrapper.
function HeroBackground() {
  return (
    <div className='absolute inset-0 w-full h-full opacity-70'>
      <VideoBackgroundShader
        src='/assets/hero-bg.mp4'
        className='absolute inset-0 w-full h-full'
        dotStyle='ascii'
        dotColor='rgba(125, 211, 252, 0.7)'
        dotSize={10}
        chars=' .:-~=@zele'
        animSpeed={3}
        gamma={0.8}
        enableMask={false}
        fadeTop={false}
        fadeBottom={false}
      />
    </div>
  )
}

export function HeroSection() {
  const [fontsReady, setFontsReady] = useState(false)

  useEffect(() => {
    const timeout = setTimeout(() => setFontsReady(true), 3000)
    void document.fonts.ready.then(() => setFontsReady(true))
    return () => clearTimeout(timeout)
  }, [])

  return (
    <div className='relative mt-4 lg:mt-8 mb-6 lg:mb-10 w-full flex flex-col items-center overflow-hidden'>
      <HeroBackground />
      <div
        className='relative z-[2] flex flex-col items-center justify-center text-center max-w-[820px] mx-auto w-full px-5 py-8 sm:py-10 lg:py-12 gap-4'
        style={{ opacity: fontsReady ? 1 : 0, transition: 'opacity 0.3s cubic-bezier(0.23, 1, 0.32, 1)' }}
      >
        <h1
          className='flex flex-col items-center leading-[1.1] text-[32px] sm:text-[42px] md:text-[52px] text-foreground'
          style={{ fontFamily: HERO_FONT }}
        >
          <span>Email and calendar CLI</span>
          <span>for you and your agents</span>
        </h1>
        <div className='flex gap-2.5 flex-wrap justify-center'>
          <a
            href={GITHUB_URL}
            target='_blank'
            rel='noopener noreferrer'
            className='inline-flex items-center gap-2 rounded-md backdrop-blur-sm h-9 px-4 text-sm font-medium text-foreground no-underline hover:bg-accent/50 transition-colors cursor-pointer'
          >
            <GithubIcon size={14} />
            GitHub
          </a>
        </div>
      </div>
    </div>
  )
}
