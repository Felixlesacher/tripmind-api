import { NextResponse } from "next/server";

// ----- DACH-Whitelist für Startflughäfen -----
const DACH_IATA = new Set([
  // DE
  "BER","BRE","CGN","DTM","DRS","DUS","FRA","HHN","FDH","HAM","HAJ","FKB","LEJ","FMM","MUC","FMO","NUE","PAD","STR","NRN",
  // AT
  "GRZ","INN","KLU","LNZ","SZG","VIE",
  // CH
  "BSL","BRN","GVA","LUG","SIR","ACH","ZRH"
]);

// ----- OAuth Token Cache im Speicher -----
let tokenCache = { token: null, expiresAt: 0 };

async function getAmadeusToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 60_000) return tokenCache.token;

  const url = "https://test.api.amadeus.com/v1/security/oauth2/token";
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
  if (!resp.ok) throw new Error("Amadeus OAuth failed: " + (await resp.text()));

  const data = await resp.json();
  tokenCache.token = data.access_token;
  tokenCache.expiresAt = Date.now() + (data.expires_in || 0) * 1000;
  return tokenCache.token;
}

// ISO-8601 "PT7H30M" -> 7.5
function isoDurationToHours(iso) {
  if (!iso || !iso.startsWith("PT")) return 0;
  const h = (iso.match(/(\d+)H/) || [])[1];
  const m = (iso.match(/(\d+)M/) || [])[1];
  const hours = (h ? parseInt(h) : 0) + (m ? parseInt(m)/60 : 0);
  return Math.round(hours*10)/10;
}

// CORS
function withCORS(res, origin) {
  const allowed = process.env.ALLOWED_ORIGIN || "";
  const devAllowed = ["http://localhost:3000", "http://127.0.0.1:3000"];
  if (origin && (origin === allowed || devAllowed.includes(origin))) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Vary", "Origin");
  }
  res.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return res;
}

export async function OPTIONS(request) {
  const res = NextResponse.json({}, { status: 204 });
  return withCORS(res, request.headers.get("origin"));
}

export async function POST(request) {
  try {
    const { origin, destination, departDate, returnDate, adults = 1, currency = "EUR", maxFlightHours } = await request.json();

    const bad = v => v===undefined || v===null || (typeof v==="string" && v.trim()==="");
    if (bad(origin) || bad(destination) || bad(departDate) || !adults) {
      return withCORS(NextResponse.json({ error: "Missing required fields" }, { status: 400 }), request.headers.get("origin"));
    }

    const ORI = String(origin).toUpperCase().slice(0,3);
    const DST = String(destination).toUpperCase().slice(0,3);
    if (!DACH_IATA.has(ORI)) {
      return withCORS(NextResponse.json({ error: "Origin not allowed (DACH only)" }, { status: 400 }), request.headers.get("origin"));
    }

    const token = await getAmadeusToken();

    const params = new URLSearchParams({
      originLocationCode: ORI,
      destinationLocationCode: DST,
      departureDate: departDate,
      adults: String(Math.min(Math.max(Number(adults)||1, 1), 9)),
      currencyCode: currency || "EUR",
      max: "20",
      nonStop: "false"
    });
    if (returnDate) params.set("returnDate", returnDate);

    const url = `https://test.api.amadeus.com/v2/shopping/flight-offers?${params.toString()}`;
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store"
    });

    if (!resp.ok) {
      return withCORS(NextResponse.json({ error: "Amadeus API error", details: await resp.text() }, { status: resp.status }), request.headers.get("origin"));
    }

    const data = await resp.json();
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
          (offer?.itineraries||[]).flatMap(it => (it?.segments||[]).map(s => s?.carrierCode)).filter(Boolean)
        )
      ));
      const totalDurationHours = Math.round(itineraries.reduce((sum, it)=> sum + (it.durationHours||0), 0)*10)/10;
      return { price, currency: currencyCode, totalDurationHours, itineraries, airlines };
    });

    const filtered = (maxFlightHours && Number(maxFlightHours)>0)
      ? items.filter(x => x.totalDurationHours <= Number(maxFlightHours))
      : items;

    const res = NextResponse.json({
      query: { origin: ORI, destination: DST, departDate, returnDate: returnDate||null, adults, currency, maxFlightHours: maxFlightHours||null },
      fetchedAt: new Date().toISOString(),
      count: filtered.length,
      results: filtered
    });
    return withCORS(res, request.headers.get("origin"));
  } catch (e) {
    const res = NextResponse.json({ error: "Server error", details: String(e?.message || e) }, { status: 500 });
    return withCORS(res, request.headers.get("origin"));
  }
}
