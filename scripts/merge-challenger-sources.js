#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'fs'
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
const DATA_DIR = join(ROOT, getArg('data-dir', 'data'))
const SOURCES = ['kr', 'euw']

function loadJson(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function placementStats(placement = []) {
  const total = placement.reduce((sum, v) => sum + Number(v ?? 0), 0)
  if (total <= 0) return { total: 0, top4Rate: 0, avgPlacement: 0 }
  const top4 = placement.slice(0, 4).reduce((sum, v) => sum + Number(v ?? 0), 0)
  const weighted = placement.reduce((sum, v, idx) => sum + Number(v ?? 0) * (idx + 1), 0)
  return { total, top4Rate: top4 / total, avgPlacement: weighted / total }
}

function aggregateComps(allRawComps) {
  const compMap = {}
  for (const comp of allRawComps) {
    const key = (comp.championIds ?? []).join(',')
    if (!key) continue
    if (!compMap[key]) compMap[key] = { championIds: comp.championIds, placements: [], itemStats: {}, threeStarStats: {} }
    compMap[key].placements.push(comp.placement)
    for (const [champId, items] of Object.entries(comp.items ?? {})) {
      if (!compMap[key].itemStats[champId]) {
        compMap[key].itemStats[champId] = { itemCounts: {}, matchesWithItems: 0, totalItems: 0, maxItems: 0 }
      }
      compMap[key].itemStats[champId].matchesWithItems++
      compMap[key].itemStats[champId].totalItems += items.length
      compMap[key].itemStats[champId].maxItems = Math.max(compMap[key].itemStats[champId].maxItems, items.length)
      for (const item of items) {
        compMap[key].itemStats[champId].itemCounts[item] = (compMap[key].itemStats[champId].itemCounts[item] ?? 0) + 1
      }
    }
    for (const champId of comp.threeStars ?? []) {
      compMap[key].threeStarStats[champId] = (compMap[key].threeStarStats[champId] ?? 0) + 1
    }
  }

  return Object.values(compMap)
    .filter(c => c.placements.length >= 2)
    .map(c => {
      const total = c.placements.length
      const top4 = c.placements.filter(p => p <= 4).length
      const avgPlace = c.placements.reduce((s, p) => s + p, 0) / total
      const items = {}
      const roles = {}
      const threeStars = Object.entries(c.threeStarStats)
        .filter(([, count]) => count >= 2 && count / total >= 0.2)
        .sort((a, b) => b[1] - a[1])
        .map(([champId]) => champId)
        .slice(0, 3)
      const holders = Object.entries(c.itemStats)
        .map(([champId, stat]) => {
          const coverage = stat.matchesWithItems / total
          const avgItems = stat.totalItems / stat.matchesWithItems
          const score = stat.matchesWithItems * 10 + stat.totalItems * 3 + stat.maxItems * 8 + coverage * 25
          return { champId, stat, coverage, avgItems, score }
        })
        .filter(({ stat, coverage, avgItems }) =>
          stat.matchesWithItems >= 2 && (coverage >= 0.18 || avgItems >= 2.4 || stat.maxItems >= 3)
        )
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)

      for (const { champId, stat, avgItems } of holders) {
        const top = Object.entries(stat.itemCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([i]) => i)
        if (!top.length) continue
        items[champId] = top
        roles[champId] = threeStars.includes(champId)
          ? '3-star'
          : (avgItems >= 2.5 ? 'Carry' : 'Item holder')
      }

      return {
        championIds: c.championIds,
        champions: c.championIds.map(id => id.replace(/^TFT\d+_/i, '').replace(/([a-z])([A-Z])/g, '$1 $2')),
        count: total,
        top4Rate: top4 / total,
        avgPlace,
        winRate: c.placements.filter(p => p === 1).length / total,
        items,
        roles,
        threeStars,
        augments: [],
        positions: {},
        tips: [],
        source: 'merged',
        primarySource: 'merged',
        sourceKind: 'challenger',
        sourceCount: 2,
        style: `${total} jocuri Challenger combinate`,
        tier: top4 / total >= 0.6 ? 'S' : top4 / total >= 0.4 ? 'A' : 'B',
      }
    })
    .sort((a, b) => (
      b.count - a.count ||
      (b.top4Rate ?? 0) - (a.top4Rate ?? 0) ||
      (a.avgPlace ?? 9) - (b.avgPlace ?? 9)
    ))
    .slice(0, 30)
}

function mergeUnitStats(datasets) {
  const merged = {}
  for (const data of datasets) {
    for (const [apiName, stat] of Object.entries(data?.unitStats ?? {})) {
      if (!merged[apiName]) merged[apiName] = { total: 0, top4Weighted: 0, placementWeighted: 0, itemCounts: {} }
      const total = Number(stat.total ?? 0)
      const top4Rate = Number(stat.top4Rate ?? 0)
      const avgPlacement = Number(stat.avgPlacement ?? 0)
      merged[apiName].total += total
      merged[apiName].top4Weighted += top4Rate * total
      merged[apiName].placementWeighted += avgPlacement * total
      for (const item of stat.topItems ?? []) {
        const key = item.name
        merged[apiName].itemCounts[key] = (merged[apiName].itemCounts[key] ?? 0) + Number(item.count ?? 0)
      }
    }
  }
  const result = {}
  for (const [apiName, stat] of Object.entries(merged)) {
    if (stat.total <= 0) continue
    result[apiName] = {
      total: stat.total,
      top4Rate: Number((stat.top4Weighted / stat.total).toFixed(4)),
      avgPlacement: Number((stat.placementWeighted / stat.total).toFixed(3)),
      topItems: Object.entries(stat.itemCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([name, count]) => ({ name, count })),
      source: 'merged',
    }
  }
  return result
}

function mergeTraitStats(datasets) {
  const merged = {}
  for (const data of datasets) {
    for (const trait of data?.traitStats ?? []) {
      const key = trait.apiName ?? trait.name
      if (!key) continue
      if (!merged[key]) merged[key] = { name: trait.name ?? key, appearances: 0, top4Weighted: 0, placementWeighted: 0 }
      const apps = Number(trait.appearances ?? 0)
      merged[key].appearances += apps
      merged[key].top4Weighted += Number(trait.top4Rate ?? 0) * apps
      merged[key].placementWeighted += Number(trait.avgPlacement ?? 0) * apps
    }
  }
  return Object.entries(merged)
    .filter(([, stat]) => stat.appearances > 0)
    .map(([apiName, stat]) => ({
      name: stat.name,
      apiName,
      appearances: stat.appearances,
      top4Rate: Number((stat.top4Weighted / stat.appearances).toFixed(4)),
      avgPlacement: Number((stat.placementWeighted / stat.appearances).toFixed(3)),
      source: 'merged',
    }))
    .sort((a, b) => b.appearances - a.appearances)
}

function mergeAugmentStats(datasets) {
  const merged = {}
  for (const data of datasets) {
    for (const aug of data?.augmentStats ?? []) {
      const key = aug.apiName ?? aug.name
      if (!key) continue
      if (!merged[key]) merged[key] = { apiName: aug.apiName, name: aug.name ?? key, appearances: 0, top4Weighted: 0, placementWeighted: 0, fromChallenger: !!aug.fromChallenger }
      const apps = Number(aug.appearances ?? 0)
      merged[key].appearances += apps
      merged[key].top4Weighted += Number(aug.top4Rate ?? 0) * apps
      merged[key].placementWeighted += Number(aug.avgPlacement ?? 0) * apps
      merged[key].fromChallenger = merged[key].fromChallenger || !!aug.fromChallenger
    }
  }
  return Object.values(merged)
    .filter(stat => stat.appearances > 0)
    .map(stat => ({
      ...(stat.apiName ? { apiName: stat.apiName } : {}),
      name: stat.name,
      appearances: stat.appearances,
      top4Rate: Number((stat.top4Weighted / stat.appearances).toFixed(4)),
      avgPlacement: Number((stat.placementWeighted / stat.appearances).toFixed(3)),
      fromChallenger: stat.fromChallenger,
    }))
    .sort((a, b) => b.appearances - a.appearances)
}

function mergeProfiles(datasets) {
  const seen = new Set()
  const profiles = []
  for (const data of datasets) {
    for (const profile of data?.profiles ?? []) {
      const key = `${profile.region ?? ''}:${profile.slug ?? ''}`
      if (!profile.slug || seen.has(key)) continue
      seen.add(key)
      profiles.push(profile)
    }
  }
  return profiles
}

function mergeData() {
  const datasets = SOURCES
    .map(region => loadJson(join(DATA_DIR, `challenger-${region}-${SET}.json`)))
    .filter(Boolean)

  if (datasets.length === 0) {
    console.log('[merge-challenger] No source datasets found')
    process.exit(0)
  }

  const matchIds = new Set()
  const rawCompByMatch = new Map()

  for (const data of datasets) {
    for (const matchId of data.matchIds ?? []) {
      if (matchId) matchIds.add(matchId)
    }
    for (const rawComp of data.rawComps ?? []) {
      const key = rawComp.matchId
        ? `${rawComp.matchId}:${rawComp.placement}:${(rawComp.championIds ?? []).join(',')}`
        : `${(rawComp.championIds ?? []).join(',')}:${rawComp.placement}:${JSON.stringify(rawComp.items ?? {})}`
      if (!rawCompByMatch.has(key)) rawCompByMatch.set(key, rawComp)
    }
  }

  const rawComps = [...rawCompByMatch.values()]
  const challengerComps = aggregateComps(rawComps)
  const scannedMatches = matchIds.size > 0
    ? matchIds.size
    : datasets.reduce((sum, data) => sum + Number(data.scannedMatches ?? 0), 0)

  const merged = {
    sources: {
      api: datasets.some(data => data.sources?.riot),
      opgg: datasets.some(data => data.source === 'op.gg' || data.sources?.opgg),
      merged: true,
    },
    regions: SOURCES.filter(region => existsSync(join(DATA_DIR, `challenger-${region}-${SET}.json`))),
    unitStats: mergeUnitStats(datasets),
    traitStats: mergeTraitStats(datasets),
    augmentStats: mergeAugmentStats(datasets).slice(0, 50),
    challengerComps,
    scannedMatches,
    uniqueMatchIds: matchIds.size,
    matchIds: [...matchIds],
    rawComps,
    scannedProfiles: datasets.reduce((sum, data) => sum + Number(data.scannedProfiles ?? 0), 0),
    profiles: mergeProfiles(datasets),
    source: 'merged',
    patchVersion: datasets.find(data => data.patchVersion)?.patchVersion ?? null,
    patchStartTime: datasets.find(data => data.patchStartTime)?.patchStartTime ?? null,
    scrapedAt: Date.now(),
  }

  const outPath = join(DATA_DIR, `challenger-merged-${SET}.json`)
  writeFileSync(outPath, JSON.stringify(merged, null, 2))
  console.log(`[merge-challenger] Saved ${outPath} (${scannedMatches} unique matches, ${challengerComps.length} comps)`)
}

mergeData()
