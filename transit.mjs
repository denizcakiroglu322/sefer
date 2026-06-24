// transit.mjs — cok-modlu ulasim modeli (toplu tasima)
// Curated realistic subset, hardcoded — swappable for İBB GTFS later (same pattern as the
// synthetic traffic curve). Headways/first-last are realistic approximations; fares verified
// for İstanbul Feb 2026 tariff.
//
// Hatlar: Marmaray (TCDD, mesafe-bazli), M2/M4 (İBB metro, duz), Vapur (İBB, duz).
// Cekirdek: transitLeg(from,to,departMin) -> o saatte o origin-destination icin en iyi tahmin.

import { haversineKm, fmt } from "./engine.mjs";

const WALK_KMH = 5;                 // yuruyus hizi
const ACCESS_WALK_MAX_KM = 1.6;     // bir duraga yuruyup binmek icin makul azami mesafe
const TRANSFER_WALK_MIN = 4;        // aktarma yuruyus suresi (dk)
const FLAT_FARE = 42;               // İstanbulkart duz ucret (metro/vapur), Şub 2026
const TRANSFER_2ND = 31.27;         // 90 dk icinde 2. binis (aktarma)
const TRANSFER_3RD_PLUS = 24.02;    // 3. ve sonrasi
const FARE_WINDOW_MIN = 90;         // aktarma penceresi

const r1 = fmt.round1;
const walkMin = (a, b) => (haversineKm(a, b) / WALK_KMH) * 60;

// PEAK = hafta ici 07:00–10:00 ve 17:00–20:00; aksi OFFPEAK. (Tarih yok -> hafta ici varsayilir.)
export function daypart(minOfDay) {
  const t = ((minOfDay % 1440) + 1440) % 1440;
  const peak = (t >= 7 * 60 && t < 10 * 60) || (t >= 17 * 60 && t < 20 * 60);
  return peak ? "PEAK" : "OFFPEAK";
}

// Marmaray mesafe ucreti: bu curated alt kumede (<=7 istasyon) kisa hop ~₺34; uzadikca ~₺75.
function marmarayFare(enIdx, exIdx) {
  const stations = Math.abs(exIdx - enIdx) + 1;
  if (stations <= 7) return 34;
  return Math.min(75, Math.round(34 + (stations - 7) * 8));
}

export const LINES = {
  marmaray: {
    id: "marmaray", name: "Marmaray", operator: "TCDD", mode: "rail",
    headway: { PEAK: 8, OFFPEAK: 15 }, first: 6 * 60, last: 24 * 60, ridePerHopMin: 3, fare: marmarayFare,
    stations: [
      { name: "Söğütlüçeşme",     lat: 40.9905, lng: 29.0353 },
      { name: "Ayrılık Çeşmesi",  lat: 40.9985, lng: 29.0265 },
      { name: "Üsküdar",          lat: 41.0255, lng: 29.0153 },
      { name: "Sirkeci",          lat: 41.0143, lng: 28.9772 },
      { name: "Yenikapı",         lat: 41.0040, lng: 28.9500 },
      { name: "Kazlıçeşme",       lat: 40.9925, lng: 28.9165 }
    ]
  },
  m2: {
    id: "m2", name: "M2", operator: "İBB", mode: "rail",
    headway: { PEAK: 4, OFFPEAK: 8 }, first: 6 * 60, last: 24 * 60, ridePerHopMin: 2.5, fare: () => FLAT_FARE,
    stations: [
      { name: "Yenikapı",           lat: 41.0040, lng: 28.9500 },
      { name: "Vezneciler",         lat: 41.0135, lng: 28.9610 },
      { name: "Haliç",              lat: 41.0240, lng: 28.9660 },
      { name: "Şişhane",            lat: 41.0285, lng: 28.9740 },
      { name: "Taksim",             lat: 41.0370, lng: 28.9855 },
      { name: "Osmanbey",           lat: 41.0490, lng: 28.9875 },
      { name: "Şişli-Mecidiyeköy",  lat: 41.0670, lng: 28.9930 },
      { name: "Gayrettepe",         lat: 41.0680, lng: 29.0070 },
      { name: "Levent",             lat: 41.0820, lng: 29.0100 },
      { name: "4.Levent",           lat: 41.0875, lng: 29.0095 },
      { name: "Sanayi",             lat: 41.0950, lng: 29.0120 },
      { name: "Seyrantepe",         lat: 41.1040, lng: 29.0050 },
      { name: "İTÜ-Ayazağa",        lat: 41.1055, lng: 29.0235 },
      { name: "Atatürk Oto Sanayi", lat: 41.1130, lng: 29.0150 },
      { name: "Darüşşafaka",        lat: 41.1180, lng: 29.0140 },
      { name: "Hacıosman",          lat: 41.1230, lng: 29.0130 }
    ]
  },
  m4: {
    id: "m4", name: "M4", operator: "İBB", mode: "rail",
    headway: { PEAK: 5, OFFPEAK: 10 }, first: 6 * 60, last: 24 * 60, ridePerHopMin: 2.5, fare: () => FLAT_FARE,
    stations: [
      { name: "Kadıköy",          lat: 40.9907, lng: 29.0245 },
      { name: "Ayrılık Çeşmesi",  lat: 40.9985, lng: 29.0265 },
      { name: "Acıbadem",         lat: 41.0010, lng: 29.0430 },
      { name: "Ünalan",           lat: 41.0030, lng: 29.0570 },
      { name: "Göztepe",          lat: 40.9810, lng: 29.0610 },
      { name: "Yenisahra",        lat: 40.9865, lng: 29.0905 },
      { name: "Kozyatağı",        lat: 40.9760, lng: 29.1015 },
      { name: "Bostancı",         lat: 40.9530, lng: 29.0950 }
    ]
  }
};

// Vapur: duz ucret, headway 25, ilk 07:00 son 21:00. Nokta-nokta (terminal) hatlar.
export const FERRY = {
  id: "ferry", name: "Vapur", operator: "İBB",
  headway: { PEAK: 25, OFFPEAK: 25 }, first: 7 * 60, last: 21 * 60, fare: () => FLAT_FARE,
  routes: [
    { name: "Kadıköy↔Beşiktaş", t1: { name: "Kadıköy", lat: 40.9907, lng: 29.0245 }, t2: { name: "Beşiktaş", lat: 41.0415, lng: 29.0080 }, rideMin: 20 },
    { name: "Üsküdar↔Eminönü",  t1: { name: "Üsküdar", lat: 41.0255, lng: 29.0153 }, t2: { name: "Eminönü",  lat: 41.0175, lng: 28.9730 }, rideMin: 15 }
  ]
};

// Aktarma noktalari (~4 dk yuruyus): istasyon, hangi hatlarda hangi index.
const TRANSFERS = [
  { station: "Ayrılık Çeşmesi", a: { line: "m4", idx: 1 },       b: { line: "marmaray", idx: 1 } },
  { station: "Yenikapı",        a: { line: "marmaray", idx: 4 }, b: { line: "m2", idx: 0 } }
];

function nearestStation(line, pt) {
  let bi = 0, bd = Infinity;
  line.stations.forEach((s, i) => { const d = haversineKm(s, pt); if (d < bd) { bd = d; bi = i; } });
  return { idx: bi, km: bd, station: line.stations[bi] };
}

// platforma varis (boardReadyMin) sonrasi ilk sefer; son seferi gectiyse null.
function nextVehicle(line, boardReadyMin) {
  const hw = line.headway[daypart(boardReadyMin)];
  if (boardReadyMin > line.last) return null;
  const dep = boardReadyMin <= line.first
    ? line.first
    : line.first + Math.ceil((boardReadyMin - line.first) / hw) * hw;
  if (dep > line.last) return null;
  return { board: dep, wait: dep - boardReadyMin };
}

// İstanbulkart 90-dk aktarma merdiveni: ilk binis tam ucret, 90 dk icindeki 2. ₺31.27, 3.+ ₺24.02.
export function applyFareLadder(boardings) {
  const sorted = boardings.slice().sort((a, b) => a.boardMin - b.boardMin);
  let total = 0, windowStart = null, idx = 0;
  for (const b of sorted) {
    if (windowStart === null || b.boardMin - windowStart > FARE_WINDOW_MIN) { windowStart = b.boardMin; idx = 0; }
    total += idx === 0 ? b.fullFare : idx === 1 ? TRANSFER_2ND : TRANSFER_3RD_PLUS;
    idx++;
  }
  return Math.round(total * 100) / 100;
}

// --- aday uretici fonksiyonlar (her biri {total,...} veya {blocked} veya null) ---
function railOption(L, from, to, departMin) {
  const en = nearestStation(L, from), ex = nearestStation(L, to);
  if (en.km > ACCESS_WALK_MAX_KM || ex.km > ACCESS_WALK_MAX_KM) return null;
  if (en.idx === ex.idx) return null;
  const accessW = walkMin(from, en.station);
  const veh = nextVehicle(L, departMin + accessW);
  if (!veh) return { blocked: L.name };
  const ride = Math.abs(ex.idx - en.idx) * L.ridePerHopMin;
  const egressW = walkMin(ex.station, to);
  return {
    total: accessW + veh.wait + ride + egressW,
    arriveMin: veh.board + ride + egressW,
    walk: accessW + egressW, ride, wait: veh.wait,
    boardings: [{ line: L.id, fullFare: L.fare(en.idx, ex.idx), boardMin: veh.board }],
    legs: [
      { mode: "walk", to: L.stations[en.idx].name, min: r1(accessW) },
      { mode: L.mode, line: L.name, from: L.stations[en.idx].name, to: L.stations[ex.idx].name, min: r1(ride) },
      { mode: "walk", from: L.stations[ex.idx].name, min: r1(egressW) }
    ],
    summary: `${L.name} (${L.stations[en.idx].name}→${L.stations[ex.idx].name})`
  };
}

function transferOptions(tp, from, to, departMin) {
  const out = [];
  for (const [L1, i1, L2, i2] of [
    [LINES[tp.a.line], tp.a.idx, LINES[tp.b.line], tp.b.idx],
    [LINES[tp.b.line], tp.b.idx, LINES[tp.a.line], tp.a.idx]
  ]) {
    const en = nearestStation(L1, from), ex = nearestStation(L2, to);
    if (en.km > ACCESS_WALK_MAX_KM || ex.km > ACCESS_WALK_MAX_KM) continue;
    const hopsA = Math.abs(i1 - en.idx), hopsB = Math.abs(ex.idx - i2);
    if (hopsA === 0 || hopsB === 0) continue; // dejenere -> tek-hat zaten yakalar
    const accessW = walkMin(from, en.station);
    const vehA = nextVehicle(L1, departMin + accessW);
    if (!vehA) { out.push({ blocked: L1.name }); continue; }
    const rideA = hopsA * L1.ridePerHopMin;
    const vehB = nextVehicle(L2, vehA.board + rideA + TRANSFER_WALK_MIN);
    if (!vehB) { out.push({ blocked: L2.name }); continue; }
    const rideB = hopsB * L2.ridePerHopMin;
    const egressW = walkMin(ex.station, to);
    out.push({
      total: accessW + vehA.wait + rideA + TRANSFER_WALK_MIN + vehB.wait + rideB + egressW,
      arriveMin: vehB.board + rideB + egressW,
      walk: accessW + TRANSFER_WALK_MIN + egressW, ride: rideA + rideB, wait: vehA.wait + vehB.wait,
      boardings: [
        { line: L1.id, fullFare: L1.fare(en.idx, i1), boardMin: vehA.board },
        { line: L2.id, fullFare: L2.fare(i2, ex.idx), boardMin: vehB.board }
      ],
      legs: [
        { mode: "walk", to: L1.stations[en.idx].name, min: r1(accessW) },
        { mode: L1.mode, line: L1.name, from: L1.stations[en.idx].name, to: tp.station, min: r1(rideA) },
        { mode: "transfer", at: tp.station, min: TRANSFER_WALK_MIN },
        { mode: L2.mode, line: L2.name, from: tp.station, to: L2.stations[ex.idx].name, min: r1(rideB) },
        { mode: "walk", from: L2.stations[ex.idx].name, min: r1(egressW) }
      ],
      summary: `${L1.name}→${L2.name} (aktarma: ${tp.station})`
    });
  }
  return out;
}

function ferryOptions(from, to, departMin) {
  const out = [];
  for (const route of FERRY.routes) {
    let a, b;
    if (haversineKm(from, route.t1) <= ACCESS_WALK_MAX_KM && haversineKm(to, route.t2) <= ACCESS_WALK_MAX_KM) { a = route.t1; b = route.t2; }
    else if (haversineKm(from, route.t2) <= ACCESS_WALK_MAX_KM && haversineKm(to, route.t1) <= ACCESS_WALK_MAX_KM) { a = route.t2; b = route.t1; }
    else continue;
    const accessW = walkMin(from, a);
    const veh = nextVehicle(FERRY, departMin + accessW);
    if (!veh) { out.push({ blocked: "Vapur" }); continue; }
    const egressW = walkMin(b, to);
    out.push({
      total: accessW + veh.wait + route.rideMin + egressW,
      arriveMin: veh.board + route.rideMin + egressW,
      walk: accessW + egressW, ride: route.rideMin, wait: veh.wait,
      boardings: [{ line: "ferry", fullFare: FLAT_FARE, boardMin: veh.board }],
      legs: [
        { mode: "walk", to: a.name, min: r1(accessW) },
        { mode: "ferry", line: "Vapur", from: a.name, to: b.name, min: route.rideMin },
        { mode: "walk", from: b.name, min: r1(egressW) }
      ],
      summary: `Vapur (${a.name}→${b.name})`
    });
  }
  return out;
}

// from->to icin o saatteki en iyi transit tahmini. Uydurma yok: hat yoksa feasible:false.
export function transitLeg(from, to, departMin) {
  const raw = [
    railOption(LINES.marmaray, from, to, departMin),
    railOption(LINES.m2, from, to, departMin),
    railOption(LINES.m4, from, to, departMin),
    ...transferOptions(TRANSFERS[0], from, to, departMin),
    ...transferOptions(TRANSFERS[1], from, to, departMin),
    ...ferryOptions(from, to, departMin)
  ].filter(Boolean);

  const feasible = raw.filter((o) => o.total != null && !o.blocked);
  if (!feasible.length) {
    const blocked = raw.filter((o) => o.blocked).map((o) => o.blocked);
    if (blocked.length) return { feasible: false, note: `son sefer geçti (${[...new Set(blocked)].join(", ")})` };
    return { feasible: false, note: "bu çift için uygun hat/vapur yok (en yakın duraklar yürüme mesafesinde değil)" };
  }
  feasible.sort((a, b) => a.total - b.total);
  const best = feasible[0];
  return {
    feasible: true,
    totalMin: r1(best.total),
    fareTRY: applyFareLadder(best.boardings),
    departBoard: fmt.hhmm(best.boardings[0].boardMin),
    arriveMin: best.arriveMin,
    rideMin: r1(best.ride), waitMin: r1(best.wait), walkMin: r1(best.walk),
    boardings: best.boardings,
    summary: best.summary,
    legs: best.legs
  };
}
