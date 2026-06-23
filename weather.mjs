// weather.mjs — open-meteo guncel hava (anahtar gerekmez)
// Cevrimdisi/engelli ortamda zarif dusus: {available:false}. Mac'te calisir.
// rainRisk -> motora rainBoost olarak verilip trafik tahminini sisirebilir.

export async function getWeather(lat, lng) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,precipitation,weather_code,wind_speed_10m`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error("http " + res.status);
    const data = await res.json();
    const c = data.current || {};
    const precip = c.precipitation ?? 0;
    return {
      available: true,
      temperatureC: c.temperature_2m,
      precipitationMm: precip,
      windKmh: c.wind_speed_10m,
      weatherCode: c.weather_code,
      rainRisk: precip > 0.1,
      // yagmurda onerilen trafik ek katsayisi
      suggestedRainBoost: precip > 0.5 ? 0.18 : precip > 0.1 ? 0.08 : 0
    };
  } catch (e) {
    return {
      available: false,
      rainRisk: false,
      suggestedRainBoost: 0,
      note: "Hava verisine ulasilamadi (cevrimdisi olabilir): " + e.message
    };
  }
}
