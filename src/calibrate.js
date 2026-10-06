// Turns clef's pairwise coherence and quality scores into a 0-5 integer verdict (the rubric used by prime-app).
// Clef only measures how well the sections relate, so empty, copied and injected text is decided by rules here;
// everything else goes to a small gradient-boosted model (model.json) trained to reproduce GPT-6 Luna's score from
// clef's scores plus text features (length, repetition, overlap, first-person). See scripts in the repo history.
import MODEL from "./model.json" with { type: "json" };

const CJK = /[㐀-鿿]/gu;
const CONTENT = /[\p{L}\p{M}\p{N}]/gu;
const HAS_CONTENT = /[\p{L}\p{M}\p{N}]/u;
const TAMIL = /[஀-௿]/u;
const FIRST_PERSON = /(?<![\p{L}])(saya|aku|kami|i|my)(?![\p{L}])|我|நான்|எனக்கு|என்(?![\p{L}\p{M}])/iu;
const INJECTION =
  /(ignore|abaikan|disregard|忽略|புறக்கணி)[^.。\n]{0,40}(instruction|arahan|指令|அறிவுரை)|(beri|give)[^.。\n]{0,20}(markah|score|mark)|给我\s*\d\s*分|\d\s*மதிப்பெண்\s*கொடு/iu;

// CJK characters carry about 3x the information of a Latin letter.
const weight = (s) => (s.match(CONTENT)?.length ?? 0) + 2 * (s.match(CJK)?.length ?? 0);
const norm = (s) => (s.match(CONTENT) ?? []).join("").toLowerCase();
const sentences = (s) => s.split(/[.!?。！？]+/u).filter((x) => HAS_CONTENT.test(x)).length;

const SYMBOL = /[^\p{L}\p{M}\s.,!?;:'"()。，！？；：、“”‘’\-]/gu;
const bigrams = (s) => {
  const n = norm(s);
  const set = new Set();
  for (let i = 0; i < n.length - 1; i++) set.add(n.slice(i, i + 2));
  return set;
};
const jaccard = (a, b) => {
  const [x, y] = [bigrams(a), bigrams(b)];
  let both = 0;
  for (const g of x) if (y.has(g)) both++;
  return x.size + y.size - both ? both / (x.size + y.size - both) : 0;
};
const ratio = (part, whole) => (whole ? part / whole : 0);

export function features({ title, excerpt, moral }, { titleExcerpt: te, titleMoral: tm, excerptMoral: em }, extra = {}) {
  const tamil = TAMIL.test(excerpt + moral) ? 1 : 0;
  const zh = CJK.test(excerpt + moral) ? 1 : 0;
  CJK.lastIndex = 0;
  const mean = (te + tm + em) / 3;
  return {
    te, tm, em, mean, min: Math.min(te, tm, em), max: Math.max(te, tm, em), tamil, zh,
    exW: Math.log1p(weight(excerpt)), moW: Math.log1p(weight(moral)), tiW: Math.log1p(weight(title)),
    sent: Math.min(sentences(excerpt), 5), fp: FIRST_PERSON.test(moral) ? 1 : 0,
    ratio: Math.log1p(weight(moral)) - Math.log1p(weight(excerpt)),
    sym: ratio((excerpt + moral).match(SYMBOL)?.length ?? 0, (excerpt + moral).length),
    ovTE: jaccard(title, excerpt), ovTM: jaccard(title, moral), ovEM: jaccard(excerpt, moral),
    uniq: ratio(bigrams(excerpt).size, Math.max(1, norm(excerpt).length - 1)),
    avgSent: Math.log1p(weight(excerpt) / Math.max(1, sentences(excerpt))),
    tiRep: Math.min(3, norm(excerpt).split(norm(title)).length - 1),
    rf: extra.reflection ?? 0, ev: extra.events ?? 0, mn: extra.meaningful ?? 0,
  };
}

const REASONS = ["GIBBERISH", "MEANINGLESS_CONTENT", "WEAK_LOGIC", "BASIC_COMPREHENSION", "GOOD_COMPREHENSION", "STRONG_REFLECTION"];

function predict(x) {
  const raw = [...MODEL.init];
  for (const stage of MODEL.trees)
    stage.forEach((t, c) => {
      let n = 0;
      while (t.l[n] !== -1) n = x[t.f[n]] <= t.t[n] ? t.l[n] : t.r[n];
      raw[c] += t.v[n];
    });
  return MODEL.classes[raw.indexOf(Math.max(...raw))];
}

export function calibrate(input, scores, extra = {}) {
  const { title, excerpt, moral } = input;
  const raw = (scores.titleExcerpt + scores.titleMoral + scores.excerptMoral) / 3;
  const flags = [];
  const done = (weightage, reason) => ({ weightage, reason, flags, raw });

  if (INJECTION.test(`${title} ${excerpt} ${moral}`)) {
    flags.push("PROMPT_INJECTION");
    return done(0, "INJECTION");
  }
  if (!norm(excerpt) || !norm(moral)) return done(0, "GIBBERISH");
  const [t, e, m] = [norm(title), norm(excerpt), norm(moral)];
  if (e === m || e === t || m === t) return done(0, "REPEATED_TEXT");

  const f = features(input, scores, extra);
  const weightage = predict(MODEL.keys.map((k) => f[k]));
  return done(weightage, REASONS[weightage]);
}
