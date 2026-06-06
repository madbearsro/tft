import { useState, useEffect } from 'react'

const TABS = ['Challenger', 'Meta', 'Augmente', 'Artefacte']

function useApi(endpoint) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(endpoint)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [endpoint])

  return { data, loading, error }
}

function LoadingSpinner() {
  return <div className="spinner" />
}

function ErrorBox({ message }) {
  return <div className="error-box">Eroare: {message}</div>
}

function ChallengerTab() {
  const { data, loading, error } = useApi('/api/challenger.php')

  if (loading) return <LoadingSpinner />
  if (error) return <ErrorBox message={error} />

  const entries = data?.data ?? data?.entries ?? []

  return (
    <div className="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Jucător</th>
            <th>LP</th>
            <th>Victorii</th>
            <th>Înfrângeri</th>
            <th>WR%</th>
          </tr>
        </thead>
        <tbody>
          {entries.slice(0, 50).map((p, i) => {
            const wins = p.wins ?? p.win ?? 0
            const losses = p.losses ?? p.lose ?? 0
            const total = wins + losses
            const wr = total > 0 ? ((wins / total) * 100).toFixed(1) : '-'
            return (
              <tr key={p.summonerName ?? p.summoner_name ?? i}>
                <td className="rank">{i + 1}</td>
                <td className="name">{p.summonerName ?? p.summoner_name ?? p.name}</td>
                <td className="lp">{(p.leaguePoints ?? p.lp ?? 0).toLocaleString()}</td>
                <td className="wins">{wins}</td>
                <td className="losses">{losses}</td>
                <td className={`wr ${parseFloat(wr) >= 55 ? 'wr-high' : ''}`}>{wr}%</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function MetaTab() {
  const { data, loading, error } = useApi('/api/meta.php')

  if (loading) return <LoadingSpinner />
  if (error) return <ErrorBox message={error} />

  const comps = data?.comps ?? data?.data ?? []

  if (!comps.length) return <p className="empty">Nu există date meta disponibile.</p>

  return (
    <div className="card-grid">
      {comps.slice(0, 20).map((comp, i) => (
        <div key={comp.name ?? i} className="card">
          <div className="card-header">
            <span className="card-rank">#{i + 1}</span>
            <span className="card-title">{comp.name ?? comp.comp_name ?? 'Comp'}</span>
          </div>
          {comp.placement != null && (
            <div className="card-stat">
              <span>Plasament mediu</span>
              <span className="stat-val">{Number(comp.placement).toFixed(2)}</span>
            </div>
          )}
          {comp.top4 != null && (
            <div className="card-stat">
              <span>Top 4%</span>
              <span className="stat-val">{Number(comp.top4).toFixed(1)}%</span>
            </div>
          )}
          {comp.win != null && (
            <div className="card-stat">
              <span>Win%</span>
              <span className="stat-val">{Number(comp.win).toFixed(1)}%</span>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function AugmentsTab() {
  const { data, loading, error } = useApi('/api/augments.php')
  const [search, setSearch] = useState('')

  if (loading) return <LoadingSpinner />
  if (error) return <ErrorBox message={error} />

  const items = (Array.isArray(data) ? data : data?.data ?? []).filter(
    (a) => !search || (a.name ?? '').toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <div>
      <input
        className="search-input"
        placeholder="Caută augment..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="card-grid">
        {items.slice(0, 60).map((aug, i) => (
          <div key={aug.apiName ?? aug.id ?? i} className={`card tier-${aug.tier ?? 0}`}>
            <div className="card-header">
              <span className="card-title">{aug.name ?? aug.apiName}</span>
              {aug.tier != null && (
                <span className={`badge tier-badge-${aug.tier}`}>
                  {aug.tier === 1 ? 'Argint' : aug.tier === 2 ? 'Aur' : aug.tier === 3 ? 'Prismatic' : `T${aug.tier}`}
                </span>
              )}
            </div>
            {aug.desc && <p className="card-desc">{aug.desc}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}

function ArtefacteTab() {
  const { data, loading, error } = useApi('/api/artifacts.php')
  const [search, setSearch] = useState('')

  if (loading) return <LoadingSpinner />
  if (error) return <ErrorBox message={error} />

  const items = (Array.isArray(data) ? data : data?.data ?? []).filter(
    (a) => !search || (a.name ?? '').toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <div>
      <input
        className="search-input"
        placeholder="Caută artefact..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="card-grid">
        {items.slice(0, 60).map((art, i) => (
          <div key={art.apiName ?? art.id ?? i} className="card">
            <div className="card-header">
              <span className="card-title">{art.name ?? art.apiName}</span>
              <span className="badge">Artefact</span>
            </div>
            {art.desc && <p className="card-desc">{art.desc}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function App() {
  const [tab, setTab] = useState(0)

  const panels = [<ChallengerTab />, <MetaTab />, <AugmentsTab />, <ArtefacteTab />]

  return (
    <div className="app">
      <header className="app-header">
        <h1>TFT Helper</h1>
        <nav className="tabs">
          {TABS.map((t, i) => (
            <button
              key={t}
              className={`tab-btn ${tab === i ? 'active' : ''}`}
              onClick={() => setTab(i)}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>
      <main className="app-main">{panels[tab]}</main>
    </div>
  )
}
