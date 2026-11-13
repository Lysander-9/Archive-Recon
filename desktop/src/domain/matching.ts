/** Host/subdomain matching and interesting-path patterns (behavior reference: Python baseline). */

const INTERESTING_PATTERNS: RegExp[] = [
  /\.bak$/i, /\.backup$/i, /\.old$/i, /\.swp$/i, /\.save$/i,
  /\.sql$/i, /\.sql\.gz$/i, /\.db$/i, /\.sqlite$/i,
  /\.zip$/i, /\.tar$/i, /\.gz$/i, /\.7z$/i, /\.rar$/i,
  /\.env$/i, /\.ini$/i, /\.config$/i, /\.conf$/i,
  /\.log$/i, /\.git\/config$/i, /\.git\/HEAD$/i,
  /\.htaccess$/i, /\.htpasswd$/i,
  /wp-config\.php$/i, /wp-config\.bak$/i,
  /\.pem$/i, /\.key$/i, /\.crt$/i, /\.cer$/i,
  /\.DS_Store$/i, /\.svn\//i, /Thumbs\.db$/i,
  /\/admin\/?$/i, /\/wp-admin\/?$/i, /\/phpmyadmin\/?$/i,
  /\/\.git\/?$/i, /\/\.env\/?$/i,
];

export function isInterestingUrl(url: string): boolean {
  if (!url) return false;
  return INTERESTING_PATTERNS.some((pattern) => pattern.test(url));
}

export function extractHostname(url: string): string {
  if (!url) return "";
  try {
    return new URL(url.includes("://") ? url : `http://${url}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function matchDomainPattern(hostname: string, pattern: string): boolean {
  const host = (hostname || "").toLowerCase();
  let candidate = (pattern || "").trim().toLowerCase();
  candidate = candidate.replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/^\*\./, "");
  if (!host || !candidate) return false;
  return host === candidate || host.endsWith(`.${candidate}`);
}

export function matchDomainPatterns(
  url: string,
  includePatterns: string[],
  excludePatterns: string[],
): boolean {
  const hostname = extractHostname(url);
  if (!hostname) return true;
  for (const pattern of excludePatterns) {
    if (matchDomainPattern(hostname, pattern)) return false;
  }
  if (includePatterns.length === 0) return true;
  return includePatterns.some((pattern) => matchDomainPattern(hostname, pattern));
}

const DOMAIN_COUNT_SUFFIX = /\s*\(\d+\)\s*$/;

export function stripDomainCountSuffix(value: string): string {
  return (value || "").replace(DOMAIN_COUNT_SUFFIX, "").trim();
}

export function splitTerms(raw: string): { includes: string[]; excludes: string[] } {
  const includes: string[] = [];
  const excludes: string[] = [];
  for (const part of (raw || "").split(",")) {
    const term = part.trim();
    if (!term) continue;
    if (term.startsWith("!")) {
      const value = term.slice(1).trim();
      if (value) excludes.push(value);
    } else {
      includes.push(term);
    }
  }
  return { includes, excludes };
}
