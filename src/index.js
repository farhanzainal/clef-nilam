import { calibrate } from "./calibrate.js";

const MODEL = "@cf/cloudflare/clef";
const SUSPICIOUS_BELOW = 2;
const MAX = { title: 300, excerpt: 8000, moral: 2000 };

const SCALE = [
  "0 - Langsung tiada kaitan / bercanggah",
  "1 - Sangat lemah kaitannya",
  "2 - Lemah, banyak tidak selari",
  "3 - Sederhana selari",
  "4 - Selari",
  "5 - Sangat selari",
];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
const fail = (status, error) => json({ error }, status);

function validate(b) {
  if (!b || typeof b !== "object") return "Body mesti JSON object";
  for (const k of ["title", "excerpt", "moral"]) {
    if (typeof b[k] !== "string" || !b[k].trim()) return `Medan '${k}' wajib dan mesti string tidak kosong`;
    if (b[k].length > MAX[k]) return `Medan '${k}' melebihi ${MAX[k]} aksara`;
  }
  if (b.declaredLanguage != null && (typeof b.declaredLanguage !== "string" || b.declaredLanguage.length > 50))
    return "Medan 'declaredLanguage' mesti string (maks 50 aksara)";
  return null;
}

const pair = (a, b) =>
  `Nilai tahap keselarian antara ${a} dan ${b} bagi bahan bacaan ini. 0 = langsung tiada kaitan atau bercanggah (mungkin palsu/spam), 5 = sangat selari.`;

function buildQuestions(declaredLanguage) {
  const q = {
    title_excerpt: { type: "score", instructions: pair("TAJUK", "SINOPSIS"), criteria: SCALE },
    title_moral: { type: "score", instructions: pair("TAJUK", "PENGAJARAN"), criteria: SCALE },
    excerpt_moral: { type: "score", instructions: pair("SINOPSIS", "PENGAJARAN"), criteria: SCALE },
  };
  const one = (instructions) => ({ type: "score", instructions, criteria: SCALE });
  q.reflection = one("Adakah PENGAJARAN menunjukkan refleksi peribadi, iaitu penulis mengaitkan pengajaran dengan hidupnya sendiri? 0 = tiada langsung, 5 = sangat reflektif.");
  q.events = one("Adakah SINOPSIS menceritakan peristiwa atau idea utama dengan ayat yang jelas, bukan senarai perkataan atau aksara rawak? 0 = tidak langsung, 5 = sangat jelas.");
  q.meaningful = one("Adakah keseluruhan teks (tajuk, sinopsis, pengajaran) ayat yang bermakna dan lengkap, bukan aksara rawak, simbol atau perkataan berulang? 0 = tidak bermakna, 5 = sangat bermakna.");
  if (declaredLanguage)
    q.language_match = {
      type: "noul",
      instructions: `Adakah sinopsis dan pengajaran ditulis dalam bahasa "${declaredLanguage}"?`,
    };
  return q;
}

// Skor 0-5 dari jawapan model. Terima taburan kebarangkalian {label|index: p}, array, atau nilai terus.
function toScore(ans) {
  if (ans == null) return null;
  if (typeof ans === "number") return ans >= 0 && ans <= 5 ? ans : null;
  const dist = ans.probabilities ?? ans.distribution ?? ans.scores ?? ans.options;
  const src = dist ?? (typeof ans === "object" ? ans : null);
  let entries = null;
  if (Array.isArray(src) && src.every((x) => typeof x === "number")) entries = src.map((p, i) => [i, p]);
  else if (src && typeof src === "object")
    entries = Object.entries(src)
      .filter(([, p]) => typeof p === "number")
      .map(([k, p]) => [parseInt(k, 10), p]);
  if (entries?.length && entries.every(([i]) => i >= 0 && i <= 5)) {
    const total = entries.reduce((s, [, p]) => s + p, 0) || 1;
    return entries.reduce((s, [i, p]) => s + i * (p / total), 0);
  }
  const direct = ans.answer ?? ans.value ?? ans.index ?? ans.label;
  const n = typeof direct === "string" ? parseInt(direct, 10) : direct;
  return Number.isFinite(n) && n >= 0 && n <= 5 ? n : null;
}

function toYes(ans) {
  if (typeof ans === "boolean") return ans;
  const p = ans?.probabilities ?? ans?.distribution ?? ans;
  const y = p?.yes ?? p?.true ?? ans?.probability;
  return typeof y === "number" ? y >= 0.5 : (ans?.answer ?? ans?.value ?? null);
}

const r1 = (n) => Math.round(n * 10) / 10;
const r1o = (ans) => {
  const n = toScore(ans);
  return n == null ? null : r1(n);
};

async function evaluate(env, b) {
  const declared = b.declaredLanguage?.trim() || null;
  const res = await env.AI.run(MODEL, {
    model: "clef",
    state: { title: b.title.trim(), excerpt: b.excerpt.trim(), moral: b.moral.trim() },
    questions: buildQuestions(declared),
  });
  const a = res.answers ?? {};
  const scores = {
    titleExcerpt: toScore(a.title_excerpt),
    titleMoral: toScore(a.title_moral),
    excerptMoral: toScore(a.excerpt_moral),
  };
  if (Object.values(scores).some((s) => s == null))
    return { error: "Format jawapan model tidak dikenali", raw: res };

  const cal = calibrate(b, scores);
  const languageMatch = declared ? toYes(a.language_match) : null;
  const weightage = languageMatch === false ? Math.max(0, cal.weightage - 1) : cal.weightage;

  return {
    weightage,
    score: r1(cal.raw),
    reason: cal.reason,
    flags: cal.flags,
    suspicious: weightage < SUSPICIOUS_BELOW,
    extra: { reflection: r1o(a.reflection), events: r1o(a.events), meaningful: r1o(a.meaningful) },
    breakdown: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, r1(v)])),
    languageMatch,
    usage: res.usage,
  };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS")
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-allow-methods": "POST, OPTIONS",
        },
      });
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname !== "/v1/verify" || req.method !== "POST") return fail(404, "Guna POST /v1/verify");

    if (!env.API_KEY || req.headers.get("authorization") !== `Bearer ${env.API_KEY}`)
      return fail(401, "API key tidak sah");

    let body;
    try {
      body = await req.json();
    } catch {
      return fail(400, "Body bukan JSON yang sah");
    }
    const err = validate(body);
    if (err) return fail(400, err);

    try {
      const out = await evaluate(env, body);
      return json(out, out.error ? 502 : 200);
    } catch (e) {
      return fail(502, `Panggilan model gagal: ${e.message}`);
    }
  },
};
