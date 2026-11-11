/**
 * Windom front — Leaflet + GeoTIFF (decoded in the browser with geotiff.js).
 * Technical decision: the Worker proxies Météo-France WCS GeoTIFFs (see worker header);
 * the browser decodes U/V rasters, so no GRIB2 / heavy JSON is needed.
 * Internally everything is UTC epoch ms; display uses Réunion time (UTC+4).
 */
import { fromArrayBuffer } from 'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/+esm';

const WORKER_URL = "https://windom.picard-nicolas-run.workers.dev";
const TZ = 4, H = 3600e3;

const I18N = {
  fr: {
    updated: "Mis à jour", next: "Prochaine", wind: "Vent", gust: "Rafales", anim: "Animation",
    ok: "Données chargées", err: "Erreur de chargement", load: "Chargement…",
    from: "de", toward: "vent", now: "Auj."
  },
  en: {
    updated: "Updated", next: "Next", wind: "Wind", gust: "Gusts", anim: "Animation",
    ok: "Data loaded", err: "Loading error", load: "Loading…",
    from: "from", toward: "wind", now: "Today."
  },
};
let lang = navigator.language?.startsWith("en") ? "en" : "fr";
const T = (k) => I18N[lang][k];

const STOPS = [
  [0,   [40, 70, 180]],
  [10,  [40, 150, 220]],
  [20,  [40, 200, 170]],
  [30,  [120, 220, 80]],
  [40,  [240, 220, 60]],
  [55,  [250, 150, 40]],
  [70,  [230, 60, 40]],
  [90,  [180, 30, 120]],
  [110, [120, 20, 160]],
];
const LUT = Array.from({ length: 121 }, (_, k) => {
  let i = STOPS.findIndex(([v]) => v >= k); if (i <= 0) i = 1;
  const [v0, c0] = STOPS[i - 1], [v1, c1] = STOPS[i], f = Math.min(1, (k - v0) / (v1 - v0));
  return c0.map((c, j) => Math.round(c + (c1[j] - c) * f));
});
const rgb = (c) => `rgb(${c.join(",")})`;

const $ = (id) => document.getElementById(id);
const S = { kind: "wind", t: null, day: 0, meta: null, f: null, anim: true, pin: null, token: 0 };
const fmt = (ms) => {
  const d = new Date(ms + TZ * H), p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}h${p(d.getUTCMinutes())}`;
};
function setStatus(s) { $("dot").className = "dot " + s; $("dot").title = T({ ok: "ok", error: "err", loading: "load" }[s]); }

const map = L.map("map", { 
  center: [-21.1, 55.5], 
  zoom: 7, 
  minZoom: 7.5,  
  maxZoom: 12,
  zoomControl: false,
  preferCanvas: true 
});
L.control.zoom({ position: "bottomleft" }).addTo(map);
L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}{r}.png?key=cb1_56p3_1_02e4e5c60e17be46250aad47", {
  attribution: "© OpenStreetMap © CARTO | Météo-France AROME (Etalab)", maxZoom: 12
}).addTo(map);
let colorLayer = null, velocity = null;

async function getTiff(c, t) {
  const r = await fetch(`${WORKER_URL}/api/field?c=${c}&t=${new Date(t).toISOString().replace(/\.\d+Z$/, "Z")}`);
  if (!r.ok) throw new Error(r.status);
  const run = r.headers.get("X-Run"), img = await (await fromArrayBuffer(await r.arrayBuffer())).getImage();
  const [band] = await img.readRasters({ interleave: false });
  return { band, w: img.getWidth(), h: img.getHeight(), bbox: img.getBoundingBox(), run };
}

async function load() {
  const tok = ++S.token; 
  setStatus("loading");
  $("loading-overlay").style.display = "flex";

  try {
    const [a, b, g] = await Promise.all((S.kind === "wind" ? ["u", "v"] : ["u", "v", "g"]).map((c) => getTiff(c, S.t)));
    if (tok !== S.token) return;
    
    S.f = { u: a.band, v: b.band, g: g?.band, w: a.w, h: a.h, bbox: a.bbox };
        
    if (S.f.bbox && !map.options.maxBounds) {
      const [W, Sx, E, N] = S.f.bbox;
      const pad = 0.5;
      
      const bounds = [
        [Sx - pad, W - pad],
        [N + pad, E + pad]
      ];

      map.setMaxBounds(bounds);
      map.options.maxBoundsViscosity = 1.0;

      map.fitBounds(bounds, { padding: [20, 20] });

      setTimeout(() => {
        const currentZoom = map.getZoom();
        map.setMinZoom(currentZoom - 1); 
      }, 100);
    }
    
    if (a.run && S.meta && a.run !== S.meta.run) { 
      S.meta.run = a.run; 
      header(); 
    }
    
    renderColor(); 
    renderVelocity(); 
    refreshPin(); 
    setStatus("ok");
  } catch (e) { 
    console.error(e); 
    if (tok === S.token) setStatus("error"); 
  } finally {
    if (tok === S.token) $("loading-overlay").style.display = "none";
  }
}

/** Nearest-cell lookup -> {u, v (m/s), kmh, dir (meteorological "from" degrees)} or null. */
function sample(ll) {
  const f = S.f; if (!f) return null; const [W, Sx, E, N] = f.bbox;
  const col = Math.floor((ll.lng - W) / (E - W) * f.w), row = Math.floor((N - ll.lat) / (N - Sx) * f.h);
  if (col < 0 || row < 0 || col >= f.w || row >= f.h) return null;
  const u = f.u[row * f.w + col], v = f.v[row * f.w + col]; if (!(Math.abs(u) < 500 && Math.abs(v) < 500)) return null;
  const sp = f.g ? f.g[row * f.w + col] : Math.hypot(u, v); if (!(sp < 500)) return null;
  return { u, v, kmh: sp * 3.6, dir: (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360 };
}

function renderColor() {
  const f = S.f, [W, Sx, E, N] = f.bbox, cv = document.createElement("canvas"); cv.width = f.w; cv.height = f.h;
  const g = cv.getContext("2d"), img = g.createImageData(f.w, f.h), d = img.data;
  const mer = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)), mN = mer(N), mS = mer(Sx);
  for (let j = 0; j < f.h; j++) {
    const lat = (2 * Math.atan(Math.exp(mN - (j + 0.5) / f.h * (mN - mS))) - Math.PI / 2) * 180 / Math.PI;
    const row = Math.min(f.h - 1, Math.floor((N - lat) / (N - Sx) * f.h));
    for (let i = 0; i < f.w; i++) {
      const k = row * f.w + i, u = f.u[k], v = f.v[k], o = (j * f.w + i) * 4;
      if (!(Math.abs(u) < 500)) continue;
      const c = LUT[Math.min(120, Math.round((f.g ? f.g[k] : Math.hypot(u, v)) * 3.6))];
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 145;
    }
  }
  g.putImageData(img, 0, 0);
  if (colorLayer) map.removeLayer(colorLayer);
  colorLayer = L.imageOverlay(cv.toDataURL(), [[Sx, W], [N, E]], { opacity: 1, interactive: false }).addTo(map);
  colorLayer.bringToBack(); map.eachLayer((l) => l instanceof L.TileLayer && l.bringToBack());
}

function renderVelocity() {
  if (velocity) { map.removeLayer(velocity); velocity = null; }
  if (!S.anim || !S.f) return;
  const f = S.f, [W, Sx, E, N] = f.bbox, k = Math.max(1, Math.round(f.w / 350)), res = (E - W) / f.w;
  const nx = Math.floor(f.w / k), ny = Math.floor(f.h / k), uu = [], vv = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = (j * k) * f.w + i * k, u = f.u[p], v = f.v[p]; uu.push(Math.abs(u) < 500 ? u : 0); vv.push(Math.abs(v) < 500 ? v : 0);
  }
  const hdr = (n) => ({
    parameterUnit: "m.s-1", parameterCategory: 2, parameterNumber: n, nx, ny, numberPoints: nx * ny,
    lo1: W + res / 2, la1: N - res / 2, lo2: W + res / 2 + (nx - 1) * k * res, la2: N - res / 2 - (ny - 1) * k * res,
    dx: k * res, dy: k * res, refTime: new Date().toISOString()
  });
  velocity = L.velocityLayer({
    displayValues: false, data: [{ header: hdr(2), data: uu }, { header: hdr(3), data: vv }],
    maxVelocity: 25, velocityScale: 0.006, lineWidth: 1.4, particleMultiplier: 1 / 400,
    colorScale: ["#ffffff", "#e0f2fe", "#fef3c7"]
  }).addTo(map);
}

const tip = L.tooltip({ className: "wtip", direction: "top", offset: [0, -8] });
const txt = (p) => p ? `<b>${p.kmh.toFixed(0)} km/h</b> · ${Math.round(p.dir)}°` : "–";
if (matchMedia("(hover:hover)").matches) {
  map.on("mousemove", (e) => {
    const p = sample(e.latlng);
    tip.setLatLng(e.latlng).setContent(txt(p)); if (!map.hasLayer(tip)) tip.addTo(map);
    $("cursor").innerHTML = `${e.latlng.lat.toFixed(3)}, ${e.latlng.lng.toFixed(3)} — ${txt(p)}`;
  });
  map.on("mouseout", () => map.removeLayer(tip));
}
let pinMarker = L.circleMarker([0, 0], { radius: 6, color: "#fff", fillColor: "#38bdf8", fillOpacity: 1 });
map.on("click", (e) => { S.pin = e.latlng; refreshPin(); });
function refreshPin() {
  if (!S.pin) return; pinMarker.setLatLng(S.pin).addTo(map).unbindTooltip()
    .bindTooltip(txt(sample(S.pin)), { className: "wtip", permanent: true, direction: "top", offset: [0, -8] });
}

const dayStart = (off) => {
  const d = new Date(Date.now() + TZ * H);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + off) - TZ * H;
};
const valid = (t) => S.meta && t >= Date.parse(S.meta.validFrom) && t <= Date.parse(S.meta.validTo);

function renderTime() {
  $("dates").innerHTML = ""; $("hours").innerHTML = "";
  
  [0, 1, 2].forEach((off, i) => { 
    const d = new Date(Date.now() + TZ * H + off * 24 * H);
    const days = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
    const dayName = days[d.getUTCDay()];
    const dayNum = d.getUTCDate();
    
    const b = document.createElement("button"); 
    b.innerHTML = `<span style="font-size:12px;">${dayName} ${dayNum}</span>`;
    b.className = off === S.day ? "sel" : ""; 
    b.onclick = () => pickDay(off); 
    $("dates").append(b); 
  });
  
  for (let h = 0; h < 24; h += 3) { 
    const t = dayStart(S.day) + h * H, b = document.createElement("button");
    b.textContent = String(h).padStart(2, "0") + "h"; 
    b.disabled = !valid(t); 
    b.className = t === S.t ? "sel" : ""; 
    b.onclick = () => { S.t = t; renderTime(); load(); }; 
    $("hours").append(b); 
  }
}

function pickDay(off) {
  const hr = S.t != null ? Math.round(((S.t - dayStart(S.day)) / H) / 3) * 3 : 12; S.day = off;
  const cells = [...Array(8)].map((_, i) => dayStart(off) + i * 3 * H).filter(valid);
  S.t = cells.sort((a, b) => Math.abs(a - (dayStart(off) + hr * H)) - Math.abs(b - (dayStart(off) + hr * H)))[0] ?? S.t;
  renderTime(); load();
}

function header() { 
  const pubDate = S.meta.lastPublished ? Date.parse(S.meta.lastPublished) : Date.parse(S.meta.run) + 8 * H;
  $("last").textContent = fmt(pubDate);
  
  $("next").textContent = fmt(Date.parse(S.meta.nextRun)); 
}

function legend() {
  $("legend").innerHTML = `<div class="lab"><span>km/h</span></div><div class="bar" style="background:linear-gradient(90deg,${STOPS.map(([v, c]) => `${rgb(c)} ${v / 1.2}%`).join(",")})"></div><div class="lab"><span>0</span><span>30</span><span>60</span><span>90</span><span>120</span></div>`;
}
function applyLang() {
  document.documentElement.lang = lang; $("lang").textContent = lang === "fr" ? "EN" : "FR";
  document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = T(el.dataset.i18n)));
  $("kind").textContent = T(S.kind); setStatus($("dot").className.split(" ")[1]); renderTime();
}

$("lang").onclick = () => { lang = lang === "fr" ? "en" : "fr"; applyLang(); };
$("kind").onclick = () => { S.kind = S.kind === "wind" ? "gust" : "wind"; $("kind").textContent = T(S.kind); load(); };
$("collapse").onclick = () => $("hud").classList.toggle("collapsed");
if (innerWidth < 700) $("hud").classList.add("collapsed");

(async function init() {
  legend(); applyLang();
  try {
    S.meta = await (await fetch(`${WORKER_URL}/api/meta`)).json(); 
    header();
    const now = Date.now(), cells = [...Array(8)].map((_, i) => dayStart(0) + i * 3 * H).filter(valid);
    S.t = cells.filter((t) => t <= now).pop() ?? cells[0] ?? Date.parse(S.meta.validFrom);
    renderTime(); load();
  } catch (e) { console.error(e); setStatus("error"); }
})();
