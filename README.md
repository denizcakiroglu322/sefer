# sefer — prototype

İstanbul rota motoru. Çekirdek tez: **doğru çıkış saati + doğru sıra.**
Üstüne köprü seçici, HGS/yakıt maliyeti ve open-meteo hava katmanları.

Sıfır bağımlılık (sadece Node yerleşikleri). Node 18+ gerekir.

## Çalıştır

```bash
npm install        # bağımlılık yok, anında biter
node demo.mjs      # çekirdek motor: tarama + deadline + sıra
node server.mjs    # HTTP API -> "sefer api :3000"
```

Yeni sekmede:

```bash
curl -s localhost:3000/health
curl -s localhost:3000/scan -H 'content-type: application/json' \
  -d '{"from":"Tuzla","to":"Maslak"}'
curl -s localhost:3000/plan -H 'content-type: application/json' \
  -d '{"from":"Kadikoy","to":"Levent"}'
```

## Uçlar

| Metot+yol        | Ne yapar | Govde |
|------------------|----------|-------|
| `GET /health`    | sağlık | — |
| `POST /geocode`  | konum çöz | `{q}` |
| `POST /scan`     | en kısa süren çıkış saati | `{from,to,startMin?,endMin?,stepMin?}` |
| `POST /deadline` | deadline için en geç çıkış | `{from,to,arriveBy:"HH:MM"}` |
| `POST /optimize` | durak sırası optimizasyonu | `{stops:[...], start?}` |
| `POST /plan`     | rota + köprü + maliyet + hava | `{from,to,depart?}` |
| `GET/POST /tours`| kayıtlı turlar | `{name,stops}` |
| `POST /notify`   | bildirim (stub) | `{title,body}` |

`from/to/stops`: ya `"Tuzla"` gibi isim (gazetteer/Nominatim ile çözülür) ya da `{lat,lng}`.

## Dosyalar

- `engine.mjs` — mesafe + trafik eğrisi, tarama, deadline, 2-opt sıra optimizasyonu
- `bridges.mjs` — Boğaz geçişi seçici (15 Temmuz / FSM / YSS / Avrasya)
- `cost.mjs` — HGS toll tablosu + yakıt maliyeti (**örnek değerler, güncelle**)
- `weather.mjs` — open-meteo güncel hava (offline'da zarif düşüş)
- `geo.mjs` — İstanbul gazetteer + Nominatim canlı yedek
- `server.mjs` — HTTP API
- `demo.mjs` — çekirdek tez demosu

## İnce ayar (önemli)

Trafik eğrisi, hız ve geçiş/yakıt fiyatları **sabit** ve dosya başlarında:
- `engine.mjs` → `CONFIG` (detour, freeFlowKmh, sabah/akşam zirve)
- `cost.mjs` → `TOLLS_TRY`, `FUEL`

Bunlar deterministik bir model; gerçek ölçümle (Google Directions vb.) kalibre
edip senin gerçek figürlerine oturtursun.
