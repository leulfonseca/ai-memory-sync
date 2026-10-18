// Sensitive-data scrubber. Replaces matches with [REDACTED:<kind>] and never throws.
// Idempotent: scrubbing already-scrubbed text returns it unchanged.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const R = (kind) => `[REDACTED:${kind}]`;

/** Shannon entropy in bits per character. */
export function entropy(s) {
  const freq = new Map();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Looks like a random credential: long, high entropy, mixed character classes. */
function looksRandom(v) {
  if (v.length < 20) return false;
  if (/^[0-9a-f]{32,}$/i.test(v)) return true; // hex secrets / hashes next to a key word
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(v)).length;
  return classes >= 3 && entropy(v) >= 3.5;
}

// Order matters: multi-line and most specific patterns first.
const PATTERNS = [
  ["private-key", /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g],
  ["private-key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[^\n]*/g],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{16,}/g],
  ["stripe-key", /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}/g],
  ["openai-key", /\bsk-(?:proj-|svcacct-|admin-)?(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{20,}/g],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}/g],
  ["aws-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["hs-key", /\bhso?_(?=[A-Za-z_-]*\d)[A-Za-z0-9_-]{16,}/g],
  ["google-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g],
];

const URL_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@?#\[\]]+):([^\s@/?#]+)@/gi;
const BEARER = /\b(Bearer)\s+(?!\[REDACTED)(?=[A-Za-z._~+/=-]*\d)[A-Za-z0-9._~+/-]{8,}=*/g;
const ASSIGN =
  /(?<![A-Za-z0-9])(password|passwd|pwd|secret|client[_-]?secret|token|access[_-]?token|auth[_-]?token|refresh[_-]?token|api[_-]?key|apikey|[a-z0-9]+[_-]key|senha|chave)(["']?[ \t]*[:=][ \t]*)(["'`]?)([^\s"'`,;)]+)\3/gi;
const NEAR_KEYWORD =
  /(?<![A-Za-z0-9])(key|keys|secret|secrets|token|tokens|credential|credentials|password|senha|chave|apikey)\b([^\n]{0,40}?)(?<![A-Za-z0-9+/_=-])([A-Za-z0-9+/_=-]{20,})/gi;
const EMAIL = /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;
const PHONE =
  /(?<![\w+\]])(?:\+\d{1,3}[ .-]?(?:\(\d{1,4}\)|\d{1,4})[ .-]?\d{3,5}[ .-]?\d{3,4}|\(\d{2,3}\) ?\d{4,5}[ .-]?\d{4})(?![\w-])/g;

const SKIP_VALUES = /^(true|false|null|nil|none|undefined|required|optional|string|number|boolean|object|redacted|example|placeholder|x{3,}|\*+|\.{3}|…)$/i;

function acceptAssignedValue(v, quoted) {
  if (v.startsWith("[REDACTED")) return false;
  if (/^[$<{%[(]/.test(v) || /^process\.env/.test(v)) return false;
  if (SKIP_VALUES.test(v)) return false;
  if (v.length < (quoted ? 4 : 6)) return false;
  if (/^(\.{3}|…)/.test(v)) return false; // "apiKey=..." placeholder
  if (/^[a-z]+$/.test(v) || (/^[A-Za-z]+$/.test(v) && v.length < 8)) return false; // a plain word: prose, not a secret
  return true;
}

/**
 * Scrub `text`. `literals` is a list of exact strings (e.g. .env values) to redact.
 * Returns { text, counts } where counts maps kind → number of replacements.
 */
export function scrub(text, literals = []) {
  const counts = {};
  const hit = (kind) => (counts[kind] = (counts[kind] ?? 0) + 1);
  let out = String(text ?? "");
  try {
    for (const [kind, re] of PATTERNS.slice(0, 2)) out = out.replace(re, () => (hit(kind), R(kind)));
    // .env literals, longest first so overlapping values redact fully.
    for (const lit of [...new Set(literals)].sort((a, b) => b.length - a.length)) {
      if (!lit || lit.length < 8) continue;
      const parts = out.split(lit); // split/join: no regex escaping needed
      if (parts.length > 1) {
        counts.env = (counts.env ?? 0) + parts.length - 1;
        out = parts.join(R("env"));
      }
    }
    for (const [kind, re] of PATTERNS.slice(2)) out = out.replace(re, () => (hit(kind), R(kind)));
    out = out.replace(URL_CREDS, (m, scheme, user) =>
      user === "[REDACTED" ? m : (hit("url-credentials"), `${scheme}${R("credentials")}@`),
    );
    out = out.replace(BEARER, (m, b) => (hit("bearer"), `${b} ${R("bearer")}`));
    out = out.replace(ASSIGN, (m, key, sep, q, val) => {
      if (!acceptAssignedValue(val, Boolean(q))) return m;
      hit("secret");
      return `${key}${sep}${q}${R("secret")}${q}`;
    });
    out = out.replace(NEAR_KEYWORD, (m, kw, mid, val) => {
      if (!looksRandom(val) || /REDACTED/.test(val)) return m;
      hit("high-entropy");
      return `${kw}${mid}${R("high-entropy")}`;
    });
    out = out.replace(EMAIL, (m, local, domain) =>
      /^(git|no-?reply)$/i.test(local) || /(^|\.)users\.noreply\.github\.com$/i.test(domain) ? m : (hit("email"), R("email")),
    );
    out = out.replace(PHONE, (m) => {
      if (m.replace(/\D/g, "").length < 10) return m;
      hit("phone");
      return R("phone");
    });
  } catch {
    // Never abort: return what we have.
  }
  return { text: out, counts };
}

const ENV_FILE = /^(\.env(\..+)?|\.dev\.vars)$/;

// Values of these keys ship to the browser by design, so they are not secrets.
const PUBLIC_KEY = /^(NEXT_PUBLIC_|PUBLIC_|VITE_|EXPO_PUBLIC_|NUXT_PUBLIC_|REACT_APP_|GATSBY_)/;

/** Read literal values from the project's .env* files (never printed). `allowKeys` skips named keys. */
export function envLiterals(root, allowKeys = []) {
  const allow = new Set(allowKeys);
  const values = [];
  let names = [];
  try {
    names = readdirSync(root).filter((f) => ENV_FILE.test(f));
  } catch {
    return values;
  }
  for (const name of names) {
    let raw = "";
    try {
      const p = join(root, name);
      if (!existsSync(p)) continue;
      raw = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
      if (!m || PUBLIC_KEY.test(m[1]) || allow.has(m[1])) continue;
      let v = m[2].trim();
      const q = v[0];
      if ((q === '"' || q === "'") && v.lastIndexOf(q) > 0) v = v.slice(1, v.lastIndexOf(q));
      else v = v.replace(/\s+#.*$/, "");
      if (v.length < 8) continue;
      if (/^(true|false|null|-?\d+(\.\d+)?)$/i.test(v)) continue;
      if (/^[a-z][a-z_-]*$/.test(v) && v.length < 20) continue; // development, production, us-east...
      if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)([:/]|$)/i.test(v) && !/@/.test(v)) continue;
      if (/^\$\{?[A-Za-z_]/.test(v)) continue;
      values.push(v);
    }
  }
  return values;
}

export function mergeCounts(into, from) {
  for (const [k, n] of Object.entries(from)) into[k] = (into[k] ?? 0) + n;
  return into;
}
