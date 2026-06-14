const relay = require('../../utils/relay')

const MAP_HISTORY_KEY = 'mapHistory'
const MAX_HISTORY = 20

function saveToHistory(mapData) {
  let history = []
  try { history = wx.getStorageSync(MAP_HISTORY_KEY) || [] } catch {}
  const entry = {
    id: Date.now().toString(),
    title: mapData.title || '地图',
    timestamp: Date.now(),
    data: mapData,
  }
  history.unshift(entry)
  if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY)
  wx.setStorageSync(MAP_HISTORY_KEY, history)
}

function loadHistory() {
  try { return wx.getStorageSync(MAP_HISTORY_KEY) || [] } catch { return [] }
}

function formatTime(ts) {
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const pad = (n) => String(n).padStart(2, '0')
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (isToday) return `今天 ${time}`
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${time}`
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`
}

Page({
  data: {
    mode: 'empty', // 'map' | 'empty'
    center: { lat: 39.9042, lng: 116.4074 },
    scale: 14,
    wxMarkers: [],
    wxPolyline: [],
    actionId: '',
    stats: { show: false },
    history: [],
    showHistory: false,
    shareImagePath: '',
  },

  _shareCanvas: null,
  _mapData: null,

  onShareAppMessage() {
    const title = this._mapData?.title || '地图轨迹'
    return {
      title: `${title} — CodePocket`,
      path: '/pages/map/map',
      imageUrl: this.data.shareImagePath || '',
    }
  },

  onShareTimeline() {
    return {
      title: `${this._mapData?.title || '地图轨迹'} — CodePocket`,
      imageUrl: this.data.shareImagePath || '',
    }
  },

  _drawShareImage() {
    const mapData = this._mapData
    if (!mapData) return

    const query = wx.createSelectorQuery()
    query.select('#shareCanvas').fields({ node: true, size: true }).exec((res) => {
      if (!res[0]) return
      const canvas = res[0].node
      const ctx = canvas.getContext('2d')
      const dpr = wx.getWindowInfo().pixelRatio
      const W = 500
      const H = 400
      canvas.width = W * dpr
      canvas.height = H * dpr
      ctx.scale(dpr, dpr)

      // Background
      ctx.fillStyle = '#f0f4ff'
      ctx.fillRect(0, 0, W, H)

      // Title bar
      ctx.fillStyle = '#1677FF'
      ctx.fillRect(0, 0, W, 56)
      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 18px sans-serif'
      ctx.fillText(mapData.title || '地图轨迹', 16, 36)

      // Collect all points
      const allPoints = []
      const markers = mapData.markers || []
      const polylines = mapData.polyline || []
      markers.forEach(m => allPoints.push(m))
      polylines.forEach(pl => pl.points.forEach(p => allPoints.push(p)))
      if (allPoints.length === 0) return

      // Bounds
      let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity
      allPoints.forEach(p => {
        if (p.latitude < minLat) minLat = p.latitude
        if (p.latitude > maxLat) maxLat = p.latitude
        if (p.longitude < minLng) minLng = p.longitude
        if (p.longitude > maxLng) maxLng = p.longitude
      })
      const padLat = (maxLat - minLat) * 0.1 || 0.005
      const padLng = (maxLng - minLng) * 0.1 || 0.005
      minLat -= padLat; maxLat += padLat
      minLng -= padLng; maxLng += padLng

      const drawW = W - 60
      const drawH = H - 120
      const toX = (lng) => 30 + (lng - minLng) / (maxLng - minLng) * drawW
      const toY = (lat) => 70 + (1 - (lat - minLat) / (maxLat - minLat)) * drawH

      // Draw polylines
      polylines.forEach(pl => {
        if (pl.points.length < 2) return
        ctx.beginPath()
        ctx.strokeStyle = pl.color || '#1677FF'
        ctx.lineWidth = 3
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        pl.points.forEach((p, i) => {
          const x = toX(p.longitude), y = toY(p.latitude)
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
        })
        ctx.stroke()
      })

      // Draw markers
      markers.forEach(m => {
        const x = toX(m.longitude), y = toY(m.latitude)
        ctx.beginPath()
        ctx.fillStyle = '#f53f3f'
        ctx.arc(x, y, 6, 0, Math.PI * 2)
        ctx.fill()
        ctx.beginPath()
        ctx.fillStyle = '#ffffff'
        ctx.arc(x, y, 3, 0, Math.PI * 2)
        ctx.fill()
        if (m.title) {
          ctx.fillStyle = '#333333'
          ctx.font = '12px sans-serif'
          ctx.fillText(m.title, x + 9, y + 4)
        }
      })

      // Stats bar
      const stats = this.data.stats
      if (stats.show) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)'
        ctx.fillRect(0, H - 44, W, 44)
        ctx.fillStyle = '#666666'
        ctx.font = '13px sans-serif'
        ctx.fillText(`距离 ${stats.distance}`, 16, H - 18)
        ctx.fillText(`时间 ${stats.duration}`, 140, H - 18)
        ctx.fillText(`均速 ${stats.speed}`, 264, H - 18)
        ctx.fillText(`${stats.points} 点`, 388, H - 18)
      }

      // Generate temp image
      wx.canvasToTempFilePath({
        canvas,
        width: W * dpr,
        height: H * dpr,
        destWidth: W * 2,
        destHeight: H * 2,
        success: (res) => {
          this.setData({ shareImagePath: res.tempFilePath })
        },
      })
    })
  },

  onLoad() {
    const mapData = wx.getStorageSync('mapShowData')
    if (mapData) {
      saveToHistory(mapData)
      this._renderMap(mapData)
      return
    }

    // No current data — show empty state
    const history = loadHistory()
    this.setData({ mode: 'empty', history: history.map(h => ({
      ...h,
      timeText: formatTime(h.timestamp),
      pointCount: (h.data.markers || []).length + (h.data.polyline || []).reduce((s, p) => s + p.points.length, 0),
    })) })
  },

  onHistoryTap() {
    this.setData({ showHistory: !this.data.showHistory })
  },

  onViewHistory(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.history.find(h => h.id === id)
    if (!item) return
    this.setData({ showHistory: false })
    this._renderMap(item.data)
  },

  onDeleteHistory(e) {
    const id = e.currentTarget.dataset.id
    let history = loadHistory().filter(h => h.id !== id)
    wx.setStorageSync(MAP_HISTORY_KEY, history)
    this.setData({
      history: history.map(h => ({
        ...h,
        timeText: formatTime(h.timestamp),
        pointCount: (h.data.markers || []).length + (h.data.polyline || []).reduce((s, p) => s + p.points.length, 0),
      })),
    })
    if (history.length === 0) this.setData({ showHistory: false })
  },

  onGoChat() {
    wx.switchTab({ url: '/pages/index/index' })
  },

  _renderMap(mapData) {
    const { markers, polyline, title, actionId } = mapData
    this._mapData = mapData
    this.setData({ mode: 'map', actionId: actionId || '' })

    if (title) wx.setNavigationBarTitle({ title })

    const wxMarkers = (markers || []).map((m, i) => ({
      id: i,
      latitude: m.latitude,
      longitude: m.longitude,
      title: m.title || '',
      width: 24,
      height: 30,
      callout: m.title ? {
        content: m.title,
        display: 'ALWAYS',
        fontSize: 12,
        borderRadius: 4,
        padding: 4,
        bgColor: '#ffffff',
      } : undefined,
    }))

    const wxPolyline = (polyline || []).map((pl) => ({
      points: pl.points,
      color: pl.color || '#1677FF',
      width: pl.width || 4,
      arrowLine: true,
    }))

    const allPoints = []
    ;(markers || []).forEach((m) => allPoints.push(m))
    ;(polyline || []).forEach((pl) => pl.points.forEach((p) => allPoints.push(p)))

    let center = { lat: 39.9042, lng: 116.4074 }
    if (allPoints.length === 1) {
      center = { lat: allPoints[0].latitude, lng: allPoints[0].longitude }
    } else if (allPoints.length > 1) {
      const latSum = allPoints.reduce((s, p) => s + p.latitude, 0)
      const lngSum = allPoints.reduce((s, p) => s + p.longitude, 0)
      center = { lat: latSum / allPoints.length, lng: lngSum / allPoints.length }
    }

    this.setData({ wxMarkers, wxPolyline, center })

    const allPolylinePoints = []
    ;(polyline || []).forEach((pl) => pl.points.forEach((p) => allPolylinePoints.push(p)))
    if (allPolylinePoints.length >= 2) {
      this.setData({ stats: this.calcStats(allPolylinePoints) })
    }

    // Fit bounds after render
    if (allPoints.length >= 2) {
      setTimeout(() => {
        const mapCtx = wx.createMapContext('map', this)
        mapCtx.includePoints({
          points: allPoints.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
          padding: [80, 80, 80, 80],
        })
      }, 300)
    }

    // Generate share screenshot
    setTimeout(() => { this._drawShareImage() }, 500)
  },

  onReady() {
    if (this.data.mode !== 'map') return
    const mapData = wx.getStorageSync('mapShowData')
    if (!mapData) return

    const allPoints = []
    ;(mapData.markers || []).forEach((m) => allPoints.push(m))
    ;(mapData.polyline || []).forEach((pl) => pl.points.forEach((p) => allPoints.push(p)))

    if (allPoints.length >= 2) {
      const mapCtx = wx.createMapContext('map', this)
      mapCtx.includePoints({
        points: allPoints.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
        padding: [80, 80, 80, 80],
      })
    }
  },

  calcStats(points) {
    let totalDist = 0
    for (let i = 1; i < points.length; i++) {
      totalDist += this.haversine(points[i - 1], points[i])
    }
    let durationMs = (points[points.length - 1].timestamp || 0) - (points[0].timestamp || 0)
    if (durationMs === 0) {
      try {
        const last = wx.getStorageSync('lastTrackResult')
        if (last && last.points && last.points.length >= 2) {
          durationMs = (last.points[last.points.length - 1].timestamp || 0) - (last.points[0].timestamp || 0)
        }
      } catch {}
    }
    const durationSec = durationMs / 1000
    const durationMin = Math.round(durationSec / 60)
    let avgSpeed = durationSec > 0 ? (totalDist / durationSec) * 3.6 : 0
    let distStr = totalDist >= 1000 ? (totalDist / 1000).toFixed(2) + ' km' : Math.round(totalDist) + ' m'
    let durStr = durationMin >= 60 ? Math.floor(durationMin / 60) + 'h' + (durationMin % 60) + 'min' : durationMin + ' min'
    if (durationMin === 0 && durationSec > 0) durStr = Math.round(durationSec) + 's'
    let speedStr = avgSpeed.toFixed(1) + ' km/h'
    return {
      show: true,
      distance: distStr,
      duration: durStr,
      speed: speedStr,
      points: String(points.length),
    }
  },

  haversine(a, b) {
    const R = 6371000
    const toRad = (d) => d * Math.PI / 180
    const dLat = toRad(b.latitude - a.latitude)
    const dLng = toRad(b.longitude - a.longitude)
    const sinLat = Math.sin(dLat / 2)
    const sinLng = Math.sin(dLng / 2)
    const h = sinLat * sinLat + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * sinLng * sinLng
    return 2 * R * Math.asin(Math.sqrt(h))
  },

  onDone() {
    const { actionId } = this.data
    if (actionId) {
      relay.sendPhoneActionResponse(actionId, true, { shown: true }, null)
    }
    wx.navigateBack()
  },
})
