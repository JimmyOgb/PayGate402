/**
 * PayGate402 Stage 8.39: Homepage-Only Hero & Navigation UX Test Suite
 *
 * Verifies:
 * 1. Homepage isolation: Hero is self-contained with zero below-the-fold content.
 * 2. Navigation & CTAs: "SEE IT HAPPEN" -> #explore, "DISCUSS A PLAN" -> #my-services.
 * 3. Routing integrity: All product destinations remain fully accessible.
 * 4. Mainnet parameters & wallet safety: Arc Mainnet 5042, real contract, zero monkey-patching.
 * 5. Responsive CSS rules: 1280x800 desktop fit and mobile overflow protection.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()

describe('Stage 8.39: Homepage-Only Hero & Navigation UX Verification', () => {
  const overviewSource = fs.readFileSync(path.join(ROOT, 'src/components/Overview.tsx'), 'utf8')
  const heroSource = fs.readFileSync(path.join(ROOT, 'src/components/MeridianHero.tsx'), 'utf8')
  const headerSource = fs.readFileSync(path.join(ROOT, 'src/components/Header.tsx'), 'utf8')
  const appSource = fs.readFileSync(path.join(ROOT, 'src/App.tsx'), 'utf8')
  const cssSource = fs.readFileSync(path.join(ROOT, 'src/index.css'), 'utf8')
  const paygateLibSource = fs.readFileSync(path.join(ROOT, 'src/lib/paygate402.ts'), 'utf8')

  test('1. Homepage isolation: Overview.tsx renders only MeridianHero and no below-the-fold sections', () => {
    // Must render MeridianHero
    assert.match(overviewSource, /<MeridianHero/, 'Overview must render MeridianHero')

    // Must NOT contain below-the-fold sections
    assert.doesNotMatch(overviewSource, /Live On-Chain Telemetry/i, 'Overview must NOT render on-chain telemetry grid')
    assert.doesNotMatch(overviewSource, /Recent Arc Mainnet Activity/i, 'Overview must NOT render activity/transaction table')
    assert.doesNotMatch(overviewSource, /HTTP 402 On-Chain Micropayment Handshake/i, 'Overview must NOT render handshake walkthrough')
    assert.doesNotMatch(overviewSource, /LIVE SERVICE #0/i, 'Overview must NOT render service spotlight card')
    assert.doesNotMatch(overviewSource, /Verifiable Arc Mainnet Smart Contract Invariants/i, 'Overview must NOT render invariants card')
  })

  test('2. App.tsx renders persistent Header across all routes without scroll delay on homepage', () => {
    // Header should be rendered directly in App shell
    assert.match(appSource, /<Header\s+activeRoute=\{activeRoute\}/, 'Header must be rendered directly without scrolledPastHero gate')
    assert.doesNotMatch(appSource, /scrolledPastHero/, 'App.tsx must not gate Header visibility on scroll')

    // Footer should only render on secondary scrollable routes
    assert.match(appSource, /activeRoute !== 'overview' && \(\s*<footer/, 'Footer must only render on secondary routes')
  })

  test('3. CTA Buttons and Eyebrow in MeridianHero lead to valid functional destinations', () => {
    // "SEE IT HAPPEN" CTA must navigate to explore (marketplace & flow demonstration)
    assert.match(heroSource, /href="#explore"/, 'b1 CTA button must link to #explore')
    assert.match(heroSource, /onNavigate\('explore'\)/, 'b1 CTA button click handler must navigate to explore')

    // "DISCUSS A PLAN" CTA must navigate to my-services (service registration portal)
    assert.match(heroSource, /href="#my-services"/, 'b2 CTA button must link to #my-services')
    assert.match(heroSource, /onNavigate\('my-services'\)/, 'b2 CTA button click handler must navigate to my-services')

    // Eyebrow pill must navigate to explore
    assert.match(heroSource, /href="#explore"/, 'Eyebrow pill must link to #explore')
    assert.match(heroSource, /onNavigate\('explore'\)/, 'Eyebrow pill must navigate to explore')
  })

  test('4. Header.tsx provides full navigation and Arc Mainnet indicators', () => {
    // Must contain all core navigation items
    const requiredNavRoutes = ['overview', 'explore', 'my-services', 'transactions', 'docs']
    for (const route of requiredNavRoutes) {
      assert.ok(headerSource.includes(`'${route}'`), `Header NAV_ITEMS must include '${route}'`)
    }

    // Must include Agent CLI simulator button
    assert.match(headerSource, /Agent CLI/, 'Header must provide Agent CLI access')

    // Must indicate Arc Mainnet (5042)
    assert.match(headerSource, /Arc Mainnet/, 'Header must display Arc Mainnet network badge')
    assert.match(headerSource, /ARC_MAINNET_CHAIN_ID/, 'Header must reference Arc Mainnet chain ID')

    // Must include ConnectKitButton for wallet connection
    assert.match(headerSource, /ConnectKitButton/, 'Header must provide wallet connection button')
  })

  test('5. Meridian Hero composition and layout engine are preserved', () => {
    // Headline text check
    assert.match(heroSource, /Move payments forward together/, 'Hero must display exact headline')

    // Lede description check
    assert.match(heroSource, /Smart reports from teams using PayGate402/, 'Hero must display supporting description')

    // Cinematic video and poster check
    assert.match(heroSource, /0e1b18f2-b590-4b97-96f0-b05e019d07eb\.mp4/, 'Hero must use cinematic video background')
    assert.match(heroSource, /19548534-c502-431f-904d-24d31b17c471\.jpg/, 'Hero must use photo fallback poster')

    // Dynamic layout calculation check
    assert.match(heroSource, /Math\.min\(vw \/ 1280/, 'Hero must calculate --u based on viewport aspect')
    assert.match(heroSource, /cb = ctaRect\.bottom - heroRect\.top/, 'Hero must dynamically anchor crown below CTA')
  })

  test('6. CSS rules account for header and prevent desktop overflow at 1280x800', () => {
    // Hero height must account for header
    assert.match(cssSource, /height:\s*calc\(100vh - 3\.5rem\)/, 'Hero height must subtract header height (3.5rem)')
    assert.match(cssSource, /height:\s*calc\(100dvh - 3\.5rem\)/, 'Hero height must support dvh units')

    // Stage desktop dimensions
    assert.match(cssSource, /width:\s*1280px/, 'Stage desktop width must be 1280px')
    assert.match(cssSource, /height:\s*744px/, 'Stage desktop height must be 744px (800 - 56px header)')

    // Responsive media queries exist
    assert.match(cssSource, /@media \(max-width: 510\.98px\)/, 'Mobile media query must be present')
    assert.match(cssSource, /@media \(prefers-reduced-motion: reduce\)/, 'prefers-reduced-motion must be honored')
  })

  const networkConfigSource = fs.readFileSync(path.join(ROOT, 'src/lib/networkConfig.ts'), 'utf8')

  test('7. Real Arc Mainnet configuration invariants are preserved', () => {
    // Mainnet Chain ID 5042
    assert.match(networkConfigSource, /ARC_MAINNET_CHAIN_ID\s*=\s*5042/, 'Must use Arc Mainnet Chain ID 5042')

    // Mainnet deployed contract
    assert.match(paygateLibSource, /0xa27e390CC82793911D805D4cB3E0c50F2117C77A/i, 'Must use verified deployed contract')

    // Canonical Arc Mainnet USDC
    assert.match(networkConfigSource, /0x3600000000000000000000000000000000000000/i, 'Must use canonical USDC contract')

    // Confirm tracing.ts is unimported from the runtime application
    const mainSource = fs.readFileSync(path.join(ROOT, 'src/main.tsx'), 'utf8')
    assert.doesNotMatch(mainSource, /tracing/, 'main.tsx must NOT import tracing.ts')

    // Confirm active app files (App.tsx, Header.tsx, Overview.tsx, MeridianHero.tsx, etc.) do not monkey-patch
    const activeAppFiles = ['App.tsx', 'components/Header.tsx', 'components/Overview.tsx', 'components/MeridianHero.tsx', 'components/Marketplace.tsx', 'components/MyServices.tsx', 'components/TransactionsView.tsx', 'components/DeveloperDocs.tsx', 'components/AgentCLI.tsx']
    for (const file of activeAppFiles) {
      const content = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8')
      assert.doesNotMatch(
        content,
        /Object\.defineProperty\(\s*(?:window|globalThis)\s*,\s*['"]ethereum['"]/,
        `File src/${file} must NOT monkey-patch window.ethereum`
      )
    }
  })

  test('8. Stage 8.41: Production runtime boundary is strictly Arc Mainnet only', () => {
    // FlowDashboard: No Testnet chain ID, obsolete contract, or Testnet copy
    const flowSource = fs.readFileSync(path.join(ROOT, 'src/components/FlowDashboard.tsx'), 'utf8')
    assert.doesNotMatch(flowSource, /5042002/, 'FlowDashboard must not contain Testnet chain ID 5042002')
    assert.doesNotMatch(flowSource, /0xcc69506b784dffda4ee4d221b122303304099971/i, 'FlowDashboard must not contain obsolete Testnet contract')
    assert.doesNotMatch(flowSource, /Arc Testnet/, 'FlowDashboard must not reference Arc Testnet')

    // AgentCLI: strictly Arc Mainnet 5042
    const cliSource = fs.readFileSync(path.join(ROOT, 'src/components/AgentCLI.tsx'), 'utf8')
    assert.doesNotMatch(cliSource, /5042002/, 'AgentCLI must not contain Testnet chain ID 5042002')
    assert.doesNotMatch(cliSource, /ARC_TESTNET_CHAIN_ID/, 'AgentCLI must not reference ARC_TESTNET_CHAIN_ID')

    // MyServices: strictly Arc Mainnet 5042
    const myServicesSource = fs.readFileSync(path.join(ROOT, 'src/components/MyServices.tsx'), 'utf8')
    assert.doesNotMatch(myServicesSource, /5042002/, 'MyServices must not contain Testnet chain ID 5042002')
    assert.doesNotMatch(myServicesSource, /ARC_TESTNET_CHAIN_ID/, 'MyServices must not reference ARC_TESTNET_CHAIN_ID')

    // Onchain facts: Arc Testnet removed
    const onchainFactsSource = fs.readFileSync(path.join(ROOT, 'src/onchain-facts.ts'), 'utf8')
    assert.doesNotMatch(onchainFactsSource, /5042002/, 'onchain-facts.ts must not contain Testnet chain ID 5042002')
    assert.doesNotMatch(onchainFactsSource, /rpc\.testnet\.arc\.io/, 'onchain-facts.ts must not contain Testnet RPC')

    // .env.example: only Arc Mainnet
    const envExampleSource = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8')
    assert.doesNotMatch(envExampleSource, /rpc\.testnet\.arc\.io/, '.env.example must not contain Testnet RPC')
  })
})
