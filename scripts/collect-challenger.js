#!/usr/bin/env node
/**
 * TFT Challenger Data Collector
 * Extrage date din OP.GG si salveaza in data/challenger-{region}-{set}.json
 * Usage: node scripts/collect-challenger.js [--region euw] [--set 17] [--limit 30]
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = join(__dirname, '..')

// --- CLI args ---
const args = process.argv.slice(2)
function getArg(name, def) {
  const idx = args.indexOf(`--${name}`)
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : def
}
const REGION = getArg('region', 'euw')
const SET    = Number(getArg('set', '17'))
const LIMIT  = Number(getArg('limit', '30'))
const DATA_DIR_ARG = getArg('data-dir', null)
const CONCURRENCY = 4

// --- Discord ---
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK

async function sendDiscord(content) {
  if (!DISCORD_WEBHOOK) return
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
  } catch {}
}

// --- HTTP helpers ---
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

async function safeFetch(url, extraHeaders = {}) {
  try {
    const r = await fetch(url, {
      headers: { ...HEADERS, ...extraHeaders },
      signal: AbortSignal.timeout(12000),
    })
    if (!r.ok) { console.warn(`[opgg] ${url} -> ${r.status}`); return null }
    return r
  } catch (e) {
    console.warn(`[opgg] ${url} -> ${e.message}`)
    return null
  }
}

async function safePost(url, body, extraHeaders = {}) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { ...HEADERS, ...extraHeaders },
      body,
      signal: AbortSignal.timeout(12000),
    })
    return r
  } catch (e) {
    console.warn(`[opgg] POST ${url} -> ${e.message}`)
    return null
  }
}

// --- Batch concurrency ---
async function runBatched(items, fn, concurrency) {
  const results = []
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency)
    const batchResults = await Promise.all(batch.map(fn))
    results.push(...batchResults)
  }
  return results
}

// --- OP.GG constants ---
const OPGG_MATCH_ACTION = '408275cb92fed10d7ca8ba8aac30d76033f7f72ac7'

// --- Helper functions (extrase din vite.config.js) ---

function buildNextRouterStateTree(profileRegion, slug) {
  return encodeURIComponent(JSON.stringify([
    '',
    {
      children: [
        ['locale', 'en', 'd'],
        {
          children: [
            'tft',
            {
              children: [
                'summoners',
                {
                  children: [
                    ['region', profileRegion, 'd'],
                    {
                      children: [
                        ['summoner', slug, 'd'],
                        { children: ['__PAGE__', {}, null, null] },
                        null, null,
                      ],
                    },
                    null, null,
                  ],
                },
                null, null,
              ],
            },
            null, null,
          ],
        },
        null, null,
      ],
    },
    null, null, true,
  ]))
}

function decodeFlightPayload(html) {
  return String(html ?? '')
    .replace(/\\"/g, '"')
    .replace(/\\u0026/g, '&')
    .replace(/\\n/g, '\n')
    .replace(/\\\//g, '/')
}

function extractBalancedObject(text, key) {
  const keyIdx = text.indexOf(key)
  if (keyIdx === -1) return null
  const start = text.indexOf('{', keyIdx + key.length)
  if (start === -1) return null
  let depth = 0, inString = false, escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth++
    if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1) }
  }
  return null
}

function extractBalancedArray(text, key) {
  const keyIdx = text.indexOf(key)
  if (keyIdx === -1) return null
  const start = text.indexOf('[', keyIdx + key.length)
  if (start === -1) return null
  let depth = 0, inString = false, escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '[') depth++
    if (ch === ']') { depth--; if (depth === 0) return text.slice(start, i + 1) }
  }
  return null
}

function extractBalancedArrayFrom(text, start) {
  if (start < 0 || text[start] !== '[') return null
  let depth = 0, inString = false, escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '[') depth++
    if (ch === ']') { depth--; if (depth === 0) return text.slice(start, i + 1) }
  }
  return null
}

function findMatchArray(value) {
  if (!Array.isArray(value)) return null
  if (value.length > 0 && value.every(item => item?.metadata?.matchId && item?.info && item?.summary)) return value
  for (const item of value) {
    if (Array.isArray(item)) {
      const found = findMatchArray(item)
      if (found) return found
    } else if (item && typeof item === 'object') {
      for (const child of Object.values(item)) {
        const found = findMatchArray(child)
        if (found) return found
      }
    }
  }
  return null
}

function tryParseMatchArray(raw) {
  if (!raw || raw.indexOf('"metadata"') === -1 || raw.indexOf('"matchId"') === -1) return null
  if (raw.indexOf('"gameCreation"') === -1 || raw.indexOf('"summary"') === -1) return null
  try { return findMatchArray(JSON.parse(raw)) } catch { return null }
}

function extractRscMatchArray(decoded) {
  const starts = []
  const chunkRe = /(?:^|[^\d])\d+:\[\{"metadata"\s*:/g
  for (const match of decoded.matchAll(chunkRe)) {
    const bracketOffset = match[0].lastIndexOf('[')
    if (bracketOffset !== -1) starts.push((match.index ?? 0) + bracketOffset)
  }
  const directRe = /\[\{"metadata"\s*:/g
  for (const match of decoded.matchAll(directRe)) starts.push(match.index ?? 0)
  const signatures = ['"gameCreation"', '"matchId"', '"summary"', '"units"']
  for (const sig of signatures) {
    let sigIdx = decoded.indexOf(sig)
    while (sigIdx !== -1) {
      const min = Math.max(0, sigIdx - 50000)
      for (let i = sigIdx; i >= min; i--) {
        if (decoded[i] === '[') starts.push(i)
      }
      sigIdx = decoded.indexOf(sig, sigIdx + sig.length)
    }
  }
  const seen = new Set()
  for (const start of starts) {
    if (seen.has(start)) continue
    seen.add(start)
    const raw = extractBalancedArrayFrom(decoded, start)
    const matches = tryParseMatchArray(raw)
    if (matches?.length > 0) return matches
  }
  return null
}

function placementStats(placement = []) {
  const total = placement.reduce((sum, v) => sum + Number(v ?? 0), 0)
  if (total <= 0) return { total: 0, top4Rate: 0, avgPlacement: 0 }
  const top4 = placement.slice(0, 4).reduce((sum, v) => sum + Number(v ?? 0), 0)
  const weighted = placement.reduce((sum, v, idx) => sum + Number(v ?? 0) * (idx + 1), 0)
  return { total, top4Rate: top4 / total, avgPlacement: weighted / total }
}

function getLastWednesdayMs() {
  const now = new Date()
  const utcDay = now.getUTCDay()
  const daysSinceWed = (utcDay - 3 + 7) % 7
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 0, 0))
  start.setUTCDate(start.getUTCDate() - daysSinceWed)
  if (now < start) start.setUTCDate(start.getUTCDate() - 7)
  return start.getTime()
}

function rankedBucket(group) {
  if (!group) return {}
  return group['1100'] ?? group[1100] ?? group.RANKED ?? group.ranked ?? group
}

function parseLeaderboard(html, limit) {
  const players = []
  const seen = new Set()
  const hrefRe = /href="\/tft\/summoners\/([^/"]+)\/([^"]+)"/g
  for (const match of html.matchAll(hrefRe)) {
    const playerRegion = match[1]
    const slug = match[2]
    if (!slug || slug.includes('/matches') || seen.has(slug)) continue
    seen.add(slug)
    players.push({ region: playerRegion, slug })
    if (players.length >= limit) break
  }
  return players
}

function parseProfile(html, slug) {
  const decoded = decodeFlightPayload(html)
  let matches = extractRscMatchArray(decoded)
  if (!matches) {
    const matchesRaw = extractBalancedArray(decoded, '"matches":')
    try { if (matchesRaw) matches = JSON.parse(matchesRaw) } catch { matches = null }
    if (!Array.isArray(matches) || !matches[0]?.participants) matches = null
  }
  const matchStatRaw = extractBalancedObject(decoded, '"matchStat"')
  let matchStat = null
  try { if (matchStatRaw) matchStat = JSON.parse(matchStatRaw) } catch { matchStat = null }
  const summonerRaw = extractBalancedObject(decoded, '"summoner"')
  let summoner = null
  try { if (summonerRaw) summoner = JSON.parse(summonerRaw) } catch { summoner = null }
  const puuidMatch = decoded.match(/"puuid"\s*:\s*"([^"]+)"/)
  if (puuidMatch?.[1]) summoner = { ...(summoner ?? {}), puuid: summoner?.puuid ?? puuidMatch[1] }
  return { slug, summoner, matchStat, matches }
}

function processMatchHistory(matches, patchStartMs, setNum) {
  const unitMap = {}, traitMap = {}, rawComps = []
  let counted = 0
  for (const match of matches) {
    const isNew = !!(match.info && match.summary && match.metadata?.matchId)
    const ts = isNew
      ? Number(match.info.gameCreation ?? 0)
      : (match.created_at ? new Date(match.created_at).getTime() : Number(match.game_datetime ?? 0))
    if (!ts || ts < patchStartMs) continue
    if (isNew) {
      if (Number(match.info.queueId) !== 1100) continue
    } else {
      const gt = match.game_type ?? match.queue_type ?? ''
      if (gt && gt !== 'ranked' && String(gt) !== '1100') continue
    }
    const matchSet = isNew ? match.info.tftSetNumber : (match.tft_set_number ?? match.set_number)
    if (matchSet && Number(matchSet) !== setNum) continue
    const units = isNew ? (match.summary.units ?? []) : ((match.participants ?? [])[0]?.units ?? [])
    const traits = isNew ? (match.summary.traits ?? []) : ((match.participants ?? [])[0]?.traits ?? [])
    const placement = isNew
      ? Math.min(Math.max(Number(match.summary.placement ?? 8), 1), 8)
      : Math.min(Math.max(Number((match.participants ?? [])[0]?.placement ?? 8), 1), 8)
    if (!isNew && !(match.participants ?? [])[0]) continue
    counted++
    const placementIdx = placement - 1
    for (const unit of units) {
      const id = isNew ? unit.characterId : (unit.id ?? unit.character_id ?? unit.apiName)
      if (!id || !id.startsWith(`TFT${setNum}_`)) continue
      if (!unitMap[id]) unitMap[id] = { apiName: id, placement: Array(8).fill(0), total: 0 }
      unitMap[id].placement[placementIdx]++
      unitMap[id].total++
    }
    for (const trait of traits) {
      const name = isNew ? trait.name : (trait.id ?? trait.apiName ?? trait.name)
      if (!name) continue
      const numUnits = isNew ? (trait.numUnits ?? 0) : (trait.num_units ?? trait.numUnits ?? 0)
      if (numUnits < 2) continue
      if (!traitMap[name]) traitMap[name] = { apiName: name, name, placement: Array(8).fill(0), total: 0 }
      traitMap[name].placement[placementIdx]++
      traitMap[name].total++
    }
    if (isNew) {
      const champIds = units.map(u => u.characterId).filter(id => id?.startsWith(`TFT${setNum}_`))
      if (champIds.length >= 4) {
        const items = {}
        for (const unit of units) {
          const validItems = (unit.itemNames ?? []).filter(Boolean)
          if (validItems.length > 0) items[unit.characterId] = validItems
        }
        rawComps.push({ championIds: champIds.slice().sort(), placement, items })
      }
    }
  }
  return { unitMap, traitMap, counted, rawComps }
}

function aggregateComps(allRawComps) {
  const compMap = {}
  for (const comp of allRawComps) {
    const key = comp.championIds.join(',')
    if (!compMap[key]) compMap[key] = { championIds: comp.championIds, placements: [], allItems: {} }
    compMap[key].placements.push(comp.placement)
    for (const [champId, items] of Object.entries(comp.items ?? {})) {
      if (!compMap[key].allItems[champId]) compMap[key].allItems[champId] = {}
      for (const item of items) {
        compMap[key].allItems[champId][item] = (compMap[key].allItems[champId][item] ?? 0) + 1
      }
    }
  }
  const rawAggregates = Object.values(compMap).map(c => {
    const total = c.placements.length
    const top4 = c.placements.filter(p => p <= 4).length
    const avgPlace = c.placements.reduce((s, p) => s + p, 0) / total
    const items = {}
    for (const [champId, itemCounts] of Object.entries(c.allItems)) {
      const top = Object.entries(itemCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([i]) => i)
      if (top.length) items[champId] = top
    }
    return {
      championIds: c.championIds,
      champions: c.championIds.map(id => id.replace(/^TFT\d+_/i, '').replace(/([a-z])([A-Z])/g, '$1 $2')),
      count: total,
      top4Rate: top4 / total,
      avgPlace,
      winRate: c.placements.filter(p => p === 1).length / total,
      items,
      roles: {}, threeStars: [], augments: [], positions: {}, tips: [],
      source: 'op.gg', primarySource: 'op.gg', sourceKind: 'challenger', sourceCount: 1,
      style: `${total} jocuri OP.GG Challenger`,
      tier: top4 / total >= 0.6 ? 'S' : top4 / total >= 0.4 ? 'A' : 'B',
    }
  })
  const repeated = rawAggregates.filter(c => c.count >= 2)
  return (repeated.length >= 8 ? repeated : rawAggregates)
    .sort((a, b) => b.count - a.count)
    .slice(0, 30)
}

function mergeUnit(target, unit) {
  const stats = placementStats(unit.placement)
  if (!stats.total || !unit.apiName) return
  if (!target[unit.apiName]) target[unit.apiName] = { total: 0, placement: Array(8).fill(0) }
  target[unit.apiName].total += stats.total
  unit.placement.forEach((v, idx) => { target[unit.apiName].placement[idx] += Number(v ?? 0) })
}

function mergeTrait(target, trait) {
  const stats = placementStats(trait.placement)
  if (!stats.total || !trait.apiName) return
  if (!target[trait.apiName]) target[trait.apiName] = { total: 0, placement: Array(8).fill(0), name: trait.name }
  target[trait.apiName].total += stats.total
  trait.placement.forEach((v, idx) => { target[trait.apiName].placement[idx] += Number(v ?? 0) })
}

async function fetchProfileWithFallbacks(player, summoner, debugActionBody) {
  const baseProfileUrl = `https://op.gg/tft/summoners/${player.region}/${player.slug}`
  const profileUrl = `${baseProfileUrl}/matches`

  const profileRes = await safeFetch(profileUrl)
  if (!profileRes) return null
  const profileHtml = await profileRes.text()
  const profile = parseProfile(profileHtml, player.slug)

  // Fallback 1: RSC fetch
  if (!profile.matches?.length) {
    const rscHeaders = { 'Accept': 'text/x-component', 'RSC': '1', 'Next-Router-Prefetch': '1' }
    for (const rscUrl of [`${profileUrl}?_rsc=tfthelper`, `${baseProfileUrl}?_rsc=tfthelper`]) {
      const rscRes = await safeFetch(rscUrl, rscHeaders)
      if (!rscRes) continue
      const rscProfile = parseProfile(await rscRes.text(), player.slug)
      if (rscProfile.matches?.length) { profile.matches = rscProfile.matches; break }
    }
  }

  // Fallback 2: Next-Action POST
  if (!profile.matches?.length) {
    const decodedSlug = decodeURIComponent(player.slug)
    const splitIdx = decodedSlug.lastIndexOf('-')
    const gameName = splitIdx === -1 ? decodedSlug : decodedSlug.slice(0, splitIdx)
    const tagLine = splitIdx === -1 ? '' : decodedSlug.slice(splitIdx + 1)
    const puuid = summoner?.puuid ?? profile.summoner?.puuid

    const bodies = [
      puuid ? JSON.stringify([{ region: player.region, puuid, startedAt: `$D${new Date().toISOString()}`, locale: 'en', queueType: '$undefined' }]) : null,
      JSON.stringify([player.region, decodedSlug]),
      JSON.stringify([{ region: player.region, gameName, tagLine }]),
    ].filter(Boolean)

    for (const body of bodies) {
      const extraHeaders = {
        'Accept': 'text/x-component',
        'Content-Type': 'text/plain;charset=UTF-8',
        'Next-Action': OPGG_MATCH_ACTION,
        'Next-Router-State-Tree': buildNextRouterStateTree(player.region, player.slug),
        'Origin': 'https://op.gg',
        'Referer': baseProfileUrl,
        'Cookie': `_tft_rs=%22${player.region}%22`,
      }
      const actionRes = await safePost(baseProfileUrl, body, extraHeaders)
      if (!actionRes?.ok) continue
      const actionProfile = parseProfile(await actionRes.text(), player.slug)
      if (actionProfile.matches?.length) { profile.matches = actionProfile.matches; break }
    }
  }

  return profile
}

// --- Main collection ---
async function collect() {
  console.log(`[challenger] Incep colectarea: region=${REGION} set=${SET} limit=${LIMIT}`)

  const leaderboardUrl = `https://op.gg/tft/leaderboards/ranked?region=${encodeURIComponent(REGION)}`
  const leaderboardRes = await safeFetch(leaderboardUrl)
  if (!leaderboardRes) {
    await sendDiscord(`⚠️ **TFT Collector** [${REGION}]: Nu am putut accesa leaderboard-ul OP.GG.`)
    process.exit(1)
  }
  const leaderboardHtml = await leaderboardRes.text()
  const slugs = parseLeaderboard(leaderboardHtml, LIMIT)
  console.log(`[challenger] ${slugs.length} profile gasite`)

  const patchStartMs = getLastWednesdayMs()
  const units = {}, traits = {}
  const aggregateUnits = {}, aggregateTraits = {}
  const profiles = []
  const allRawComps = []
  let scannedMatches = 0, usedIndividualMatches = 0, aggregateMatches = 0, aggregateProfiles = 0

  async function processPlayer(player) {
    try {
      const profile = await fetchProfileWithFallbacks(player, null, null)
      if (!profile) return

      profiles.push({
        slug: player.slug,
        region: player.region,
        gameName: profile.summoner?.gameName,
        tagLine: profile.summoner?.tagLine,
      })

      if (profile.matches?.length > 0) {
        const { unitMap, traitMap, counted, rawComps } = processMatchHistory(profile.matches, patchStartMs, SET)
        scannedMatches += counted
        if (counted > 0) {
          usedIndividualMatches++
          for (const stat of Object.values(unitMap)) mergeUnit(units, stat)
          for (const stat of Object.values(traitMap)) mergeTrait(traits, stat)
          allRawComps.push(...rawComps)
        } else if (profile.matchStat) {
          const rankedMatch = rankedBucket(profile.matchStat.match)
          aggregateMatches += Number(rankedMatch.total ?? 0)
          aggregateProfiles++
          Object.values(rankedBucket(profile.matchStat.units ?? {})).forEach(u => mergeUnit(aggregateUnits, u))
          Object.values(rankedBucket(profile.matchStat.traits ?? {})).forEach(t => mergeTrait(aggregateTraits, t))
        }
        console.log(`[challenger] ${player.slug}: ${counted}/${profile.matches.length} meciuri ranked`)
      } else if (profile.matchStat) {
        const rankedMatch = rankedBucket(profile.matchStat.match)
        aggregateMatches += Number(rankedMatch.total ?? 0)
        aggregateProfiles++
        Object.values(rankedBucket(profile.matchStat.units ?? {})).forEach(u => mergeUnit(aggregateUnits, u))
        Object.values(rankedBucket(profile.matchStat.traits ?? {})).forEach(t => mergeTrait(aggregateTraits, t))
      }
    } catch (e) {
      console.warn(`[challenger] Eroare la ${player.slug}: ${e.message}`)
    }
  }

  await runBatched(slugs, processPlayer, CONCURRENCY)

  // Daca nu avem meciuri individuale, folosim aggregate ca fallback
  if (scannedMatches === 0 && aggregateMatches > 0) {
    Object.values(aggregateUnits).forEach(u => mergeUnit(units, u))
    Object.values(aggregateTraits).forEach(t => mergeTrait(traits, t))
  }

  const challengerComps = usedIndividualMatches > 0 ? aggregateComps(allRawComps) : []

  const unitStats = {}
  Object.entries(units).forEach(([apiName, stat]) => {
    const computed = placementStats(stat.placement)
    if (!computed.total) return
    unitStats[apiName] = {
      total: computed.total,
      top4Rate: computed.top4Rate,
      avgPlacement: computed.avgPlacement,
      topItems: [],
      source: 'op.gg',
    }
  })

  const traitStats = Object.entries(traits)
    .map(([apiName, stat]) => {
      const computed = placementStats(stat.placement)
      return { name: stat.name ?? apiName, apiName, appearances: computed.total, top4Rate: computed.top4Rate, avgPlacement: computed.avgPlacement, source: 'op.gg' }
    })
    .filter(s => s.appearances > 0)
    .sort((a, b) => b.appearances - a.appearances)

  const result = {
    source: 'op.gg',
    region: REGION,
    set: SET,
    profiles,
    scannedProfiles: profiles.length,
    scannedMatches,
    aggregateMatches,
    aggregateProfiles,
    aggregateUsed: scannedMatches === 0 && aggregateMatches > 0,
    hasIndividualMatches: usedIndividualMatches > 0,
    individualProfiles: usedIndividualMatches,
    patchStartMs,
    unitStats,
    traitStats,
    augmentStats: [],
    challengerComps,
    updatedAt: new Date().toISOString(),
    scrapedAt: Date.now(),
  }

  // Salveaza in fisier
  const dataDir = DATA_DIR_ARG ? join(process.cwd(), DATA_DIR_ARG) : join(ROOT, 'data')
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  const outPath = join(dataDir, `challenger-${REGION}-${SET}.json`)
  writeFileSync(outPath, JSON.stringify(result, null, 2))

  const matchSummary = `${scannedMatches} meciuri, ${challengerComps.length} comps, ${profiles.length} profile`
  console.log(`[challenger] Salvat: ${outPath} (${matchSummary})`)

  if (scannedMatches === 0 && aggregateMatches === 0) {
    await sendDiscord(`⚠️ **TFT Collector** [${REGION.toUpperCase()}]: 0 meciuri gasite. Hash-ul OP.GG Next-Action s-a schimbat probabil.\n\`OPGG_MATCH_ACTION = '${OPGG_MATCH_ACTION}'\``)
  } else {
    console.log(`[challenger] OK: ${matchSummary}`)
  }
}

collect().catch(async err => {
  console.error('[challenger] Eroare fatala:', err)
  await sendDiscord(`❌ **TFT Collector** [${REGION.toUpperCase()}]: Eroare fatala — ${err.message}`)
  process.exit(1)
})
