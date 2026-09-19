/* İngilizce Çalışma Aracı — çevrimdışı PWA.
   Kayıtlar yalnızca bu cihazda (IndexedDB). Sunucu yok. */

const el = (id) => document.getElementById(id);

const KATEGORI_ADI = {
  kelime_bilmiyorum: "Kelimeyi bilmiyordum",
  baska_anlam: "Burada başka anlama gelmiş",
  cumle_kurulumu: "Cümleyi yanlış kurdum",
  fark_degil: "Yanlış değil, başka türlü söylenmiş",
};

// Seviye kodu verinin içinde A1/A2/B1/B2 olarak duruyor (dosya adları
// da öyle); ekranda yanına ne demek olduğu yazılır — CEFR etiketi
// ortaokul öğrencisine kendi başına bir şey anlatmıyor.
const SEVIYE_ADI = {
  A1: "Kolay", A2: "Orta", B1: "Zor", B2: "En zor",
};

// Hata değil: istatistiğe ve kart havuzuna girmez, ayrı sayılır.
const FARK_DEGIL = "fark_degil";

const KART_CARPANI = { bilemedim: 2.0, zorlandim: 1.3, biliyordum: 0.6 };
const KART_PARTI = 15;

// Uyarı vurgusunda en fazla kaç kelime işaretlenir. Hepsini işaretlemek
// sinyali gürültüye çevirir.
const EN_FAZLA_UYARI = 3;

// Yön: seviye seçimi gibi KALICI bir ayar (localStorage'da durur, tema/
// seviye gibi). Seçili yön değişene kadar çalışma tümüyle o yön
// üzerinden ilerler — EN->TR'nin üzerine "ikinci aşama" olarak eklenen
// eski davet-düğmesi tasarımı bu yüzden kaldırıldı (bkz. CLAUDE.md).
const YON_ANAHTAR = "ingilizce-yon";

let durum = {
  dizin: null,
  seviye: null,
  yon: "en_tr",
  indeks: 0,
  cumle: null,
  acik: false,          // doğru çeviri/cümle açıldı mı
  seciliSira: null,
  bakilanlar: new Set(), // bu cümlede ipucuna bakılan kelime sıraları
  sozluk: null,
};

// --- IndexedDB ------------------------------------------------------------

const VT_ADI = "ingilizce-calisma";
let vt = null;

function vtAc() {
  return new Promise((coz, red) => {
    const istek = indexedDB.open(VT_ADI, 3);
    istek.onupgradeneeded = () => {
      const d = istek.result;
      if (!d.objectStoreNames.contains("ceviri")) {
        const s = d.createObjectStore("ceviri", { keyPath: "id", autoIncrement: true });
        s.createIndex("cumle", "cumle_id");
      }
      if (!d.objectStoreNames.contains("hata")) {
        const s = d.createObjectStore("hata", { keyPath: "id", autoIncrement: true });
        s.createIndex("cumle", "cumle_id");
      }
      if (!d.objectStoreNames.contains("kart_gecmisi")) {
        const s = d.createObjectStore("kart_gecmisi", { keyPath: "id", autoIncrement: true });
        s.createIndex("hata_id", "hata_id");
      }
      // sürüm 3: ayrı "ters_ceviri" deposu kalktı. TR->EN artık
      // "ikinci aşama" bir deneme değil, kalıcı bir yön seçeneği —
      // denemeler ceviri deposunda yon alanıyla duruyor (bkz. CLAUDE.md).
      if (d.objectStoreNames.contains("ters_ceviri")) {
        d.deleteObjectStore("ters_ceviri");
      }
    };
    istek.onsuccess = () => coz(istek.result);
    istek.onerror = () => red(new Error("Veri deposu açılamadı: " + istek.error));
  });
}

function islem(depo, mod) {
  return vt.transaction(depo, mod).objectStore(depo);
}

function beklet(istek) {
  return new Promise((coz, red) => {
    istek.onsuccess = () => coz(istek.result);
    istek.onerror = () => red(istek.error);
  });
}

const kayit = {
  ekle: (depo, nesne) => beklet(islem(depo, "readwrite").add(nesne)),
  guncelle: (depo, nesne) => beklet(islem(depo, "readwrite").put(nesne)),
  hepsi: (depo) => beklet(islem(depo, "readonly").getAll()),
  cumleninkiler: (depo, cumle_id) =>
    beklet(islem(depo, "readonly").index("cumle").getAll(cumle_id)),
  temizle: (depo) => beklet(islem(depo, "readwrite").clear()),
};

// --- veri -----------------------------------------------------------------

const seviyeOnbellek = new Map();

async function dizinYukle() {
  if (durum.dizin) return durum.dizin;
  const cevap = await fetch("veri/dizin.json");
  if (!cevap.ok) throw new Error("Seviye listesi bulunamadı.");
  durum.dizin = (await cevap.json()).seviyeler;
  return durum.dizin;
}

async function seviyeYukle(ad) {
  if (seviyeOnbellek.has(ad)) return seviyeOnbellek.get(ad);
  const cevap = await fetch(`veri/seviye-${ad}.json`);
  if (!cevap.ok) throw new Error(`${ad} verisi bulunamadı.`);
  const veri = await cevap.json();
  seviyeOnbellek.set(ad, veri);
  return veri;
}

async function sozlukYukle() {
  if (durum.sozluk) return durum.sozluk;
  const cevap = await fetch("veri/sozluk.json");
  if (!cevap.ok) throw new Error("Sözlük bulunamadı.");
  durum.sozluk = await cevap.json();
  return durum.sozluk;
}

function simdi() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// --- tema -----------------------------------------------------------------
//
// İlk uygulama index.html'in başındaki satır içi betikte yapılır (ilk
// boyamadan önce olsun diye). Burada yalnızca değiştirme ve saklama var.
// Kullanıcı hiç dokunmadıysa localStorage boş kalır ve her açılışta
// sistem tercihi izlenir; dokunduğu an seçimi sabitlenir.

const TEMA_ANAHTAR = "ingilizce-tema";
const TEMA_ZEMIN = { acik: "#faf9f6", koyu: "#17161a" };

function temaOku() {
  return document.documentElement.getAttribute("data-tema") === "koyu"
    ? "koyu" : "acik";
}

function temaUygula(ad) {
  document.documentElement.setAttribute("data-tema", ad);
  const etiket = document.querySelector('meta[name="theme-color"]');
  if (etiket) etiket.setAttribute("content", TEMA_ZEMIN[ad]);
  const dugme = el("tema-dugme");
  // Düğme, tıklanınca GEÇİLECEK temayı gösterir.
  dugme.textContent = ad === "koyu" ? "☀" : "☾";
  dugme.setAttribute("aria-label",
    ad === "koyu" ? "Açık temaya geç" : "Koyu temaya geç");
  dugme.title = dugme.getAttribute("aria-label");
}

function temaDegistir() {
  const yeni = temaOku() === "koyu" ? "acik" : "koyu";
  try {
    localStorage.setItem(TEMA_ANAHTAR, yeni);
  } catch (e) { /* özel sekmede localStorage kapalı olabilir */ }
  temaUygula(yeni);
}

// --- bildirim -------------------------------------------------------------

function gezinmeHatasi(mesaj) {
  const alan = el("gezinme-hata");
  alan.textContent = mesaj || "";
  alan.hidden = !mesaj;
}

function durumYaz(alan, mesaj, sure = 2500) {
  const k = el(alan);
  k.textContent = mesaj;
  if (sure) setTimeout(() => { if (k.textContent === mesaj) k.textContent = ""; }, sure);
}

function bilgiGoster(baslik, metin, onay) {
  const kutu = el("bilgi-kutusu");
  el("bilgi-baslik").textContent = baslik;
  el("bilgi-metin").textContent = metin;
  el("bilgi-vazgec").hidden = !onay;
  return new Promise((coz) => {
    const tamam = () => { kapat(); coz(true); };
    const vazgec = () => { kapat(); coz(false); };
    function kapat() {
      el("bilgi-tamam").removeEventListener("click", tamam);
      el("bilgi-vazgec").removeEventListener("click", vazgec);
      kutu.close();
    }
    el("bilgi-tamam").addEventListener("click", tamam);
    el("bilgi-vazgec").addEventListener("click", vazgec);
    kutu.showModal();
  });
}

// --- çizim ----------------------------------------------------------------

/* Cümleyi, hazır verideki karakter konumlarına göre çizer.
   Konumlar Python tokenizer'ından gelir; tarayıcı kendi bölmesini
   yapmaz — böylece hata kaydındaki kelime_sira ile ekrandaki kelime
   hiçbir zaman ayrışmaz. */
function cumleCiz(uyarililar = new Map()) {
  const kap = el("ingilizce");
  kap.textContent = "";
  const metin = durum.cumle.en;
  let imlec = 0;

  durum.cumle.k.forEach(([bas, son, kok], sira) => {
    if (bas > imlec) {
      kap.appendChild(document.createTextNode(metin.slice(imlec, bas)));
    }
    const span = document.createElement("span");
    span.className = "kelime";
    span.dataset.sira = String(sira);
    span.textContent = metin.slice(bas, son);
    if (uyarililar.has(sira)) {
      span.classList.add("uyari");
      span.title = uyarililar.get(sira);
    }
    if (durum.bakilanlar.has(sira)) span.classList.add("bakildi");
    if (durum.seciliSira === sira) span.classList.add("secili");
    kap.appendChild(span);
    imlec = son;
  });

  if (imlec < metin.length) {
    kap.appendChild(document.createTextNode(metin.slice(imlec)));
  }
  kap.classList.toggle("acik", durum.acik);
}

function konumYaz() {
  const bilgi = durum.dizin.find((s) => s.ad === durum.seviye);
  const ad = SEVIYE_ADI[durum.seviye] || durum.seviye;
  el("konum").textContent = `${durum.seviye} · ${ad} — `
    + `${durum.indeks + 1}. cümle / ${bilgi ? bilgi.cumle_sayisi : "?"}`;
  el("atla-no").value = String(durum.indeks + 1);
  for (const dugme of el("seviye-secim").children) {
    dugme.setAttribute("aria-pressed", String(dugme.dataset.seviye === durum.seviye));
  }
  for (const dugme of el("yon-secim").children) {
    dugme.setAttribute("aria-pressed", String(dugme.dataset.yon === durum.yon));
  }
}

async function hatalariCiz() {
  const hatalar = await kayit.cumleninkiler("hata", durum.cumle.i);
  const liste = el("hata-liste");
  liste.textContent = "";
  el("kayitli-hatalar").hidden = !hatalar.length;
  for (const h of hatalar) {
    const li = document.createElement("li");
    const kelime = document.createElement("strong");
    kelime.textContent = h.kelime;
    li.appendChild(kelime);
    const etiket = document.createElement("span");
    etiket.className = "kategori";
    etiket.textContent = " — " + (h.kaynak === "ipucu"
      ? "ipucuna baktın"
      : (KATEGORI_ADI[h.kategori] || h.kategori));
    li.appendChild(etiket);
    if (h.dogru_hali) li.appendChild(document.createTextNode(" · " + h.dogru_hali));
    if (h.aciklama) li.appendChild(document.createTextNode(" · " + h.aciklama));
    liste.appendChild(li);
  }
}

/* Kök başına kaç FARKLI cümlede hata kaydı var.
   Kart havuzu ve uyarı vurgusu bu tek kaynağı paylaşır.
   fark_degil hariç: o gerçek bir hata değil, zorluk sinyaline katılmaz.
   "Bu kartı çıkar" ile filtrelenmez — o havuz üyeliğidir, zorluk değil. */
async function kokCumleSayaci() {
  const tumu = (await kayit.hepsi("hata"))
    .filter((h) => h.kok && h.kategori !== FARK_DEGIL);
  const harita = new Map();
  for (const h of tumu) {
    if (!harita.has(h.kok)) harita.set(h.kok, new Set());
    harita.get(h.kok).add(h.cumle_id);
  }
  return harita;
}

/* Bu cümlede, kökü BAŞKA cümlelerde de seni yenmiş kelimeler.
   Doğru anlamı söylemez; yalnızca nerede yanıldığını hatırlatır.

   Eşik neden 1 değil 2: havuza artık ipucu kayıtları da giriyor ve yeni
   öğrenen başlangıçta çok kelimeye bakıyor. Eşik 1 olsaydı uyarı hemen
   her cümlede yanar, sinyal taşımaz olurdu — Kur'an sürümünde eski
   özellik sayacı tam bu yüzden kaldırılmıştı. Gerçek kullanımda
   gözden geçirilecek. */
const UYARI_ESIGI = 2;

async function uyarilariHesapla() {
  const sayac = await kokCumleSayaci();
  const adaylar = [];
  durum.cumle.k.forEach(([, , kok], sira) => {
    const cumleler = sayac.get(kok);
    if (!cumleler) return;
    const baskalari = [...cumleler].filter((id) => id !== durum.cumle.i);
    if (baskalari.length < UYARI_ESIGI) return;
    adaylar.push({ sira, kok, sayi: baskalari.length });
  });
  adaylar.sort((a, b) => b.sayi - a.sayi);
  return adaylar.slice(0, EN_FAZLA_UYARI);
}

/* Uyarıları doğrudan cümlenin üzerine çizer. Eskiden ayrı bir "bir
   daha bak" ekranı vardı (liste + "baktım" düğmesi); kaldırıldı, çok
   kalabalık yapıyordu. Bilgi kaybolmuyor: turuncu çizgi hâlâ orada,
   üstüne gelince (title) hangi kökte yanıldığını söylüyor — yardım
   sayfası da bunu anlatıyor. */
async function uyariVurgusuUygula() {
  const uyarilar = await uyarilariHesapla();
  const harita = new Map();
  for (const u of uyarilar) {
    harita.set(u.sira,
      `"${u.kok}" kökünde daha önce ${u.sayi} cümlede yanılmışsın.`);
  }
  cumleCiz(harita);
}

// --- yön (EN->TR / TR->EN) -------------------------------------------------
//
// Seviye seçimi gibi kalıcı bir ayar: hangi yön seçiliyse çalışma
// TÜMÜYLE onun üzerinden ilerler (bkz. CLAUDE.md). #ingilizce (tıklanabilir
// İngilizce metin; kelime paneli, hata kaydı ve kart havuzu ona bağlı)
// TEK düğüm — yöne göre yeri değişir:
//   EN->TR: her zaman soru kutusunda (okunacak cümle, baştan görünür).
//   TR->EN: cevap açılana kadar gizli; kaydedince doğru kutusuna taşınır
//     (o zaman görünen "cevap" İngilizcedir). Aynı düğüm taşındığı için
//     olay dinleyicisi ve tüm kelime paneli/hata/kart mantığı DOKUNULMADAN
//     çalışır — kelime tıklama zaten durum.cumle.en + durum.cumle.k
//     üzerinden ilerliyor, yön onu değiştirmiyor.
// Kilitliyken (cevap açılmadan) TR->EN'de kelime paneli YOK: Türkçe soru
// cümlesinin altında henüz tıklanacak İngilizce metin yok — bedelli ipucu
// kavramı yalnızca EN->TR'de anlamlı kalıyor. #ingilizce zaten gizli
// olduğu için bu, ayrı bir kontrol gerektirmeden kendiliğinden oluyor.

function ingilizceYerlestir() {
  const ing = el("ingilizce");
  if (durum.yon === "tr_en" && durum.acik) {
    el("dogru-kutusu").insertBefore(ing, el("alt-blok"));
  } else {
    el("cumle-kutusu").insertBefore(ing, el("ceviri-alani"));
  }
  ing.hidden = durum.yon === "tr_en" && !durum.acik;
}

/* Doğru kutusunun başlığını ve içeriğini yöne göre doldurur.
   EN->TR: tek referans çeviri (Türkçe) yeterli — çeviri OKUNMUYOR,
   üretiliyor. TR->EN: üretilen şey serbest olduğu için tek örnek
   yanıltıcı olur; Tatoeba'nın aynı Türkçe cümleye bağladığı BAŞKA
   İngilizce cümleler (varsa, cumle.alt) "başka doğru yol" olarak da
   gösterilir. */
function cevapKutusunuDoldur() {
  const trYon = durum.yon === "tr_en";
  el("senin-baslik").textContent = trYon ? "Senin İngilizcen" : "Senin çevirin";
  el("dogru-baslik").textContent = trYon ? "Orijinal İngilizce" : "Doğru çeviri";
  el("referans-metin").hidden = trYon;
  if (trYon) {
    const alt = durum.cumle.alt || [];
    el("alt-blok").hidden = !alt.length;
    const liste = el("alt-liste");
    liste.textContent = "";
    for (const a of alt) {
      const li = document.createElement("li");
      li.textContent = a;
      liste.appendChild(li);
    }
    el("dogru-ipucu").textContent = "Bu tek bir örnek, seninki farklı "
      + "olup yine de doğru olabilir — birebir aynı kelimeleri kullanman "
      + "gerekmiyor. Gerçekten yanıldığın kelimeye dokun, işaretle.";
  } else {
    el("referans-metin").textContent = durum.cumle.tr;
    el("alt-blok").hidden = true;
    el("dogru-ipucu").textContent = "Bu tek bir çeviri, seninki farklı "
      + "olup yine de doğru olabilir — her farkı hata sayma. Gerçekten "
      + "yanıldığın kelimeye dokun, işaretle.";
  }
}

async function yonDegistir(yon) {
  if (yon === durum.yon) return;
  durum.yon = yon;
  try { localStorage.setItem(YON_ANAHTAR, yon); } catch (e) { /* özel sekme */ }
  await cumleGoster();
}

// --- cümle yükleme --------------------------------------------------------

async function cumleGoster() {
  const veri = await seviyeYukle(durum.seviye);
  if (!veri.cumleler.length) throw new Error("Bu seviyede cümle yok.");
  durum.indeks = Math.min(Math.max(durum.indeks, 0), veri.cumleler.length - 1);
  durum.cumle = veri.cumleler[durum.indeks];
  durum.acik = false;
  durum.seciliSira = null;

  // Bu cümlede daha önce hangi kelimelere bakılmış: kayıt kalıcı, bir
  // sonraki gelişte de işaretli görünsün.
  const oncekiKayitlar = await kayit.cumleninkiler("hata", durum.cumle.i);
  durum.bakilanlar = new Set(oncekiKayitlar
    .filter((h) => h.kaynak === "ipucu" && h.kelime_sira != null)
    .map((h) => h.kelime_sira));

  konumYaz();
  gezinmeHatasi("");
  el("kelime-bolum").hidden = true;

  el("soru-tr").hidden = durum.yon !== "tr_en";
  el("soru-tr").textContent = durum.cumle.tr;
  el("ceviri-metin").placeholder = durum.yon === "tr_en"
    ? "Cümlenin İngilizcesini buraya yaz…"
    : "Cümlenin Türkçesini buraya yaz…";
  // İpucu notu yalnızca EN->TR'de anlamlı: TR->EN'de soru kutusunda
  // henüz tıklanacak İngilizce metin yok.
  el("cumle-ipucu").hidden = durum.yon === "tr_en";

  // Daha önce AYNI YÖNDE çevrilmişse kart doğrudan "açık" hâlde başlar:
  // kullanıcı kendi cevabını zaten vermiş, tekrar yazmaya zorlamanın
  // pedagojik değeri yok. İki yön birbirinden bağımsız ilerler — aynı
  // cümlenin EN->TR kaydı TR->EN'i kilitli tutar/açmaz.
  const onceki = (await kayit.cumleninkiler("ceviri", durum.cumle.i))
    .filter((c) => (c.yon || "en_tr") === durum.yon);
  durum.acik = onceki.length > 0;
  el("ceviri-alani").hidden = durum.acik;
  el("referans-alani").hidden = !durum.acik;

  ingilizceYerlestir();
  if (durum.acik) {
    el("senin-ceviri-metni").textContent = onceki[0].metin;
    cevapKutusunuDoldur();
    await uyariVurgusuUygula();
  } else {
    el("ceviri-metin").value = "";
    cumleCiz();
  }

  await hatalariCiz();
  konumKaydet();
}

function konumKaydet() {
  try {
    localStorage.setItem("ingilizce-konum",
      JSON.stringify({ seviye: durum.seviye, indeks: durum.indeks }));
  } catch (e) { /* özel sekmede localStorage kapalı olabilir */ }
}

function konumOku() {
  try {
    const ham = localStorage.getItem("ingilizce-konum");
    return ham ? JSON.parse(ham) : null;
  } catch (e) { return null; }
}

// --- eylemler -------------------------------------------------------------

async function ceviriKaydet() {
  const metin = el("ceviri-metin").value.trim();
  if (!metin) {
    durumYaz("ceviri-durum", durum.yon === "tr_en"
      ? "Önce İngilizce cümleni yaz." : "Önce kendi çevirini yaz.");
    return;
  }
  // Aynı cümleye AYNI YÖNDE ikinci çeviri üzerine yazar, yeni kayıt
  // açmaz; farklı yönde ayrı kayıt açar — iki yön bağımsız ilerler.
  const mevcut = (await kayit.cumleninkiler("ceviri", durum.cumle.i))
    .filter((c) => (c.yon || "en_tr") === durum.yon);
  if (mevcut.length) {
    await kayit.guncelle("ceviri",
      { ...mevcut[0], metin, tarih: simdi() });
  } else {
    await kayit.ekle("ceviri", {
      cumle_id: durum.cumle.i, seviye: durum.seviye, yon: durum.yon,
      metin, tarih: simdi(),
    });
  }
  durumYaz("ceviri-durum", "Kaydedildi.");

  // Kart yerinde dönüşür: aynı kutu, çeviri alanı yerine artık senin
  // çevirin + doğrusu görünür. Ayrı bir "göster" düğmesi yok — kaydetme
  // eylemi zaten bilinçli adımdı, kilidin amacı buydu.
  el("senin-ceviri-metni").textContent = metin;
  el("ceviri-alani").hidden = true;
  el("referans-alani").hidden = false;
  durum.acik = true;
  cevapKutusunuDoldur();
  ingilizceYerlestir();
  // İpucu için açık kalmış panelde hata formu gizliydi; kapatıp
  // kullanıcıyı kelimeye yeniden dokunmaya bırakmak daha temiz.
  kelimeKapat();
  await uyariVurgusuUygula();
}

/* Kelimeye dokunmak, referans çeviri açılmadan ÖNCE de anlamı verir —
   ama bedeli vardır: kelime "bakıldı" diye kaydedilir ve kart havuzuna
   girer. Boş sayfa bırakmak yeni öğrenende üretme etkisini çalıştırmaz,
   sadece bilmediğini öğretir. Kilit yine de duruyor: açılan şey tek
   kelimenin anlamı, cümlenin çevirisi değil. */
async function kelimeSec(sira) {
  gezinmeHatasi("");
  durum.seciliSira = sira;
  const [bas, son, kok] = durum.cumle.k[sira];
  const kelime = durum.cumle.en.slice(bas, son);

  el("kelime-baslik").textContent = kelime;
  const anlamlar = (durum.sozluk && durum.sozluk[kok]) || [];
  el("kelime-anlam").textContent = anlamlar.length
    ? anlamlar.join(" · ")
    : "Sözlükte karşılığı yok.";

  // Hata formu ancak referans görüldükten sonra anlamlı: kendi çevirini
  // doğrusuyla karşılaştırmadan neyi yanlış yaptığını sınıflandıramazsın.
  el("hata-form").hidden = !durum.acik;
  el("ipucu-notu").hidden = durum.acik;
  if (durum.acik) { el("hata-form").reset(); detayKapat(); }
  else await ipucuKaydet(sira, kelime, kok);

  el("kelime-bolum").hidden = false;
  el("kelime-bolum").scrollIntoView({ behavior: "smooth", block: "nearest" });
  cumleCiz();
}

/* Bakılan kelimeyi kaydeder. Aynı cümlede aynı kelimeye ikinci kez
   dokunmak yeni kayıt açmaz — bakmak bir olaydır, tekrar bakmak aynı
   olay. */
async function ipucuKaydet(sira, kelime, kok) {
  if (durum.bakilanlar.has(sira)) return;
  durum.bakilanlar.add(sira);
  const [bas, son] = durum.cumle.k[sira];
  await kayit.ekle("hata", {
    cumle_id: durum.cumle.i,
    seviye: durum.seviye,
    cumle_en: durum.cumle.en,
    cumle_tr: durum.cumle.tr,
    kelime_sira: sira,
    kelime,
    kelime_bas: bas,
    kelime_son: son,
    kok,
    kategori: "kelime_bilmiyorum",
    // Elle kaydedilen hatadan ayrılsın: ikisi de kart üretir ama
    // "bakmak" ile "yanlış çevirdim" aynı güçte kanıt değil.
    kaynak: "ipucu",
    dogru_hali: "",
    aciklama: "",
    tarih: simdi(),
  });
  await hatalariCiz();
}

function detayAc() {
  el("detay-alanlar").hidden = false;
  el("detay-ac").hidden = true;
}

function detayKapat() {
  el("detay-alanlar").hidden = true;
  el("detay-ac").hidden = false;
}

function kelimeKapat() {
  durum.seciliSira = null;
  el("kelime-bolum").hidden = true;
  cumleCiz();
}

async function hataKaydet(olay) {
  olay.preventDefault();
  if (durum.seciliSira === null) return;
  const sira = durum.seciliSira;
  const [bas, son, kok] = durum.cumle.k[sira];
  const secili = el("hata-form").querySelector("input[name=kategori]:checked");

  await kayit.ekle("hata", {
    cumle_id: durum.cumle.i,
    seviye: durum.seviye,
    // Cümle metni kayda GÖMÜLÜR: paketlenen cümle kümesi sürümler
    // arasında değişebilir, kart o zaman da çizilebilsin.
    cumle_en: durum.cumle.en,
    cumle_tr: durum.cumle.tr,
    kelime_sira: sira,
    kelime: durum.cumle.en.slice(bas, son),
    kelime_bas: bas,
    kelime_son: son,
    kok,
    kategori: secili.value,
    kaynak: "kayit",
    dogru_hali: el("hata-dogru-hali").value.trim(),
    aciklama: el("hata-not").value.trim(),
    tarih: simdi(),
  });

  durumYaz("hata-durum", "Kaydedildi.");
  el("hata-form").reset();
  detayKapat();
  kelimeKapat();
  await hatalariCiz();
}

async function seviyeDegistir(ad) {
  durum.seviye = ad;
  durum.indeks = 0;
  await cumleGoster();
}

async function ilerle(adim) {
  const veri = await seviyeYukle(durum.seviye);
  const yeni = durum.indeks + adim;
  if (yeni < 0) { gezinmeHatasi("İlk cümledesin."); return; }
  if (yeni >= veri.cumleler.length) { gezinmeHatasi("Son cümledesin."); return; }
  durum.indeks = yeni;
  await cumleGoster();
}

async function atla(olay) {
  olay.preventDefault();
  const no = parseInt(el("atla-no").value, 10);
  const veri = await seviyeYukle(durum.seviye);
  if (!Number.isFinite(no) || no < 1 || no > veri.cumleler.length) {
    gezinmeHatasi(`1 ile ${veri.cumleler.length} arasında bir numara yaz.`);
    return;
  }
  durum.indeks = no - 1;
  await cumleGoster();
}

// --- durum (kaba ilerleme göstergesi) --------------------------------------
//
// ÖLÇÜLEN ŞEY ÇEVİRİNİN DOĞRULUĞU DEĞİL. Program kullanıcının çeviri
// metnini referansla hiç karşılaştırmıyor; karşılaştırsa da bir
// cümlenin tek doğru çevirisi yok, uydurma bir doğruluk yüzdesi
// yanıltıcı olurdu. Ölçülen: kaç cümle YARDIM ALMADAN bitirilmiş —
// yani kelimesine bakılmamış ve içinde yanlış işaretlenmemiş.
// Bu, kullanıcının kendi davranışının sayımı; yorum değil.

const SON_PENCERE = 20;

// Bu sayının altında oran gösterilmez. 6 cümlenin 6'sını yardımsız
// bitirmek "%100" değildir; dolu bir çubuk göstermek öğrenciye
// olduğundan iyi bir tablo çizer.
const ORAN_ICIN_EN_AZ = 10;

async function durumHesapla() {
  const ceviriler = await kayit.hepsi("ceviri");
  const hatalar = await kayit.hepsi("hata");
  const gecmis = await kayit.hepsi("kart_gecmisi");

  const yardimAlinan = new Set(hatalar.map((h) => h.cumle_id));

  const seviyeler = durum.dizin.map((s) => {
    const kendi = ceviriler
      .filter((c) => c.seviye === s.ad)
      .sort((a, b) => new Date(a.tarih) - new Date(b.tarih));
    const yardimsiz = (c) => !yardimAlinan.has(c.cumle_id);
    const son = kendi.slice(-SON_PENCERE);
    return {
      ad: s.ad,
      toplam: s.cumle_sayisi,
      calisilan: kendi.length,
      yardimsiz: kendi.filter(yardimsiz).length,
      sonAdet: son.length,
      sonYardimsiz: son.filter(yardimsiz).length,
    };
  });

  // Kelime kartları: aynı (cümle, kelime) tek kart. fark_degil kart
  // üretmiyor, sayıma da girmemeli.
  const kartlar = new Map();
  for (const h of hatalar) {
    if (h.kelime_sira == null || h.kategori === FARK_DEGIL) continue;
    const anahtar = `${h.cumle_id}:${h.kelime_sira}`;
    const k = kartlar.get(anahtar) || { idler: [], disi: false };
    k.idler.push(h.id);
    if (h.kart_disi) k.disi = true;
    kartlar.set(anahtar, k);
  }

  const sonSonuc = new Map();
  for (const g of gecmis.sort((a, b) => new Date(a.tarih) - new Date(b.tarih))) {
    sonSonuc.set(g.hata_id, g.sonuc);
  }

  let bilinen = 0;
  for (const k of kartlar.values()) {
    const sonuclar = k.idler.map((id) => sonSonuc.get(id)).filter(Boolean);
    if (k.disi || (sonuclar.length && sonuclar.every((s) => s === "biliyordum"))) {
      bilinen++;
    }
  }

  return { seviyeler, kartToplam: kartlar.size, kartBilinen: bilinen };
}

function yuzde(pay, payda) {
  return payda ? Math.round((100 * pay) / payda) : 0;
}

function durumSatiriCiz(s) {
  const kap = document.createElement("div");
  kap.className = "durum-satir";

  const baslik = document.createElement("h2");
  baslik.textContent = `${s.ad} · ${SEVIYE_ADI[s.ad] || s.ad}`;
  kap.appendChild(baslik);

  if (!s.calisilan) {
    const bos = document.createElement("p");
    bos.className = "ipucu";
    bos.textContent = "Bu seviyede henüz çalışmadın.";
    kap.appendChild(bos);
    return kap;
  }

  const oran = yuzde(s.yardimsiz, s.calisilan);
  const ozet = document.createElement("p");
  ozet.textContent = s.calisilan < ORAN_ICIN_EN_AZ
    ? `${s.calisilan} cümle çalıştın, ${s.yardimsiz} tanesinde hiç yardım `
      + "almadın."
    : `${s.calisilan} cümle çalıştın. `
      + `${s.yardimsiz} tanesini hiç yardım almadan bitirdin (%${oran}).`;
  kap.appendChild(ozet);

  if (s.calisilan < ORAN_ICIN_EN_AZ) {
    const not = document.createElement("p");
    not.className = "ipucu";
    not.textContent = `Oranı gösterebilmem için biraz daha çalışman lazım `
      + `(en az ${ORAN_ICIN_EN_AZ} cümle) — birkaç cümleye bakıp yüzde `
      + "vermek yanıltıcı olurdu.";
    kap.appendChild(not);
    return kap;
  }

  const cubuk = document.createElement("div");
  cubuk.className = "cubuk";
  cubuk.setAttribute("role", "img");
  cubuk.setAttribute("aria-label", `Yardımsız oranı yüzde ${oran}`);
  const dolu = document.createElement("span");
  dolu.style.width = oran + "%";
  cubuk.appendChild(dolu);
  kap.appendChild(cubuk);

  const son = document.createElement("p");
  son.className = "ipucu";
  son.textContent = s.sonAdet < SON_PENCERE
    ? `Bu seviyedeki ${s.toplam} cümlenin ${s.calisilan}'ini gördün.`
    : `Son ${s.sonAdet} cümlede yardımsız oranın: `
      + `%${yuzde(s.sonYardimsiz, s.sonAdet)}. `
      + `(Bu sayı genel ortalamadan yüksekse ilerliyorsun.)`;
  kap.appendChild(son);
  return kap;
}

async function durumGoster() {
  ekranGoster("durum-ekrani");
  const v = await durumHesapla();

  const kap = el("durum-seviyeler");
  kap.textContent = "";
  for (const s of v.seviyeler) kap.appendChild(durumSatiriCiz(s));

  el("durum-kelime").textContent = v.kartToplam
    ? `${v.kartToplam} kelime kartın var. Bunlardan ${v.kartBilinen} tanesini `
      + "artık biliyorsun."
    : "Henüz kelime kartın yok. Bilmediğin kelimelere dokundukça birikecek.";
}

// --- ekranlar --------------------------------------------------------------

const EKRANLAR = ["calisma-ekrani", "durum-ekrani", "kart-ekrani"];

function ekranGoster(ad) {
  for (const e of EKRANLAR) el(e).hidden = (e !== ad);
}

// --- kart çalışması --------------------------------------------------------
//
// Havuz: hata kayıtları, fark_degil hariç ve "bu kartı çıkar" denmemiş
// olanlar. Aynı (cumle_id, kelime_sira) için birden çok kayıt TEK karta
// birleşir. Vade/kuyruk YOK; her seçimde ağırlıklı rastgele çekilir.

let kartDurumu = null;

async function kartHavuzuOlustur() {
  const uygun = (await kayit.hepsi("hata"))
    .filter((h) => h.kelime_sira != null && h.kategori !== FARK_DEGIL && !h.kart_disi)
    .sort((a, b) => new Date(a.tarih) - new Date(b.tarih));

  const gruplar = new Map();
  for (const h of uygun) {
    const anahtar = `${h.cumle_id}:${h.kelime_sira}`;
    if (!gruplar.has(anahtar)) gruplar.set(anahtar, []);
    gruplar.get(anahtar).push(h);
  }

  const kartlar = [];
  for (const [anahtar, kayitlar] of gruplar) {
    const son = kayitlar[kayitlar.length - 1];
    kartlar.push({
      anahtar,
      cumle_en: son.cumle_en,
      kelime: son.kelime,
      kelime_bas: son.kelime_bas,
      kelime_son: son.kelime_son,
      kok: son.kok || null,
      hataIdler: kayitlar.map((h) => h.id),
      aciklamalar: kayitlar.map((h) => h.aciklama).filter(Boolean),
      dogruHali: son.dogru_hali || son.aciklama || "",
    });
  }
  return kartlar;
}

async function kartAgirlikliSecim(adet, haricAnahtarlar) {
  const havuz = (await kartHavuzuOlustur())
    .filter((k) => !haricAnahtarlar.has(k.anahtar));
  if (!havuz.length) return [];

  const kokCumleler = await kokCumleSayaci();
  const tumGecmis = await kayit.hepsi("kart_gecmisi");

  const agirlikli = havuz.map((k) => {
    const kokTekrar = k.kok && kokCumleler.has(k.kok)
      ? Math.max(0, kokCumleler.get(k.kok).size - 1) : 0;
    const ilgili = tumGecmis
      .filter((g) => k.hataIdler.includes(g.hata_id))
      .sort((a, b) => new Date(b.tarih) - new Date(a.tarih));
    let gunGecti = 30;
    let carpan = 1.0;
    if (ilgili.length) {
      gunGecti = Math.max(0, Math.floor(
        (Date.now() - new Date(ilgili[0].tarih)) / 86400000));
      carpan = KART_CARPANI[ilgili[0].sonuc] ?? 1.0;
    }
    const agirlik = (1 + kokTekrar) * Math.min(gunGecti, 30) * carpan;
    return { kart: k, agirlik: Math.max(agirlik, 0.0001) };
  });

  const secilenler = [];
  const kalan = agirlikli.slice();
  const n = Math.min(adet, kalan.length);
  for (let i = 0; i < n; i++) {
    const toplam = kalan.reduce((s, x) => s + x.agirlik, 0);
    let esik = Math.random() * toplam;
    let idx = 0;
    while (idx < kalan.length - 1 && esik > kalan[idx].agirlik) {
      esik -= kalan[idx].agirlik;
      idx++;
    }
    secilenler.push(kalan[idx].kart);
    kalan.splice(idx, 1);
  }
  return secilenler;
}

async function kartCalismayaBasla() {
  ekranGoster("kart-ekrani");
  kartDurumu = {
    kuyruk: [], indeks: 0, aktifKart: null,
    gosterilenler: new Set(),
    sonuclar: { bilemedim: 0, zorlandim: 0, biliyordum: 0 },
  };
  await kartYeniParti();
}

async function kartYeniParti() {
  const kartlar = await kartAgirlikliSecim(KART_PARTI, kartDurumu.gosterilenler);
  kartDurumu.kuyruk = kartlar;
  kartDurumu.indeks = 0;
  el("kart-ozet").hidden = true;
  if (!kartlar.length) {
    el("kart-govde").hidden = true;
    el("kart-bos").hidden = false;
    el("kart-ilerleme").textContent = "";
    return;
  }
  el("kart-bos").hidden = true;
  el("kart-govde").hidden = false;
  kartCiz();
}

function kartCiz() {
  const k = kartDurumu.kuyruk[kartDurumu.indeks];
  kartDurumu.aktifKart = k;
  kartDurumu.gosterilenler.add(k.anahtar);

  const kap = el("kart-cumle");
  kap.textContent = "";
  kap.appendChild(document.createTextNode(k.cumle_en.slice(0, k.kelime_bas)));
  const hedef = document.createElement("span");
  hedef.className = "kelime secili";
  hedef.textContent = k.cumle_en.slice(k.kelime_bas, k.kelime_son);
  kap.appendChild(hedef);
  kap.appendChild(document.createTextNode(k.cumle_en.slice(k.kelime_son)));

  el("kart-arka").hidden = true;
  el("kart-cevir").hidden = false;
  el("kart-ilerleme").textContent =
    `Kart ${kartDurumu.indeks + 1} / ${kartDurumu.kuyruk.length}`;
}

function kartCevir() {
  const k = kartDurumu.aktifKart;
  const anlamlar = (durum.sozluk && k.kok && durum.sozluk[k.kok]) || [];
  el("kart-sozluk").textContent = anlamlar.length
    ? `${k.kok} — ${anlamlar.join(" · ")}`
    : "Sözlükte karşılığı yok.";

  const kendiNotu = k.dogruHali || k.aciklamalar.length;
  el("kart-kendi-notun").hidden = !kendiNotu;
  if (kendiNotu) {
    el("kart-dogrusu").textContent = k.dogruHali || "(yazmamışsın)";
    el("kart-sandigin").textContent = k.aciklamalar.length
      ? k.aciklamalar.join("\n")
      : "(not düşmemişsin)";
  }

  el("kart-arka").hidden = false;
  el("kart-cevir").hidden = true;
}

async function kartSonuc(sonuc) {
  const k = kartDurumu.aktifKart;
  for (const hata_id of k.hataIdler) {
    await kayit.ekle("kart_gecmisi", { hata_id, sonuc, tarih: simdi() });
  }
  kartDurumu.sonuclar[sonuc]++;
  kartDurumu.indeks++;
  if (kartDurumu.indeks >= kartDurumu.kuyruk.length) {
    kartOturumOzetiGoster();
    return;
  }
  kartCiz();
}

function kartOturumOzetiGoster() {
  const s = kartDurumu.sonuclar;
  el("kart-govde").hidden = true;
  el("kart-ozet").hidden = false;
  el("kart-ozet-metin").textContent =
    `Bitti — biliyordum ${s.biliyordum}, zorlandım ${s.zorlandim}, `
    + `bilemedim ${s.bilemedim}.`;
}

async function kartCikar(olay) {
  olay.preventDefault();
  const k = kartDurumu.aktifKart;
  const onay = await bilgiGoster("Kartı çıkar",
    `"${k.kelime}" kartı bir daha gelmesin mi? Hata kaydı silinmez, `
    + "yalnızca kart havuzundan çıkar.", true);
  if (!onay) return;
  const hepsi = await kayit.hepsi("hata");
  for (const h of hepsi) {
    if (k.hataIdler.includes(h.id)) {
      await kayit.guncelle("hata", { ...h, kart_disi: true });
    }
  }
  kartDurumu.indeks++;
  if (kartDurumu.indeks >= kartDurumu.kuyruk.length) {
    kartOturumOzetiGoster();
    return;
  }
  kartCiz();
}

async function kartKapat() {
  ekranGoster("calisma-ekrani");
  kartDurumu = null;
  await cumleGoster();
}

// --- dışa / içe aktarma ---------------------------------------------------

function dosyaIndir(ad, icerik, tur) {
  const blob = new Blob([icerik], { type: tur });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = ad;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function disaAktar() {
  const paket = {
    surum: typeof INGILIZCE_SURUM !== "undefined" ? INGILIZCE_SURUM : "?",
    tarih: simdi(),
    ceviri: await kayit.hepsi("ceviri"),
    hata: await kayit.hepsi("hata"),
    kart_gecmisi: await kayit.hepsi("kart_gecmisi"),
  };
  dosyaIndir(`ingilizce-kayitlar-${simdi().slice(0, 10)}.json`,
             JSON.stringify(paket, null, 2), "application/json");
}

async function iceAktarDosya(dosya) {
  let paket;
  try {
    paket = JSON.parse(await dosya.text());
  } catch (e) {
    await bilgiGoster("İçe aktarma", "Dosya okunamadı: geçerli JSON değil.");
    return;
  }
  if (!paket || !Array.isArray(paket.ceviri) || !Array.isArray(paket.hata)) {
    await bilgiGoster("İçe aktarma",
      "Dosya bu uygulamanın dışa aktarımına benzemiyor.");
    return;
  }
  const onay = await bilgiGoster("İçe aktarma",
    `${paket.ceviri.length} çeviri, ${paket.hata.length} hata kaydı bulundu. `
    + "Şu anki kayıtların SİLİNİP bunlarla değiştirilecek. Devam?", true);
  if (!onay) return;

  for (const depo of ["ceviri", "hata", "kart_gecmisi"]) {
    await kayit.temizle(depo);
    for (const nesne of (paket[depo] || [])) {
      await kayit.guncelle(depo, nesne);
    }
  }
  await bilgiGoster("İçe aktarma", "Kayıtlar yüklendi.");
  await cumleGoster();
}

/* Anki: yalnızca hata kaydı düşülen kelimeler.
   Ön yüz kelime + CÜMLE İÇİNDEKİ hâli; arka yüz doğru hali, kendi
   notun ve sözlük karşılığı. Sekmeyle ayrılmış iki sütun. */
async function ankiAktar() {
  const kartlar = await kartHavuzuOlustur();
  if (!kartlar.length) {
    await bilgiGoster("Anki", "Henüz hata kaydı yok.");
    return;
  }
  const temiz = (s) => String(s || "").replace(/\t/g, " ").replace(/\n/g, "<br>");
  const satirlar = kartlar.map((k) => {
    const on = `${k.kelime}<br><i>${temiz(k.cumle_en)}</i>`;
    const anlamlar = (durum.sozluk && k.kok && durum.sozluk[k.kok]) || [];
    const arka = [
      k.dogruHali && `Doğrusu: ${temiz(k.dogruHali)}`,
      k.aciklamalar.length && `Notun: ${temiz(k.aciklamalar.join(" / "))}`,
      k.kok && `Kök: ${k.kok}`,
      anlamlar.length && `Sözlük: ${temiz(anlamlar.join(" · "))}`,
    ].filter(Boolean).join("<br>");
    return `${on}\t${arka}`;
  });
  dosyaIndir(`ingilizce-anki-${simdi().slice(0, 10)}.txt`,
             satirlar.join("\n"), "text/plain");
}

// --- servis çalışanı ------------------------------------------------------

async function kurulumDurumu() {
  const alan = el("kurulum-durumu");
  if (!("caches" in window)) { alan.textContent = ""; return; }
  try {
    const surum = typeof INGILIZCE_SURUM !== "undefined" ? INGILIZCE_SURUM : null;
    if (!surum) return;
    const onbellek = await caches.open("ingilizce-" + surum);
    // Sayı değil, ADI geçen dosyalar aranır: kabuk listesi değişince
    // sihirli sayı sessizce yanlışa düşüyor.
    const gerekli = ["index.html", "app.js", "veri/sozluk.json"]
      .concat((durum.dizin || []).map((s) => `veri/seviye-${s.ad}.json`));
    const eksik = [];
    for (const yol of gerekli) {
      if (!(await onbellek.match(yol))) eksik.push(yol);
    }
    alan.textContent = eksik.length
      ? `Kuruluyor… (${gerekli.length - eksik.length}/${gerekli.length})`
      : "Çevrimdışı hazır";
  } catch (e) {
    alan.textContent = "";
  }
}

function servisCalisaniKaydet() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("sw.js").catch(() => null);
  navigator.serviceWorker.addEventListener("message", (olay) => {
    if (olay.data && olay.data.tur === "kurulum") {
      el("kurulum-durumu").textContent =
        `Kuruluyor… ${olay.data.tamam} / ${olay.data.toplam}`;
      if (olay.data.tamam >= olay.data.toplam) kurulumDurumu();
    }
  });
}

// --- bağlama --------------------------------------------------------------

function seviyeDugmeleriniCiz() {
  const kap = el("seviye-secim");
  kap.textContent = "";
  for (const s of durum.dizin) {
    const dugme = document.createElement("button");
    dugme.type = "button";
    dugme.dataset.seviye = s.ad;
    const kod = document.createElement("span");
    kod.className = "seviye-kod";
    kod.textContent = s.ad;
    const ad = document.createElement("span");
    ad.className = "seviye-ad";
    ad.textContent = SEVIYE_ADI[s.ad] || "";
    dugme.append(kod, ad);
    dugme.addEventListener("click", () => seviyeDegistir(s.ad));
    kap.appendChild(dugme);
  }
}

function baglantilariKur() {
  el("tema-dugme").addEventListener("click", temaDegistir);
  el("onceki").addEventListener("click", () => ilerle(-1));
  el("sonraki").addEventListener("click", () => ilerle(1));
  el("atla-form").addEventListener("submit", atla);
  el("ceviri-kaydet").addEventListener("click", ceviriKaydet);
  el("hata-form").addEventListener("submit", hataKaydet);
  el("hata-iptal").addEventListener("click", kelimeKapat);
  el("detay-ac").addEventListener("click", detayAc);
  for (const dugme of el("yon-secim").children) {
    dugme.addEventListener("click", () => yonDegistir(dugme.dataset.yon));
  }

  el("ingilizce").addEventListener("click", (olay) => {
    const hedef = olay.target.closest(".kelime");
    if (hedef) kelimeSec(Number(hedef.dataset.sira));
  });

  el("durum-ac").addEventListener("click", durumGoster);
  el("durum-kapat").addEventListener("click", () => ekranGoster("calisma-ekrani"));
  el("kart-calis").addEventListener("click", kartCalismayaBasla);
  el("kart-cevir").addEventListener("click", kartCevir);
  el("kart-bilemedim").addEventListener("click", () => kartSonuc("bilemedim"));
  el("kart-zorlandim").addEventListener("click", () => kartSonuc("zorlandim"));
  el("kart-biliyordum").addEventListener("click", () => kartSonuc("biliyordum"));
  el("kart-cikar").addEventListener("click", kartCikar);
  el("kart-daha").addEventListener("click", kartYeniParti);
  el("kart-bitir").addEventListener("click", kartKapat);
  el("kart-kapat").addEventListener("click", kartKapat);

  el("disa-aktar").addEventListener("click", disaAktar);
  el("ice-aktar").addEventListener("click", () => el("dosya-sec").click());
  el("dosya-sec").addEventListener("change", async (olay) => {
    const dosya = olay.target.files[0];
    olay.target.value = "";
    if (dosya) await iceAktarDosya(dosya);
  });
  el("anki-aktar").addEventListener("click", ankiAktar);
}

// --- açılış ---------------------------------------------------------------

async function basla() {
  temaUygula(temaOku());
  vt = await vtAc();
  await dizinYukle();
  await sozlukYukle();
  seviyeDugmeleriniCiz();
  baglantilariKur();

  let yonKayit = null;
  try { yonKayit = localStorage.getItem(YON_ANAHTAR); } catch (e) { /* özel sekme */ }
  durum.yon = (yonKayit === "en_tr" || yonKayit === "tr_en") ? yonKayit : "en_tr";

  const kaydedilen = konumOku();
  const gecerli = kaydedilen
    && durum.dizin.some((s) => s.ad === kaydedilen.seviye);
  durum.seviye = gecerli ? kaydedilen.seviye : durum.dizin[0].ad;
  durum.indeks = gecerli ? kaydedilen.indeks : 0;

  await cumleGoster();
  servisCalisaniKaydet();
  kurulumDurumu();
  window.__arayuzHazir = true;
}

basla();
