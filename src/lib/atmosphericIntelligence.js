const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');

// ── Cardinal direction → degrees the wind comes FROM ─────────────────────────
const CARDINAL_MAP = {
  N:0, NNE:22.5, NE:45, ENE:67.5, E:90, ESE:112.5, SE:135, SSE:157.5,
  S:180, SSW:202.5, SW:225, WSW:247.5, W:270, WNW:292.5, NW:315, NNW:337.5,
};
function parseBearing(dir) {
  if (!dir) return null;
  const u = String(dir).trim().toUpperCase();
  if (CARDINAL_MAP[u] !== undefined) return CARDINAL_MAP[u];
  const n = parseFloat(dir);
  return isNaN(n) ? null : n;
}

// ── Drift corridor: 3 downwind collection zones at 5/10/20 miles ─────────────
function calculateDriftZones(lat, lng, windDirText) {
  const fromDeg = parseBearing(windDirText);
  if (lat == null || lng == null || fromDeg === null) return null;

  const downwind = (fromDeg + 180) % 360;
  const R = 3958.8;
  const lat1 = lat * Math.PI / 180;
  const lng1 = lng * Math.PI / 180;
  const b = downwind * Math.PI / 180;

  return [5, 10, 20].map(miles => {
    const d = miles / R;
    const lat2 = Math.asin(Math.sin(lat1)*Math.cos(d) + Math.cos(lat1)*Math.sin(d)*Math.cos(b));
    const lng2 = lng1 + Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(lat1), Math.cos(d)-Math.sin(lat1)*Math.sin(lat2));
    return {
      miles,
      lat: parseFloat((lat2 * 180 / Math.PI).toFixed(5)),
      lng: parseFloat((lng2 * 180 / Math.PI).toFixed(5)),
      bearing: Math.round(downwind),
    };
  });
}

// ── OpenSky Network — current state vectors in a 50-mile bounding box ─────────
async function fetchNearbyFlights(lat, lng) {
  try {
    const lamin = (lat - 0.75).toFixed(4);
    const lamax = (lat + 0.75).toFixed(4);
    const lomin = (lng - 0.90).toFixed(4);
    const lomax = (lng + 0.90).toFixed(4);
    const url = `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const states = data?.states || [];
    return states
      .map(s => ({
        icao24:     s[0],
        callsign:   (s[1] || '').trim(),
        origin:     s[2],
        lat:        s[6],
        lng:        s[5],
        altitude_m: s[7],
        on_ground:  s[8],
        velocity_ms:s[9],
        heading:    s[10],
      }))
      .filter(s => !s.on_ground && s.altitude_m != null && s.altitude_m > 1000);
  } catch (e) {
    console.log('[atmos-intel] OpenSky unavailable (non-fatal):', e.message);
    return null;
  }
}

// ── NOAA api.weather.gov — recent humidity/temp at nearest NWS station ────────
async function fetchWeatherConditions(lat, lng) {
  const headers = {
    'User-Agent': 'Mycelium Community Watch (mycelium.unprecedentedtimes.org)',
    Accept: 'application/geo+json',
  };
  try {
    // 1. Get NWS grid point
    const ptRes = await fetch(
      `https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`,
      { signal: AbortSignal.timeout(8000), headers }
    );
    if (!ptRes.ok) return null;
    const ptData = await ptRes.json();
    const stationsUrl = ptData?.properties?.observationStations;
    if (!stationsUrl) return null;

    // 2. Get nearest station
    const stRes = await fetch(stationsUrl, { signal: AbortSignal.timeout(8000), headers });
    if (!stRes.ok) return null;
    const stData = await stRes.json();
    const stationId = stData?.features?.[0]?.properties?.stationIdentifier;
    if (!stationId) return null;

    // 3. Get most recent observations (last 3 hours)
    const start = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const obsRes = await fetch(
      `https://api.weather.gov/stations/${stationId}/observations?start=${start}&limit=5`,
      { signal: AbortSignal.timeout(8000), headers }
    );
    if (!obsRes.ok) return null;
    const obsData = await obsRes.json();
    const obs = obsData?.features?.[0]?.properties;
    if (!obs) return null;

    return {
      station:      stationId,
      humidity_pct: obs.relativeHumidity?.value ?? null,
      temp_c:       obs.temperature?.value ?? null,
      description:  obs.textDescription || null,
      obs_time:     obs.timestamp || null,
    };
  } catch (e) {
    console.log('[atmos-intel] NOAA weather unavailable (non-fatal):', e.message);
    return null;
  }
}

// ── EPA ECHO — TRI reporters near the sample location ────────────────────────
async function fetchTRINearby(lat, lng) {
  try {
    const params = new URLSearchParams({
      output:      'JSON',
      p_st:        'AL',
      p_county:    'MADISON',
      p_tribel:    'Y',
      p_per_page:  '10',
    });
    const url = `https://echodata.epa.gov/echo/facility_search.json?${params}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const facilities = data?.Results?.Facilities || [];
    return facilities.slice(0, 10).map(f => ({
      name:     f.FacilityName,
      city:     f.City,
      address:  f.LocationAddress,
      lat:      parseFloat(f.Latitude84) || null,
      lng:      parseFloat(f.Longitude84) || null,
      programs: f.ProgramSystemAcronyms,
    }));
  } catch (e) {
    console.log('[atmos-intel] EPA TRI unavailable (non-fatal):', e.message);
    return null;
  }
}

// ── Classify based on flight + weather evidence ───────────────────────────────
function classifyFromData(obs, flights, weather) {
  if (!flights) return 'pending';
  if (flights.length === 0) return 'unidentified';

  const humidity = weather?.humidity_pct ?? null;
  const alt = obs.estimated_altitude;

  // Altitude bands in meters
  const LOW_MAX = 3048;   // 10,000 ft
  const MED_MAX = 7620;   // 25,000 ft

  const altMatched = flights.filter(f => {
    if (!f.altitude_m) return false;
    if (alt === 'low')    return f.altitude_m <= LOW_MAX;
    if (alt === 'medium') return f.altitude_m > LOW_MAX && f.altitude_m <= MED_MAX;
    if (alt === 'high')   return f.altitude_m > MED_MAX;
    return true;
  });

  // Persistent contrails need high altitude + humidity >= 60%
  if (altMatched.length > 0 && humidity !== null && humidity >= 60) return 'explained';
  if (altMatched.length > 0 && humidity !== null && humidity < 40)  return 'unexplained';
  if (flights.length > 0 && altMatched.length === 0)               return 'partial';
  return 'partial';
}

// ── Classify a newly submitted observation (runs async after POST) ─────────────
async function classifyObservation(reportId) {
  let obs;
  try {
    const r = await pool.query('SELECT * FROM atmospheric_observations WHERE id = $1', [reportId]);
    obs = r.rows[0];
    if (!obs) return;
  } catch (e) {
    console.error('[atmos-intel] Load obs failed:', e.message);
    return;
  }

  if (!obs.location_lat || !obs.location_lng) {
    console.log(`[atmos-intel] Obs ${reportId}: no coordinates — skipping classification`);
    return;
  }

  const lat = parseFloat(obs.location_lat);
  const lng = parseFloat(obs.location_lng);

  const [flights, weather] = await Promise.all([
    fetchNearbyFlights(lat, lng),
    fetchWeatherConditions(lat, lng),
  ]);

  const classification = classifyFromData(obs, flights, weather);
  const driftZones = calculateDriftZones(lat, lng, obs.wind_direction);

  try {
    await pool.query(
      `UPDATE atmospheric_observations
       SET classification=$1, matched_flights=$2, weather_data=$3, drift_zones=$4, classified_at=NOW()
       WHERE id=$5`,
      [
        classification,
        flights ? JSON.stringify(flights) : null,
        weather ? JSON.stringify(weather) : null,
        driftZones ? JSON.stringify(driftZones) : null,
        reportId,
      ]
    );
    console.log(`[atmos-intel] Obs ${reportId} → ${classification}`);

    // Auto-link unlinked soil samples within ~25 miles
    if (lat && lng) {
      await pool.query(
        `UPDATE soil_samples SET linked_observation_id=$1
         WHERE linked_observation_id IS NULL
           AND location_lat IS NOT NULL AND location_lng IS NOT NULL
           AND ((location_lat-$2)^2 + (location_lng-$3)^2) < 0.13`,
        [reportId, lat, lng]
      );
    }
  } catch (e) {
    console.error('[atmos-intel] Save classification failed:', e.message);
  }
}

// ── AI compound origin analysis for an elevated soil sample ──────────────────
async function analyzeCompoundOrigin(sampleId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;

  let sample;
  try {
    const r = await pool.query(
      `SELECT ss.*, u.username,
              ao.title AS obs_title, ao.report_type AS obs_type,
              ao.location_label AS obs_location, ao.created_at AS obs_date,
              ao.classification AS obs_classification,
              ao.matched_flights, ao.weather_data
       FROM soil_samples ss
       JOIN users u ON u.id = ss.user_id
       LEFT JOIN atmospheric_observations ao ON ao.id = ss.linked_observation_id
       WHERE ss.id = $1`,
      [sampleId]
    );
    sample = r.rows[0];
    if (!sample) return;
  } catch (e) {
    console.error('[atmos-intel] Load sample failed:', e.message);
    return;
  }

  const elevated = [];
  if (sample.aluminum_ppb  > 50)  elevated.push(`Aluminum: ${sample.aluminum_ppb} ppb`);
  if (sample.barium_ppb    > 2)   elevated.push(`Barium: ${sample.barium_ppb} ppb`);
  if (sample.strontium_ppb > 5)   elevated.push(`Strontium: ${sample.strontium_ppb} ppb`);
  if (sample.silver_ppb    > 0.5) elevated.push(`Silver: ${sample.silver_ppb} ppb`);
  if (sample.tio2_ppb      > 10)  elevated.push(`Titanium Dioxide: ${sample.tio2_ppb} ppb`);
  if (sample.pfas_ppb      > 0.1) elevated.push(`PFAS: ${sample.pfas_ppb} ppb`);

  if (elevated.length === 0) return;

  let permits = [];
  try {
    const r = await pool.query(
      `SELECT * FROM weather_modification_permits
       WHERE active_to IS NULL OR active_to >= NOW() - INTERVAL '7 days' LIMIT 10`
    );
    permits = r.rows;
  } catch (e) {}

  const client = new Anthropic({ apiKey });

  const prompt = `You are an environmental forensics analyst assessing compound origins in a ${sample.sample_type} sample from Huntsville, Alabama / Madison County.

SAMPLE: ${sample.location_label || 'not specified'} | Collected: ${sample.collection_date || 'not specified'} | Lab: ${sample.lab_name || 'not specified'}
ELEVATED COMPOUNDS: ${elevated.join(', ')}
DISTANCE FROM OBS CLUSTER: ${sample.distance_from_obs_miles ? `${sample.distance_from_obs_miles} miles ${sample.direction_from_obs || ''}` : 'not specified'}

LINKED ATMOSPHERIC OBSERVATION:
${sample.obs_title ? `${sample.obs_title} (${sample.obs_type}) — classified: ${sample.obs_classification} — ${sample.obs_location} on ${sample.obs_date}` : 'None'}

NEARBY EPA TRI SOURCES: ${sample.tri_sources ? JSON.stringify(sample.tri_sources).slice(0, 400) : 'None found'}

ACTIVE WEATHER MODIFICATION PERMITS: ${permits.length > 0 ? JSON.stringify(permits).slice(0, 300) : 'None on record'}

CONTEXT: Alabama USGS baseline — soil Al background 1000-50000 ppm, Ba 40-800 ppm, Sr 20-300 ppm (rainwater should be far lower). Geoengineering compounds often cited: Al oxide, BaCl2, SrCl2, AgI, TiO2. PFAS from industrial/military sources.

Return ONLY valid JSON:
{
  "assessment": "2-3 sentence summary of most likely compound origins",
  "confidence": "low|medium|high",
  "sources_ranked": [{ "source": "name", "likelihood": "high|medium|low", "reasoning": "one sentence" }],
  "flags": {
    "known_industrial_source_nearby": true|false,
    "atmospheric_deposition_possible": true|false,
    "geoengineering_signature": true|false,
    "natural_background_level": true|false
  }
}`;

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = message.content[0]?.text || '';
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON');
    const parsed = JSON.parse(m[0]);
    const validConf = ['low','medium','high'];
    await pool.query(
      `UPDATE soil_samples SET ai_assessment=$1, ai_confidence=$2, ai_assessed_at=NOW() WHERE id=$3`,
      [JSON.stringify(parsed), validConf.includes(parsed.confidence) ? parsed.confidence : 'low', sampleId]
    );
    console.log(`[atmos-intel] Compound origin analysis done for sample ${sampleId}`);
  } catch (e) {
    console.error('[atmos-intel] Compound origin AI failed:', e.message);
  }
}

// ── Pattern analysis run every 6 hours ───────────────────────────────────────
async function runAtmosphericIntelligence() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[atmos-intel] ANTHROPIC_API_KEY not set — skipping');
    return;
  }
  console.log('[atmos-intel] Starting atmospheric pattern analysis…');

  let observations, soilSamples, permits, contextReports;
  try {
    const r = await pool.query(
      `SELECT ao.*, u.username FROM atmospheric_observations ao
       JOIN users u ON u.id = ao.user_id
       WHERE ao.classification IN ('unexplained','unidentified','pending')
         AND ao.created_at > NOW() - INTERVAL '7 days'
       ORDER BY ao.created_at DESC LIMIT 50`
    );
    observations = r.rows;
  } catch (e) { console.error('[atmos-intel] Fetch obs failed:', e.message); return; }

  try {
    const r = await pool.query(
      `SELECT ss.*, u.username FROM soil_samples ss
       JOIN users u ON u.id = ss.user_id
       WHERE ss.created_at > NOW() - INTERVAL '30 days'
         AND (ss.aluminum_ppb > 50 OR ss.barium_ppb > 2 OR ss.strontium_ppb > 5 OR ss.pfas_ppb > 0.1)
       ORDER BY ss.created_at DESC LIMIT 30`
    );
    soilSamples = r.rows;
  } catch (e) { soilSamples = []; }

  try {
    const r = await pool.query(
      `SELECT * FROM weather_modification_permits
       WHERE active_to IS NULL OR active_to >= CURRENT_DATE - INTERVAL '7 days' LIMIT 10`
    );
    permits = r.rows;
  } catch (e) { permits = []; }

  try {
    const r = await pool.query(
      `SELECT id, dashboard_type, title, location_label, severity, created_at
       FROM watch_reports
       WHERE dashboard_type IN ('health','environment')
         AND created_at > NOW() - INTERVAL '14 days'
       ORDER BY created_at DESC LIMIT 40`
    );
    contextReports = r.rows;
  } catch (e) { contextReports = []; }

  if (observations.length + soilSamples.length < 5) {
    console.log('[atmos-intel] Fewer than 5 atmospheric observations/samples — skipping until real data accumulates');
    return;
  }

  const client = new Anthropic({ apiKey });

  const obsSlim = observations.map(o => ({
    id: o.id, type: o.report_type, severity: o.severity, classification: o.classification,
    location: o.location_label, lat: o.location_lat, lng: o.location_lng,
    altitude: o.estimated_altitude, wind_dir: o.wind_direction,
    weather: o.weather_conditions, tracker_result: o.flight_tracking_result,
    date: o.created_at,
  }));
  const sampSlim = soilSamples.map(s => ({
    id: s.id, type: s.sample_type, location: s.location_label,
    al: s.aluminum_ppb, ba: s.barium_ppb, sr: s.strontium_ppb,
    ag: s.silver_ppb, tio2: s.tio2_ppb, pfas: s.pfas_ppb,
    linked_obs: s.linked_observation_id, date: s.created_at,
  }));

  const prompt = `You are an atmospheric surveillance pattern analyst for Huntsville, Alabama. Analyze community atmospheric observations and soil/rainwater test results for patterns indicating non-routine atmospheric activity.

UNEXPLAINED/UNIDENTIFIED OBSERVATIONS (last 7 days, ${observations.length} total):
${JSON.stringify(obsSlim, null, 2).slice(0, 2000)}

ELEVATED COMPOUND SAMPLES (last 30 days, ${soilSamples.length} total):
${JSON.stringify(sampSlim, null, 2).slice(0, 1200)}

ACTIVE WEATHER MODIFICATION PERMITS: ${permits.length > 0 ? JSON.stringify(permits).slice(0, 400) : 'None'}

HEALTH/ENVIRONMENT CONTEXT REPORTS: ${contextReports.length > 0 ? JSON.stringify(contextReports).slice(0, 800) : 'None'}

Look for:
1. OBSERVATION_CLUSTER — 3+ UNEXPLAINED/UNIDENTIFIED reports within 20 miles in 7 days
2. COMPOUND_ELEVATION — elevated Al+Ba+Sr together in rainwater/soil downwind of obs cluster
3. TEMPORAL_CORRELATION — observation spike within ±3 days of weather modification permit activity
4. HEALTH_CORRELATION — UNEXPLAINED obs cluster correlating with respiratory/neurological health reports in same area
5. UNIDENTIFIED_CORRIDOR — multiple UNIDENTIFIED (no flights) reports along a geographic corridor

Return ONLY valid JSON:
{"anomalies":[{"anomaly_type":"observation_cluster|compound_elevation|temporal_correlation|health_correlation|unidentified_corridor","title":"under 80 chars","description":"2-3 sentences","affected_areas":["area"],"severity":"critical|serious|moderate|minor","ai_confidence":"low|medium|high","affected_report_ids":["uuid"]}]}

Max 4 anomalies. Return {"anomalies":[]} if no meaningful patterns.`;

  let parsed;
  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = message.content[0]?.text || '';
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON');
    parsed = JSON.parse(m[0]);
  } catch (e) {
    console.error('[atmos-intel] AI analysis failed:', e.message);
    return;
  }

  const anomalies = parsed.anomalies || [];
  const validSev  = ['critical','serious','moderate','minor'];
  const validConf = ['low','medium','high'];
  let saved = 0;

  for (const a of anomalies) {
    if (!a.anomaly_type || !a.title || !a.description) continue;
    if (!validSev.includes(a.severity))    a.severity    = 'moderate';
    if (!validConf.includes(a.ai_confidence)) a.ai_confidence = 'low';

    const area = (a.affected_areas || [])[0] || null;
    try {
      const dupe = await pool.query(
        `SELECT id FROM watch_anomalies
         WHERE anomaly_type=$1
           AND ($2 IS NULL OR location_label ILIKE $3)
           AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1`,
        [a.anomaly_type, area, area ? `%${area}%` : '%']
      );
      if (dupe.rows[0]) continue;

      const dashTypes = ['atmospheric_observations'];
      if (a.anomaly_type === 'health_correlation') dashTypes.push('health');
      if (a.anomaly_type === 'compound_elevation')  dashTypes.push('environment');

      await pool.query(
        `INSERT INTO watch_anomalies
           (anomaly_type, description, affected_reports, severity, dashboard_types, location_label, ai_confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          a.anomaly_type,
          `[Atmospheric] ${a.title}: ${a.description}`,
          a.affected_report_ids || [],
          a.severity,
          dashTypes,
          area,
          a.ai_confidence,
        ]
      );
      saved++;
    } catch (e) {
      console.error('[atmos-intel] Save anomaly failed:', e.message);
    }
  }

  console.log(`[atmos-intel] Pattern analysis complete — saved ${saved} anomalies`);
}

module.exports = { classifyObservation, runAtmosphericIntelligence, analyzeCompoundOrigin, fetchTRINearby };
