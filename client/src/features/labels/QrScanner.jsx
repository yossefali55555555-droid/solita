import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui.jsx';

const SAME_CODE_PAUSE_MS = 2500;

async function makeDetector() {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return null;
  try {
    const formats = await window.BarcodeDetector.getSupportedFormats();
    if (!formats.includes('qr_code')) return null;
    return new window.BarcodeDetector({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

/**
 * Camera QR scanner with a typed fallback. Uses the browser BarcodeDetector
 * when available and jsQR otherwise (iPhone Safari). Calls onCode(text) once
 * per code; the same code is ignored for a moment to avoid double scans.
 */
export function QrScanner({ onCode, busy = false, autoStart = true, compact = false }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const lastRef = useRef({ text: '', at: 0 });
  const onCodeRef = useRef(onCode);
  const busyRef = useRef(busy);
  const [active, setActive] = useState(autoStart);
  const [attempt, setAttempt] = useState(0);
  const [cameraError, setCameraError] = useState('');
  const [typed, setTyped] = useState('');

  useEffect(() => {
    onCodeRef.current = onCode;
    busyRef.current = busy;
  });

  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    let timer = null;

    const emit = (text) => {
      const now = Date.now();
      if (busyRef.current) return;
      if (text === lastRef.current.text && now - lastRef.current.at < SAME_CODE_PAUSE_MS) return;
      lastRef.current = { text, at: now };
      if (navigator.vibrate) navigator.vibrate(80);
      onCodeRef.current(text);
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError('الكاميرا غير متاحة في هذا المتصفح — اكتب الكود يدويًا');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        video.srcObject = stream;
        await video.play();
      } catch {
        setCameraError('تعذر فتح الكاميرا — اسمح للموقع باستخدام الكاميرا أو اكتب الكود يدويًا');
        return;
      }
      const detector = await makeDetector();
      // jsQR is only downloaded on browsers without a native QR detector.
      const jsQR = detector ? null : (await import('jsqr')).default;
      const tick = async () => {
        if (stopped) return;
        const video = videoRef.current;
        if (video && video.readyState >= 2) {
          try {
            if (detector) {
              const codes = await detector.detect(video);
              if (codes[0]?.rawValue) emit(codes[0].rawValue);
            } else {
              const canvas = canvasRef.current;
              const w = video.videoWidth;
              const h = video.videoHeight;
              const scale = Math.min(1, 640 / Math.max(w, h));
              canvas.width = Math.round(w * scale);
              canvas.height = Math.round(h * scale);
              const ctx = canvas.getContext('2d', { willReadFrequently: true });
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const found = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
              if (found?.data) emit(found.data);
            }
          } catch {
            /* a frame that cannot be read is skipped */
          }
        }
        timer = setTimeout(tick, 180);
      };
      tick();
    })();

    return () => {
      stopped = true;
      clearTimeout(timer);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [active, attempt]);

  const submitTyped = (e) => {
    e.preventDefault();
    const text = typed.trim();
    if (!text || busy) return;
    lastRef.current = { text, at: Date.now() };
    onCode(text.toUpperCase().startsWith('SOL:') ? text : `SOL:${text}`);
    setTyped('');
  };

  return (
    <div className={`qr-scanner ${compact ? 'qr-scanner--compact' : ''}`}>
      {active && !cameraError && (
        <div className="qr-scanner__view">
          <video ref={videoRef} playsInline muted />
          <span className="qr-scanner__frame" aria-hidden="true" />
        </div>
      )}
      <canvas ref={canvasRef} hidden />
      {cameraError && <p className="alert alert--warning">{cameraError}</p>}
      <div className="qr-scanner__row">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            if (cameraError) {
              setCameraError('');
              setActive(true);
              setAttempt((n) => n + 1);
            } else setActive((v) => !v);
          }}
        >
          {active && !cameraError ? 'إيقاف الكاميرا' : 'فتح الكاميرا'}
        </Button>
      </div>
      <form className="qr-scanner__manual" onSubmit={submitTyped}>
        <input
          className="input mono"
          dir="ltr"
          placeholder="SOL:24-1/2"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          aria-label="كود الطرد"
          autoComplete="off"
        />
        <Button type="submit" size="sm" loading={busy}>إدخال</Button>
      </form>
    </div>
  );
}
