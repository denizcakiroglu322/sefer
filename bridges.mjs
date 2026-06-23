// bridges.mjs — Bogaz gecisi secici
// Kalkis ve varis farkli yakalardaysa, yaklasim+gecis mesafesini trafik ile
// olcekleyerek en uygun gecisi secer. Toll bilgisi cost.mjs'ye birakilir.

import { haversineKm, travelMinutes, fmt } from "./engine.mjs";
import { sideOf } from "./geo.mjs";
import { tollFor } from "./cost.mjs";

export const CROSSINGS = [
  { id: "15temmuz", name: "15 Temmuz Sehitler Koprusu", lat: 41.0450, lng: 29.0350, type: "bridge" },
  { id: "fsm",      name: "Fatih Sultan Mehmet Koprusu", lat: 41.0910, lng: 29.0610, type: "bridge" },
  { id: "yss",      name: "Yavuz Sultan Selim Koprusu",  lat: 41.2010, lng: 29.1140, type: "bridge" },
  { id: "avrasya",  name: "Avrasya Tuneli",              lat: 40.9950, lng: 29.0000, type: "tunnel" }
];

// Zaman-deger dengesi: 1 dk yolculuk kac TL'ye denk? (knob) 5 TL/dk ~ 300 TL/saat.
// Kopru secimi salt zamana degil, zaman+ucrete gore yapilir: skor = totalMin*VOT + toll.
export const VALUE_OF_TIME_TRY_PER_MIN = 5;

// from->to icin en iyi gecisi sec. refMin: hesaplama referans saati.
// NOT: bacak SURESI hala kopruden gecmiyor (bilinen model siniri) — burada yalniz
// SECIMI zaman+ucretle duzeltiyoruz; sure-icine-yaklasim/cikis fix'i IBB/sunucu fazina ertelendi.
export function chooseCrossing(from, to, opts = {}) {
  const refMin = opts.refMin ?? 12 * 60;
  const rainBoost = opts.rainBoost ?? 0;
  const fromSide = sideOf(from), toSide = sideOf(to);
  if (fromSide === toSide) {
    return { needed: false, side: fromSide, note: "Ayni yaka — Bogaz gecisi gerekmiyor." };
  }
  // yon (A2E/E2A): tek-yon ucretli kopruler yalniz A2E'de ucretli — toll skora girer.
  const direction = fromSide === "ASIA" && toSide === "EU" ? "A2E"
                  : fromSide === "EU" && toSide === "ASIA" ? "E2A" : null;
  const VOT = opts.valueOfTime ?? VALUE_OF_TIME_TRY_PER_MIN;

  const ranked = CROSSINGS.map((c) => {
    const approach = travelMinutes(from, c, refMin, rainBoost).minutes;
    const egress = travelMinutes(c, to, refMin + approach, rainBoost).minutes;
    const totalMin = fmt.round1(approach + egress);
    const toll = tollFor(c.id, direction);
    return {
      id: c.id, name: c.name, type: c.type,
      approachMin: approach, egressMin: egress,
      totalMin,
      detourKm: fmt.round1(haversineKm(from, c) + haversineKm(c, to)),
      toll,
      score: fmt.round1(totalMin * VOT + toll)   // zaman+ucret genel maliyeti
    };
  }).sort((a, b) => a.score - b.score);

  return {
    needed: true,
    from: fromSide, to: toSide,
    direction,
    valueOfTimeTRYPerMin: VOT,
    best: ranked[0],
    alternatives: ranked.slice(1),
    refTime: fmt.hhmm(refMin)
  };
}
