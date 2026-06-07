#!/usr/bin/env node
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
const SET = Number(getArg('set', '17'))
const DATA_DIR_ARG = getArg('data-dir', null)

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

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

const METATFT_HEADERS = {
  ...HEADERS,
  'Accept': 'application/json, */*',
  'Origin': 'https://www.metatft.com',
  'Referer': 'https://www.metatft.com/',
}

async function safeFetch(url, extra = {}) {
  try {
    const r = await fetch(url, { headers: { ...HEADERS, ...extra }, signal: AbortSignal.timeout(12000) })
    if (!r.ok) { console.warn(`[meta] ${new URL(url).pathname} → ${r.status}`); return null }
    return r
  } catch (e) { console.warn(`[meta] ${url} → ${e.message}`); return null }
}

const { parseMetaPage, extractNextBuildId, combineComps, parseMetaTFTApi, parseTftAcademy, parseOpggTft, augmentIdToName } =
  await import('./parseMetaSite.js')

async function fetchSiteComps(baseUrl, nextPaths) {
  const r = await safeFetch(baseUrl)
  if (!r) return []
  const html = await r.text()
  const buildId = extractNextBuildId(html)
  const origin = new URL(baseUrl).origin
  if (!buildId) return []
  for (const p of (nextPaths ?? [])) {
    const url = `${origin}/_next/data/${buildId}/${p}`
    const nr = await safeFetch(url, { 'Accept': 'application/json, */*', 'x-nextjs-data': '1', 'Referer': `${origin}/` })
    if (!nr) continue
    try {
      const json = await nr.json()
      const parsed = parseMetaPage(JSON.stringify(json))
      if (parsed.comps?.length > 0) {
        console.log(`[meta] ${origin} (${p}) → ${parsed.comps.length} comps`)
        return parsed.comps
      }
    } catch (e) { console.warn(`[meta] ${origin}/${p} parse error: ${e.message}`) }
  }
  return []
}

async function fetchMetaTFT() {
  try {
    const [optionsRes, buildsRes] = await Promise.all([
      safeFetch('https://api-hc.metatft.com/tft-comps-api/comp_options', METATFT_HEADERS),
      safeFetch('https://api-hc.metatft.com/tft-comps-api/comp_builds', METATFT_HEADERS),
    ])
    if (!optionsRes) return []
    const optionsJson = await optionsRes.json()
    const buildsJson = buildsRes ? await buildsRes.json() : null

    const validClusterIds = []
    const rawOptions = optionsJson?.results?.options ?? {}
    for (const [clusterId, sizeGroups] of Object.entries(rawOptions)) {
      for (const size of ['8', '7', '9', '6', '10']) {
        const list = sizeGroups?.[size]
        if (Array.isArray(list) && list.some(c => c.count >= 100 && c.avg < 4.5)) {
          validClusterIds.push(clusterId)
          break
        }
      }
    }

    const [compsDataRes, detailsResponses] = await Promise.all([
      safeFetch('https://api-hc.metatft.com/tft-comps-api/comps_data', METATFT_HEADERS),
      Promise.all(
        validClusterIds.map(id => {
          const clusterGroupId = Math.floor(parseInt(id) / 1000)
          return safeFetch(`https://api-hc.metatft.com/tft-comps-api/comp_details?comp=${id}&cluster_id=${clusterGroupId}`, METATFT_HEADERS)
        })
      ),
    ])

    const augmentsMap = {}
    const compsDataDetails = {}
    if (compsDataRes) {
      try {
        const compsDataJson = await compsDataRes.json()
        const clusterDetails = compsDataJson?.results?.data?.cluster_details ?? {}
        for (const [compId, compData] of Object.entries(clusterDetails)) {
          compsDataDetails[compId] = compData
          const nameStr = compData?.name_string ?? ''
          const augsFromName = nameStr.split(',')
            .map(s => s.trim())
            .filter(s => s.includes('Augment') && s.startsWith('TFT'))
            .map(id => augmentIdToName(id))
            .filter(Boolean)
          if (augsFromName.length > 0) augmentsMap[compId] = augsFromName
        }
      } catch (e) { console.warn('[meta] comps_data parse error:', e.message) }
    }

    const detailsMap = {}
    for (let i = 0; i < validClusterIds.length; i++) {
      const r = detailsResponses[i]
      if (!r) continue
      try {
        const data = await r.json()
        const results = data?.results ?? {}
        const threeStars = (results.unit_stats ?? [])
          .filter(u => (u.tiers?.find(t => t.tier === 3)?.pcnt ?? 0) >= 0.4)
          .map(u => u.unit)
        const positions = {}
        const posUnits = results.positioning?.units ?? {}
        for (const [unitId, unitData] of Object.entries(posUnits)) {
          const topCell = unitData.positions?.[0]?.cell
          if (!topCell) continue
          const cellNum = parseInt(topCell.replace('cell_', ''))
          if (!Number.isFinite(cellNum) || cellNum < 1) continue
          const slot = cellNum - 1
          const row = 4 - Math.floor(slot / 7)
          const col = (slot % 7) + 1
          if (row >= 1 && row <= 4 && col >= 1 && col <= 7) positions[unitId] = { row, col }
        }
        const detailAugs = (results.augments ?? [])
          .filter(a => a.aug && a.aug.startsWith('TFT') && (a.count ?? 0) > 50)
          .sort((a, b) => b.count - a.count).slice(0, 6).map(a => a.aug)
        if (detailAugs.length > 0) {
          const existing = augmentsMap[validClusterIds[i]] ?? []
          augmentsMap[validClusterIds[i]] = [...new Set([...existing, ...detailAugs])].slice(0, 6)
        }
        detailsMap[validClusterIds[i]] = { threeStars, positions }
      } catch {}
    }

    const comps = parseMetaTFTApi(optionsJson, buildsJson, detailsMap, augmentsMap)
    console.log(`[meta] metatft → ${comps.length} comps`)
    return comps
  } catch (e) { console.warn('[meta] metatft error:', e.message); return [] }
}

async function fetchTftAcademy() {
  try {
    const r = await safeFetch('https://tftacademy.com/tierlist/comps')
    if (!r) return []
    const html = await r.text()
    const comps = parseTftAcademy(html)
    console.log(`[meta] tftacademy → ${comps.length} comps`)
    return comps
  } catch (e) { console.warn('[meta] tftacademy error:', e.message); return [] }
}

async function fetchOpggMeta() {
  try {
    const r = await safeFetch('https://op.gg/tft/meta-trends/comps', { 'Referer': 'https://op.gg/tft' })
    if (!r) return []
    const html = await r.text()
    const comps = parseOpggTft(html, [])
    console.log(`[meta] op.gg → ${comps.length} comps`)
    return comps
  } catch (e) { console.warn('[meta] op.gg error:', e.message); return [] }
}

async function collect() {
  console.log(`[meta] Incep colectarea: set=${SET}`)

  const [tacticsComps, lolchessComps, metaTFTComps, academyComps, opggComps] = await Promise.all([
    fetchSiteComps('https://tactics.tools/team-compositions', ['en/team-compositions.json', 'team-compositions.json']),
    fetchSiteComps('https://lolchess.gg/meta', ['meta.json', 'en/meta.json']),
    fetchMetaTFT(),
    fetchTftAcademy(),
    fetchOpggMeta(),
  ])

  console.log(`[meta] tactics: ${tacticsComps.length} | lolchess: ${lolchessComps.length} | metatft: ${metaTFTComps.length} | academy: ${academyComps.length} | opgg: ${opggComps.length}`)

  const sources = [tacticsComps, lolchessComps, metaTFTComps, academyComps, opggComps].filter(l => l.length > 0)
  let comps = []
  if (sources.length >= 2) {
    comps = combineComps(sources)
    console.log(`[meta] Combinat: ${comps.length} comps (${comps.filter(c => c.sourceCount >= 2).length} confirmate)`)
  } else if (sources.length === 1) {
    comps = sources[0]
  } else {
    await sendDiscord(`⚠️ **TFT Meta Collector**: Toate sursele au esuat pentru set ${SET}.`)
  }

  const result = {
    comps,
    set: SET,
    sources: {
      tactics: tacticsComps.length,
      lolchess: lolchessComps.length,
      metatft: metaTFTComps.length,
      academy: academyComps.length,
      opgg: opggComps.length,
    },
    confirmedCount: comps.filter(c => c.sourceCount >= 2).length,
    updatedAt: new Date().toISOString(),
    scrapedAt: Date.now(),
  }

  const dataDir = DATA_DIR_ARG ? join(process.cwd(), DATA_DIR_ARG) : join(ROOT, 'data')
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  const outPath = join(dataDir, `meta-${SET}.json`)
  writeFileSync(outPath, JSON.stringify(result, null, 2))
  console.log(`[meta] Salvat: ${outPath} (${comps.length} comps)`)
}

collect().catch(async err => {
  console.error('[meta] Eroare fatala:', err)
  await sendDiscord(`❌ **TFT Meta Collector**: Eroare fatala — ${err.message}`)
  process.exit(1)
})
