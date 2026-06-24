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
//   POST /day        {stops,dwell?,window?,mode?,arriveBy?,optimizeOrder?} -> tum gun, COK-MODLU (araç vs toplu): sira+kalkis+ETA+maliyet+modes
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
import { tripCost, tollFor, fuelCost, PARKING_TRY_PER_STOP } from "./cost.mjs";
import { getWeather } from "./weather.mjs";
import { transitLeg, applyFareLadder } from "./transit.mjs";

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
// withTransit=true ise her bacaga transit secenegi eklenir (yalniz nihai planda; tarama hizli kalsin).
function simulateDay(pts, departMin, dwellOf, rainBoost, withTransit = false) {
  let clock = departMin, drivingMin = 0, dwellMin = 0, totalKm = 0, tollTRY = 0;
  const legs = [];
  let tRide = 0, tWait = 0, tWalk = 0, tTotal = 0, tFeasible = 0, tFailNote = null;
  const tBoardings = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const legDepartMin = clock;
    const leg = travelMinutes(a, b, clock, rainBoost);
    const cr = chooseCrossing(a, b, { refMin: clock, rainBoost });
    const crossingId = cr.needed ? cr.best.id : null;
    const direction = cr.needed
      ? (cr.from === "ASIA" && cr.to === "EU" ? "A2E"
         : cr.from === "EU" && cr.to === "ASIA" ? "E2A" : null)
      : null;
    const toll = crossingId ? tollFor(crossingId, direction) : 0;
    const legObj = {
      from: a.name, to: b.name,
      depart: fmt.hhmm(legDepartMin), arrive: fmt.hhmm(legDepartMin + leg.minutes),
      durationMin: leg.minutes, distanceKm: leg.km,
      crossing: crossingId ? { id: crossingId, name: cr.best.name, direction } : null,
      tollTRY: toll
    };
    if (withTransit) {
      const t = transitLeg(a, b, legDepartMin);
      if (t.feasible) {
        legObj.transit = { feasible: true, totalMin: t.totalMin, fareTRY: t.fareTRY, departBoard: t.departBoard, summary: t.summary };
        tRide += t.rideMin; tWait += t.waitMin; tWalk += t.walkMin; tTotal += t.totalMin; tFeasible++;
        tBoardings.push(...t.boardings);
      } else {
        legObj.transit = { feasible: false, note: t.note };
        if (!tFailNote) tFailNote = `${a.name}→${b.name}: ${t.note}`;
      }
    }
    legs.push(legObj);
    clock = legDepartMin + leg.minutes;
    drivingMin += leg.minutes; totalKm += leg.km; tollTRY += toll;
    // ara durakta (son degilse) bekleme/toplanti suresi ekle
    if (i + 1 < pts.length - 1) { const d = dwellOf(b.name); clock += d; dwellMin += d; }
  }
  const out = {
    legs,
    drivingMin: fmt.round1(drivingMin), dwellMin,
    arrivalMin: clock, doorToDoorMin: fmt.round1(clock - departMin),
    totalKm: fmt.round1(totalKm), tollTRY
  };
  if (withTransit) {
    out.transit = {
      rideMin: fmt.round1(tRide), waitMin: fmt.round1(tWait), walkMin: fmt.round1(tWalk),
      totalMin: fmt.round1(tTotal), boardings: tBoardings,
      feasibleLegs: tFeasible, totalLegs: pts.length - 1, failNote: tFailNote
    };
  }
  return out;
}

// Transit gunu: her bacak transitLeg ile; saat transit varislariyla ilerler.
// Bir bacak bile infeasible -> tum gun infeasible (deadline modunda son-tren farkindaligi icin).
function simulateTransitDay(pts, departMin, dwellOf) {
  let clock = departMin;
  for (let i = 0; i < pts.length - 1; i++) {
    const t = transitLeg(pts[i], pts[i + 1], clock);
    if (!t.feasible) return { feasible: false, failAt: `${pts[i].name}→${pts[i + 1].name}`, note: t.note };
    clock = t.arriveMin;
    if (i + 1 < pts.length - 1) clock += dwellOf(pts[i + 1].name);
  }
  return { feasible: true, arrivalMin: clock };
}

const HELP = `sefer api

POST /scan      {from,to}                 en kisa suren kalkis saati
POST /deadline  {from,to,arriveBy}        deadline icin en gec kalkis
POST /optimize  {stops:[...]}             durak sirasini optimize et
POST /plan      {from,to,depart?}         rota + kopru + maliyet + hava
POST /day       {stops,dwell?,window?,mode?}  tum gun cok-modlu: araç vs toplu (sira+kalkis+ETA+maliyet)
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
  "GET /help": async () => HELP,

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

    // Nihai plan icin transit-li yeniden simule et (tarama hizli kalsin diye yalniz burada).
    const finalSim = simulateDay(orderedPts, best.depart, dwellOf, rainBoost, true);

    // savedByOrdering: ayni kalkista girdi sirasi vs optimize sira (surus dk farki)
    const baseSim = simulateDay(pts, best.depart, dwellOf, rainBoost);
    const savedByOrdering = fmt.round1(baseSim.drivingMin - finalSim.drivingMin);

    // 5) ARAÇ maliyeti: yakit (toplam mesafe) + yon-duyarli toll. (Ust-seviye totals DEGISMEZ.)
    const fuelTRY = fuelCost(finalSim.totalKm);
    const tollTRY = finalSim.tollTRY;

    // otopark: ilk durak (cikis) ve eve-donus haric, durulan duraklar
    const lastIsOrigin = orderedPts.length > 1 && orderedPts[0].name === orderedPts[orderedPts.length - 1].name;
    const parkingStops = Math.max(0, (orderedPts.length - 1) - (lastIsOrigin ? 1 : 0));
    const parkingTRY = PARKING_TRY_PER_STOP * parkingStops;

    // gun-seviye transit: 90-dk aktarma merdiveniyle ucret + feasibility
    const ts = finalSim.transit;
    const transitFareDay = applyFareLadder(ts.boardings);
    const transitFeasible = ts.feasibleLegs === ts.totalLegs;
    const modes = {
      car: {
        doorToDoorMin: finalSim.doorToDoorMin, drivingMin: finalSim.drivingMin,
        fuelTRY, tollTRY, parkingTRY, totalTRY: fuelTRY + tollTRY + parkingTRY
      },
      transit: {
        doorToDoorMin: fmt.round1(ts.totalMin + finalSim.dwellMin),
        rideMin: ts.rideMin, waitMin: ts.waitMin, walkMin: ts.walkMin,
        fareTRY: transitFareDay, feasibleLegs: ts.feasibleLegs, totalLegs: ts.totalLegs,
        totalTRY: transitFareDay, feasible: transitFeasible,
        note: transitFeasible ? null : ts.failNote
      }
    };

    // PART 3 — deadline modunda transit son-tren / deadline farkindaligi
    let transitDeadline = null;
    if (mode === "deadline") {
      let tBest = null, firstFail = null;
      for (let d = winStart; d <= winEnd; d += STEP) {
        const sim = simulateTransitDay(orderedPts, d, dwellOf);
        if (sim.feasible && sim.arrivalMin <= arriveBy) tBest = d;
        else if (!sim.feasible && !firstFail) firstFail = sim;
      }
      if (tBest != null) {
        const probe = simulateTransitDay(orderedPts, tBest + STEP, dwellOf);
        let limitingLine = "deadline", note = `${fmt.hhmm(arriveBy)} deadline bağlayıcı (son tren değil)`;
        if (!probe.feasible) { limitingLine = probe.failAt; note = `son sefer/uygunluk sınırı: ${probe.note}`; }
        transitDeadline = { feasible: true, lastFeasibleDeparture: fmt.hhmm(tBest), limitingLine, note };
      } else {
        transitDeadline = {
          feasible: false,
          note: firstFail ? `${firstFail.failAt}: ${firstFail.note}` : `transit ${fmt.hhmm(arriveBy)} deadline'ina yetişemiyor`
        };
      }
    }

    const out = {
      mode,
      order: orderedPts.map((p) => p.name),
      recommendedDeparture: fmt.hhmm(best.depart),
      arrival: fmt.hhmm(finalSim.arrivalMin),
      savedByOrdering,
      legs: finalSim.legs,
      totals: {
        drivingMin: finalSim.drivingMin,
        dwellMin: finalSim.dwellMin,
        doorToDoorMin: finalSim.doorToDoorMin,
        distanceKm: finalSim.totalKm,
        fuelTRY,
        tollTRY,
        totalTRY: fuelTRY + tollTRY
      },
      modes,
      weather: wx
    };
    if (transitDeadline) out.transitDeadline = transitDeadline;
    return out;
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
  // tarayici icin: kok yol (/) interaktif frontend'i sunar; ayni-origin oldugu icin /day'e CORS gerekmez.
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    try {
      const html = await readFile(join(__dirname, "web", "index.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(HELP);
    }
  }
  const handler = routes[key];
  if (!handler) return send(res, 404, { error: "bulunamadi", path: key, hint: "GET /help kullanim metni" });
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
