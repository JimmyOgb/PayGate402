import { useEffect, useRef, useCallback } from 'react'
import { AppRoute } from './Header'

interface MeridianHeroProps {
  onNavigate: (route: AppRoute) => void
  serviceCount?: number
  myServiceCount?: number
  usdcBalance?: bigint
}

export function MeridianHero({
  onNavigate,
}: MeridianHeroProps) {
  const heroRef = useRef<HTMLElement | null>(null)
  const photoRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLElement | null>(null)
  const ctaRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const h1Ref = useRef<HTMLHeadingElement | null>(null)

  // ─────────────────────────────────────────────────────────────────────────────
  // Layout Engine — Exact Meridian Specification
  // ─────────────────────────────────────────────────────────────────────────────
  const updateLayout = useCallback(() => {
    if (typeof window === 'undefined') return
    const IW = 1586,
      IH = 992,
      CROWN = 530,
      GAP_D = 49.24,
      GAP_M = 26,
      OVERSCAN = 1.00078,
      K_T = 0.9,
      MAX_ZOOM = 1.4

    const vw = window.innerWidth
    const vh = window.innerHeight
    const heroEl = heroRef.current
    const H = heroEl?.offsetHeight || Math.max(vh - 56, 400)
    const u = Math.min(vw / 1280, H / 744)

    document.documentElement.style.setProperty('--u', String(u))
    document.documentElement.style.setProperty('--vh', `${vh}px`)

    const isDesk = window.matchMedia('(min-width:1152px) and (min-height:720px)').matches
    const isPhone = window.matchMedia('(max-width:510.98px)').matches

    let cb = 0
    if (ctaRef.current && heroEl) {
      const heroRect = heroEl.getBoundingClientRect()
      const ctaRect = ctaRef.current.getBoundingClientRect()
      cb = ctaRect.bottom - heroRect.top
    }

    const kVal = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--k'))
    const k = isNaN(kVal) ? K_T : kVal

    const crown = cb + (isDesk ? GAP_D * u : !isPhone ? GAP_D * k : GAP_M)
    const cover = Math.max(vw / IW, H / IH)
    let s = Math.max(cover, (H - crown) / (IH - CROWN))

    let finalCrown = crown
    if (s > cover * MAX_ZOOM) {
      s = cover * MAX_ZOOM
      finalCrown = H - (IH - CROWN) * s
    }
    s *= OVERSCAN

    const fx = vw / H < 1 ? 815 : IW / 2
    const x0 = Math.min(0, Math.max(vw - IW * s, vw / 2 - fx * s))
    const y0 = finalCrown - CROWN * s

    if (photoRef.current) {
      photoRef.current.style.setProperty('--s', String(s))
      photoRef.current.style.setProperty('--x0', `${x0}px`)
      photoRef.current.style.setProperty('--y0', `${y0}px`)
    }
  }, [])

  useEffect(() => {
    let rafId: number | null = null
    const schedule = () => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(updateLayout)
    }

    window.addEventListener('resize', schedule, { passive: true })
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', schedule, { passive: true })
    }

    let ro: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined' && stageRef.current) {
      ro = new ResizeObserver(schedule)
      ro.observe(stageRef.current)
    }

    updateLayout()

    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      window.removeEventListener('resize', schedule)
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', schedule)
      }
      if (ro) ro.disconnect()
    }
  }, [updateLayout])

  // ─────────────────────────────────────────────────────────────────────────────
  // Video Playback Recovery
  // ─────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    video.muted = true
    const tryPlay = () => {
      const p = video.play()
      if (p && typeof p.catch === 'function') {
        p.catch(() => {})
      }
    }

    tryPlay()
    video.addEventListener('canplay', tryPlay)

    const onVisibility = () => {
      if (!document.hidden) tryPlay()
    }
    document.addEventListener('visibilitychange', onVisibility)

    const events = ['pointerdown', 'touchstart', 'scroll']
    events.forEach(ev => window.addEventListener(ev, tryPlay, { once: true, passive: true }))

    return () => {
      video.removeEventListener('canplay', tryPlay)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // ─────────────────────────────────────────────────────────────────────────────
  // Entrance Animation (Web Animations API)
  // ─────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (prefersReducedMotion || typeof document === 'undefined' || !('animate' in document.documentElement)) {
      document.documentElement.classList.remove('intro')
      document.documentElement.classList.add('intro-done')
      return
    }

    const runIntro = () => {
      const isPhone = window.matchMedia('(max-width:510.98px)').matches
      const d = isPhone ? 0.75 : 1.0

      const EXPO = 'cubic-bezier(.16,1,.3,1)'
      const QUART = 'cubic-bezier(.25,1,.5,1)'
      const SHUTTER = 'cubic-bezier(.76,0,.24,1)'

      const heroEl = heroRef.current
      if (!heroEl) return

      const pill = heroEl.querySelector('a.pill')
      const h1 = h1Ref.current
      const lede = heroEl.querySelector('p.lede')
      const b1 = heroEl.querySelector('.btn.b1')
      const b2 = heroEl.querySelector('.btn.b2')

      const originalH1 = h1 ? h1.innerHTML : ''
      let wordSpans: HTMLElement[] = []

      if (h1) {
        const words = h1.textContent?.trim().split(/\s+/) || []
        h1.innerHTML = words
          .map(w => `<span class="w"><span>${w}</span></span>`)
          .join(' ')
        wordSpans = Array.from(h1.querySelectorAll('.w > span'))
      }

      const b1Label = b1?.querySelector('span')
      const b2Label = b2?.querySelector('span')
      const b2Svg = b2?.querySelector('svg')

      const anims: Animation[] = []

      if (pill) {
        anims.push(
          pill.animate(
            [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)' }],
            { delay: 300, duration: 750, easing: SHUTTER, fill: 'backwards' }
          )
        )
      }

      const wordAnims: Animation[] = []
      wordSpans.forEach((span, i) => {
        const a = span.animate(
          [{ transform: 'translate(0, 132%)' }, { transform: 'translate(0, 0)' }],
          { delay: 450 + i * 55, duration: 1050, easing: EXPO, fill: 'backwards' }
        )
        anims.push(a)
        wordAnims.push(a)
      })

      if (lede) {
        anims.push(
          lede.animate(
            [
              { opacity: 0, transform: `translate(0, ${12 * d}px)` },
              { opacity: 1, transform: 'translate(0, 0)' },
            ],
            { delay: 850, duration: 900, easing: QUART, fill: 'backwards' }
          )
        )
      }

      if (b1) {
        anims.push(
          b1.animate(
            [{ clipPath: 'inset(100% 0 0 0)' }, { clipPath: 'inset(0% 0 0 0)' }],
            { delay: 1050, duration: 750, easing: EXPO, fill: 'backwards' }
          )
        )
      }

      if (b1Label) {
        anims.push(
          b1Label.animate(
            [
              { opacity: 0, transform: `translate(0, ${8 * d}px)` },
              { opacity: 1, transform: 'translate(0, 0)' },
            ],
            { delay: 1150, duration: 700, easing: QUART, fill: 'backwards' }
          )
        )
      }

      if (b2) {
        anims.push(
          b2.animate(
            [{ clipPath: 'inset(100% 0 0 0)' }, { clipPath: 'inset(0% 0 0 0)' }],
            { delay: 1130, duration: 750, easing: EXPO, fill: 'backwards' }
          )
        )
      }

      if (b2Label) {
        anims.push(
          b2Label.animate(
            [
              { opacity: 0, transform: `translate(0, ${8 * d}px)` },
              { opacity: 1, transform: 'translate(0, 0)' },
            ],
            { delay: 1230, duration: 700, easing: QUART, fill: 'backwards' }
          )
        )
      }

      if (b2Svg) {
        anims.push(
          b2Svg.animate(
            [
              { opacity: 0, transform: `translate(0, ${8 * d}px)` },
              { opacity: 1, transform: 'translate(0, 0)' },
            ],
            { delay: 1230, duration: 700, easing: QUART, fill: 'backwards' }
          )
        )
      }

      document.documentElement.classList.remove('intro')

      Promise.all(wordAnims.map(a => a.finished))
        .then(() => {
          if (h1 && originalH1) h1.innerHTML = originalH1
        })
        .catch(() => {})

      Promise.all(anims.map(a => a.finished))
        .then(() => {
          anims.forEach(a => {
            try {
              a.cancel()
            } catch {}
          })
          document.documentElement.classList.add('intro-done')
        })
        .catch(() => {})
    }

    if (document.fonts && document.fonts.ready) {
      void document.fonts.ready.then(() => {
        updateLayout()
        requestAnimationFrame(runIntro)
      })
    } else {
      updateLayout()
      requestAnimationFrame(runIntro)
    }
  }, [updateLayout])

  return (
    <section ref={heroRef} className="hero" id="hero" aria-label="PayGate402">
      {/* Background cinematic video with photographic fallback */}
      <div ref={photoRef} className="photo" id="photo" aria-hidden="true">
        <video
          ref={videoRef}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          width="1586"
          height="992"
          poster="https://d2ol7oe51mr4n9.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/19548534-c502-431f-904d-24d31b17c471.jpg"
          src="https://d2ol7oe51mr4n9.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/0e1b18f2-b590-4b97-96f0-b05e019d07eb.mp4"
        />
      </div>

      {/* Main 1280×800 Scaled Composition Stage */}
      <main ref={stageRef} className="stage" id="stage">
        {/* Eyebrow Pill */}
        <a
          className="pill"
          href="#explore"
          onClick={e => {
            e.preventDefault()
            onNavigate('explore')
          }}
          style={{ '--nx': '0.75px', '--ny': '0px' } as React.CSSProperties}
        >
          <i className="sq" />
          <span>HTTP 402 · ON-CHAIN PAYMENTS</span>
          <svg viewBox="0 0 11 10.5" fill="none" stroke="#fff" strokeWidth="1.75" strokeLinecap="square" strokeLinejoin="miter">
            <path d="M1 0.9l4.2 4.35L1 9.6" />
            <path d="M6.2 0.9l4.2 4.35L6.2 9.6" />
          </svg>
        </a>

        {/* Headline */}
        <h1
          ref={h1Ref}
          style={{ '--nx': '-3.0px', '--ny': '110px' } as React.CSSProperties}
        >
          Move payments forward together
        </h1>

        {/* 3-Line Lede */}
        <p
          className="lede"
          style={{ '--nx': '-3.0px', '--ny': '186px' } as React.CSSProperties}
        >
          Smart reports from teams using PayGate402 to manage spending,
          <br className="d" />
          issue cards, and stay in control as they grow. Accounts stay
          <br className="d" />
          secure, orderly, and dependable.
        </p>

        {/* CTA Pair */}
        <div ref={ctaRef} className="cta" id="cta">
          <a
            className="btn b1"
            href="#explore"
            onClick={e => {
              e.preventDefault()
              onNavigate('explore')
            }}
            style={{ '--nx': '-0.25px', '--ny': '0px' } as React.CSSProperties}
          >
            <span>SEE IT HAPPEN</span>
          </a>

          <a
            className="btn b2"
            href="#my-services"
            onClick={e => {
              e.preventDefault()
              onNavigate('my-services')
            }}
            style={{ '--nx': '0.5px', '--ny': '0px' } as React.CSSProperties}
          >
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.05">
              <circle cx="2.3" cy="2.3" r="1.75" />
              <circle cx="9.7" cy="2.3" r="1.75" />
              <circle cx="2.3" cy="9.7" r="1.75" />
              <circle cx="9.7" cy="9.7" r="1.75" />
              <path d="M3.6 3.9L8.4 8.1" />
            </svg>
            <span>DISCUSS A PLAN</span>
          </a>
        </div>
      </main>
    </section>
  )
}
