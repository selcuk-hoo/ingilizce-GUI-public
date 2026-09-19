/* Service worker: uygulamayı ve tüm veriyi cihaza yazar.
   Kurulumdan sonra internet gerekmez. */

// SURUM'un değeri pwa_hazirla.py tarafından, uygulamanın tüm içeriğinin
// karma değerinden OTOMATİK yazılır — elle artırmayı unutma riski
// olmasın diye. Tarayıcı bir servis çalışanının güncellenip
// güncellenmediğine YALNIZCA bu dosyanın kendi baytlarına bakarak karar
// verir; sürüm başka bir dosyada dursaydı bu satır hiç değişmediği için
// güncelleme hiç tetiklenmezdi. Bu satırı elle değiştirme.
const SURUM = "ingilizce-61e0738927f9";

const KABUK = [
  "./",
  "./index.html",
  "./surum.js",
  "./app.js",
  "./style.css",
  "./yardim.html",
  "./manifest.json",
  "./ikon.svg",
  "./veri/dizin.json",
  "./veri/sozluk.json",
];

const VERI = ["A1", "A2", "B1", "B2"].map((s) => `./veri/seviye-${s}.json`);

self.addEventListener("install", (olay) => {
  olay.waitUntil((async () => {
    const onbellek = await caches.open(SURUM);
    // Kabuk önce: uygulama en azından açılabilsin
    await onbellek.addAll(KABUK);
    // Veri tek tek: bir hata bütün kurulumu düşürmesin
    for (let i = 0; i < VERI.length; i++) {
      await onbellek.add(VERI[i]).catch(() => null);
      const istemciler = await self.clients.matchAll({ includeUncontrolled: true });
      istemciler.forEach((c) => c.postMessage({
        tur: "kurulum", tamam: i + 1, toplam: VERI.length,
      }));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (olay) => {
  olay.waitUntil((async () => {
    const adlar = await caches.keys();
    await Promise.all(adlar.filter((a) => a !== SURUM).map((a) => caches.delete(a)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (olay) => {
  const istek = olay.request;
  if (istek.method !== "GET") return;
  olay.respondWith((async () => {
    // Önce önbellek: çevrimdışı çalışmanın tamamı buna dayanıyor
    const bulunan = await caches.match(istek, { ignoreSearch: true });
    // Yönlendirilmiş (redirected) bir yanıtı gezinmeye döndürmek
    // tarayıcıda ERR_FAILED'e yol açıyor — fetch spesifikasyonunun
    // kısıtı. Önbellekte böyle bozuk bir kayıt kalmışsa yokmuş gibi
    // davranıp ağdan tazesini alıyoruz.
    if (bulunan && !(istek.mode === "navigate" && bulunan.redirected)) {
      return bulunan;
    }
    try {
      const cevap = await fetch(istek);
      if (cevap.ok && new URL(istek.url).origin === location.origin) {
        const onbellek = await caches.open(SURUM);
        onbellek.put(istek, cevap.clone());
      }
      return cevap;
    } catch (e) {
      // Çevrimdışıyken ve önbellekte yoksa: gezinme isteğini kabuğa düşür
      if (istek.mode === "navigate") {
        const kabuk = await caches.match("./index.html");
        if (kabuk) return kabuk;
      }
      throw e;
    }
  })());
});

self.addEventListener("message", (olay) => {
  if (olay.data && olay.data.tur === "hemen-gec") self.skipWaiting();
});
