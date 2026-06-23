// engine.mjs — rota motorunun cekirdegi
// Canli Directions API'si olmadan deterministik bir model:
//   mesafe (haversine) + sehir ici dolanim katsayisi + saatlik trafik egrisi.
// Ayni girdi -> ayni cikti. Sabitler tepede; gercek olcumlerle ince ayar yapilir.

export const CONFIG = {
  detour: 1.35,        // kus ucusu -> gercek yol carpani (sehir ici)
  freeFlowKmh: 46,     // bos yol ortalama hizi (km/s)
  // trafik egrisi: taban + sabah zirvesi + aksam zirvesi (Gauss)
  traffic: {
    base: 1.0,
    morning: { center: 8.5 * 60, amp: 1.05, sigma: 75 },
    evening: { center: 18.0 * 60, amp: 1.25, sigma: 95 }
  }
};

export function haversineKm(a, b) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Belirli bir dakikadaki (00:00'dan) trafik yogunlugu carpani (>=1).
// rainBoost: yagmur varsa ek yuzde (0.15 = +%15) verilebilir.
export function congestionAt(minuteOfDay, rainBoost = 0) {
  const t = ((minuteOfDay % 1440) + 1440) % 1440;
  const g = (p) => p.amp * Math.exp(-((t - p.center) ** 2) / (2 * p.sigma ** 2));
  const c = CONFIG.traffic.base + g(CONFIG.traffic.morning) + g(CONFIG.traffic.evening);
  return c * (1 + rainBoost);
}

// Iki nokta arasi seyahat suresi (dk). depart=kalkis dakikasi.
// Sureyi orta-yol zamanindaki yogunlukla olcekler.
export function travelMinutes(a, b, depart = 12 * 60, rainBoost = 0) {
  const km = haversineKm(a, b) * CONFIG.detour;
  const freeMin = (km / CONFIG.freeFlowKmh) * 60;
  const mid = depart + freeMin / 2;
  const dur = freeMin * congestionAt(mid, rainBoost);
  return { km: round1(km), freeMin: round1(freeMin), minutes: round1(dur) };
}

const round1 = (x) => Math.round(x * 10) / 10;
const hhmm = (m) => {
  m = Math.round(((m % 1440) + 1440) % 1440);
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
};
export const fmt = { hhmm, round1 };

// 1) CIKIS SAATI TARAMASI
// from..to arasinda [startMin,endMin] penceresini stepMin adimlarla tarar,
// en kisa suren kalkisi bulur.
export function scanDeparture(from, to, opts = {}) {
  const start = opts.startMin ?? 6 * 60;
  const end = opts.endMin ?? 21 * 60;
  const step = opts.stepMin ?? 10;
  const rainBoost = opts.rainBoost ?? 0;
  const rows = [];
  let best = null;
  for (let d = start; d <= end; d += step) {
    const t = travelMinutes(from, to, d, rainBoost);
    const row = { depart: hhmm(d), departMin: d, minutes: t.minutes, arrive: hhmm(d + t.minutes) };
    rows.push(row);
    if (!best || row.minutes < best.minutes) best = row;
  }
  return { best, sampleCount: rows.length, rows };
}

// 2) DEADLINE COZUCU
// arriveByMin'e kadar varmak icin en gec kalkis saatini bulur.
export function latestDeparture(from, to, arriveByMin, opts = {}) {
  const start = opts.startMin ?? 4 * 60;
  const step = opts.stepMin ?? 5;
  const rainBoost = opts.rainBoost ?? 0;
  let latest = null;
  for (let d = start; d <= arriveByMin; d += step) {
    const t = travelMinutes(from, to, d, rainBoost);
    if (d + t.minutes <= arriveByMin) {
      latest = { depart: hhmm(d), departMin: d, minutes: t.minutes, arrive: hhmm(d + t.minutes) };
    }
  }
  return {
    arriveBy: hhmm(arriveByMin),
    latest,
    feasible: !!latest,
    note: latest ? null : "Bu pencerede deadline'a yetisen kalkis yok."
  };
}

// 3) SIRA OPTIMIZASYONU
// stops: [{name,lat,lng}]. start verilmezse ilk durak baslangic kabul edilir.
// nearest-neighbor + 2-opt. Referans saatte (refMin) hesaplar.
export function optimizeSequence(stops, opts = {}) {
  const refMin = opts.refMin ?? 12 * 60;
  const rainBoost = opts.rainBoost ?? 0;
  const fixedStart = opts.start ?? null;
  const pts = fixedStart ? [fixedStart, ...stops] : [...stops];
  const n = pts.length;
  if (n < 2) return { error: "en az 2 durak gerekli" };

  const D = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      if (i !== j) D[i][j] = travelMinutes(pts[i], pts[j], refMin, rainBoost).minutes;

  const pathMinutes = (order) => {
    let s = 0;
    for (let i = 0; i < order.length - 1; i++) s += D[order[i]][order[i + 1]];
    return round1(s);
  };

  const baseOrder = pts.map((_, i) => i); // girdi sirasi
  const baseline = pathMinutes(baseOrder);

  // nearest-neighbor (0'dan basla)
  const seen = new Set([0]);
  let nn = [0];
  while (nn.length < n) {
    const last = nn[nn.length - 1];
    let nxt = -1, bd = Infinity;
    for (let j = 0; j < n; j++)
      if (!seen.has(j) && D[last][j] < bd) { bd = D[last][j]; nxt = j; }
    nn.push(nxt); seen.add(nxt);
  }

  // 2-opt (baslangici sabit tut)
  let improved = true, order = nn.slice();
  while (improved) {
    improved = false;
    for (let i = 1; i < n - 1; i++)
      for (let k = i + 1; k < n; k++) {
        const cand = order.slice(0, i).concat(order.slice(i, k + 1).reverse(), order.slice(k + 1));
        if (pathMinutes(cand) < pathMinutes(order)) { order = cand; improved = true; }
      }
  }

  const optimized = pathMinutes(order);
  const toNames = (o) => o.map((i) => pts[i].name || `#${i}`);
  return {
    baseline: { order: toNames(baseOrder), minutes: baseline },
    optimized: { order: toNames(order), minutes: optimized },
    savedMinutes: round1(baseline - optimized),
    refTime: hhmm(refMin),
    stopCount: n
  };
}
