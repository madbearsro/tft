export function extractNextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!match) return null
  try { return JSON.parse(match[1]) } catch { return null }
}

export function extractNextBuildId(html) {
  const d = extractNextData(html)
  return d?.buildId ?? null
}

function inferTier(avgPlace) {
  if (avgPlace < 3.2) return 'S'
  if (avgPlace < 3.7) return 'A'
  if (avgPlace < 4.2) return 'B'
  return 'C'
}

function normalizeBoardPosition(pos) {
  if (!pos) return null
  let row = Number(pos.row ?? pos.y ?? pos.hexRow)
  let col = Number(pos.col ?? pos.column ?? pos.x ?? pos.hexCol)
  const slot = Number(pos.slot ?? pos.position ?? pos.boardIndex ?? pos.hex ?? pos.cell)

  if ((!Number.isFinite(row) || !Number.isFinite(col)) && Number.isFinite(slot)) {
    row = Math.floor(slot / 7)
    col = slot % 7
  }

  if (!Number.isFinite(row) || !Number.isFinite(col)) return null
  if (row >= 0 && row <= 3) row += 1
  if (col >= 0 && col <= 6) col += 1
  if (row < 1 || row > 4 || col < 1 || col > 7) return null

  return { row, col }
}

function cleanTipText(text) {
  if (!text || typeof text !== 'string') return ''
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractTipsFromValue(value, depth = 0) {
  if (!value || depth > 4) return []
  if (typeof value === 'string') {
    const text = cleanTipText(value)
    return text.length >= 18 && text.length <= 260 ? [text] : []
  }
  if (Array.isArray(value)) {
    return value.flatMap(v => extractTipsFromValue(v, depth + 1))
  }
  if (typeof value !== 'object') return []

  const tipKeys = [
    'tip', 'tips', 'guide', 'guides', 'description', 'desc', 'summary',
    'notes', 'note', 'playstyle', 'playStyle', 'howToPlay', 'earlyGame',
    'midGame', 'lateGame', 'leveling', 'positioning',
  ]

  const direct = []
  for (const key of tipKeys) {
    if (value[key] !== undefined) direct.push(...extractTipsFromValue(value[key], depth + 1))
  }
  for (const key of ['text', 'title', 'body', 'content', 'label']) {
    if (typeof value[key] === 'string') direct.push(...extractTipsFromValue(value[key], depth + 1))
  }

  return direct
}

function dedupeTips(tips, max = 5) {
  const seen = new Set()
  return tips
    .map(cleanTipText)
    .filter(Boolean)
    .filter(t => {
      const key = t.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, max)
}

function decodeHtmlEntities(text) {
  if (!text || typeof text !== 'string') return ''
  return text
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function normalizeLookupName(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function buildKnownChampionLookup(knownChampions = []) {
  const list = knownChampions
    .map(champ => {
      if (typeof champ === 'string') return { id: '', name: champ }
      return { id: champ?.id ?? '', name: champ?.name ?? champ?.displayName ?? '' }
    })
    .filter(champ => champ.name)

  const byName = new Map()
  list.forEach(champ => {
    const key = normalizeLookupName(champ.name)
    if (key && !byName.has(key)) byName.set(key, champ)
  })

  return { list, byName }
}


export function augmentIdToName(apiName) {
  if (!apiName) return ''
  let n = apiName
    .replace(/^TFT\d*_Augment_/i, '')
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
  n = n.replace(/\s*3$/, ' III').replace(/\s*2$/, ' II').replace(/\s*1$/, ' I')
  n = n.replace(/\s*Plus$/, '+').replace(/\s*Minus$/, '-')
  return n
}

export function parseTacticsTools(json) {
  const groups = json?.pageProps?.initialData?.groups
    ?? json?.initialData?.groups
    ?? []
  if (!groups.length) return []

  const comps = []
  for (const group of groups) {
    const raw = group?.full?.comps ?? group?.comps ?? []
    for (const c of raw) {
      const units = c.units ?? []
      if (units.length < 4) continue
      const count = c.count ?? 0
      if (count < 30) continue

      const avgPlace = c.place ?? 5
      const top4Rate = count > 0 ? (c.top4 ?? 0) / count : 0
      const winRate  = count > 0 ? (c.win  ?? 0) / count : 0

      comps.push({
        source: 'tactics.tools',
        tier: inferTier(avgPlace),
        style: `avg #${avgPlace.toFixed(1)} · top4 ${Math.round(top4Rate * 100)}%`,
        championIds: units,
        champions: units.map(u => u.replace(/^TFT\d+_/i, '').replace(/([a-z])([A-Z])/g, '$1 $2')),
        count,
        avgPlace,
        top4Rate,
        winRate,
      })
    }
  }

  return comps.sort((a, b) => a.avgPlace - b.avgPlace)
}

export function parseLolchess(json) {
  const queries = json?.pageProps?.dehydratedState?.queries
    ?? json?.dehydratedState?.queries
    ?? []

  if (!queries.length) return []

  const champMap = {}
  const itemMap  = {}
  let guideDecks = []

  for (const q of queries) {
    const data = q?.state?.data
    if (!data) continue
    if (Array.isArray(data.champions)) {
      data.champions.forEach(c => { if (c.key && c.ingameKey) champMap[c.key] = c.ingameKey })
    }
    if (Array.isArray(data.items)) {
      data.items.forEach(it => { if (it.key && it.ingameKey) itemMap[it.key] = it.ingameKey })
    }
    if (Array.isArray(data.guideDecks) && data.guideDecks.length > 0) {
      guideDecks = data.guideDecks
    }
  }

  console.log(`[scraper] lolchess maps: ${Object.keys(champMap).length} champs, ${Object.keys(itemMap).length} items, ${guideDecks.length} decks`)

  if (!guideDecks.length) return []

  const comps = []
  const seenKeys = new Set()

  for (const deck of guideDecks) {
    const slots = deck.data?.slots ?? []
    if (slots.length < 4) continue

    const championIds = slots
      .map(s => {
        const resolved = champMap[s.champion]
        if (resolved) return resolved
        if (s.champion?.startsWith('TFT')) return s.champion
        const key = Object.keys(champMap).find(k => k.toLowerCase() === (s.champion ?? '').toLowerCase())
        return key ? champMap[key] : null
      })
      .filter(id => id?.startsWith('TFT'))

    if (championIds.length < 4) continue

    const setKey = championIds.slice().sort().join(',')
    if (seenKeys.has(setKey)) continue
    seenKeys.add(setKey)

    const itemsPerChamp = {}
    const positions = {}
    slots.forEach(s => {
      const champId = champMap[s.champion]
        ?? (s.champion?.startsWith('TFT') ? s.champion : null)
      if (!champId) return

      const pos = normalizeBoardPosition(s)
      if (pos) positions[champId] = pos

      const resolved = (s.items ?? [])
        .map(k => itemMap[k] ?? k)
        .filter(Boolean)
      if (resolved.length > 0) itemsPerChamp[champId] = resolved
    })

    const threeStars = slots
      .filter(s => s.star >= 3)
      .map(s => champMap[s.champion])
      .filter(Boolean)

    const roles = {}
    slots.forEach(s => {
      const champId = champMap[s.champion]
        ?? (s.champion?.startsWith('TFT') ? s.champion : null)
      if (!champId) return
      const sourceRole = s.role ?? s.type ?? s.positionType ?? s.unitRole ?? s.championRole
      if (sourceRole && typeof sourceRole === 'string') roles[champId] = sourceRole
      else if (s.isCarry || s.carry || s.mainCarry) roles[champId] = 'Carry'
      else if (s.star >= 3) roles[champId] = '3-star'
      else if ((s.items ?? []).length >= 2) roles[champId] = 'Item holder'
    })

    const augments = (deck.data?.augments ?? deck.augments ?? [])
      .map(a => typeof a === 'string' ? a : a?.key ?? a?.apiName ?? a?.name ?? '')
      .filter(Boolean)
      .map(augmentIdToName)
      .filter(Boolean)

    const tips = dedupeTips([
      ...extractTipsFromValue(deck.tips),
      ...extractTipsFromValue(deck.guide),
      ...extractTipsFromValue(deck.description),
      ...extractTipsFromValue(deck.data?.tips),
      ...extractTipsFromValue(deck.data?.guide),
      ...extractTipsFromValue(deck.data?.description),
      ...extractTipsFromValue(deck.data?.notes),
      ...extractTipsFromValue(deck.data?.playstyle),
      ...extractTipsFromValue(deck.data?.leveling),
      ...extractTipsFromValue(deck.data?.positioning),
    ])

    const deckSlug = deck.slug ?? deck.id ?? null
    const sourceUrl = deckSlug ? `https://lolchess.gg/guide/${deckSlug}` : null

    comps.push({
      source: 'lolchess.gg',
      name: deck.name ?? championIds.slice(0, 2).map(id => id.replace(/^TFT\d+_/i, '')).join(' + '),
      tier: 'A',
      championIds,
      champions: championIds.map(id => id.replace(/^TFT\d+_/i, '').replace(/([a-z])([A-Z])/g, '$1 $2')),
      items: itemsPerChamp,
      positions,
      augments,
      tips,
      threeStars,
      roles,
      sourceUrl,
      count: 0,
      avgPlace: 4.0,
      top4Rate: 0,
      winRate: 0,
      style: deck.name ?? '',
    })
  }

  console.log(`[scraper] lolchess parsed ${comps.length} comps`)
  return comps
}

export function parseBlitz(json) {
  const root = json?.pageProps ?? json?.props?.pageProps ?? json
  const rawComps =
    root?.comps ?? root?.teamComps ?? root?.compositions ??
    root?.data?.comps ?? root?.data?.teamComps ?? []

  if (Array.isArray(rawComps) && rawComps.length > 0) {
    return rawComps
      .map(c => {
        const units = (c.units ?? c.champions ?? c.slots ?? [])
          .map(u => typeof u === 'string' ? u : u?.championId ?? u?.id ?? u?.key ?? '')
          .filter(s => typeof s === 'string' && s.startsWith('TFT'))
        if (units.length < 4) return null
        const count    = c.count ?? c.games ?? 0
        const avgPlace = c.avgPlace ?? c.averagePlacement ?? c.place ?? 4
        const top4     = c.top4 ?? c.top4Rate ?? 0
        const top4Rate = top4 <= 1 ? top4 : count > 0 ? top4 / count : 0
        return {
          source: 'blitz.gg',
          tier: inferTier(Number(avgPlace)),
          championIds: units,
          champions: units.map(u => u.replace(/^TFT\d+_/i, '').replace(/([a-z])([A-Z])/g, '$1 $2')),
          count,
          avgPlace: Number(avgPlace),
          top4Rate,
          winRate: 0,
          style: '',
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.avgPlace - b.avgPlace)
  }
  return []
}

export function parseMobalytics(json) {
  const root = json?.data ?? json?.pageProps?.data ?? json?.props?.pageProps ?? json
  const rawComps =
    root?.tftTeamComps ?? root?.comps ?? root?.teamComps ??
    root?.compositions ?? root?.entries ?? []

  if (!Array.isArray(rawComps) || rawComps.length === 0) return []

  return rawComps
    .map(c => {
      const units = (c.champions ?? c.units ?? c.tftChampions ?? [])
        .map(u => {
          if (typeof u === 'string') return u
          return u?.championId ?? u?.key ?? u?.id ?? u?.name ?? ''
        })
        .filter(s => s.startsWith('TFT'))

      if (units.length < 4) return null

      const count    = c.count ?? c.gamesPlayed ?? 0
      const avgPlace = c.avgPlace ?? c.averagePlacement ?? c.placement ?? 4
      const top4     = c.top4Rate ?? c.top4 ?? 0
      const top4Rate = top4 <= 1 ? top4 : count > 0 ? top4 / count : 0

      return {
        source: 'mobalytics',
        tier: c.tier ?? inferTier(Number(avgPlace)),
        championIds: units,
        champions: units.map(u => u.replace(/^TFT\d+_/i, '').replace(/([a-z])([A-Z])/g, '$1 $2')),
        count,
        avgPlace: Number(avgPlace),
        top4Rate,
        winRate: 0,
        style: c.name ?? '',
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.avgPlace - b.avgPlace)
}

export function parseUgg(json) {
  const apolloState =
    json?.__APOLLO_STATE__ ??
    json?.pageProps?.__APOLLO_STATE__ ??
    json?.props?.pageProps?.__APOLLO_STATE__ ??
    null

  if (!apolloState) return []

  const allKeys = Object.keys(apolloState)
  const typeNames = [...new Set(allKeys.map(k => k.split(':')[0]))]
  console.log(`[scraper] u.gg Apollo entries: ${allKeys.length}, types: [${typeNames.slice(0, 8).join(', ')}]`)

  const unitById = {}
  for (const key of allKeys) {
    const m = key.match(/^[^:]+:(TFT\d+_\w+)$/)
    if (m) unitById[m[1]] = apolloState[key]
  }
  console.log(`[scraper] u.gg unit index: ${Object.keys(unitById).length} campioni`)

  const comps = []
  const seenKeys = new Set()

  function resolveRef(ref) {
    return ref?.__ref ? apolloState[ref.__ref] : ref
  }

  function extractChampIds(o) {
    if (!o) return []
    const fieldNames = ['units', 'champions', 'composition', 'tftUnits', 'tft_units', 'comps', 'slots', 'unitList', 'teamComposition']
    const candidates = fieldNames.map(f => o[f]).filter(Array.isArray)

    for (const arr of candidates) {
      const direct = arr.map(u => typeof u === 'string' && u.match(/^TFT\d+_/) ? u : null).filter(Boolean)
      if (direct.length >= 4) return direct

      const fromRef = arr.map(u => {
        if (!u?.__ref) return null
        const m = u.__ref.match(/TFT\d+_\w+/)
        return m ? m[0] : null
      }).filter(Boolean)
      if (fromRef.length >= 4) return fromRef

      const resolved = arr.map(u => {
        const r = resolveRef(u)
        if (!r) return null
        return r?.unitId ?? r?.championId ?? r?.id ?? r?.tftId ?? r?.key ?? r?.ingameKey ?? ''
      }).filter(s => typeof s === 'string' && s.match(/^TFT\d+_/))
      if (resolved.length >= 4) return resolved
    }
    return []
  }

  for (const obj of Object.values(apolloState)) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue

    const units = extractChampIds(obj)
    if (units.length < 4) continue

    const champKey = units.slice().sort().join(',')
    if (seenKeys.has(champKey)) continue
    seenKeys.add(champKey)

    const count    = obj.count ?? obj.games ?? obj.gamesPlayed ?? obj.frequency ?? 0
    const avgPlace = obj.avgPlacement ?? obj.avgPlace ?? obj.averagePlacement ?? obj.place ?? 4
    const top4raw  = obj.top4Rate ?? obj.top4 ?? obj.topFourRate ?? 0
    const top4Rate = top4raw <= 1 ? top4raw : count > 0 ? top4raw / count : 0

    comps.push({
      source: 'u.gg',
      tier: inferTier(Number(avgPlace)),
      championIds: units,
      champions: units.map(u => u.replace(/^TFT\d+_/i, '').replace(/([a-z])([A-Z])/g, '$1 $2')),
      count,
      avgPlace: Number(avgPlace),
      top4Rate,
      winRate: 0,
      style: '',
    })
  }

  console.log(`[scraper] u.gg Apollo parsed ${comps.length} comps`)
  return comps.sort((a, b) => a.avgPlace - b.avgPlace)
}

export function parseLolalytics(json) {
  const root = json?.pageProps ?? json?.data ?? json
  const rawComps =
    root?.comps ?? root?.compositions ?? root?.tierList ??
    root?.data?.comps ?? root?.result ?? []

  if (!Array.isArray(rawComps) || rawComps.length === 0) return []

  return rawComps
    .map(c => {
      const units = (c.units ?? c.champions ?? c.comp ?? [])
        .map(u => typeof u === 'string' ? u : u?.id ?? u?.championId ?? '')
        .filter(s => s.startsWith('TFT'))
      if (units.length < 4) return null
      const count    = c.n ?? c.count ?? c.games ?? 0
      const avgPlace = c.place ?? c.avgPlace ?? c.avg ?? 4
      const top4     = c.top4 ?? c.top4Rate ?? 0
      const top4Rate = top4 <= 1 ? top4 : count > 0 ? top4 / count : 0
      return {
        source: 'lolalytics',
        tier: inferTier(Number(avgPlace)),
        championIds: units,
        champions: units.map(u => u.replace(/^TFT\d+_/i, '').replace(/([a-z])([A-Z])/g, '$1 $2')),
        count, avgPlace: Number(avgPlace), top4Rate, winRate: 0, style: '',
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.avgPlace - b.avgPlace)
}

export function parseMetaTFTApi(json, buildsJson = null, detailsMap = {}, augmentsMap = {}) {
  const options = json?.results?.options
  if (!options) return []

  const buildsMap = {}
  if (buildsJson?.results) {
    for (const [clusterId, clusterData] of Object.entries(buildsJson.results)) {
      const unitBuilds = {}
      for (const build of (clusterData?.builds ?? [])) {
        const unit = build.unit
        if (!unit || (build.num_items ?? 0) < 3) continue
        const items = (build.buildName ?? []).filter(it => typeof it === 'string' && it.startsWith('TFT'))
        if (items.length < 3) continue
        const score = build.score ?? 0
        if (!unitBuilds[unit] || score > unitBuilds[unit].score) {
          unitBuilds[unit] = { items: items.slice(0, 3), score }
        }
      }
      buildsMap[clusterId] = unitBuilds
    }
  }

  const comps = []
  const seenKeys = new Set()

  for (const [clusterId, sizeGroups] of Object.entries(options)) {
    for (const size of ['8', '7', '9', '6', '10']) {
      const list = sizeGroups[size]
      if (!Array.isArray(list) || list.length === 0) continue

      const valid = list.filter(c => c.count >= 100 && c.avg < 4.5)
      if (valid.length === 0) continue

      const best = valid.sort((a, b) => b.count - a.count)[0]
      const units = (best.units_list ?? '').split('&').filter(u => u.match(/^TFT\d+_/))
      if (units.length < 4) continue

      const champKey = units.slice().sort().join(',')
      if (seenKeys.has(champKey)) { break }
      seenKeys.add(champKey)

      const avgPlace = best.avg ?? 5

      const clusterBuilds = buildsMap[clusterId] ?? {}
      const items = {}
      const roles = {}

      for (const unit of units) {
        const buildData = clusterBuilds[unit]
        if (buildData?.items?.length >= 3) {
          items[unit] = buildData.items
          roles[unit] = 'Item holder'
        }
      }

      const fallback = buildMetaTftRoleData(best, units)
      for (const [champId, champItems] of Object.entries(fallback.items)) {
        if (!items[champId]) {
          items[champId] = champItems
          roles[champId] ??= 'Item holder'
        }
      }

      const clusterDetails = detailsMap[clusterId]
      const rawThreeStars = clusterDetails?.threeStars ?? fallback.threeStars
      const threeStars = rawThreeStars.filter(u => units.includes(u))
      for (const unit of threeStars) {
        roles[unit] = '3-star'
      }

      const rawPositions = clusterDetails?.positions ?? {}
      const positions = {}
      for (const unit of units) {
        if (rawPositions[unit]) positions[unit] = rawPositions[unit]
      }

      const name = best.name ?? best.comp_name ?? best.compName ?? best.title ?? best.label ?? null
      const sourceUrl = best.url ?? best.link ?? best.href ?? `https://www.metatft.com/comps`
      const augments = augmentsMap[clusterId] ?? []

      comps.push({
        source: 'metatft.com',
        name,
        tier: inferTier(Number(avgPlace)),
        championIds: units,
        champions: units.map(u => u.replace(/^TFT\d+_/i, '').replace(/([a-z])([A-Z])/g, '$1 $2')),
        count: best.count ?? 0,
        avgPlace: Number(avgPlace),
        top4Rate: 0,
        winRate: 0,
        items,
        roles,
        threeStars,
        positions,
        augments,
        style: `${size}u · avg #${avgPlace.toFixed(1)}`,
        sourceUrl,
      })
      break
    }
  }

  console.log(`[scraper] metatft parsed ${comps.length} comps`)
  return comps.sort((a, b) => a.avgPlace - b.avgPlace)
}

export function parseMetaTFT(json) {
  const data = json?.pageProps ?? json?.props?.pageProps ?? json
  if (!data) return []
  const rawComps = data.comps ?? data.compositions ?? data.teamComps ?? data.data?.comps ?? []
  if (!Array.isArray(rawComps) || rawComps.length === 0) return []

  const comps = []
  for (const c of rawComps) {
    const unitIds = (c.units ?? c.champions ?? c.composition ?? [])
      .map(u => typeof u === 'string' ? u : u?.id ?? u?.championId ?? '')
      .filter(s => typeof s === 'string' && s.startsWith('TFT'))
    if (unitIds.length < 4) continue
    const count    = c.count ?? c.games ?? 0
    const avgPlace = c.avgPlace ?? c.place ?? c.averagePlacement ?? 5
    const top4raw  = c.top4 ?? c.top4Rate ?? 0
    const top4Rate = top4raw <= 1 ? top4raw : count > 0 ? top4raw / count : 0
    const { items, roles, threeStars } = buildMetaTftRoleData(c, unitIds)
    const name = c.name ?? c.comp_name ?? c.compName ?? c.title ?? c.label ?? null
    const sourceUrl = c.url ?? c.link ?? c.href ?? c.sourceUrl ?? null
    comps.push({
      source: 'metatft.com',
      name,
      tier: inferTier(Number(avgPlace)),
      championIds: unitIds,
      champions: unitIds.map(u => u.replace(/^TFT\d+_/i, '').replace(/([a-z])([A-Z])/g, '$1 $2')),
      count, avgPlace: Number(avgPlace), top4Rate, winRate: 0, style: '',
      items,
      roles,
      threeStars,
      sourceUrl,
    })
  }
  return comps.sort((a, b) => a.avgPlace - b.avgPlace)
}

export function parseTftAcademy(html) {
  if (typeof html !== 'string' || !html.includes('finalComp:[{apiName:"TFT17_')) return []

  function extractArray(str, startIdx) {
    let depth = 0, i = startIdx
    while (i < str.length) {
      if (str[i] === '[') depth++
      else if (str[i] === ']') { depth--; if (depth === 0) return str.slice(startIdx, i + 1) }
      i++
    }
    return null
  }

  function findObjectStart(str, innerIdx) {
    let depth = 0
    for (let i = innerIdx; i >= 0; i--) {
      if (str[i] === '}') depth++
      else if (str[i] === '{') {
        if (depth === 0) return i
        depth--
      }
    }
    return -1
  }

  function extractObject(str, startIdx) {
    if (startIdx < 0 || str[startIdx] !== '{') return null
    let depth = 0
    for (let i = startIdx; i < str.length; i++) {
      if (str[i] === '{') depth++
      else if (str[i] === '}') {
        depth--
        if (depth === 0) return str.slice(startIdx, i + 1)
      }
    }
    return null
  }

  function extractTftAcademyTips(compObj) {
    const tipsIdx = compObj.indexOf('tips:[')
    if (tipsIdx === -1) return []
    const tipsArr = extractArray(compObj, tipsIdx + 'tips:'.length)
    if (!tipsArr) return []
    return dedupeTips(
      [...tipsArr.matchAll(/tip:"([^"]{18,500})"/g)].map(m => m[1]),
      6
    )
  }

  const comps = []
  const seenKeys = new Set()
  let pos = 0

  while (pos < html.length) {
    const idx = html.indexOf('finalComp:[{apiName:"TFT17_', pos)
    if (idx === -1) break

    const arr = extractArray(html, idx + 'finalComp:'.length)
    if (!arr) { pos = idx + 1; continue }
    const compObj = extractObject(html, findObjectStart(html, idx)) ?? ''

    const units = [...arr.matchAll(/apiName:"(TFT17_[A-Za-z0-9]+)"/g)].map(m => m[1])

    const itemsPerChamp = {}
    for (const m of arr.matchAll(/\{apiName:"(TFT17_[^"]+)",[^}]*items:\[([^\]]*)\]/g)) {
      const items = m[2].split(',').map(s => s.replace(/"/g, '')).filter(s => s.startsWith('TFT'))
      if (items.length > 0) itemsPerChamp[m[1]] = items
    }

    const threeStars = []
    for (const m of arr.matchAll(/\{apiName:"(TFT17_[^"]+)"([\s\S]*?)\}/g)) {
      const stars = Number(m[2].match(/\bstars?:(\d+)/)?.[1] ?? 0)
      if (stars >= 3) threeStars.push(m[1])
    }

    const positions = {}
    for (const m of arr.matchAll(/\{apiName:"(TFT17_[^"]+)"([\s\S]*?)\}/g)) {
      const pos = normalizeBoardPosition({
        row: m[2].match(/\b(?:row|y|hexRow):(-?\d+)/)?.[1],
        col: m[2].match(/\b(?:col|column|x|hexCol):(-?\d+)/)?.[1],
        slot: m[2].match(/\b(?:slot|position|boardIndex|hex|cell):(-?\d+)/)?.[1],
      })
      if (pos) positions[m[1]] = pos
    }

    const champKey = units.slice().sort().join(',')
    if (seenKeys.has(champKey) || units.length < 4) { pos = idx + arr.length; continue }
    seenKeys.add(champKey)

    const lb = html.slice(Math.max(0, idx - 4000), idx)
    const tierM  = compObj.match(/tier:"([SABC][+-]?)"/) ?? lb.match(/tier:"([SABC][+-]?)"/)
    const styleM = compObj.match(/style:"([^"]{2,40})"/) ?? lb.match(/style:"([^"]{2,40})"/)
    const titleM = compObj.match(/title:"([^"]{2,80})"/) ?? compObj.match(/metaTitle:"([^"]{2,120})"/)
    const mainM  = compObj.match(/mainChampion:\{apiName:"(TFT17_[^"]+)"/) ?? lb.match(/mainChampion:\{apiName:"(TFT17_[^"]+)"/)
    const slugM  = compObj.match(/compSlug:"([^"]+)"/) ?? lb.match(/compSlug:"([^"]+)"/)

    const after = html.slice(idx, Math.min(idx + arr.length + 4000, html.length))
    const overlayAugM = after.match(/overlayAugments:\[([^\]]*)\]/)
    const augments = overlayAugM
      ? [...overlayAugM[1].matchAll(/apiName:"([^"]+)"/g)]
          .map(m => augmentIdToName(m[1])).filter(Boolean).slice(0, 6)
      : []

    const tips = extractTftAcademyTips(compObj)

    const rawTier = tierM?.[1] ?? 'A'
    const tier = rawTier.startsWith('S') ? 'S' : rawTier.startsWith('A') ? 'A' : rawTier.startsWith('B') ? 'B' : 'C'

    const slug = slugM?.[1] ?? null
    const sourceUrl = slug ? `https://tftacademy.com/tierlist/comps/${slug}` : null

    comps.push({
      source: 'tftacademy.com',
      name: titleM?.[1] ?? '',
      tier,
      style: styleM?.[1] ?? '',
      carry: mainM?.[1]?.replace(/^TFT\d+_/, '').replace(/([a-z])([A-Z])/g, '$1 $2') ?? '',
      carryId: mainM?.[1] ?? '',
      championIds: units,
      champions: units.map(u => u.replace(/^TFT\d+_/i, '').replace(/([a-z])([A-Z])/g, '$1 $2')),
      items: itemsPerChamp,
      positions,
      augments,
      tips,
      threeStars,
      roles: mainM?.[1] ? { [mainM[1]]: 'Carry' } : {},
      sourceUrl,
      count: 0,
      avgPlace: tier === 'S' ? 3.0 : tier === 'A' ? 3.5 : tier === 'B' ? 4.0 : 4.5,
      top4Rate: 0,
      winRate: 0,
    })

    pos = idx + arr.length
  }

  console.log(`[scraper] tftacademy parsed ${comps.length} comps`)
  return comps
}

export function parseOpggTft(html, knownChampions = []) {
  if (typeof html !== 'string' || !html.includes('op.gg')) return []

  const { list: knownList, byName } = buildKnownChampionLookup(knownChampions)
  if (knownList.length === 0) return []

  function champFromName(name) {
    return byName.get(normalizeLookupName(name)) ?? null
  }

  function percentToRate(value) {
    const n = Number(String(value ?? '').replace('%', '').trim())
    if (!Number.isFinite(n)) return 0
    return n > 1 ? n / 100 : n
  }

  function compactText(value) {
    return decodeHtmlEntities(String(value ?? ''))
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, '\n')
      .replace(/\s+\n/g, '\n')
      .replace(/\n\s+/g, '\n')
  }

  function isBadTitle(line) {
    const lower = line.toLowerCase()
    return !line
      || line.length < 3
      || line.length > 80
      || /^\d+(?:\.\d+)?%?$/.test(line)
      || /^lv\s*\d+/i.test(line)
      || /^(tier|search|sort|comps|emblem|popular|normal|hard|easy|avg\. place|top 4 rate|pick rate|1st place)$/i.test(line)
      || byName.has(normalizeLookupName(line))
      || lower.includes('op.gg')
      || lower.includes('advertisement')
  }

  function numberAfter(lines, start, label) {
    const labelIdx = lines.findIndex((line, idx) => idx >= start && line.toLowerCase() === label)
    if (labelIdx === -1) return null
    for (let i = labelIdx + 1; i < Math.min(labelIdx + 5, lines.length); i++) {
      const n = Number(String(lines[i]).replace('%', '').trim())
      if (Number.isFinite(n)) return lines[i]
    }
    return null
  }

  function extractChampionIdsFromLines(lines) {
    const ids = []
    for (const line of lines) {
      const champ = champFromName(line)
      if (champ?.id && !ids.includes(champ.id)) ids.push(champ.id)
    }
    return ids
  }

  function extractItemsFromLines(lines, champIds) {
    const itemNoise = new Set([
      'avg. place', '1st place', 'top 4 rate', 'pick rate', 'popular',
      'normal', 'hard', 'easy', 'tier', 'comps', 'emblem',
    ])
    const items = {}

    lines.forEach((line, idx) => {
      const champ = champFromName(line)
      if (!champ?.id || !champIds.includes(champ.id)) return

      const prev = []
      for (let j = idx - 1; j >= 0 && prev.length < 3; j--) {
        const value = lines[j]
        const lower = value.toLowerCase()
        if (!value || itemNoise.has(lower)) continue
        if (/^\d+(?:\.\d+)?%?$/.test(value) || /^\d+\s*(st|nd|rd|th)$/i.test(value)) continue
        if (/^lv\s*\d+/i.test(value)) continue
        if (champFromName(value)) break
        if (/^[a-z][a-z\s'.&-]{2,40}$/i.test(value)) prev.unshift(value)
      }
      if (prev.length > 0) items[champ.id] = prev.slice(-3)
    })

    return items
  }

  function buildCompFromLines(lines, start, end, title) {
    const block = lines.slice(start, end)
    const avgPlace = Number(numberAfter(block, 0, 'avg. place') ?? 0)
    if (!Number.isFinite(avgPlace) || avgPlace <= 0) return null

    const top4Rate = percentToRate(numberAfter(block, 0, 'top 4 rate'))
    const winRate = percentToRate(numberAfter(block, 0, '1st place'))
    const pickRate = percentToRate(numberAfter(block, 0, 'pick rate'))
    const count = Number(block.find(line => /^\d+$/.test(line)) ?? 0)
    const championIds = extractChampionIdsFromLines(block)
    if (championIds.length < 4) return null

    const items = extractItemsFromLines(block, championIds)
    const roles = {}
    Object.keys(items).forEach(champId => { roles[champId] = 'Item holder' })

    const level = block.find(line => /^lv\s*\d+/i.test(line)) ?? ''
    const difficulty = block.find(line => /^(easy|normal|hard)$/i.test(line)) ?? ''
    const style = [level, difficulty].filter(Boolean).join(' - ')

    return {
      source: 'op.gg',
      name: title,
      tier: inferTier(avgPlace),
      championIds,
      champions: championIds.map(id => knownList.find(c => c.id === id)?.name ?? id.replace(/^TFT\d+_/, '')),
      count,
      avgPlace,
      top4Rate,
      winRate,
      pickRate,
      style: style || `avg #${avgPlace.toFixed(1)} - OP.GG`,
      items,
      roles,
      augments: [],
      sourceUrl: 'https://op.gg/tft/meta-trends/comps',
    }
  }

  const text = compactText(html)
  const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean)
  const starts = []

  for (let i = 0; i < lines.length; i++) {
    const title = lines[i]
    if (isBadTitle(title)) continue
    const window = lines.slice(i, i + 18).map(line => line.toLowerCase())
    const hasCoreStats = window.includes('avg. place') && window.includes('top 4 rate') && window.includes('pick rate')
    if (!hasCoreStats) continue
    starts.push({ idx: i, title })
  }

  const comps = []
  const seen = new Set()
  for (let s = 0; s < starts.length; s++) {
    const start = starts[s]
    const end = starts[s + 1]?.idx ?? Math.min(start.idx + 180, lines.length)
    const comp = buildCompFromLines(lines, start.idx, end, start.title)
    if (!comp) continue
    const key = comp.championIds.slice().sort().join(',')
    if (seen.has(key)) continue
    seen.add(key)
    comps.push(comp)
  }

  console.log(`[scraper] op.gg parsed ${comps.length} comps`)
  return comps.sort((a, b) => a.avgPlace - b.avgPlace)
}

function jaccard(a, b) {
  const sa = new Set(a.championIds?.length ? a.championIds : a.champions.map(n => n.toLowerCase()))
  const sb = new Set(b.championIds?.length ? b.championIds : b.champions.map(n => n.toLowerCase()))
  let inter = 0
  sa.forEach(x => { if (sb.has(x)) inter++ })
  return inter / (sa.size + sb.size - inter)
}

function overlapDetails(a, b) {
  const aIds = a.championIds?.length ? a.championIds : []
  const bIds = b.championIds?.length ? b.championIds : []
  const aSet = new Set(aIds)
  const bSet = new Set(bIds)
  const overlap = aIds.filter(id => bSet.has(id)).length
  const minSize = Math.max(1, Math.min(aSet.size || aIds.length || 1, bSet.size || bIds.length || 1))
  const maxSize = Math.max(1, Math.max(aSet.size || aIds.length || 1, bSet.size || bIds.length || 1))
  return {
    overlap,
    minSize,
    maxSize,
    ratio: overlap / minSize,
    unionRatio: overlap / maxSize,
  }
}

function mergeObjectMaps(group, key) {
  const counts = {}
  for (const comp of group) {
    for (const [champId, value] of Object.entries(comp?.[key] ?? {})) {
      if (!counts[champId]) counts[champId] = new Map()
      const rawList = Array.isArray(value) ? value : [value]
      rawList.filter(Boolean).forEach(entry => {
        counts[champId].set(entry, (counts[champId].get(entry) ?? 0) + 1)
      })
    }
  }
  const out = {}
  for (const [champId, stat] of Object.entries(counts)) {
    const merged = [...stat.entries()].sort((a, b) => b[1] - a[1]).map(([value]) => value)
    if (merged.length > 0) out[champId] = key === 'roles' ? merged[0] : merged.slice(0, 3)
  }
  return out
}

function mergeStringLists(group, key, max = 6) {
  const counts = new Map()
  const values = new Map()
  for (const comp of group) {
    for (const value of comp?.[key] ?? []) {
      const label = typeof value === 'string' ? value : value?.name
      if (!label) continue
      const normalized = label.toLowerCase().replace(/\s+/g, ' ').trim()
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1)
      if (!values.has(normalized)) values.set(normalized, value)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => values.get(key))
    .slice(0, max)
}

function mergePositions(group) {
  const byChamp = {}
  for (const comp of group) {
    for (const [champId, pos] of Object.entries(comp?.positions ?? {})) {
      const row = Number(pos?.row)
      const col = Number(pos?.col)
      if (!Number.isFinite(row) || !Number.isFinite(col)) continue
      const key = `${row}:${col}`
      if (!byChamp[champId]) byChamp[champId] = {}
      byChamp[champId][key] = (byChamp[champId][key] ?? 0) + 1
    }
  }
  const out = {}
  for (const [champId, positions] of Object.entries(byChamp)) {
    const best = Object.entries(positions).sort((a, b) => b[1] - a[1])[0]?.[0]
    if (!best) continue
    const [row, col] = best.split(':').map(Number)
    out[champId] = { row, col }
  }
  return out
}

function pickPrimaryComp(group) {
  function score(comp) {
    return (comp.sourceCount ?? 1) * 20
      + ((comp.count ?? 0) > 0 ? Math.min(20, Math.log10((comp.count ?? 0) + 1) * 8) : 0)
      + (Object.keys(comp.items ?? {}).length > 0 ? 10 : 0)
      + (Object.keys(comp.positions ?? {}).length > 0 ? 8 : 0)
      + ((comp.augments ?? []).length > 0 ? 7 : 0)
      + ((comp.tips ?? []).length > 0 ? 5 : 0)
      + ((comp.avgPlace ?? 5) > 0 ? Math.max(0, 10 - Number(comp.avgPlace ?? 5)) : 0)
  }
  return [...group].sort((a, b) => score(b) - score(a))[0]
}

function isTftChampionId(value) {
  return typeof value === 'string'
    && /^TFT\d+_[A-Za-z0-9]+$/.test(value)
    && !value.includes('_Item_')
    && !value.includes('_Augment_')
}

function isPlayableChampionId(value) {
  return isTftChampionId(value) && !/(?:Summon|Minion|Relic)$/i.test(value)
}

function cleanChampionIds(championIds = []) {
  return [...new Set(
    championIds
      .filter(isPlayableChampionId)
  )]
}

function championNameFromId(id) {
  return id.replace(/^TFT\d+_/i, '').replace(/([a-z])([A-Z])/g, '$1 $2')
}

function normalizeCompRecord(comp) {
  const championIds = cleanChampionIds(comp?.championIds ?? [])
  if (championIds.length < 4) return null

  const allowed = new Set(championIds)
  const filterMap = (value) => Object.fromEntries(
    Object.entries(value ?? {}).filter(([key]) => allowed.has(key))
  )
  const filterList = (value) => (value ?? []).filter(id => allowed.has(id))

  return {
    ...comp,
    championIds,
    champions: championIds.map(championNameFromId),
    items: filterMap(comp?.items),
    positions: filterMap(comp?.positions),
    roles: filterMap(comp?.roles),
    threeStars: filterList(comp?.threeStars),
  }
}

function isTftItemId(value) {
  return typeof value === 'string'
    && /^TFT\d*_Item_/i.test(value)
}

function splitMaybeList(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  return value.split(/[,&|;]/).map(v => v.trim()).filter(Boolean)
}

function collectItemIds(value) {
  const found = []
  const visit = (node) => {
    if (!node) return
    if (typeof node === 'string') {
      splitMaybeList(node).forEach(part => {
        if (isTftItemId(part)) found.push(part)
      })
      return
    }
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (typeof node !== 'object') return
    Object.values(node).forEach(visit)
  }
  visit(value)
  return [...new Set(found)]
}

function extractUnitDetailsFromValue(value, knownUnitIds = []) {
  const known = new Set(knownUnitIds)
  const details = {}

  function addDetail(champId, patch = {}) {
    if (!isTftChampionId(champId) || (known.size > 0 && !known.has(champId))) return
    if (!details[champId]) details[champId] = { items: [], stars: 0, role: '' }
    if (patch.items?.length) {
      details[champId].items = [...new Set([...details[champId].items, ...patch.items])]
    }
    if (Number(patch.stars) > details[champId].stars) details[champId].stars = Number(patch.stars)
    if (patch.role && !details[champId].role) details[champId].role = patch.role
  }

  function findChampionId(obj) {
    const directKeys = [
      'apiName', 'character_id', 'characterId', 'champion_id', 'championId',
      'unit_id', 'unitId', 'unit', 'champion', 'ingameKey', 'key', 'id',
    ]
    for (const key of directKeys) {
      if (isTftChampionId(obj?.[key])) return obj[key]
    }
    return Object.values(obj ?? {}).find(isTftChampionId) ?? null
  }

  function visit(node) {
    if (!node) return
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (typeof node !== 'object') return

    const champId = findChampionId(node)
    if (champId) {
      const starValue = node.star ?? node.stars ?? node.tier ?? node.unit_tier ?? node.unitTier ?? node.rank
      const itemValues = [
        node.items, node.item_names, node.itemNames, node.item_ids, node.itemIds,
        node.items_list, node.itemsList, node.item_list, node.itemList, node.equipped_items,
      ]
      const items = itemValues.flatMap(collectItemIds)
      const role = node.role ?? node.unitRole ?? node.type ?? ''
      addDetail(champId, { items, stars: Number(starValue ?? 0), role })
    }

    Object.values(node).forEach(visit)
  }

  visit(value)
  return details
}

function buildMetaTftRoleData(rawComp, unitIds) {
  const details = extractUnitDetailsFromValue(rawComp, unitIds)
  const items = {}
  const roles = {}
  const threeStars = []

  Object.entries(details).forEach(([champId, detail]) => {
    if (detail.items?.length > 0) {
      items[champId] = detail.items.slice(0, 3)
      roles[champId] = 'Item holder'
    }
    if (detail.stars >= 3) {
      threeStars.push(champId)
      roles[champId] = '3-star'
    } else if (detail.role) {
      roles[champId] = detail.role
    }
  })

  return { items, roles, threeStars }
}

export function combineComps(compLists) {
  const all = compLists
    .flat()
    .map(normalizeCompRecord)
    .filter(c => c && (c.championIds?.length >= 4 || c.champions?.length >= 4))
  if (all.length === 0) return []

  const annotated = all.map((comp, idx) => {
    const similar = all.filter((other, otherIdx) => {
      if (otherIdx === idx) return false
      const overlap = overlapDetails(comp, other)
      return overlap.ratio >= 0.72 || (overlap.ratio >= 0.6 && overlap.overlap >= 6)
    })
    const group = [comp, ...similar]
    const sources = [...new Set(group.map(c => c.source).filter(Boolean))]
    const primary = pickPrimaryComp(group)
    const avgJaccard = group.length <= 1
      ? 1
      : group
          .filter(other => other !== primary)
          .reduce((sum, other) => sum + jaccard(primary, other), 0) / (group.length - 1)
    const statComps = group.filter(c => c.count > 0 && Number.isFinite(Number(c.avgPlace)))
    const avgPlace = primary.count > 0 && primary.avgPlace
      ? Number(primary.avgPlace)
      : statComps.length > 0
        ? statComps.reduce((sum, c) => sum + Number(c.avgPlace), 0) / statComps.length
        : Number(primary.avgPlace ?? 4.0)
    const top4Values = statComps.map(c => Number(c.top4Rate)).filter(Number.isFinite)
    const top4Rate = primary.top4Rate || (top4Values.length > 0
      ? top4Values.reduce((sum, value) => sum + value, 0) / top4Values.length
      : 0)

    let tier = primary.tier ?? inferTier(avgPlace)
    if (sources.length >= 2 && tier === 'A') tier = 'S'

    return normalizeCompRecord({
      ...primary,
      name: primary.name ?? primary.style ?? primary.champions?.slice(0, 2).join(' + ') ?? 'Meta comp',
      tier,
      avgPlace,
      top4Rate,
      count: Math.max(...group.map(c => c.count ?? 0), primary.count ?? 0),
      source: primary.source,
      sources,
      sourceCount: sources.length,
      primarySource: primary.source,
      metaSources: sources,
      metaConfirmed: sources.length >= 2,
      matchConfidence: Number(avgJaccard.toFixed(3)),
      items: mergeObjectMaps(group, 'items'),
      positions: mergePositions(group),
      augments: mergeStringLists(group, 'augments', 6),
      tips: dedupeTips(group.flatMap(c => c.tips ?? []), 6),
      threeStars: mergeStringLists(group, 'threeStars', 4),
      roles: mergeObjectMaps(group, 'roles'),
      sourceUrl: primary.sourceUrl ?? null,
      style: primary.style ?? (primary.count > 0 ? `avg #${avgPlace.toFixed(1)}` : 'curated'),
    })
  })

  return annotated.filter(Boolean).sort((a, b) => {
    if ((b.metaConfirmed ? 1 : 0) !== (a.metaConfirmed ? 1 : 0)) return (b.metaConfirmed ? 1 : 0) - (a.metaConfirmed ? 1 : 0)
    if (b.sourceCount !== a.sourceCount) return b.sourceCount - a.sourceCount
    if ((b.count ?? 0) !== (a.count ?? 0)) return (b.count ?? 0) - (a.count ?? 0)
    return (a.avgPlace ?? 9) - (b.avgPlace ?? 9)
  })
}

export function parseMetaPage(rawInput) {
  let json
  try {
    json = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput
  } catch {
    return { comps: [], method: 'failed' }
  }

  if (!json) return { comps: [], method: 'failed' }

  const tactics  = parseTacticsTools(json)
  if (tactics.length > 0) return { comps: tactics, method: 'tactics-tools' }

  const lolchess = parseLolchess(json)
  if (lolchess.length > 0) return { comps: lolchess, method: 'lolchess' }

  const blitz    = parseBlitz(json)
  if (blitz.length > 0) return { comps: blitz, method: 'blitz' }

  const ugg = parseUgg(json)
  if (ugg.length > 0) return { comps: ugg, method: 'ugg' }

  const lolalytics = parseLolalytics(json)
  if (lolalytics.length > 0) return { comps: lolalytics, method: 'lolalytics' }

  const mobalytics = parseMobalytics(json)
  if (mobalytics.length > 0) return { comps: mobalytics, method: 'mobalytics' }

  const metatft  = parseMetaTFT(json)
  if (metatft.length > 0) return { comps: metatft, method: 'metatft' }

  return { comps: [], method: 'failed' }
}
