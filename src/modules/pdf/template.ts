import { readFileSync } from "node:fs";
import { type CurrencyFormat, formatMoney } from "../../lib/money.ts";
import type { PackageDetailDto, PriceTable } from "../packages/read.ts";

/*
 * The itinerary PDF, as print HTML for Chrome. Built only from package data (never from the website's markup).
 * Bump TEMPLATE_VERSION whenever the layout changes: every package then gets a fresh PDF on its next download.
 */
export const TEMPLATE_VERSION = 1;

/** Mona Sans, embedded so printing needs no network and every server prints the same PDF. */
const font = (file: string) =>
  `data:font/woff2;base64,${readFileSync(new URL(`../../assets/fonts/${file}`, import.meta.url)).toString("base64")}`;
const FONT_FACES = `
@font-face { font-family: "Mona Sans"; font-weight: 200 900; font-stretch: 75% 125%; src: url(${font("mona-sans-latin.woff2")}) format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
@font-face { font-family: "Mona Sans"; font-weight: 200 900; font-stretch: 75% 125%; src: url(${font("mona-sans-latin-ext.woff2")}) format("woff2");
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }`;

export type Branding = "with-logo" | "without-logo";

export interface PdfImages {
  logo: string;
  hero: string | null;
  gallery: string[];
}

export interface PdfMeta {
  version: number;
  updatedAt: Date;
  currencies: CurrencyFormat[];
  siteUrl: string;
}

const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const MEALS: Record<string, string> = { BREAKFAST: "Breakfast", LUNCH: "Lunch", DINNER: "Dinner" };
const PRICE_ROWS = [
  ["ADULT", "Adult (12+)"],
  ["CHILD", "Child (2 to 11)"],
  ["INFANT", "Infant (under 2)"],
] as const;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "10:30" -> "10:30 AM". */
function clock(time: string) {
  const [h, m] = time.split(":").map(Number) as [number, number];
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

const date = (value: Date) => value.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric", timeZone: "UTC" });

/** Bidi-isolated so right-to-left symbols (د.إ) sit correctly before the number. */
const money = (amount: number | undefined, currency: CurrencyFormat) => {
  if (amount === undefined) return "On request";
  const text = formatMoney(amount, currency);
  return `<bdi>${esc(currency.symbol)}</bdi>${esc(text.slice(currency.symbol.length))}`;
};

function mealSummary(pkg: PackageDetailDto) {
  const counts = new Map<string, number>();
  for (const day of pkg.itinerary) for (const meal of day.meals) counts.set(meal, (counts.get(meal) ?? 0) + 1);
  if (!counts.size) return "As per itinerary";
  return ["BREAKFAST", "LUNCH", "DINNER"]
    .filter((meal) => counts.has(meal))
    .map((meal) => plural(counts.get(meal)!, MEALS[meal]!.toLowerCase()))
    .join(", ")
    .replace(/^./, (c) => c.toUpperCase());
}

function staySummary(pkg: PackageDetailDto) {
  const hotels = pkg.hotels.filter((hotel) => hotel.isDefault);
  if (hotels.length) {
    return hotels.map((hotel) => `${hotel.name}${hotel.starCategory ? ` (${hotel.starCategory}-star)` : ""}, ${plural(hotel.nights, "night")}`).join("; ");
  }
  const nights = new Map<string, number>();
  for (const day of pkg.itinerary) if (day.stay) nights.set(day.stay, (nights.get(day.stay) ?? 0) + 1);
  return [...nights].map(([city, count]) => `${city}, ${plural(count, "night")}`).join("; ") || "As per itinerary";
}

function transferSummary(pkg: PackageDetailDto) {
  const included = pkg.inclusions.filter((item) => /transfer|car and driver|private car|coach/i.test(item.title));
  return included.length ? included.map((item) => item.title).join("; ") : "See what's included";
}

function priceTable(prices: PriceTable, currencies: CurrencyFormat[]) {
  if (!currencies.length) return "";
  return `<table class="prices">
    <thead><tr><th>Per person</th>${currencies.map((c) => `<th>${esc(c.code)}</th>`).join("")}</tr></thead>
    <tbody>${PRICE_ROWS.map(
      ([type, label]) =>
        `<tr><td>${label}</td>${currencies.map((c) => `<td class="amount">${money(prices[type][c.code], c)}</td>`).join("")}</tr>`,
    ).join("")}</tbody>
  </table>`;
}

export function itineraryHtml(pkg: PackageDetailDto, branding: Branding, images: PdfImages, meta: PdfMeta) {
  const place = pkg.destination.kind === "COUNTRY" ? pkg.destination.name : `${pkg.destination.name}, ${pkg.destination.country.name}`;
  const from = pkg.branch.airport;
  const contact = [
    pkg.branch.whatsapp ? `WhatsApp +${pkg.branch.whatsapp}` : null,
    `Phone ${pkg.branch.phone}`,
    pkg.branch.email,
    `${meta.siteUrl.replace(/^https?:\/\//, "")}/packages/${pkg.slug}`,
  ].filter(Boolean);
  const [lead, ...rest] = images.gallery;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(pkg.title)} itinerary</title>
<style>${FONT_FACES}
@page { size: A4; margin: 14mm 14mm 18mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; font-family: "Mona Sans", system-ui, sans-serif; color: #0e2238; font-size: 9.6pt; line-height: 1.55; }
.label { font-size: 6.6pt; font-stretch: 112%; font-weight: 600; letter-spacing: .12em; text-transform: uppercase; color: #4f6276; }
.code { font-stretch: 125%; font-weight: 800; letter-spacing: .02em; color: #00386c; }
.display { font-stretch: 116%; font-weight: 680; letter-spacing: -0.03em; color: #00386c; line-height: 1.04; }
.head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 5mm; border-bottom: 1px solid #d6e0ea; }
.head img, .head .logo-space { height: 12mm; }
.head .logo-space { display: block; width: 40mm; }
.tag { background: #fccc50; color: #002142; padding: 1.6mm 3mm; border-radius: 0 2.6mm 0 2.6mm; font-size: 6.8pt; font-stretch: 112%; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.place { margin: 7mm 0 0; color: #005894; font-weight: 600; }
h1 { font-size: 27pt; margin: 2mm 0 2.5mm; }
.tagline { font-size: 11pt; color: #4f6276; margin: 0 0 6mm; max-width: 150mm; }
.photos { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); grid-template-rows: repeat(2, minmax(0, 1fr)); gap: 2.5mm; height: 74mm; }
.photos.single { grid-template-columns: minmax(0, 1fr); }
.photos img { width: 100%; height: 100%; object-fit: cover; border-radius: 0 5mm 0 5mm; display: block; }
.photos img:first-child { grid-row: span 2; }
.pass { margin-top: 6mm; display: grid; grid-template-columns: 1.4fr 1fr 1.2fr; border: 1px solid #d6e0ea; border-radius: 0 6mm 0 6mm; }
.pass > div { padding: 4mm 5mm; border-left: 2px dashed #d6e0ea; }
.pass > div:first-child { border-left: 0; }
.pass .code { font-size: 13pt; margin-top: 1.5mm; white-space: nowrap; }
.pass .val { margin-top: 1.5mm; font-weight: 600; color: #00386c; }
.summary { margin-top: 5mm; display: grid; grid-template-columns: 1fr 1fr; gap: 3mm 8mm; }
.summary > div { border-left: 2px solid #fccc50; padding-left: 4mm; }
.summary p { margin: 1mm 0 0; }
h2 { font-size: 15pt; margin: 9mm 0 3.5mm; }
.overview p { margin: 0 0 2.5mm; font-size: 10pt; }
.bullets { display: grid; grid-template-columns: 1fr 1fr; gap: 1.6mm 6mm; padding: 0; margin: 4mm 0 0; list-style: none; }
.bullets li { padding-left: 5mm; position: relative; }
.bullets li::before { content: ""; position: absolute; left: 0; top: 1.6mm; width: 2.4mm; height: 2.4mm; background: #fccc50; border-radius: 0 1mm 0 1mm; }
.day { display: grid; grid-template-columns: 13mm 1fr; gap: 4.5mm; padding: 3.2mm 0; break-inside: avoid; border-top: 1px solid #e6edf4; }
.keep > .day { border-top: 0; }
.badge { background: #00386c; color: #fff; border-radius: 0 3mm 0 3mm; height: 13mm; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.badge small { font-size: 5.6pt; letter-spacing: .14em; color: #fccc50; font-weight: 700; font-stretch: 112%; }
.badge b { font-size: 12pt; font-stretch: 125%; line-height: 1; }
.day h3 { margin: .5mm 0 1mm; font-size: 11pt; color: #00386c; }
.day p { margin: 0; color: #2b3d52; }
.timeline { margin: 2mm 0 0; padding: 0; list-style: none; border-left: 1.5px dashed #c5d3e0; }
.timeline li { padding: 0 0 1.4mm 4mm; position: relative; }
.timeline li::before { content: ""; position: absolute; left: -1.6mm; top: 1.4mm; width: 2.6mm; height: 2.6mm; border-radius: 50%; background: #fff; border: 1.5px solid #005894; }
.timeline .time { font-weight: 700; color: #005894; margin-right: 2mm; }
.meta { margin-top: 1.4mm !important; font-size: 8.4pt; color: #4f6276 !important; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; }
.box { border: 1px solid #d6e0ea; border-radius: 0 5mm 0 5mm; padding: 4.5mm 5mm; }
.box h3 { margin: 0 0 2.5mm; font-size: 10pt; color: #00386c; }
.box ul { margin: 0; padding-left: 4mm; }
.box li { margin: 0 0 1.2mm; }
.prices { width: 100%; border-collapse: collapse; }
.prices th, .prices td { text-align: left; padding: 2.2mm 3mm; border-bottom: 1px solid #e6edf4; }
.prices th { font-size: 6.6pt; letter-spacing: .12em; text-transform: uppercase; color: #4f6276; font-weight: 600; }
.prices .amount { font-weight: 700; color: #00386c; font-size: 11pt; }
.note { font-size: 8.2pt; color: #4f6276; margin-top: 2mm; }
.facts { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm 8mm; }
.facts > div { border-left: 2px solid #fccc50; padding-left: 4mm; }
.facts p { margin: 1mm 0 0; }
.info { margin: 4mm 0 0; padding-left: 4mm; }
.info li { margin-bottom: 1.2mm; }
.terms { font-size: 8.2pt; color: #4f6276; padding-left: 4mm; }
.contact { margin-top: 9mm; padding: 5mm 6mm; background: #002142; color: #fff; border-radius: 0 6mm 0 6mm; display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; break-inside: avoid; }
.contact .label { color: #fccc50; }
.contact p { margin: 1.2mm 0 0; color: rgba(255,255,255,.88); }
.version { margin-top: 4mm; font-size: 7.4pt; color: #4f6276; }
.keep { break-inside: avoid; }
</style></head><body>
<div class="head">${
    branding === "with-logo" ? `<img src="${images.logo}" alt="GETSET Tours &amp; Travels">` : `<span class="logo-space"></span>`
  }<span class="tag">${esc(pkg.branch.name)} branch itinerary</span></div>
<p class="place">${esc(place)}${pkg.category ? ` · ${esc(pkg.category.name)}` : ""}</p>
<h1 class="display">${esc(pkg.title)}</h1>
<p class="tagline">${esc(pkg.shortDescription)}</p>
${
  images.hero
    ? `<div class="photos${lead ? "" : " single"}"><img src="${images.hero}" alt="">${[lead, ...rest].filter(Boolean).slice(0, 2).map((src) => `<img src="${src}" alt="">`).join("")}</div>`
    : ""
}
<div class="pass">
  <div><div class="label">Route</div><div class="code">${esc(from?.code ?? "")}${pkg.arrival ? ` &rarr; ${esc(pkg.arrival.code)}` : ""}</div></div>
  <div><div class="label">Duration</div><div class="val">${plural(pkg.duration.days, "day")}, ${plural(pkg.duration.nights, "night")}</div></div>
  <div><div class="label">Best time</div><div class="val">${esc(pkg.bestTime ?? "All year")}</div></div>
</div>
<div class="summary">
  <div><div class="label">Destination</div><p>${esc(place)}</p></div>
  <div><div class="label">Hotel</div><p>${esc(staySummary(pkg))}</p></div>
  <div><div class="label">Meals</div><p>${esc(mealSummary(pkg))}</p></div>
  <div><div class="label">Transfers</div><p>${esc(transferSummary(pkg))}</p></div>
</div>

${pkg.overview.length ? `<h2 class="display">Overview</h2><div class="overview">${pkg.overview.map((p) => `<p>${esc(p)}</p>`).join("")}</div>` : ""}
${pkg.highlights.length ? `<ul class="bullets">${pkg.highlights.map((h) => `<li>${esc(h.title)}</li>`).join("")}</ul>` : ""}

${pkg.itinerary
  .map(
    (day, index) => `${index === 0 ? '<div class="keep"><h2 class="display">Day by day</h2>' : ""}<div class="day"><div class="badge"><small>DAY</small><b>${String(day.dayNumber).padStart(2, "0")}</b></div><div>
<h3>${esc(day.title)}</h3>${day.description ? `<p>${esc(day.description)}</p>` : ""}
${
  day.activities.length
    ? `<ul class="timeline">${day.activities
        .map((a) => `<li>${a.time ? `<span class="time">${clock(a.time)}</span>` : ""}${esc(a.title)}${a.location ? `, ${esc(a.location)}` : ""}${a.description ? `<br><span class="meta">${esc(a.description)}</span>` : ""}</li>`)
        .join("")}</ul>`
    : ""
}
${
  day.stay || day.hotel || day.meals.length
    ? `<p class="meta">${[
        day.hotel ? `Overnight at ${esc(day.hotel.name)}` : day.stay ? `Overnight in ${esc(day.stay)}` : "",
        day.meals.length ? `Meals: ${day.meals.map((m) => MEALS[m]).join(" + ")}` : "",
      ]
        .filter(Boolean)
        .join("&nbsp;&nbsp;&middot;&nbsp;&nbsp;")}</p>`
    : ""
}
</div></div>${index === 0 ? "</div>" : ""}`,
  )
  .join("")}

<div class="keep"><h2 class="display">Prices</h2>
${priceTable(pkg.prices, meta.currencies)}
<p class="note">Per person on twin sharing, land only. Final prices depend on travel dates and availability, and are confirmed when you book.</p></div>

${
  pkg.inclusions.length || pkg.exclusions.length
    ? `<div class="keep"><h2 class="display">What&rsquo;s included</h2><div class="cols">
<div class="box"><h3>Included</h3><ul>${pkg.inclusions.map((i) => `<li>${esc(i.title)}</li>`).join("")}</ul></div>
<div class="box"><h3>Not included</h3><ul>${pkg.exclusions.map((i) => `<li>${esc(i.title)}</li>`).join("")}</ul></div></div></div>`
    : ""
}

<div class="keep"><h2 class="display">Good to know</h2>
${pkg.destination.facts.length ? `<div class="facts">${pkg.destination.facts.map((f) => `<div><div class="label">${esc(f.label)}</div><p>${esc(f.value)}</p></div>`).join("")}</div>` : ""}
${pkg.importantInfo.length ? `<ul class="info">${pkg.importantInfo.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : ""}</div>
${pkg.terms.length ? `<div class="keep"><h2 class="display">Terms and conditions</h2><ol class="terms">${pkg.terms.map((t) => `<li>${esc(t)}</li>`).join("")}</ol></div>` : ""}

<div class="contact">
  <div><div class="label">Book this trip</div><p>${contact.map(esc).join("<br>")}</p></div>
  <div><div class="label">${esc(pkg.branch.name)} office</div><p>${pkg.branch.addressLines.map(esc).join("<br>")}</p></div>
</div>
<p class="version">Version ${meta.version} &nbsp;·&nbsp; Updated ${date(meta.updatedAt)}</p>
</body></html>`;
}

export function footerTemplate(pkg: PackageDetailDto, meta: PdfMeta) {
  return `<div style="width:100%;font:7px system-ui,sans-serif;color:#4f6276;padding:0 14mm;display:flex;justify-content:space-between"><span>GETSET Tours &amp; Travels &nbsp;|&nbsp; ${esc(pkg.title)} &nbsp;|&nbsp; Version ${meta.version}, ${date(meta.updatedAt)}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
}
