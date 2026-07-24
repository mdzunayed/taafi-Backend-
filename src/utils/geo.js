// Small geo helpers for the admin dispatch console. Kept dependency-free
// (no PostGIS / turf) — the dispatch roster only needs a coarse
// straight-line distance to sort/label providers by proximity to the
// patient, not routing-grade accuracy.

const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// Great-circle distance in kilometres between two {lat,lng} points.
// Returns `null` when any coordinate is missing/non-finite so callers can
// fall back to a stored `distance_km` rather than rendering a bogus 0 km.
function haversineKm(lat1, lng1, lat2, lng2) {
  const a = [lat1, lng1, lat2, lng2].map(Number);
  if (a.some((v) => !Number.isFinite(v))) return null;
  const [la1, lo1, la2, lo2] = a;
  const dLat = toRad(la2 - la1);
  const dLng = toRad(lo2 - lo1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_KM * c;
}

// Pull {latitude, longitude} out of a location sub-doc that may be stored
// in either the flat shape (`{latitude, longitude}`, the Account schema)
// or GeoJSON (`{coordinates: [lng, lat]}`, what the /doctor/location
// heartbeat writes). Returns `null` when neither shape yields a fix.
function readLatLng(loc) {
  if (!loc || typeof loc !== 'object') return null;
  const lat = Number(loc.latitude);
  const lng = Number(loc.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  if (Array.isArray(loc.coordinates) && loc.coordinates.length === 2) {
    const gLng = Number(loc.coordinates[0]);
    const gLat = Number(loc.coordinates[1]);
    if (Number.isFinite(gLat) && Number.isFinite(gLng)) {
      return { lat: gLat, lng: gLng };
    }
  }
  return null;
}

module.exports = { haversineKm, readLatLng };
