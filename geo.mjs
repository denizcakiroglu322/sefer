// geo.mjs — konum cozumleme
// Once dahili gazetteer (offline, internet gerekmez), bulamazsa Nominatim (canli).
// Boylelikle sandbox/cevrimdisi ortamda da calisir; Mac'te Nominatim devreye girer.

// side: 'EU' (Avrupa) | 'ASIA' (Anadolu) — kaba Bogazici esigi ile dogrulanir
export const GAZETTEER = {
  "tuzla":            { name: "Tuzla",                 lat: 40.8155, lng: 29.3003, side: "ASIA" },
  "sabiha gokcen":    { name: "Sabiha Gokcen Havalimani", lat: 40.8986, lng: 29.3092, side: "ASIA" },
  "kadikoy":          { name: "Kadikoy",               lat: 40.9907, lng: 29.0245, side: "ASIA" },
  "uskudar":          { name: "Uskudar",               lat: 41.0265, lng: 29.0153, side: "ASIA" },
  "atasehir":         { name: "Atasehir",              lat: 40.9923, lng: 29.1244, side: "ASIA" },
  "umraniye":         { name: "Umraniye",              lat: 41.0167, lng: 29.1244, side: "ASIA" },
  "kartal":           { name: "Kartal",                lat: 40.8887, lng: 29.1903, side: "ASIA" },
  "pendik":           { name: "Pendik",                lat: 40.8775, lng: 29.2587, side: "ASIA" },
  "goztepe":          { name: "Goztepe",               lat: 40.9810, lng: 29.0610, side: "ASIA" },
  "maslak":           { name: "Maslak",                lat: 41.1110, lng: 29.0190, side: "EU" },
  "levent":           { name: "Levent",                lat: 41.0820, lng: 29.0100, side: "EU" },
  "sisli":            { name: "Sisli",                 lat: 41.0602, lng: 28.9877, side: "EU" },
  "taksim":           { name: "Taksim",                lat: 41.0370, lng: 28.9850, side: "EU" },
  "besiktas":         { name: "Besiktas",              lat: 41.0430, lng: 29.0090, side: "EU" },
  "mecidiyekoy":      { name: "Mecidiyekoy",           lat: 41.0670, lng: 28.9930, side: "EU" },
  "bakirkoy":         { name: "Bakirkoy",              lat: 40.9819, lng: 28.8772, side: "EU" },
  "ist havalimani":   { name: "Istanbul Havalimani",   lat: 41.2611, lng: 28.7416, side: "EU" },
  "ataturk havalimani":{ name: "Ataturk Havalimani",   lat: 40.9769, lng: 28.8146, side: "EU" },
  "kazlicesme":       { name: "Kazlicesme",            lat: 40.9925, lng: 28.9165, side: "EU" },
  "eyup":             { name: "Eyup",                  lat: 41.0480, lng: 28.9340, side: "EU" },
  "silivri":          { name: "Silivri",               lat: 41.0731, lng: 28.2466, side: "EU" }
};

const norm = (s) =>
  String(s || "")
    .toLocaleLowerCase("tr-TR")
    .replace(/i̇/g, "i")
    .replace(/ı/g, "i").replace(/ş/g, "s").replace(/ğ/g, "g")
    .replace(/ü/g, "u").replace(/ö/g, "o").replace(/ç/g, "c")
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

function gazetteerLookup(q) {
  const key = norm(q);
  if (!key) return null;
  if (GAZETTEER[key]) return { ...GAZETTEER[key], source: "gazetteer" };
  // gevsek eslesme: anahtar sorguda geciyorsa
  for (const k of Object.keys(GAZETTEER)) {
    if (key.includes(k) || k.includes(key)) return { ...GAZETTEER[k], source: "gazetteer" };
  }
  return null;
}

// Bogazici boylam esigi ~29.03; gazetteer 'side' alani onceliklidir, bu yedek.
export function sideOf(point) {
  if (point && point.side) return point.side;
  return point && point.lng >= 29.03 ? "ASIA" : "EU";
}

async function nominatim(q) {
  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=tr&q=" +
    encodeURIComponent(q + ", Istanbul");
  const res = await fetch(url, {
    headers: { "User-Agent": "sefer-prototype/0.2 (dev)" },
    signal: AbortSignal.timeout(3000)   // yavas/erisilemez Nominatim asmasin -> catch -> geocode_failed
  });
  if (!res.ok) throw new Error("nominatim http " + res.status);
  const arr = await res.json();
  if (!arr.length) return null;
  const lat = parseFloat(arr[0].lat), lng = parseFloat(arr[0].lon);
  const p = { name: arr[0].display_name.split(",")[0], lat, lng, source: "nominatim" };
  p.side = lng >= 29.03 ? "ASIA" : "EU";
  return p;
}

// Cozumleme: once gazetteer, sonra Nominatim. Internet yoksa zarif dusus.
export async function geocode(q) {
  const hit = gazetteerLookup(q);
  if (hit) return hit;
  try {
    const live = await nominatim(q);
    if (live) return live;
    return { error: "not_found", q, note: "Gazetteer ve Nominatim'de bulunamadi." };
  } catch (e) {
    return { error: "geocode_failed", q, note: "Nominatim'e ulasilamadi (cevrimdisi olabilir): " + e.message };
  }
}
