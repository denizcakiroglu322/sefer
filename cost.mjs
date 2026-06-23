// cost.mjs — HGS gecis ucreti + yakit maliyeti
// NOT: Toll ve yakit fiyatlari ORNEK/yapilandirilabilir degerlerdir.
// Gercek tarifeyle guncelle (HGS/yakit fiyati zamana gore degisir).

export const TOLLS_TRY = {            // otomobil HGS (ornek)
  "15temmuz": 59,
  "fsm": 59,
  "yss": 95,
  "avrasya": 285
};

export const FUEL = {
  pricePerLiterTRY: 62.0,   // guncel benzin fiyati (Haz 2026)
  litersPer100km: 8.0       // ornek tuketim
};

// Tek yon ucretlenen kopruler: yalnizca Anadolu->Avrupa (A2E) yonunde ucret alinir,
// donus (E2A) bedava. yss/avrasya her gecepte ucretlendirilir.
export const ONE_WAY_TOLLS = new Set(["15temmuz", "fsm"]);

// direction: "A2E" (Anadolu->Avrupa) | "E2A" (Avrupa->Anadolu) | null (bilinmiyor).
// Yon bilinmiyorsa (null) ucret tam alinir — eksik faturalamaktansa guvenli taraf.
export function tollFor(crossingId, direction = null) {
  const base = TOLLS_TRY[crossingId] ?? 0;
  if (!base) return 0;
  if (ONE_WAY_TOLLS.has(crossingId) && direction === "E2A") return 0;
  return base;
}

export function fuelCost(km, fuel = FUEL) {
  const liters = (km / 100) * fuel.litersPer100km;
  return Math.round(liters * fuel.pricePerLiterTRY);
}

// Tek sefer toplam maliyeti.
export function tripCost({ km, crossingId = null, direction = null, fuel = FUEL }) {
  const toll = crossingId ? tollFor(crossingId, direction) : 0;
  const fuelTRY = fuelCost(km, fuel);
  return {
    fuelTRY,
    tollTRY: toll,
    totalTRY: fuelTRY + toll,
    assumptions: {
      litersPer100km: fuel.litersPer100km,
      pricePerLiterTRY: fuel.pricePerLiterTRY,
      crossingId,
      direction
    },
    note: "Toll/yakit degerleri ornektir — gercek tarifeyle guncelle."
  };
}
