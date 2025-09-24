// app/api/flight-search/route.js
import { NextResponse } from "next/server";

// -----------------------------------------------------
// DACH-Whitelist für Startflughäfen (Origin-Filter MVP)
// -----------------------------------------------------
const DACH_IATA = new Set([
  // DE
  "BER","BRE","CGN","DTM","DRS","DUS","FRA","HHN","FDH","HAM","HAJ","FKB","LEJ","FMM","MUC","FMO","NUE","PAD","STR","NRN",
  // AT
  "GRZ","INN","KLU","LNZ","SZG","VIE",
  // CH
  "BSL","BRN","GVA","LUG","SIR","ACH","ZRH"
]);

// -------------------------------------
// In-Memory OAuth Token Cache (Amadeus)
// -------------------------------------
let tokenCache = { token: null, expiresAt: 0 };

async function getAmadeusToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 60_000) {
    return tokenCache.token;
  }

  const base =
    (process.env.AMADEUS_ENV || "test") === "production"
      ? "https://api.amadeus.com"
      : "https://test.api.amadeus.com";

  const url = base + "/v1/security/oauth2/token";
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.AMADEUS_CLIENT_ID || "",
    client_secret: process.env.AMADEUS_CLIENT_SECRET || ""
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error("Amadeus OAuth failed: " + txt);
  }

  const data = await resp.json();
  tokenCache.token = data.access_token;
  tokenCache.expiresAt = Date.now() + (data.expires_in || 0) * 1000;
  return tokenCache.token;
}

// ---------------------------------------------
// Utils: ISO-8601 Dauer "PT7H30M" -> 7.5 Stunden
// ---------------------------------------------
function isoDurationToHours(iso) {
  if (!iso || !iso.startsWith("PT")) return 0;
  const h = (iso.match(/(\d+)H/) || [])[1];
  const m = (iso.match(/(\d+)M/) || [])[1];
  const hours = (h ? parseInt(h) : 0) + (m ? parseInt(m) / 60 : 0);
  return Math.round(hours * 10) / 10;
}

// ---------------------------------------------------
// CORS-Helpers: mehrere Origins via ALLOWED_ORIGINS
// ---------------------------------------------------
function parseAllowedOrigins() {
  const multi = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const single = (process.env.ALLOWED_ORIGIN || "").trim();
  const base = [...multi, single].filter(Boolean);
  // lokale Dev-Origins optional zulassen
  const dev = ["http://localhost:3000", "http://127.0.0.1:3000"];
  return [...new Set([...base, ...dev])];
}

function withCORS(res, origin) {
  const allowedOrigins = parseAllowedOrigins();
  if (origin && allowedOrigins.some(a => a === origin)) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Vary", "Origin");
  }
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return res;
}

// -----------------------------
// Preflight (OPTIONS) Handler
// -----------------------------
export async function OPTIONS(request) {
  const res = NextResponse.json({}, { status: 204 });
  return withCORS(res, request.headers.get("origin"));
}

// -----------------------------
// POST /api/flight-search
// -----------------------------
export async function POST(request) {
  try {
    const {
      origin,            // "STR"
      destination,       // "PMI"
      departDate,        // "YYYY-MM-DD"
      returnDate,        // optional "YYYY-MM-DD"
      adults = 1,        // 1..9
      currency = "EUR",  // "EUR" | "USD" | "CHF" ...
      maxFlightHours     // optional number (summe out+in)
    } = await request.json();

    // --- Validierung
    const bad = v => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
    if (bad(origin) || bad(destination) || bad(departDate) || !adults) {
      const res = NextResponse.json({ error: "Missing required fields" }, { status: 400 });
      return withCORS(res, request.headers.get("origin"));
    }

    const ORI = String(origin).toUpperCase().slice(0, 3);
    const DST = String(destination).toUpperCase().slice(0, 3);

    // DACH-Whitelist nur für origin
    if (!DACH_IATA.has(ORI)) {
      const res = NextResponse.json({ error: "Origin not allowed (DACH only)" }, { status: 400 });
      return withCORS(res, request.headers.get("origin"));
    }

    // --- OAuth Token
    const token = await getAmadeusToken();

    // --- Base URL je nach Env
    const base =
      (process.env.AMADEUS_ENV || "test") === "production"
        ? "https://api.amadeus.com"
        : "https://test.api.amadeus.com";

    // --- Query-Parameter (GET /v2/shopping/flight-offers)
    const params = new URLSearchParams({
      originLocationCode: ORI,
      destinationLocationCode: DST,
      departureDate: departDate,
      adults: String(Math.min(Math.max(Number(adults) || 1, 1), 9)),
      currencyCode: currency || "EUR",
      max: "20",
      nonStop: "false"
    });
    if (returnDate) params.set("returnDate", returnDate);

    const url = `${base}/v2/shopping/flight-offers?${params.toString()}`;

    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store"
    });

    if (!resp.ok) {
      const txt = await resp.text();
      const res = NextResponse.json({ error: "Amadeus API error", details: txt }, { status: resp.status });
      return withCORS(res, request.headers.get("origin"));
    }

    const data = await resp.json();

    // --- Normalisieren
    const items = (data?.data || []).map(offer => {
      const price = offer?.price?.total ?? null;
      const currencyCode = offer?.price?.currency ?? currency;

      const itineraries = (offer?.itineraries || []).map(it => {
        const durationHours = isoDurationToHours(it?.duration);
        const segments = (it?.segments || []).map(s => ({
          from: s?.departure?.iataCode,
          to: s?.arrival?.iataCode,
          depart: s?.departure?.at,
          arrive: s?.arrival?.at,
          carrier: s?.carrierCode,
          number: s?.number
        }));
        return { durationHours, segments };
      });

      const airlines = Array.from(new Set(
        (offer?.validatingAirlineCodes || []).concat(
          (offer?.itineraries || []).flatMap(it => (it?.segments || []).map(s => s?.carrierCode)).filter(Boolean)
        )
      ));

      const totalDurationHours = Math.round(
        itineraries.reduce((sum, it) => sum + (it.durationHours || 0), 0) * 10
      ) / 10;

      return { price, currency: currencyCode, totalDurationHours, itineraries, airlines };
    });

    // --- Optional: maxFlightHours (Summe Out+Return) filtern
    const filtered =
      (maxFlightHours && Number(maxFlightHours) > 0)
        ? items.filter(x => x.totalDurationHours <= Number(maxFlightHours))
        : items;

    const res = NextResponse.json({
      query: { origin: ORI, destination: DST, departDate, returnDate: returnDate || null, adults, currency, maxFlightHours: maxFlightHours || null },
      fetchedAt: new Date().toISOString(),
      count: filtered.length,
      results: filtered
    });

    return withCORS(res, request.headers.get("origin"));
  } catch (e) {
    const res = NextResponse.json(
      { error: "Server error", details: String(e?.message || e) },
      { status: 500 }
    );
    return withCORS(res, request.headers.get("origin"));
  }
}
