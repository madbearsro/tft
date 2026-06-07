#!/usr/bin/env node
/**
 * TFT Patch Notes Collector
 * Scrapes latest TFT patch notes from Riot's website and saves to data/patch.json
 * Usage: node scripts/collect-patch.js [--data-dir data]
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = join(__dirname, '..')

const args = process.argv.slice(2)
function getArg(name, def) {
  const idx = args.indexOf(`--${name}`)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : def
}
const DATA_DIR_ARG = getArg('data-dir', null)

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

function stripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function textWithLines(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(li|p|h1|h2|h3|h4|blockquote|div)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

const ARROW = String.fromCharCode(0x21d2)

function classifyChange(text) {
  const lower = text.toLowerCase()
  if (lower.includes('nerf') || lower.includes('reduced') || lower.includes('decreased') || lower.includes('disabled')) return 'nerf'
  if (lower.includes('buff') || lower.includes('increased')) return 'buff'
  if (text.indexOf(ARROW) !== -1) {
    const [beforeText, afterText] = text.split(ARROW)
    const beforeNums = [...beforeText.matchAll(/(\d+(?:\.\d+)?)\s*%?/g)].map(m => Number(m[1]))
    const afterNums = [...afterText.matchAll(/(\d+(?:\.\d+)?)\s*%?/g)].map(m => Number(m[1]))
    const before = beforeNums.reduce((sum, n) => sum + n, 0) / Math.max(1, beforeNums.length)
    const after = afterNums.reduce((sum, n) => sum + n, 0) / Math.max(1, afterNums.length)
    if (after > before) return 'buff'
    if (after < before) return lower.includes('mana') ? 'buff' : 'nerf'
  }
  return 'adjusted'
}

function parseChanges(articleHtml) {
  const lines = textWithLines(articleHtml)
    .split(/\n/)
    .map(s => s.trim())
    .filter(Boolean)

  const changes = []
  let section = ''
  let inMidPatch = false
  for (const line of lines) {
    if (/^mid-patch updates$/i.test(line)) {
      inMidPatch = true
      section = line
      continue
    }
    if (/^patch highlights$/i.test(line)) {
      inMidPatch = false
      continue
    }
    if (/^(champions|traits|augments|systems|units|items|god boon|god offerings|large changes)$/i.test(line)) {
      section = line
      continue
    }
    if (line.indexOf(ARROW) === -1 && !line.includes(':') && !/\b(disabled|removed|no longer)\b/i.test(line)) continue
    if (line.indexOf(ARROW) === -1 && !/\b(buff|nerf|reduced|increased|disabled|removed|no longer)\b/i.test(line)) continue
    if (line.length < 8 || line.length > 220) continue
    const entity = line.split(':')[0]?.replace(/^[-*]\s*/, '').trim() || 'General'
    changes.push({
      entity,
      text: line.replace(/^[-*]\s*/, ''),
      type: classifyChange(line),
      section,
      midPatch: inMidPatch,
    })
  }

  const seen = new Set()
  return changes.filter(change => {
    const key = change.text.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 120)
}

async function collect() {
  console.log('[patch] Scrap patch notes de la Riot...')

  const indexUrl = 'https://teamfighttactics.leagueoflegends.com/en-us/news/game-updates/'
  const indexRes = await fetch(indexUrl, { headers: HEADERS, signal: AbortSignal.timeout(15000) })
  if (!indexRes.ok) throw new Error(`Patch index ${indexRes.status}`)
  const indexHtml = await indexRes.text()

  const latestPath = indexHtml.match(/href="([^"]*teamfight-tactics-patch-[^"]+)"/i)?.[1]
    ?? indexHtml.match(/https:\/\/teamfighttactics\.leagueoflegends\.com\/en-us\/news\/game-updates\/teamfight-tactics-patch-[^"'<\s]+/i)?.[0]
  const latestUrl = latestPath
    ? new URL(latestPath, indexUrl).toString()
    : 'https://teamfighttactics.leagueoflegends.com/en-us/news/game-updates/teamfight-tactics-patch-17-12/'

  console.log(`[patch] Articol: ${latestUrl}`)

  const articleRes = await fetch(latestUrl, { headers: HEADERS, signal: AbortSignal.timeout(15000) })
  if (!articleRes.ok) throw new Error(`Patch article ${articleRes.status}`)
  const articleHtml = await articleRes.text()

  const text = stripTags(articleHtml)
  const title = text.match(/Teamfight Tactics patch \d+\.\d+/i)?.[0] ?? 'TFT Patch Notes'
  const publishedAt = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z/)?.[0] ?? null
  const latestUpdateHeading = text.match(/\b(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+\d{1,2}(?:ST|ND|RD|TH)?\b/i)?.[0] ?? null

  const changes = parseChanges(articleHtml)
  const hasMidPatch = changes.some(c => c.midPatch)
  const latestChanges = hasMidPatch ? changes.filter(c => c.midPatch) : changes

  const result = {
    title,
    publishedAt,
    latestUpdateHeading,
    buffs: changes.filter(c => c.type === 'buff'),
    nerfs: changes.filter(c => c.type === 'nerf'),
    adjusted: changes.filter(c => c.type === 'adjusted'),
    latestBuffs: latestChanges.filter(c => c.type === 'buff'),
    latestNerfs: latestChanges.filter(c => c.type === 'nerf'),
    latestAdjusted: latestChanges.filter(c => c.type === 'adjusted'),
    hasMidPatch,
    updatedAt: new Date().toISOString(),
    sourceUrl: latestUrl,
  }

  const dataDir = DATA_DIR_ARG ? join(process.cwd(), DATA_DIR_ARG) : join(ROOT, 'data')
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  const outPath = join(dataDir, 'patch.json')
  writeFileSync(outPath, JSON.stringify(result, null, 2))

  console.log(`[patch] Salvat: ${outPath}`)
  console.log(`[patch] Title: ${title}`)
  console.log(`[patch] PublishedAt: ${publishedAt ?? '(nu s-a gasit)'}`)
  console.log(`[patch] Buffs: ${result.buffs.length}, Nerfs: ${result.nerfs.length}, Adjusted: ${result.adjusted.length}`)
  console.log(`[patch] MidPatch: ${hasMidPatch}, LatestBuffs: ${result.latestBuffs.length}`)
}

collect().catch(err => {
  console.error('[patch] Eroare:', err)
  process.exit(1)
})
