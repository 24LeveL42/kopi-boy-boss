/**
 * Turns a user-supplied "where to go next" value into a same-site path.
 * Anything doubtful becomes "/". Never returns the raw input: the result is
 * re-built from a parsed URL whose origin was checked.
 *
 * Pure module so `node --test` can load it.
 */

const FALLBACK = "/";
const MAX_LENGTH = 2048;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/**
 * Control characters, whitespace (browsers strip tab/newline inside URLs, so
 * "/<tab>/evil.com" would become "//evil.com") and backslashes (read as "/").
 * Checked by character code so no invisible character hides in the source.
 */
function hasUnsafeChar(path: string): boolean {
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c <= 0x20) return true; // C0 controls + space
    if (c >= 0x7f && c <= 0xa0) return true; // DEL, C1 controls, no-break space
    if (c === 0x5c) return true; // backslash
    if (c === 0x1680 || (c >= 0x2000 && c <= 0x200f) || (c >= 0x2028 && c <= 0x202f)) return true;
    if (c === 0x205f || c === 0x3000 || c === 0xfeff) return true;
  }
  return false;
}

/** One raw form is acceptable on its own (no decoding involved). */
function looksSafe(path: string): boolean {
  if (!path.startsWith("/")) return false; // relative-to-nothing, "evil.com", "@evil.com", schemes
  if (path.startsWith("//")) return false; // protocol-relative: //evil.com
  if (hasUnsafeChar(path)) return false;
  if (SCHEME.test(path.slice(1))) return false; // "/javascript:..." is harmless as a path, but refuse it anyway
  return true;
}

export function safeRedirectPath(raw: unknown, origin: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LENGTH) return FALLBACK;

  // Check the raw value and every decoded form of it, so %2F%2F, %5C and
  // double-encoded tricks are caught too. Malformed encoding is refused.
  let current = raw;
  for (let i = 0; i < 4; i++) {
    if (!looksSafe(current)) return FALLBACK;
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return FALLBACK;
    }
    if (decoded === current) break;
    current = decoded;
    if (i === 3) return FALLBACK; // still decoding after 4 rounds: refuse
  }

  let url: URL;
  let base: URL;
  try {
    base = new URL(origin);
    url = new URL(raw, base);
  } catch {
    return FALLBACK;
  }
  if (url.origin !== base.origin) return FALLBACK;
  if (url.pathname.startsWith("/auth/callback")) return FALLBACK; // no loop back into the sign-in step

  return `${url.pathname}${url.search}${url.hash}`;
}
