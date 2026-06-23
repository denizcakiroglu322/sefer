// demo.mjs — motorun cekirdek tezini gosterir (internet gerekmez)
//   1) cikis saati taramasi -> en kisa suren kalkis
//   2) deadline -> en gec kalkis
//   3) sira optimizasyonu -> kazanc
// Sayilar modelin sabitlerinden gelir; gercek olcumle ince ayar yapilirsa
// senin gordugun rakamlara (12:10 / 14:00 / 50->36) yaklasir.

import { GAZETTEER } from "./geo.mjs";
import { scanDeparture, latestDeparture, optimizeSequence } from "./engine.mjs";

const P = (k) => GAZETTEER[k];
const line = (s = "") => console.log(s);
const rule = () => line("─".repeat(58));

line("SEFER — cekirdek motor demosu");
rule();

// 1) CIKIS SAATI TARAMASI
const from = P("tuzla"), to = P("maslak");
const scan = scanDeparture(from, to, { startMin: 6 * 60, endMin: 21 * 60, stepMin: 10 });
line(`1) Cikis saati taramasi  ${from.name} -> ${to.name}`);
line(`   Pencere 06:00–21:00, ${scan.sampleCount} ornek`);
line(`   En kisa suren kalkis: ${scan.best.depart}  (${scan.best.minutes} dk, varis ${scan.best.arrive})`);
// karsilastirma: aksam zirvesi
const peak = scan.rows.find((r) => r.depart === "18:00");
if (peak) line(`   Kiyas 18:00 kalkis:   ${peak.minutes} dk  -> tarama ${Math.round(peak.minutes - scan.best.minutes)} dk kazandiriyor`);
rule();

// 2) DEADLINE
const arriveBy = 17 * 60 + 30;
const dl = latestDeparture(from, to, arriveBy, { stepMin: 5 });
line(`2) Deadline  ${from.name} -> ${to.name}, varis <= 17:30`);
if (dl.feasible)
  line(`   En gec kalkis: ${dl.latest.depart}  (${dl.latest.minutes} dk, varis ${dl.latest.arrive})`);
else line(`   ${dl.note}`);
rule();

// 3) SIRA OPTIMIZASYONU — bilerek kotu sirali girdi
const stops = [
  P("levent"),   // baslangic
  P("kartal"),   // uzak (kotu sira: en uzagi ikinci yapiyoruz)
  P("sisli"),
  P("besiktas"),
  P("maslak")
];
const opt = optimizeSequence(stops, { refMin: 12 * 60 });
line("3) Sira optimizasyonu (5 durak, referans 12:00)");
line(`   Girdi sirasi : ${opt.baseline.order.join(" -> ")}`);
line(`                  ${opt.baseline.minutes} dk`);
line(`   Optimize     : ${opt.optimized.order.join(" -> ")}`);
line(`                  ${opt.optimized.minutes} dk`);
line(`   Kazanc       : ${opt.savedMinutes} dk`);
rule();
line("Motor calisiyor. Tam API icin:  node server.mjs");
