/** A short readable device name from a User-Agent, e.g. "Chrome على Windows" (no raw user agent is shown or logged). */
export function deviceLabel(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return 'جهاز غير معروف';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'متصفح';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'نظام غير معروف';
  return `${browser} على ${os}`;
}
