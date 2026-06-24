// congestion.mjs — topluluk congestion provider sozlesmesi (motor tarafi, SAF).
// Provider: (crossingId, direction, minuteOfDay) => ek kesir (0 = aktif sinyal yok).
//   crossingId ∈ {"15temmuz","fsm","yss","avrasya"} · direction ∈ "A2E" | "E2A"
//   doner: rainBoost-sekilli kesir (0.20 = +%20). Eszamanli sinyallerde max()
//   PLATFORM tarafinda (provider closure'inda) alinir — motor tek bir kesir gorur.
// Default no-op: enjekte edilmezse standalone motor bit-bit ayni kalir.
export const noCongestion = () => 0;
