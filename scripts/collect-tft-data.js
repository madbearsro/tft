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

const DD = 'https://ddragon.leagueoflegends.com'
const CD_P = 'https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default'
const CD_TFT = 'https://raw.communitydragon.org/latest/cdragon/tft/en_us.json'

function cleanTraitName(name) {
  return String(name ?? '')
    .replace(/\s*\[[^\]]*\]\s*/g, '')
    .replace(/UniqueTrait$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
}

function cdIconProxy(path) {
  if (!path) return null
  const rel = path.replace('/lol-game-data/assets/', '').toLowerCase()
  return `/api/img.php?p=${encodeURIComponent(rel)}`
}

function cdGameProxy(path) {
  if (!path) return null
  const rel = path.replace(/\.tex$/i, '.png').toLowerCase()
  return `/api/img.php?p=${encodeURIComponent(rel)}`
}

function resolveAugDesc(raw, effects) {
  if (!raw) return ''
  let s = String(raw)
  s = s.replace(/@([^@]+)@/g, (_, expr) => {
    const cleanExpr = expr.replace(/:[^*/+\-]*$/, '')
    const m = cleanExpr.match(/^([\w{}.]+)\s*([*/+\-])\s*(\d+(?:\.\d+)?)$/)
    if (m) {
      const [, varName, op, numStr] = m
      const num = parseFloat(numStr)
      const key = Object.keys(effects ?? {}).find(k => k.toLowerCase() === varName.toLowerCase())
      const val = effects?.[key ?? varName]
      if (val == null) return ''
      const r = op === '*' ? val * num : op === '/' ? val / num : op === '+' ? val + num : val - num
      const rounded = Math.round(r * 10) / 10
      return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
    }
    const key = Object.keys(effects ?? {}).find(k => k.toLowerCase() === cleanExpr.toLowerCase())
    const val = effects?.[key ?? cleanExpr]
    if (val != null) {
      const r = Math.round(val * 10) / 10
      return Number.isInteger(r) ? String(r) : r.toFixed(1)
    }
    return ''
  })
  s = s.replace(/\s*\{\{[^}]+\}\}/g, '')
  s = s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
  s = s.replace(/\s+([.,!?%])/g, '$1').replace(/\s+/g, ' ').trim()
  return s
}

async function collect() {
  console.log(`[tft-data] Set ${SET}...`)
  const prefix = `TFT${SET}_`

  const versionsRes = await fetch(`${DD}/api/versions.json`)
  const versions = await versionsRes.json()
  const ver = versions[0]
  console.log(`[tft-data] DataDragon: ${ver}`)

  const [ddChampsRaw, cdChampsRaw, teamPlannerRaw, ddItemsRaw, cdTftRaw] = await Promise.all([
    fetch(`${DD}/cdn/${ver}/data/en_US/tft-champion.json`).then(r => r.json()),
    fetch(`${CD_P}/v1/tftchampions.json`).then(r => r.json()),
    fetch(`${CD_P}/v1/tftchampions-teamplanner.json`).then(r => r.json()),
    fetch(`${DD}/cdn/${ver}/data/en_US/tft-item.json`).then(r => r.json()),
    fetch(CD_TFT).then(r => r.json()).catch(() => null),
  ])

  const ddMap = ddChampsRaw.data ?? ddChampsRaw
  const cdMap = {}
  cdChampsRaw.forEach(c => { if (c.name) cdMap[c.name] = c.character_record })

  const baselineTraitNames = {}
  Object.values(cdMap).forEach(record => {
    for (const trait of record?.traits ?? []) {
      if (!trait || typeof trait === 'string' || !trait.id) continue
      const name = cleanTraitName(trait.name)
      if (name) baselineTraitNames[trait.id] = name
    }
  })

  const plannerMap = {}
  const plannerSet = teamPlannerRaw[`TFTSet${SET}`] ?? []
  plannerSet.forEach(c => {
    if (c.character_id && Number.isFinite(c.team_planner_code)) plannerMap[c.character_id] = c.team_planner_code
  })

  const cdRoleMap = {}
  if (cdTftRaw?.sets) {
    const setKey = Object.keys(cdTftRaw.sets).sort((a, b) => Number(b) - Number(a))[0]
    const cdSetChamps = cdTftRaw.sets[setKey]?.champions ?? []
    cdSetChamps.forEach(c => { if (c.apiName && c.role) cdRoleMap[c.apiName] = c.role })
  }

  const championsRaw = Object.values(ddMap)
    .filter(c => c.id && c.id.startsWith(prefix) && c.cost > 0)
    .map(c => {
      const cd = cdMap[c.id] ?? {}
      const traits = (cd.traits ?? []).map(t => typeof t === 'string' ? t : (t.id ?? t.name ?? '')).filter(Boolean)
      return {
        id: c.id,
        name: cd.display_name ?? c.name ?? c.id.replace(prefix, ''),
        cost: c.cost,
        traits,
        role: cdRoleMap[c.id] ?? null,
        icon: cdIconProxy(cd.squareIconPath) ?? (c.image?.full ? `/api/img.php?base=dd&ver=${encodeURIComponent(ver)}&p=${encodeURIComponent('tft-champion/' + c.image.full)}` : null),
        teamPlannerCode: plannerMap[c.id] ?? null,
      }
    })
    .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name))

  const seenNames = new Set()
  const champions = championsRaw.filter(c => {
    const key = c.name.toLowerCase()
    if (seenNames.has(key)) return false
    seenNames.add(key)
    return true
  })

  const traitBreakpoints = {}
  const traitDisplayNames = { ...baselineTraitNames }
  const traitMeta = {}
  const augDescMap = {}
  const compositionMap = {}

  if (cdTftRaw) {
    const activeSet = (() => {
      if (!cdTftRaw.sets) return {}
      const keys = Object.keys(cdTftRaw.sets).sort((a, b) => Number(b) - Number(a))
      return cdTftRaw.sets[String(SET)] ?? cdTftRaw.sets[keys[0]] ?? {}
    })()

    const cdTraits = Array.isArray(activeSet.traits) ? activeSet.traits : []
    cdTraits.forEach(t => {
      if (!t.apiName) return
      const name = cleanTraitName(t.name)
      if (name) traitDisplayNames[t.apiName] = name
      if (Array.isArray(t.effects) && t.effects.length > 0) {
        traitBreakpoints[t.apiName] = t.effects[0].minUnits ?? 2
        const iconPath = t.icon ?? t.iconPath ?? null
        traitMeta[t.apiName] = {
          iconUrl: iconPath ? cdGameProxy(iconPath) : null,
          effects: t.effects.map(e => ({ minUnits: e.minUnits, style: e.style ?? 0 })),
        }
      }
    })

    const allCdItems = Array.isArray(cdTftRaw.items) ? cdTftRaw.items : (activeSet.items ?? [])
    const cdAugsFromItems = allCdItems.filter(it => it.apiName && /augment/i.test(it.apiName))
    const cdAugsFromSet = activeSet.augments ?? []
    const cdAugs = cdAugsFromItems.length > 0 ? cdAugsFromItems : cdAugsFromSet
    cdAugs.forEach(aug => {
      if (!aug.apiName || !aug.desc) return
      const d = resolveAugDesc(aug.desc, aug.effects)
      if (!d) return
      augDescMap[aug.apiName] = d
      augDescMap[aug.apiName.replace(/^TFT\d+_/, 'TFT_')] = d
    })

    const cdItems = Array.isArray(cdTftRaw.items) ? cdTftRaw.items : (activeSet.items ?? [])
    cdItems.forEach(it => {
      if (it.apiName && Array.isArray(it.composition) && it.composition.length >= 2) {
        compositionMap[it.apiName] = it.composition
        const normalized = it.apiName.replace(/^TFT\d+_/, 'TFT_')
        if (normalized !== it.apiName) compositionMap[normalized] = it.composition
      }
    })
  }

  const itemsRaw = ddItemsRaw.data ?? ddItemsRaw
  const itemsList = Object.values(itemsRaw)
    .filter(it => it.name && it.id && !String(it.id).includes('Tutorial') && !it.name.includes('(Debug)'))
    .map(it => ({
      id: it.id,
      name: it.name,
      icon: it.image?.full ? `/api/img.php?base=dd&ver=${encodeURIComponent(ver)}&p=${encodeURIComponent('tft-item/' + it.image.full)}` : null,
      desc: it.desc ?? '',
    }))

  const itemsById = {}
  itemsList.forEach(it => { itemsById[it.id] = it })
  const items = itemsList.map(it => {
    const compIds = compositionMap[it.id]
    if (!compIds) return it
    const from = compIds.map(cid => itemsById[cid] ?? itemsById[cid.replace(/^TFT\d+_/, 'TFT_')] ?? null).filter(Boolean)
    return from.length >= 2 ? { ...it, from } : it
  })

  const result = {
    set: SET,
    version: ver,
    champions,
    items,
    traitBreakpoints,
    traitDisplayNames,
    traitMeta,
    augDescMap,
    updatedAt: new Date().toISOString(),
  }

  const dataDir = DATA_DIR_ARG ? join(process.cwd(), DATA_DIR_ARG) : join(ROOT, 'data')
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  const outPath = join(dataDir, `tft-set${SET}.json`)
  writeFileSync(outPath, JSON.stringify(result))

  console.log(`[tft-data] Salvat: ${outPath}`)
  console.log(`[tft-data] Champions: ${champions.length}, Items: ${items.length}, Traits: ${Object.keys(traitBreakpoints).length}`)
}

collect().catch(err => {
  console.error('[tft-data] Eroare:', err)
  process.exit(1)
})
