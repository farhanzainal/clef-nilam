// Turns clef-flash's 3 pairwise coherence scores into a 0-5 integer verdict (the rubric used by prime-app).
// clef-flash only measures how well the sections relate, so quality signals it cannot see (empty, copied, injection,
// fragments, reflection) are decided here. Constants were fitted on 100 synthetic cases (Melayu/Cina/Tamil).
const TAMIL_OFFSET = 0.8; // clef-flash scores equally good Tamil ~1 point lower than Malay/Chinese
const ACCEPT_AT = 3.0; // calibrated mean at or above this is a valid reading
const GIBBERISH_BELOW = 1.4; // calibrated mean below this is nonsense
const FRAGMENT_BELOW = 30; // weighted length of a synopsis too short to describe anything
const REFLECTION_AT = 60; // weighted length of a first-person lesson that counts as reflective

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

export function features({ title, excerpt, moral }, { titleExcerpt: te, titleMoral: tm, excerptMoral: em }) {
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
  };
}

export function calibrate({ title, excerpt, moral }, { titleExcerpt, titleMoral, excerptMoral }) {
  const raw = (titleExcerpt + titleMoral + excerptMoral) / 3;
  const flags = [];
  const done = (weightage, reason) => ({ weightage, reason, flags, raw });

  if (INJECTION.test(`${title} ${excerpt} ${moral}`)) {
    flags.push("PROMPT_INJECTION");
    return done(0, "INJECTION");
  }
  if (!norm(excerpt) || !norm(moral)) return done(0, "GIBBERISH");
  const [t, e, m] = [norm(title), norm(excerpt), norm(moral)];
  if (e === m || e === t || m === t) return done(0, "REPEATED_TEXT");

  const score = raw + (TAMIL.test(excerpt + moral) ? TAMIL_OFFSET : 0);
  if (score < GIBBERISH_BELOW) return done(0, "GIBBERISH");
  if (weight(excerpt) < FRAGMENT_BELOW) return done(1, "MEANINGLESS_CONTENT");
  if (score < ACCEPT_AT) return done(2, "WEAK_LOGIC");
  if (FIRST_PERSON.test(moral) && weight(moral) >= REFLECTION_AT) return done(5, "STRONG_REFLECTION");
  return done(sentences(excerpt) >= 2 ? 4 : 3, "GOOD_COMPREHENSION");
}
