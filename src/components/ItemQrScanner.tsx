import { useCallback, useEffect, useRef, useState } from 'react'
import type QrScanner from 'qr-scanner'
import { itemCodeFromQrValue } from '../lib/packing'

interface BarcodeResult { rawValue?: string }
interface BarcodeDetectorLike { detect(source: HTMLVideoElement): Promise<BarcodeResult[]> }
interface BarcodeDetectorConstructor {
  new (options: { formats: string[] }): BarcodeDetectorLike
  getSupportedFormats?(): Promise<string[]>
}

declare global {
  interface Window { BarcodeDetector?: BarcodeDetectorConstructor }
}

interface Props {
  onCode: (itemCode: string) => void
  compact?: boolean
}

// Desktop/PC Chrome and Edge often expose window.BarcodeDetector, but on many
// Windows installs the underlying 'qr_code' format only works after a separate
// "Barcode Detection" component downloads — until then detect() runs forever
// without ever finding a code, so the camera opens but scanning silently never
// works. getSupportedFormats() reports the truth; if it's missing or doesn't
// list qr_code, fall back to the qr-scanner library (a JS decoder that works
// everywhere, mobile included) instead of trusting the constructor's mere
// existence. Mobile Chrome/Android reliably supports qr_code natively, so this
// keeps using the fast native path there — only desktop gaps fall back.
async function nativeQrDetectionAvailable(): Promise<boolean> {
  if (!window.BarcodeDetector) return false
  try {
    const formats = await window.BarcodeDetector.getSupportedFormats?.()
    return !formats || formats.includes('qr_code')
  } catch {
    return false
  }
}

// Desktop/PC webcams have no rear-facing camera, and some browser/driver
// combinations throw instead of gracefully ignoring an unsatisfiable `ideal`
// (non-mandatory) facingMode constraint. Retry unconstrained so any available
// camera (built-in webcam, USB camera) still opens.
async function acquireCameraStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } })
  } catch {
    return await navigator.mediaDevices.getUserMedia({ audio: false, video: true })
  }
}

export default function ItemQrScanner({ onCode, compact = false }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const fallbackScannerRef = useRef<QrScanner | null>(null)
  const frameRef = useRef<number | null>(null)
  const runIdRef = useRef(0)
  const lastValueRef = useRef('')
  const [running, setRunning] = useState(false)
  const [manualCode, setManualCode] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [torchSupported, setTorchSupported] = useState(false)
  const [torchOn, setTorchOn] = useState(false)

  const stopCamera = useCallback(() => {
    runIdRef.current += 1
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    fallbackScannerRef.current?.stop()
    fallbackScannerRef.current?.destroy()
    fallbackScannerRef.current = null
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setTorchSupported(false)
    setTorchOn(false)
    setRunning(false)
  }, [])

  useEffect(() => stopCamera, [stopCamera])

  const completeScan = useCallback((rawValue: string) => {
    const itemCode = itemCodeFromQrValue(rawValue)
    if (!itemCode || itemCode === lastValueRef.current) return
    lastValueRef.current = itemCode
    setSuccess(`Item ${itemCode} scanned.`)
    stopCamera()
    onCode(itemCode)
  }, [onCode, stopCamera])

  async function startCamera() {
    setError('')
    setSuccess('')
    lastValueRef.current = ''
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Camera scanning is not available in this browser. Enter the Item Code below.')
      return
    }

    try {
      stopCamera()
      const runId = runIdRef.current
      const video = videoRef.current
      if (!video) return

      if (!(await nativeQrDetectionAvailable())) {
        const { default: QrScannerFallback } = await import('qr-scanner')
        if (runId !== runIdRef.current) return
        const scanner = new QrScannerFallback(
          video,
          result => completeScan(typeof result === 'string' ? result : result.data),
          {
            preferredCamera: 'environment',
            highlightScanRegion: true,
            highlightCodeOutline: true,
            returnDetailedScanResult: true,
          },
        )
        fallbackScannerRef.current = scanner
        await scanner.start()
        if (runId !== runIdRef.current) { scanner.destroy(); return }
        scanner.hasFlash().then(setTorchSupported).catch(() => setTorchSupported(false))
        setRunning(true)
        return
      }

      const stream = await acquireCameraStream()
      if (runId !== runIdRef.current) { stream.getTracks().forEach(track => track.stop()); return }
      streamRef.current = stream
      video.srcObject = stream
      await video.play()
      const capabilities = stream.getVideoTracks()[0]?.getCapabilities() as MediaTrackCapabilities & { torch?: boolean }
      setTorchSupported(Boolean(capabilities?.torch))
      setRunning(true)
      const detector = new window.BarcodeDetector!({ formats: ['qr_code'] })

      const scanFrame = async () => {
        const video = videoRef.current
        if (!streamRef.current || !video) return
        try {
          if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            const results = await detector.detect(video)
            const rawValue = results.find(result => result.rawValue)?.rawValue
            if (rawValue) { completeScan(rawValue); return }
          }
        } catch {
          // A single decode miss is normal; keep the same camera stream alive.
        }
        frameRef.current = requestAnimationFrame(scanFrame)
      }
      frameRef.current = requestAnimationFrame(scanFrame)
    } catch (cause) {
      stopCamera()
      const name = cause instanceof DOMException ? cause.name : ''
      setError(
        name === 'NotAllowedError' ? 'Camera permission was denied. Allow camera access or enter the Item Code below.'
        : name === 'NotFoundError' ? 'No camera was found on this device. Enter the Item Code below.'
        : 'Camera could not be opened. Check that another app is not using it, or enter the Item Code below.'
      )
    }
  }

  function submitManual(event: React.FormEvent) {
    event.preventDefault()
    const itemCode = itemCodeFromQrValue(manualCode)
    if (!itemCode) { setError('Enter an Item Code, tracking number, or customer name.'); return }
    setSuccess('')
    onCode(itemCode)
  }

  async function toggleTorch() {
    try {
      if (fallbackScannerRef.current) {
        await fallbackScannerRef.current.toggleFlash()
        setTorchOn(fallbackScannerRef.current.isFlashOn())
        return
      }
      const track = streamRef.current?.getVideoTracks()[0]
      if (!track) return
      const next = !torchOn
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] })
      setTorchOn(next)
    } catch {
      setError('Flash is not available on this device.')
    }
  }

  return (
    <div className="space-y-3">
      <div className={`relative overflow-hidden rounded-xl bg-slate-950 ${compact ? 'min-h-48' : 'min-h-64'}`}>
        <video ref={videoRef} muted playsInline className={`w-full bg-black object-contain ${compact ? 'h-48' : 'h-[min(55dvh,420px)] min-h-64'} ${running ? 'block' : 'hidden'}`} />
        {!running && <div className={`flex flex-col items-center justify-center px-5 text-center ${compact ? 'h-48' : 'h-64'}`}><QrIcon /><p className="mt-3 text-sm font-semibold text-white">Scan Item QR</p><p className="mt-1 text-xs text-slate-400">Hold the sticker inside the frame — works with a phone's rear camera or a PC/desktop webcam.</p></div>}
        {running && <div className="pointer-events-none absolute inset-5 rounded-xl border-2 border-white/80 shadow-[0_0_0_999px_rgba(0,0,0,0.18)]" />}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <button type="button" onClick={running ? stopCamera : startCamera} className="primary-button min-h-11 flex-1">{running ? 'Cancel Scan' : 'Open Camera'}</button>
        {running && torchSupported && <button type="button" onClick={toggleTorch} className="secondary-button min-h-11">{torchOn ? 'Turn Flash Off' : 'Turn Flash On'}</button>}
      </div>
      {error && <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{error}</div>}
      {success && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">{success}</div>}
      <form onSubmit={submitManual} className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <input value={manualCode} onChange={event => setManualCode(event.target.value)} placeholder="Item Code, tracking #, or customer" className="form-input flex-1" />
        <button className="secondary-button min-h-11" type="submit">Find Item</button>
      </form>
    </div>
  )
}

function QrIcon() {
  return <svg className="size-12 text-white/80" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4h5v5H4V4zm11 0h5v5h-5V4zM4 15h5v5H4v-5zm11 0h2v2h-2v-2zm4 0h1v5h-5v-1m0-3h2m-5-4h2m3 0h3" /></svg>
}
