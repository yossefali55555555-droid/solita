import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/**
 * QR code drawn as crisp SVG squares (error correction M, two-module
 * quiet zone), so it prints sharply at any size.
 */
export function QrSvg({ text, size = '30mm', title }) {
  const { count, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < n; c += 1) {
        if (qr.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
      }
    }
    return { count: n + 4, path: d };
  }, [text]);
  return (
    <svg
      viewBox={`0 0 ${count} ${count}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      role="img"
      aria-label={title || text}
    >
      <rect width={count} height={count} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
