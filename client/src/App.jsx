import { useState, useEffect, useCallback, useRef } from 'react'
import { parseMPO, blobToDataURL } from 'mpo-parser'
import {
  alignImages,
  computeDiff,
  computeDiffScore,
  computeDiffScoreInBoxes,
  findSubjectOffset,
  generateWobbleGif,
  createAnaglyphBlob,
  downloadBlob,
  getImageDimensions,
} from './imageUtils.js'
import {
  segmentSubject,
  maskToBoundingBox,
} from './ml/objectDetection.js'
import './App.css'

const HORIZONTAL_LIMIT = 200
const VIEWPORT_WIDTH = 300
const VIEWPORT_HEIGHT = 225
const DIFF_GRAPH_H_STEP = 20
const DIFF_GRAPH_V_STEP = 4

/**
 * Draw the original left/right stereo pair into a fixed-size canvas with
 * equal 50% contribution from both images. Drawing on a black background with
 * additive blending means the overlapping region is a true 50/50 blend and
 * neither image appears more opaque than the other.
 */
function OverlayCanvas({ leftUrl, rightUrl, width, height, hShift, vShift }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    const leftImg = new Image()
    const rightImg = new Image()

    leftImg.onload = () => {
      rightImg.onload = () => {
        const scaleX = width > 0 ? VIEWPORT_WIDTH / width : 1
        const scaleY = height > 0 ? VIEWPORT_HEIGHT / height : 1

        const hOffset = (Math.abs(hShift) / 2) * scaleX
        const vOffset = (Math.abs(vShift) / 2) * scaleY
        const hSign = hShift >= 0 ? 1 : -1
        const vSign = vShift >= 0 ? 1 : -1

        const leftTx = hSign * hOffset
        const leftTy = vSign * vOffset
        const rightTx = -hSign * hOffset
        const rightTy = -vSign * vOffset

        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, VIEWPORT_WIDTH, VIEWPORT_HEIGHT)

        ctx.globalAlpha = 0.5
        ctx.globalCompositeOperation = 'source-over'
        ctx.drawImage(leftImg, leftTx, leftTy, VIEWPORT_WIDTH, VIEWPORT_HEIGHT)

        ctx.globalCompositeOperation = 'lighter'
        ctx.drawImage(rightImg, rightTx, rightTy, VIEWPORT_WIDTH, VIEWPORT_HEIGHT)

        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1
      }
      rightImg.onerror = () => {}
      rightImg.src = rightUrl
    }
    leftImg.onerror = () => {}
    leftImg.src = leftUrl
  }, [leftUrl, rightUrl, width, height, hShift, vShift])

  return <canvas ref={canvasRef} width={VIEWPORT_WIDTH} height={VIEWPORT_HEIGHT} />
}

/**
 * Show the computed diff image at the exact size of the overlap region shown
 * in OverlayCanvas, centred inside the fixed viewport with black bars.
 */
function DiffViewport({ diffUrl, width, height, hShift, vShift }) {
  const hCrop = Math.abs(hShift)
  const vCrop = Math.abs(vShift)
  const scaleX = width > 0 ? VIEWPORT_WIDTH / width : 1
  const scaleY = height > 0 ? VIEWPORT_HEIGHT / height : 1

  const imgWidth = Math.max(1, width - hCrop) * scaleX
  const imgHeight = Math.max(1, height - vCrop) * scaleY
  const tx = (VIEWPORT_WIDTH - imgWidth) / 2
  const ty = (VIEWPORT_HEIGHT - imgHeight) / 2

  return (
    <div className="viewport" style={{ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT }}>
      <img
        src={diffUrl}
        alt="Diff"
        className="viewport-img"
        style={{
          width: imgWidth,
          height: imgHeight,
          transform: `translate(${tx}px, ${ty}px)`,
        }}
      />
    </div>
  )
}

/**
 * Game Boy cartridge slot page switcher.
 */
function CartridgeSwitcher({ page, onChange }) {
  return (
    <div className="cartridge-switcher">
      <button
        className={`cartridge ${page === 'simple' ? 'inserted' : ''}`}
        onClick={() => onChange('simple')}
        aria-pressed={page === 'simple'}
      >
        <span className="cartridge-label">SIMPLE</span>
      </button>
      <button
        className={`cartridge ${page === 'advanced' ? 'inserted' : ''}`}
        onClick={() => onChange('advanced')}
        aria-pressed={page === 'advanced'}
      >
        <span className="cartridge-label">ADVANCED</span>
      </button>
    </div>
  )
}

/**
 * Horizontal shift slider placed between the overlay and diff images.
 */
function HorizontalSlider({ hShift, onHShiftChange }) {
  function adjust(delta) {
    onHShiftChange((prev) => Math.max(-HORIZONTAL_LIMIT, Math.min(HORIZONTAL_LIMIT, prev + delta)))
  }

  return (
    <div className="horizontal-slider">
      <div className="slider-label-row">
        <label className="slider-label">Horizontal</label>
        <button className="reset-button" onClick={() => onHShiftChange(0)}>
          RESET
        </button>
      </div>
      <div className="slider-controls">
        <button onClick={() => adjust(-1)} disabled={hShift <= -HORIZONTAL_LIMIT}>
          -
        </button>
        <input
          type="range"
          min={-HORIZONTAL_LIMIT}
          max={HORIZONTAL_LIMIT}
          value={hShift}
          onInput={(e) => onHShiftChange(Number(e.target.value))}
        />
        <button onClick={() => adjust(1)} disabled={hShift >= HORIZONTAL_LIMIT}>
          +
        </button>
      </div>
    </div>
  )
}

/**
 * Vertical shift slider placed in the left column next to the previews.
 */
function VerticalSlider({ vShift, maxVShift, onVShiftChange }) {
  function adjust(delta) {
    onVShiftChange((prev) => Math.max(-maxVShift, Math.min(maxVShift, prev + delta)))
  }

  return (
    <div className="vertical-slider">
      <label className="slider-label">Vertical</label>
      <button onClick={() => adjust(1)} disabled={vShift >= maxVShift}>
        +
      </button>
      <div className="vertical-slider-track">
        <input
          type="range"
          className="green-thumb"
          min={-maxVShift}
          max={maxVShift}
          value={vShift}
          onInput={(e) => onVShiftChange(Number(e.target.value))}
        />
      </div>
      <button onClick={() => adjust(-1)} disabled={vShift <= -maxVShift}>
        -
      </button>
      <button className="reset-button" onClick={() => onVShiftChange(0)}>
        RESET
      </button>
    </div>
  )
}

/**
 * Side-by-side overlay and diff preview panels.
 */
function PreviewPanels({ leftOriginalUrl, rightOriginalUrl, originalDims, hShift, vShift, diffUrl }) {
  return (
    <div className="image-stack">
      <div className="image-panel">
        <h3>Overlay</h3>
        <div className="retro-screen fixed-screen">
          <OverlayCanvas
            leftUrl={leftOriginalUrl}
            rightUrl={rightOriginalUrl}
            width={originalDims.width}
            height={originalDims.height}
            hShift={hShift}
            vShift={vShift}
          />
        </div>
      </div>

      <div className="image-panel">
        <h3>Diff</h3>
        <div className="retro-screen fixed-screen">
          <DiffViewport
            diffUrl={diffUrl}
            width={originalDims.width}
            height={originalDims.height}
            hShift={hShift}
            vShift={vShift}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * Advanced GIF generation settings panel.
 */
function GifSettings({ settings, onChange }) {
  return (
    <div className="gif-settings">
      <h3>GIF Settings</h3>

      <div className="setting-row">
        <label>Frame delay</label>
        <div className="setting-control">
          <input
            type="range"
            min={50}
            max={1000}
            step={50}
            value={settings.delayMs}
            onInput={(e) => onChange({ ...settings, delayMs: Number(e.target.value) })}
          />
          <span>{settings.delayMs} ms</span>
        </div>
      </div>

      <div className="setting-row">
        <label>Cycles</label>
        <div className="setting-control">
          <input
            type="range"
            min={1}
            max={5}
            step={1}
            value={settings.cycles}
            onInput={(e) => onChange({ ...settings, cycles: Number(e.target.value) })}
          />
          <span>{settings.cycles}</span>
        </div>
      </div>

      <div className="setting-row">
        <label>Crossfade</label>
        <div className="setting-control">
          <input
            type="range"
            min={0}
            max={8}
            step={1}
            value={settings.crossfadeSteps}
            onInput={(e) => onChange({ ...settings, crossfadeSteps: Number(e.target.value) })}
          />
          <span>{settings.crossfadeSteps} frames</span>
        </div>
      </div>

      <div className="setting-row">
        <label>Scale</label>
        <div className="setting-control">
          <input
            type="range"
            min={0.25}
            max={1.0}
            step={0.05}
            value={settings.scale}
            onInput={(e) => onChange({ ...settings, scale: Number(e.target.value) })}
          />
          <span>{Math.round(settings.scale * 100)}%</span>
        </div>
      </div>

      <div className="setting-row loop-row">
        <label>Loop forever</label>
        <button
          className={`loop-toggle ${settings.loop ? 'on' : 'off'}`}
          onClick={() => onChange({ ...settings, loop: !settings.loop })}
        >
          {settings.loop ? 'ON' : 'OFF'}
        </button>
      </div>
    </div>
  )
}

/**
 * Line graph: diff score vs horizontal shift at the current vertical shift.
 */
function DiffLineGraph({ data, currentHShift, loading }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || data.length === 0) return

    const width = canvas.width
    const height = canvas.height
    const ctx = canvas.getContext('2d')

    const scores = data.map((d) => d.score)
    const minScore = Math.min(...scores)
    const maxScore = Math.max(...scores)
    const scoreRange = Math.max(maxScore - minScore, 1)

    const padding = 24
    const graphWidth = width - padding * 2
    const graphHeight = height - padding * 2

    function xForH(h) {
      return padding + ((h + HORIZONTAL_LIMIT) / (HORIZONTAL_LIMIT * 2)) * graphWidth
    }

    function yForScore(score) {
      return padding + graphHeight - ((score - minScore) / scoreRange) * graphHeight
    }

    ctx.fillStyle = '#8bac0f'
    ctx.fillRect(0, 0, width, height)

    // Grid lines
    ctx.strokeStyle = 'rgba(15, 56, 15, 0.2)'
    ctx.lineWidth = 1
    for (let h = -HORIZONTAL_LIMIT; h <= HORIZONTAL_LIMIT; h += 50) {
      const x = xForH(h)
      ctx.beginPath()
      ctx.moveTo(x, padding)
      ctx.lineTo(x, padding + graphHeight)
      ctx.stroke()
    }

    // Plot line
    ctx.strokeStyle = '#0f380f'
    ctx.lineWidth = 2
    ctx.beginPath()
    data.forEach((point, i) => {
      const x = xForH(point.hShift)
      const y = yForScore(point.score)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()

    // Current position marker
    const currentX = xForH(currentHShift)
    ctx.strokeStyle = '#b71c1c'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(currentX, padding)
    ctx.lineTo(currentX, padding + graphHeight)
    ctx.stroke()

    // Axis labels
    ctx.fillStyle = '#0f380f'
    ctx.font = '10px monospace'
    ctx.textAlign = 'center'
    ctx.fillText('-200', padding, height - 6)
    ctx.fillText('0', width / 2, height - 6)
    ctx.fillText('+200', width - padding, height - 6)
  }, [data, currentHShift])

  return (
    <div className="diff-graph retro-screen">
      <canvas ref={canvasRef} width={300} height={225} />
      {loading && <div className="graph-loading">SCANNING…</div>}
    </div>
  )
}

/**
 * 2D heatmap: diff score over horizontal and vertical shift.
 * X axis = horizontal shift, Y axis = vertical shift, colour = diff score.
 */
function DiffHeatmap({ data, currentHShift, currentVShift, maxVShift, loading }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || data.length === 0) return

    const width = canvas.width
    const height = canvas.height
    const ctx = canvas.getContext('2d')

    const scores = data.map((d) => d.score)
    const minScore = Math.min(...scores)
    const maxScore = Math.max(...scores)
    const scoreRange = Math.max(maxScore - minScore, 1)

    const padding = 24
    const graphWidth = width - padding * 2
    const graphHeight = height - padding * 2

    const hValues = [...new Set(data.map((d) => d.hShift))].sort((a, b) => a - b)
    const vValues = [...new Set(data.map((d) => d.vShift))].sort((a, b) => a - b)

    const cellW = graphWidth / hValues.length
    const cellH = graphHeight / vValues.length

    function colorForScore(score) {
      const t = (score - minScore) / scoreRange
      // Inverted heatmap: low diff = yellow, high diff = red.
      const low = { r: 255, g: 204, b: 0 }
      const mid = { r: 255, g: 69, b: 0 }
      const high = { r: 51, g: 0, b: 0 }

      let r, g, b
      if (t < 0.5) {
        const s = t * 2
        r = Math.round(low.r + (mid.r - low.r) * s)
        g = Math.round(low.g + (mid.g - low.g) * s)
        b = Math.round(low.b + (mid.b - low.b) * s)
      } else {
        const s = (t - 0.5) * 2
        r = Math.round(mid.r + (high.r - mid.r) * s)
        g = Math.round(mid.g + (high.g - mid.g) * s)
        b = Math.round(mid.b + (high.b - mid.b) * s)
      }
      return `rgb(${r}, ${g}, ${b})`
    }

    ctx.fillStyle = '#8bac0f'
    ctx.fillRect(0, 0, width, height)

    // Render the heatmap grid into a tiny canvas and scale it up with
    // bilinear smoothing so the colour transitions look continuous.
    const gridCanvas = document.createElement('canvas')
    gridCanvas.width = hValues.length
    gridCanvas.height = vValues.length
    const gridCtx = gridCanvas.getContext('2d')

    data.forEach((point) => {
      const x = hValues.indexOf(point.hShift)
      const y = vValues.indexOf(point.vShift)
      gridCtx.fillStyle = colorForScore(point.score)
      gridCtx.fillRect(x, y, 1, 1)
    })

    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(gridCanvas, padding, padding, graphWidth, graphHeight)

    // Current position marker (red crosshair)
    function interp(arr, val) {
      const i = arr.findIndex((v) => v >= val)
      if (i <= 0) return padding + (i < 0 ? arr.length - 1 : 0) * (arr === hValues ? cellW : cellH)
      const v0 = arr[i - 1]
      const v1 = arr[i]
      const t = (val - v0) / (v1 - v0)
      const base = padding + (i - 1) * (arr === hValues ? cellW : cellH)
      return base + t * (arr === hValues ? cellW : cellH)
    }

    const curX = interp(hValues, currentHShift)
    const curY = interp(vValues, currentVShift)

    ctx.strokeStyle = '#b71c1c'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(curX, padding)
    ctx.lineTo(curX, padding + graphHeight)
    ctx.stroke()

    ctx.beginPath()
    ctx.moveTo(padding, curY)
    ctx.lineTo(padding + graphWidth, curY)
    ctx.stroke()

    // Axis labels
    ctx.fillStyle = '#0f380f'
    ctx.font = '10px monospace'
    ctx.textAlign = 'center'
    ctx.fillText('-200', padding, height - 6)
    ctx.fillText('0', width / 2, height - 6)
    ctx.fillText('+200', width - padding, height - 6)

    ctx.textAlign = 'right'
    ctx.fillText(`+${maxVShift}`, padding - 4, padding + 8)
    ctx.fillText('0', padding - 4, padding + graphHeight / 2 + 4)
    ctx.fillText(`-${maxVShift}`, padding - 4, padding + graphHeight + 4)
  }, [data, currentHShift, currentVShift, maxVShift])

  return (
    <div className="diff-graph retro-screen">
      <canvas ref={canvasRef} width={300} height={225} />
      {loading && <div className="graph-loading">SCANNING…</div>}
    </div>
  )
}

/**
 * Auto-alignment panel with diff-search and ML placeholders.
 */
function AutoAlignPanel({ loading, message, mlProgress, onDiffSearch, onMlAlign }) {
  return (
    <div className="auto-align-panel">
      <h3>Auto Alignment</h3>
      <div className="auto-align-row">
        <button
          className="auto-align-button diff-search"
          onClick={onDiffSearch}
          disabled={loading}
        >
          {loading && !mlProgress ? 'SEARCHING…' : 'AUTO: DIFF SEARCH'}
        </button>
        <button
          className="auto-align-button ml"
          onClick={onMlAlign}
          disabled={loading}
        >
          {mlProgress ? `ML: ${mlProgress.text} ${Math.round(mlProgress.progress ?? 0)}%` : 'AUTO: ML'}
        </button>
      </div>
      {mlProgress && (
        <div className="ml-progress-bar">
          <div
            className="ml-progress-fill"
            style={{ width: `${mlProgress.progress ?? 0}%` }}
          />
        </div>
      )}
      {message && <div className="auto-align-message">{message}</div>}
    </div>
  )
}

/**
 * Create a canvas containing the subject mask as an RGBA image.
 */
function maskToCanvas(mask, width, height, threshold, r, g, b) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  const imageData = ctx.createImageData(width, height)

  for (let i = 0; i < mask.length; i++) {
    const active = mask[i] > threshold ? 1 : 0
    imageData.data[i * 4] = r
    imageData.data[i * 4 + 1] = g
    imageData.data[i * 4 + 2] = b
    imageData.data[i * 4 + 3] = active ? 120 : 0
  }

  ctx.putImageData(imageData, 0, 0)
  return canvas
}

/**
 * Draw subject masks and bounding boxes on top of the overlay viewport.
 */
function SubjectMaskOverlay({ width, height, hShift, vShift, leftMask, rightMask, leftBox, rightBox, threshold }) {
  const canvasRef = useRef(null)
  const leftMaskCanvasRef = useRef(null)
  const rightMaskCanvasRef = useRef(null)

  useEffect(() => {
    leftMaskCanvasRef.current = leftMask
      ? maskToCanvas(leftMask, width, height, threshold, 0, 255, 80)
      : null
    rightMaskCanvasRef.current = rightMask
      ? maskToCanvas(rightMask, width, height, threshold, 0, 170, 255)
      : null
  }, [leftMask, rightMask, width, height, threshold])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    const scaleX = width > 0 ? VIEWPORT_WIDTH / width : 1
    const scaleY = height > 0 ? VIEWPORT_HEIGHT / height : 1

    const hOffset = (Math.abs(hShift) / 2) * scaleX
    const vOffset = (Math.abs(vShift) / 2) * scaleY
    const hSign = hShift >= 0 ? 1 : -1
    const vSign = vShift >= 0 ? 1 : -1

    const leftTx = hSign * hOffset
    const leftTy = vSign * vOffset
    const rightTx = -hSign * hOffset
    const rightTy = -vSign * vOffset

    ctx.clearRect(0, 0, VIEWPORT_WIDTH, VIEWPORT_HEIGHT)

    if (leftMaskCanvasRef.current) {
      ctx.globalAlpha = 0.5
      ctx.drawImage(leftMaskCanvasRef.current, leftTx, leftTy, VIEWPORT_WIDTH, VIEWPORT_HEIGHT)
    }
    if (rightMaskCanvasRef.current) {
      ctx.globalAlpha = 0.5
      ctx.drawImage(rightMaskCanvasRef.current, rightTx, rightTy, VIEWPORT_WIDTH, VIEWPORT_HEIGHT)
    }
    ctx.globalAlpha = 1

    function drawBox(box, tx, ty, color) {
      if (!box || box.width <= 0 || box.height <= 0) return
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.strokeRect(
        box.x * scaleX + tx,
        box.y * scaleY + ty,
        box.width * scaleX,
        box.height * scaleY
      )
    }

    drawBox(leftBox, leftTx, leftTy, '#00ff50')
    drawBox(rightBox, rightTx, rightTy, '#00aaff')
  }, [width, height, hShift, vShift, leftBox, rightBox])

  return (
    <canvas
      ref={canvasRef}
      width={VIEWPORT_WIDTH}
      height={VIEWPORT_HEIGHT}
      className="subject-mask-overlay"
    />
  )
}

/**
 * Animated overlay showing how the search algorithm moved from the original
 * position to the final aligned position.
 */
function SearchVisualization({ steps, stats, leftUrl, rightUrl, width, height, segmentations }) {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (steps.length === 0) return
    const interval = setInterval(() => {
      setIndex((prev) => (prev + 1 >= steps.length ? steps.length - 1 : prev + 1))
    }, 400)
    return () => clearInterval(interval)
  }, [steps])

  const step = steps[index]
  if (!step) return null

  return (
    <div className="search-viz-panel">
      <h3>Search Visualization</h3>
      <div className="search-viz-body">
        <div className="search-viz-screen retro-screen fixed-screen" style={{ position: 'relative' }}>
          <OverlayCanvas
            leftUrl={leftUrl}
            rightUrl={rightUrl}
            width={width}
            height={height}
            hShift={step.hShift}
            vShift={step.vShift}
          />
          {segmentations && (
            <SubjectMaskOverlay
              width={width}
              height={height}
              hShift={step.hShift}
              vShift={step.vShift}
              leftMask={segmentations.left.mask}
              rightMask={segmentations.right.mask}
              leftBox={segmentations.left.box}
              rightBox={segmentations.right.box}
              threshold={segmentations.left.threshold}
            />
          )}
        </div>
        <div className="search-viz-stats">
          <div className="stat-row">
            <span>Step</span>
            <span>
              {index + 1} / {steps.length}
            </span>
          </div>
          <div className="stat-row">
            <span>H shift</span>
            <span>{step.hShift}</span>
          </div>
          <div className="stat-row">
            <span>V shift</span>
            <span>{step.vShift}</span>
          </div>
          <div className="stat-row">
            <span>Score</span>
            <span>{step.score.toFixed(1)}</span>
          </div>
          {stats && (
            <>
              <div className="stat-row">
                <span>Evaluations</span>
                <span>{stats.evaluations}</span>
              </div>
              <div className="stat-row">
                <span>Time</span>
                <span>{stats.timeMs} ms</span>
              </div>
              <div className="stat-row">
                <span>Complexity</span>
                <span>{stats.complexity}</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Combined diff graph panel: line graph on the left, heatmap on the right.
 */
function DiffGraphPanel({ lineData, lineLoading, heatmapData, heatmapLoading, currentHShift, currentVShift, maxVShift }) {
  return (
    <div className="diff-graph-panel">
      <h3>Diff Score vs Shift</h3>
      <div className="diff-graph-row">
        <DiffLineGraph data={lineData} currentHShift={currentHShift} loading={lineLoading} />
        <DiffHeatmap
          data={heatmapData}
          currentHShift={currentHShift}
          currentVShift={currentVShift}
          maxVShift={maxVShift}
          loading={heatmapLoading}
        />
      </div>
    </div>
  )
}

function App() {
  const [screen, setScreen] = useState('upload')
  const [error, setError] = useState(null)
  const [dragActive, setDragActive] = useState(false)

  const [leftBlob, setLeftBlob] = useState(null)
  const [rightBlob, setRightBlob] = useState(null)
  const [leftOriginalUrl, setLeftOriginalUrl] = useState(null)
  const [rightOriginalUrl, setRightOriginalUrl] = useState(null)
  const [originalDims, setOriginalDims] = useState({ width: 0, height: 0 })

  const [hShift, setHShift] = useState(0)
  const [vShift, setVShift] = useState(0)
  const [maxVShift, setMaxVShift] = useState(0)

  const [diffUrl, setDiffUrl] = useState(null)
  const [diffScore, setDiffScore] = useState(null)

  const [gifUrl, setGifUrl] = useState(null)
  const [gifLoading, setGifLoading] = useState(false)

  const [autoAlignLoading, setAutoAlignLoading] = useState(false)
  const [autoAlignMessage, setAutoAlignMessage] = useState(null)
  const [autoAlignSteps, setAutoAlignSteps] = useState([])
  const [autoAlignStats, setAutoAlignStats] = useState(null)
  const [autoAlignMode, setAutoAlignMode] = useState(null)

  const [mlProgress, setMlProgress] = useState(null)
  const [mlSegmentations, setMlSegmentations] = useState(null)

  const [page, setPage] = useState('simple')

  const [gifSettings, setGifSettings] = useState({
    delayMs: 300,
    cycles: 1,
    crossfadeSteps: 0,
    scale: 1.0,
    loop: true,
  })

  const [diffGraphData, setDiffGraphData] = useState([])
  const [diffGraphLoading, setDiffGraphLoading] = useState(false)
  const [diffLineData, setDiffLineData] = useState([])
  const [diffLineLoading, setDiffLineLoading] = useState(false)

  const fileInputRef = useRef(null)
  const graphTimeoutRef = useRef(null)
  const lineTimeoutRef = useRef(null)

  const updateDerivedImages = useCallback(async (lBlob, rBlob, h, v) => {
    if (!lBlob || !rBlob) return

    try {
      const { left: leftAligned, right: rightAligned } = await alignImages(lBlob, rBlob, h, v)
      const { diffUrl: dUrl, diffScore: score } = await computeDiff(leftAligned, rightAligned)

      setDiffUrl(dUrl)
      setDiffScore(score)
    } catch (err) {
      console.error('Failed to compute derived images:', err)
      setError(err.message)
    }
  }, [])

  async function processFile(file) {
    if (!file) return

    setError(null)
    setDiffUrl(null)
    setDiffScore(null)
    setGifUrl(null)
    setDiffGraphData([])
    setDiffLineData([])

    try {
      const buffer = await file.arrayBuffer()
      const { left, right } = parseMPO(buffer)

      const [dims, lUrl, rUrl] = await Promise.all([
        getImageDimensions(left),
        blobToDataURL(left),
        blobToDataURL(right),
      ])

      const maxV = Math.max(0, Math.round(dims.height * 0.05))

      setLeftBlob(left)
      setRightBlob(right)
      setLeftOriginalUrl(lUrl)
      setRightOriginalUrl(rUrl)
      setOriginalDims(dims)
      setHShift(0)
      setVShift(0)
      setMaxVShift(maxV)
      setPage('simple')

      await updateDerivedImages(left, right, 0, 0)
      setScreen('preview')
    } catch (err) {
      console.error('parseMPO failed:', err)
      setError(err.message)
    }
  }

  function handleFileChange(e) {
    processFile(e.target.files[0])
  }

  function handleDrop(e) {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0])
    }
  }

  function handleDragOver(e) {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(true)
  }

  function handleDragLeave(e) {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
  }

  function handleBackToUpload() {
    setLeftBlob(null)
    setRightBlob(null)
    setLeftOriginalUrl(null)
    setRightOriginalUrl(null)
    setOriginalDims({ width: 0, height: 0 })
    setHShift(0)
    setVShift(0)
    setMaxVShift(0)
    setDiffUrl(null)
    setDiffScore(null)
    setGifUrl(null)
    setDiffGraphData([])
    setDiffLineData([])
    setError(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
    setScreen('upload')
  }

  async function generateGifWithSettings(settings) {
    if (!leftBlob || !rightBlob) return

    setGifLoading(true)
    try {
      const { left, right } = await alignImages(leftBlob, rightBlob, hShift, vShift)
      const url = await generateWobbleGif(left, right, settings)
      setGifUrl(url)
      setScreen('gif')
    } catch (err) {
      console.error('Failed to generate GIF:', err)
      setError(err.message)
    } finally {
      setGifLoading(false)
    }
  }

  async function handleCreateGif() {
    await generateGifWithSettings({
      delayMs: 300,
      cycles: 1,
      crossfadeSteps: 0,
      scale: 1.0,
      loop: true,
    })
  }

  async function handleGenerateAdvancedGif() {
    await generateGifWithSettings(gifSettings)
  }

  async function evaluateAlignment(h, v) {
    const { left, right } = await alignImages(leftBlob, rightBlob, h, v)
    const score = await computeDiffScore(left, right)
    return { hShift: h, vShift: v, score }
  }

  async function ternarySearch1D(lo, hi, evaluateFn, steps) {
    let best = null
    while (hi - lo > 2) {
      const m1 = Math.floor(lo + (hi - lo) / 3)
      const m2 = Math.floor(hi - (hi - lo) / 3)
      const p1 = await evaluateFn(m1)
      const p2 = await evaluateFn(m2)
      steps.push(p1, p2)
      if (!best || p1.score < best.score) best = p1
      if (!best || p2.score < best.score) best = p2
      if (p1.score < p2.score) {
        hi = m2
      } else {
        lo = m1
      }
    }
    for (let x = lo; x <= hi; x++) {
      const p = await evaluateFn(x)
      steps.push(p)
      if (!best || p.score < best.score) best = p
    }
    return best
  }

  async function handleDiffSearchAlign() {
    if (!leftBlob || !rightBlob) return

    setAutoAlignLoading(true)
    setAutoAlignMessage(null)
    setAutoAlignSteps([])
    setAutoAlignStats(null)
    setAutoAlignMode('diff')
    setMlSegmentations(null)

    const startTime = performance.now()
    const steps = []

    try {
      // First, search horizontally around the current vertical shift.
      const hBest = await ternarySearch1D(
        -HORIZONTAL_LIMIT,
        HORIZONTAL_LIMIT,
        (h) => evaluateAlignment(h, vShift),
        steps
      )

      // Then, search vertically at the best horizontal shift found.
      const vBest = await ternarySearch1D(
        -maxVShift,
        maxVShift,
        (v) => evaluateAlignment(hBest.hShift, v),
        steps
      )

      const duration = Math.round(performance.now() - startTime)

      setHShift(vBest.hShift)
      setVShift(vBest.vShift)
      setAutoAlignSteps(steps)
      setAutoAlignStats({
        evaluations: steps.length,
        timeMs: duration,
        complexity: 'O(log n)',
      })
      setAutoAlignMessage(
        `DIFF SEARCH: H ${vBest.hShift} / V ${vBest.vShift} (score ${vBest.score.toFixed(1)})`
      )
    } catch (err) {
      console.error('Auto-align failed:', err)
      setError(err.message)
    } finally {
      setAutoAlignLoading(false)
    }
  }

  async function handleMlAlign() {
    if (!leftBlob || !rightBlob) return

    setAutoAlignLoading(true)
    setAutoAlignMessage(null)
    setAutoAlignSteps([])
    setAutoAlignStats(null)
    setAutoAlignMode('ml')
    setMlProgress(null)
    setMlSegmentations(null)

    const startTime = performance.now()
    const steps = []

    try {
      // 1. Segment the subject in the left image only.
      setMlProgress({ stage: 'segmenting subject', percent: 0 })
      const leftSeg = await segmentSubject(leftBlob, setMlProgress)

      const leftBox = maskToBoundingBox(leftSeg.mask, leftSeg.width, leftSeg.height)

      if (!leftBox) {
        throw new Error('No subject detected in the left image.')
      }

      // 2. Find that exact subject in the right image.
      setMlProgress({ stage: 'matching subject in right image', percent: 50 })
      const match = await findSubjectOffset(leftBlob, rightBlob, leftBox, {
        targetWidth: 320,
        hSearchRange: Math.min(120, Math.round(originalDims.width * 0.2)),
        vSearchRange: Math.min(60, Math.round(originalDims.height * 0.1)),
      })

      const estimate = {
        hShift: Number.isFinite(match.dx) ? Math.round(match.dx) : 0,
        vShift: Number.isFinite(match.dy) ? Math.round(match.dy) : 0,
      }

      // 3. Box-constrained diff refinement around the template-match estimate.
      const rightBox = {
        x: leftBox.x + estimate.hShift,
        y: leftBox.y + estimate.vShift,
        width: leftBox.width,
        height: leftBox.height,
      }

      async function evaluateInBox(h, v) {
        const { diffScore: score } = await computeDiffScoreInBoxes(
          leftBlob,
          rightBlob,
          h,
          v,
          leftBox,
          rightBox
        )
        return { hShift: h, vShift: v, score }
      }

      const hWindow = 20
      const vWindow = 10
      const hBest = await ternarySearch1D(
        Math.max(-HORIZONTAL_LIMIT, estimate.hShift - hWindow),
        Math.min(HORIZONTAL_LIMIT, estimate.hShift + hWindow),
        (h) => evaluateInBox(h, estimate.vShift),
        steps
      )

      if (!hBest || !Number.isFinite(hBest.hShift)) {
        throw new Error('ML horizontal refinement failed to produce a valid shift.')
      }

      const vBest = await ternarySearch1D(
        Math.max(-maxVShift, estimate.vShift - vWindow),
        Math.min(maxVShift, estimate.vShift + vWindow),
        (v) => evaluateInBox(hBest.hShift, v),
        steps
      )

      if (!vBest || !Number.isFinite(vBest.hShift) || !Number.isFinite(vBest.vShift)) {
        throw new Error('ML refinement failed to produce a valid shift.')
      }

      const duration = Math.round(performance.now() - startTime)

      setHShift(vBest.hShift)
      setVShift(vBest.vShift)
      setAutoAlignSteps(steps)
      setAutoAlignStats({
        evaluations: steps.length,
        timeMs: duration,
        complexity: 'O(log n)',
      })
      setMlSegmentations({
        left: { ...leftSeg, box: leftBox },
        right: { box: rightBox },
        estimate,
        matchConfidence: match.confidence,
      })
      setAutoAlignMessage(
        `ML ALIGN: template match (conf ${match.confidence.toFixed(2)}, H ${vBest.hShift} / V ${vBest.vShift}, score ${vBest.score.toFixed(1)})`
      )
    } catch (err) {
      console.error('ML auto-align failed:', err)
      setError(err.message)
    } finally {
      setAutoAlignLoading(false)
      setMlProgress(null)
    }
  }

  async function handleDownloadAnaglyph() {
    if (!leftBlob || !rightBlob) return

    try {
      const { left, right } = await alignImages(leftBlob, rightBlob, hShift, vShift)
      const blob = await createAnaglyphBlob(left, right)
      downloadBlob(blob, 'wobble-anaglyph.png')
    } catch (err) {
      console.error('Failed to generate anaglyph:', err)
      setError(err.message)
    }
  }

  function handleDownloadGif() {
    if (!gifUrl) return
    const a = document.createElement('a')
    a.href = gifUrl
    a.download = 'wobble.gif'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  useEffect(() => {
    if (leftBlob && rightBlob) {
      updateDerivedImages(leftBlob, rightBlob, hShift, vShift)
    }
  }, [hShift, vShift, leftBlob, rightBlob, updateDerivedImages])

  // Heatmap: full 2D grid of hShift x vShift. Recomputes only when the image
  // or the vertical limit changes, not when the current vertical slider moves.
  useEffect(() => {
    if (!leftBlob || !rightBlob || page !== 'advanced') {
      setDiffGraphData([])
      setDiffGraphLoading(false)
      return
    }

    if (graphTimeoutRef.current) {
      clearTimeout(graphTimeoutRef.current)
    }

    setDiffGraphLoading(true)
    graphTimeoutRef.current = setTimeout(async () => {
      try {
        const vLimit = Math.max(0, maxVShift)
        const points = []
        for (let h = -HORIZONTAL_LIMIT; h <= HORIZONTAL_LIMIT; h += DIFF_GRAPH_H_STEP) {
          for (let v = -vLimit; v <= vLimit; v += DIFF_GRAPH_V_STEP) {
            const { left, right } = await alignImages(leftBlob, rightBlob, h, v)
            const score = await computeDiffScore(left, right)
            points.push({ hShift: h, vShift: v, score })
          }
        }
        setDiffGraphData(points)
      } catch (err) {
        console.error('Failed to compute diff heatmap:', err)
      } finally {
        setDiffGraphLoading(false)
      }
    }, 300)

    return () => {
      if (graphTimeoutRef.current) {
        clearTimeout(graphTimeoutRef.current)
      }
    }
  }, [leftBlob, rightBlob, page, maxVShift])

  // Line graph: diff score vs hShift at the current vShift. Recomputes when
  // the vertical slider moves so the slice matches the live alignment.
  useEffect(() => {
    if (!leftBlob || !rightBlob || page !== 'advanced') {
      setDiffLineData([])
      setDiffLineLoading(false)
      return
    }

    if (lineTimeoutRef.current) {
      clearTimeout(lineTimeoutRef.current)
    }

    setDiffLineLoading(true)
    lineTimeoutRef.current = setTimeout(async () => {
      try {
        const points = []
        for (let h = -HORIZONTAL_LIMIT; h <= HORIZONTAL_LIMIT; h += DIFF_GRAPH_H_STEP) {
          const { left, right } = await alignImages(leftBlob, rightBlob, h, vShift)
          const score = await computeDiffScore(left, right)
          points.push({ hShift: h, score })
        }
        setDiffLineData(points)
      } catch (err) {
        console.error('Failed to compute diff line graph:', err)
      } finally {
        setDiffLineLoading(false)
      }
    }, 300)

    return () => {
      if (lineTimeoutRef.current) {
        clearTimeout(lineTimeoutRef.current)
      }
    }
  }, [leftBlob, rightBlob, page, vShift])

  const sharedVerticalSlider = (
    <VerticalSlider
      vShift={vShift}
      maxVShift={maxVShift}
      onVShiftChange={setVShift}
    />
  )

  const sharedHorizontalSlider = (
    <HorizontalSlider hShift={hShift} onHShiftChange={setHShift} />
  )

  const sharedPreviewPanels = (
    <PreviewPanels
      leftOriginalUrl={leftOriginalUrl}
      rightOriginalUrl={rightOriginalUrl}
      originalDims={originalDims}
      hShift={hShift}
      vShift={vShift}
      diffUrl={diffUrl}
    />
  )

  return (
    <div className="app">
      {error && (
        <div className="error-banner">
          <strong>ERROR:</strong> {error}
        </div>
      )}

      {screen === 'upload' && (
        <div className="upload-screen">
          <h1>3DS Wigglegram Maker</h1>

          <div
            className={`upload-zone ${dragActive ? 'active' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".mpo,.MPO"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
            <div className="upload-icon">📁</div>
            <div className="upload-title">Upload .MPO File</div>
            <div className="upload-hint">Drag & drop or click to choose</div>
          </div>

          <p className="privacy-hint">
            All processing happens locally in your browser. No images are uploaded.
          </p>
        </div>
      )}

      {screen === 'preview' && (
        <div className="preview-screen">
          <CartridgeSwitcher page={page} onChange={setPage} />

          {page === 'simple' ? (
            <div className="page-content simple-page">
              {sharedHorizontalSlider}

              <div className="preview-body">
                {sharedVerticalSlider}
                {sharedPreviewPanels}
              </div>

              {diffScore !== null && (
                <div className="diff-score">DIFF SCORE: {diffScore.toFixed(1)} / 255</div>
              )}

              <div className="action-row">
                <button className="red" onClick={handleCreateGif} disabled={gifLoading}>
                  {gifLoading ? 'WORKING…' : 'CREATE GIF'}
                </button>
                <button className="grey" onClick={handleBackToUpload}>
                  BACK
                </button>
              </div>
            </div>
          ) : (
            <div className="page-content advanced-page">
              <GifSettings settings={gifSettings} onChange={setGifSettings} />

              <AutoAlignPanel
                loading={autoAlignLoading}
                message={autoAlignMessage}
                mlProgress={mlProgress}
                onDiffSearch={handleDiffSearchAlign}
                onMlAlign={handleMlAlign}
              />

              <SearchVisualization
                key={`${autoAlignMode}-${autoAlignSteps.length}`}
                steps={autoAlignSteps}
                stats={autoAlignStats}
                leftUrl={leftOriginalUrl}
                rightUrl={rightOriginalUrl}
                width={originalDims.width}
                height={originalDims.height}
                segmentations={autoAlignMode === 'ml' ? mlSegmentations : null}
              />

              {sharedHorizontalSlider}

              <div className="preview-body">
                {sharedVerticalSlider}
                {sharedPreviewPanels}
              </div>

              {diffScore !== null && (
                <div className="diff-score">DIFF SCORE: {diffScore.toFixed(1)} / 255</div>
              )}

              <DiffGraphPanel
                lineData={diffLineData}
                lineLoading={diffLineLoading}
                heatmapData={diffGraphData}
                heatmapLoading={diffGraphLoading}
                currentHShift={hShift}
                currentVShift={vShift}
                maxVShift={maxVShift}
              />

              <div className="action-row">
                <button
                  className="red"
                  onClick={handleGenerateAdvancedGif}
                  disabled={gifLoading}
                >
                  {gifLoading ? 'WORKING…' : 'GENERATE GIF'}
                </button>
                <button className="grey" onClick={handleBackToUpload}>
                  BACK
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {screen === 'gif' && (
        <div className="gif-screen">
          <CartridgeSwitcher page={page} onChange={setPage} />

          <h2>Your Wobble GIF</h2>

          <div className="retro-screen gif-preview">
            {gifUrl && <img src={gifUrl} alt="Wobble GIF" />}
          </div>

          <div className="action-row">
            <button className="blue" onClick={handleDownloadGif}>
              DOWNLOAD GIF
            </button>
            <button className="yellow" onClick={handleDownloadAnaglyph}>
              ANAGLYPH
            </button>
            <button onClick={() => setScreen('preview')}>BACK</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
