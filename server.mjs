// server.mjs — sefer HTTP API (sifir bagimlilik, sadece node: yerlesikleri)
// Calistir:  node server.mjs   ->  "sefer api :3000"
//
// Uclar (hepsi JSON):
//   GET  /health
//   GET  /                       -> kisa kullanim metni
//   POST /geocode    {q}
//   POST /scan       {from,to,startMin?,endMin?,stepMin?}
//   POST /deadline   {from,to,arriveBy("HH:MM" | dakika)}
//   POST /optimize   {stops:[{name,lat,lng}|"isim"], start?("HH:MM" referans saat), origin?({lat,lng}|"isim" sabit baslangic)}
//   POST /plan       {from,to,depart?}      -> rota+kopru+maliyet+hava
//   POST /day        {stops,dwell?,window?,mode?,arriveBy?,optimizeOrder?} -> tum gun: sira+kalkis+ETA+maliyet
//   GET  /tours                             -> kayitli turlar
//   POST /tours      {name, stops}          -> tur kaydet
//   POST /notify     {title, body}          -> bildirim (stub: loglar)
//
// from/to/stops: ya {lat,lng} ya da gazetteer/Nominatim ile cozulen "isim".

import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { geocode } from "./geo.mjs";
import { scanDeparture, latestDeparture, optimizeSequence, travelMinutes, fmt } from "./engine.mjs";
import { chooseCrossing } from "./bridges.mjs";
import { tripCost, tollFor, fuelCost } from "./cost.mjs";
import { getWeather } from "./weather.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOURS_FILE = join(__dirname, "tours.json");
const PORT = process.env.PORT || 3000;

// ---- yardimcilar -------------------------------------------------
const toMinute = (v) => {
  if (typeof v === "number") return v;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v).trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
};

// "isim" | {lat,lng} -> {name,lat,lng,...}
async function resolvePoint(p) {
  if (p && typeof p === "object" && typeof p.lat === "number" && typeof p.lng === "number") {
    return { name: p.name || `${p.lat},${p.lng}`, ...p };
  }
  if (typeof p === "string") {
    const g = await geocode(p);
    if (g.error) throw new Error(`Konum cozulemedi: "${p}" (${g.note || g.error})`);
    return g;
  }
  throw new Error("Gecersiz konum: " + JSON.stringify(p));
}

async function loadTours() {
  try { return JSON.parse(await readFile(TOURS_FILE, "utf8")); }
  catch { return []; }
}
async function saveTours(list) {
  await writeFile(TOURS_FILE, JSON.stringify(list, null, 2));
}

const send = (res, code, obj) => {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
};
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      if (!d) return resolve({});
      try { resolve(JSON.parse(d)); } catch (e) { reject(new Error("Gecersiz JSON govdesi")); }
    });
    req.on("error", reject);
  });

// ---- /day yardimcilari: cok-duraklin gun plani (mevcut motoru birlestirir) -----
// Tum noktalar arasi surus suresi (dk) matrisi — referans saatte.
function driveMatrix(pts, refMin, rainBoost) {
  const n = pts.length;
  const D = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      if (i !== j) D[i][j] = travelMinutes(pts[i], pts[j], refMin, rainBoost).minutes;
  return D;
}

// Ilk ve son durak SABIT; ortadaki duraklarin en kisa suren sirasini bulur.
// (optimizeSequence yalnizca baslangici sabitler; eve-donus turunda son da sabit
//  olmali, o yuzden ortayi dogrudan tariyoruz — yine travelMinutes'i kullanir.)
function orderFixedEnds(pts, refMin, rainBoost) {
  const n = pts.length;
  if (n <= 3) return pts.slice();
  const D = driveMatrix(pts, refMin, rainBoost);
  const cost = (perm) => {
    let s = D[0][perm[0]] + D[perm[perm.length - 1]][n - 1];
    for (let i = 0; i < perm.length - 1; i++) s += D[perm[i]][perm[i + 1]];
    return s;
  };
  const mid = [];
  for (let i = 1; i < n - 1; i++) mid.push(i);
  let bestPerm = mid.slice(), bestCost = cost(mid);
  if (mid.length <= 8) {
    // Heap's algoritmasi: ortanin tum permutasyonlari (<=40320)
    const a = mid.slice(), c = new Array(a.length).fill(0);
    let i = 0;
    while (i < a.length) {
      if (c[i] < i) {
        const sw = i % 2 === 0 ? 0 : c[i];
        [a[sw], a[i]] = [a[i], a[sw]];
        const cc = cost(a);
        if (cc < bestCost) { bestCost = cc; bestPerm = a.slice(); }
        c[i]++; i = 0;
      } else { c[i] = 0; i++; }
    }
  } else {
    // cok fazla durak: F'den nearest-neighbor (yaklasik)
    const seen = new Set(); let last = 0; bestPerm = [];
    while (bestPerm.length < mid.length) {
      let nx = -1, bd = Infinity;
      for (const j of mid) if (!seen.has(j) && D[last][j] < bd) { bd = D[last][j]; nx = j; }
      bestPerm.push(nx); seen.add(nx); last = nx;
    }
  }
  return [pts[0], ...bestPerm.map((i) => pts[i]), pts[n - 1]];
}

// Verilen sira + kalkis icin gunu bacak bacak simule et; saat dwell'lerle ilerler.
function simulateDay(pts, departMin, dwellOf, rainBoost) {
  let clock = departMin, drivingMin = 0, dwellMin = 0, totalKm = 0, tollTRY = 0;
  const legs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const leg = travelMinutes(a, b, clock, rainBoost);
    const cr = chooseCrossing(a, b, { refMin: clock, rainBoost });
    const crossingId = cr.needed ? cr.best.id : null;
    const direction = cr.needed
      ? (cr.from === "ASIA" && cr.to === "EU" ? "A2E"
         : cr.from === "EU" && cr.to === "ASIA" ? "E2A" : null)
      : null;
    const toll = crossingId ? tollFor(crossingId, direction) : 0;
    const departHHMM = fmt.hhmm(clock);
    clock += leg.minutes;
    legs.push({
      from: a.name, to: b.name,
      depart: departHHMM, arrive: fmt.hhmm(clock),
      durationMin: leg.minutes, distanceKm: leg.km,
      crossing: crossingId ? { id: crossingId, name: cr.best.name, direction } : null,
      tollTRY: toll
    });
    drivingMin += leg.minutes; totalKm += leg.km; tollTRY += toll;
    // ara durakta (son degilse) bekleme/toplanti suresi ekle
    if (i + 1 < pts.length - 1) { const d = dwellOf(b.name); clock += d; dwellMin += d; }
  }
  return {
    legs,
    drivingMin: fmt.round1(drivingMin), dwellMin,
    arrivalMin: clock, doorToDoorMin: fmt.round1(clock - departMin),
    totalKm: fmt.round1(totalKm), tollTRY
  };
}

const HELP = `sefer api

POST /scan      {from,to}                 en kisa suren kalkis saati
POST /deadline  {from,to,arriveBy}        deadline icin en gec kalkis
POST /optimize  {stops:[...]}             durak sirasini optimize et
POST /plan      {from,to,depart?}         rota + kopru + maliyet + hava
POST /day       {stops,dwell?,window?,mode?}  tum gunu planla: sira+kalkis+ETA+maliyet
GET  /tours  |  POST /tours {name,stops}  kayitli turlar
POST /geocode   {q}                       konum cozumle
POST /notify    {title,body}              bildirim (stub)

from/to/stops: "Tuzla" gibi isim ya da {lat,lng}.
ornek: curl -s localhost:${PORT}/scan -H 'content-type: application/json' \\
  -d '{"from":"Tuzla","to":"Maslak"}'
`;

// ---- yonlendirme -------------------------------------------------
const routes = {
  "GET /health": async () => ({ ok: true, service: "sefer", port: PORT }),
  "GET /": async () => HELP,

  "POST /geocode": async (body) => {
    if (!body.q) throw new Error("q gerekli");
    return geocode(body.q);
  },

  "POST /scan": async (body) => {
    const from = await resolvePoint(body.from);
    const to = await resolvePoint(body.to);
    const r = scanDeparture(from, to, body);
    return { from: from.name, to: to.name, best: r.best, sampleCount: r.sampleCount };
  },

  "POST /deadline": async (body) => {
    const from = await resolvePoint(body.from);
    const to = await resolvePoint(body.to);
    const arr = toMinute(body.arriveBy);
    if (arr == null) throw new Error('arriveBy gerekli ("HH:MM" ya da dakika)');
    return { from: from.name, to: to.name, ...latestDeparture(from, to, arr, body) };
  },

  "POST /optimize": async (body) => {
    if (!Array.isArray(body.stops) || body.stops.length < 2)
      throw new Error("stops: en az 2 durak gerekli");
    const stops = await Promise.all(body.stops.map(resolvePoint));
    const refMin = body.start != null ? toMinute(body.start) : 12 * 60;
    const origin = body.origin ? await resolvePoint(body.origin) : null;
    return optimizeSequence(stops, { refMin, rainBoost: body.rainBoost ?? 0, start: origin });
  },

  "POST /day": async (body) => {
    if (!Array.isArray(body.stops) || body.stops.length < 2)
      throw new Error("stops: en az 2 durak gerekli");
    const mode = body.mode === "deadline" ? "deadline" : "shortest";
    const winStart = body.window?.start != null ? toMinute(body.window.start) : 8 * 60;
    const winEnd = body.window?.end != null ? toMinute(body.window.end) : 20 * 60;
    if (winStart == null || winEnd == null || winEnd <= winStart)
      throw new Error('window: gecerli "start"/"end" (HH:MM) gerekli (end > start)');
    const arriveBy = body.arriveBy != null ? toMinute(body.arriveBy) : null;
    if (mode === "deadline" && arriveBy == null)
      throw new Error('mode=deadline icin gecerli "arriveBy" (HH:MM) gerekli');

    // 1) tum duraklari coz (hayalet yok — cozulemezse hata firlatir)
    const pts = await Promise.all(body.stops.map(resolvePoint));

    // hava: gunluk tek rainBoost (ilk durak konumu), cevrimdisi ise zarif dusus
    const wx = await getWeather(pts[0].lat, pts[0].lng);
    const rainBoost = wx.suggestedRainBoost || 0;

    const dwellOf = (name) => {
      const d = body.dwell && body.dwell[name];
      return Number.isFinite(d) && d > 0 ? d : 0;
    };

    // 2) sira: ilk/son sabit, ortayi pencere ortasindaki referans saatte optimize et
    const refMid = Math.round((winStart + winEnd) / 2);
    const optimizeOrder = body.optimizeOrder !== false;
    const orderedPts = optimizeOrder ? orderFixedEnds(pts, refMid, rainBoost) : pts.slice();

    // 3) kalkis taramasi (pencere icinde 5 dk adim) — scanDeparture mantigi, cok bacakli
    const STEP = 5;
    let best = null;
    if (mode === "shortest") {
      for (let d = winStart; d <= winEnd; d += STEP) {
        const sim = simulateDay(orderedPts, d, dwellOf, rainBoost);
        if (!best || sim.drivingMin < best.sim.drivingMin) best = { depart: d, sim };
      }
    } else {
      // deadline: arriveBy'a yetisen EN GEC kalkis (artan tarama → son yetisen = en gec)
      for (let d = winStart; d <= winEnd; d += STEP) {
        const sim = simulateDay(orderedPts, d, dwellOf, rainBoost);
        if (sim.arrivalMin <= arriveBy) best = { depart: d, sim };
      }
      if (!best)
        return {
          mode, feasible: false, order: orderedPts.map((p) => p.name),
          note: `Bu pencerede ${fmt.hhmm(arriveBy)} deadline'ina yetisen kalkis yok.`,
          weather: wx
        };
    }

    // savedByOrdering: ayni kalkista girdi sirasi vs optimize sira (surus dk farki)
    const baseSim = simulateDay(pts, best.depart, dwellOf, rainBoost);
    const savedByOrdering = fmt.round1(baseSim.drivingMin - best.sim.drivingMin);

    // 5) maliyet: yakit TOPLAM mesafe uzerinden + yon-duyarli toplam toll
    const fuelTRY = fuelCost(best.sim.totalKm);
    const tollTRY = best.sim.tollTRY;

    return {
      mode,
      order: orderedPts.map((p) => p.name),
      recommendedDeparture: fmt.hhmm(best.depart),
      arrival: fmt.hhmm(best.sim.arrivalMin),
      savedByOrdering,
      legs: best.sim.legs,
      totals: {
        drivingMin: best.sim.drivingMin,
        dwellMin: best.sim.dwellMin,
        doorToDoorMin: best.sim.doorToDoorMin,
        distanceKm: best.sim.totalKm,
        fuelTRY,
        tollTRY,
        totalTRY: fuelTRY + tollTRY
      },
      weather: wx
    };
  },

  "POST /plan": async (body) => {
    const from = await resolvePoint(body.from);
    const to = await resolvePoint(body.to);
    const depart = body.depart != null ? toMinute(body.depart) : null;

    // once hava (yagmur trafigi etkiler)
    const wx = await getWeather(to.lat, to.lng);
    const rainBoost = wx.suggestedRainBoost || 0;

    // kalkis: verilmediyse en kisa süreni tara
    let chosenDepart = depart;
    let scan = null;
    if (chosenDepart == null) {
      scan = scanDeparture(from, to, { rainBoost });
      chosenDepart = scan.best.departMin;
    }

    const leg = travelMinutes(from, to, chosenDepart, rainBoost);
    const crossing = chooseCrossing(from, to, { refMin: chosenDepart, rainBoost });
    const crossingId = crossing.needed ? crossing.best.id : null;
    // Yon: tek-yon ucretli kopruler (15T/FSM) yalnizca Anadolu->Avrupa'da ucretli.
    const direction = crossing.needed
      ? (crossing.from === "ASIA" && crossing.to === "EU" ? "A2E"
         : crossing.from === "EU" && crossing.to === "ASIA" ? "E2A" : null)
      : null;
    const cost = tripCost({ km: leg.km, crossingId, direction });

    return {
      from: from.name, to: to.name,
      depart: fmt.hhmm(chosenDepart),
      arrive: fmt.hhmm(chosenDepart + leg.minutes),
      durationMin: leg.minutes,
      distanceKm: leg.km,
      departureScanUsed: scan ? { best: scan.best } : "verilen kalkis kullanildi",
      crossing,
      cost,
      weather: wx
    };
  },

  "GET /tours": async () => ({ tours: await loadTours() }),

  "POST /tours": async (body) => {
    if (!body.name || !Array.isArray(body.stops))
      throw new Error("name ve stops[] gerekli");
    const tours = await loadTours();
    const tour = { id: Date.now().toString(36), name: body.name, stops: body.stops, savedAt: new Date().toISOString() };
    tours.push(tour);
    await saveTours(tours);
    return { saved: tour, count: tours.length };
  },

  "POST /notify": async (body) => {
    // Stub: gercek entegrasyon (push/WhatsApp/Telegram) buraya baglanir.
    console.log(`[notify] ${body.title || "(baslik yok)"} — ${body.body || ""}`);
    return { delivered: true, channel: "console-stub", title: body.title || null };
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  if (!handler) return send(res, 404, { error: "bulunamadi", path: key, hint: "GET / kullanim metni" });
  try {
    const body = req.method === "POST" ? await readBody(req) : {};
    const out = await handler(body);
    if (typeof out === "string") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(out);
    }
    send(res, 200, out);
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`sefer api :${PORT}`);
  console.log(`dene:  curl -s localhost:${PORT}/health`);
});
