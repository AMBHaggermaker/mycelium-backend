/**
 * Seed 15 realistic Watch reports for AI anomaly detection testing.
 *
 * Designed with:
 *   - 4 critical reports
 *   - 3 location clusters (reports within 0.5 miles of each other)
 *   - Cross-dashboard correlations (health + environment, infrastructure + health)
 *   - Dates spread over the past 30 days
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'mycelium_db',
  user:     process.env.DB_USER     || 'mycelium_user',
  password: process.env.DB_PASSWORD || 'mycelium2026',
});

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

async function seed() {
  // Use the founder account as reporter for all seed data
  const userResult = await pool.query(
    `SELECT id FROM users WHERE username = 'AMBHaggermaker' AND is_active = TRUE LIMIT 1`
  );
  if (!userResult.rows[0]) {
    console.error('Could not find AMBHaggermaker user — aborting');
    process.exit(1);
  }
  const userId = userResult.rows[0].id;
  console.log(`Seeding as user: ${userId}`);

  // ─────────────────────────────────────────────────────────────────────────
  // CLUSTER 1: North Huntsville near Johnson High School
  // Health + Environment cross-dashboard cluster — respiratory + air quality
  // All within ~0.3 miles of 34.762, -86.554
  // ─────────────────────────────────────────────────────────────────────────
  const cluster1 = [
    {
      dashboard_type: 'health',
      title: 'Spike in respiratory illness complaints — Fernwood Drive area',
      description: 'Multiple households on Fernwood Dr and surrounding blocks reporting persistent cough, shortness of breath, and eye irritation over the past two weeks. Three families have visited urgent care. Kids and elderly most affected.',
      location_label: 'Fernwood Dr, North Huntsville',
      location_lat: 34.7620, location_lng: -86.5551,
      severity: 'serious', report_type: 'respiratory illness',
      created_at: daysAgo(20),
    },
    {
      dashboard_type: 'health',
      title: 'CRITICAL: Child hospitalized with severe respiratory distress',
      description: 'An 8-year-old from the Fernwood/Oakwood area was admitted to Huntsville Hospital with acute respiratory distress. Family reports no prior history. Doctors asking about environmental exposures. Two other neighbors report similar symptoms same week.',
      location_label: 'Oakwood Ave, North Huntsville',
      location_lat: 34.7628, location_lng: -86.5542,
      severity: 'critical', report_type: 'respiratory illness',
      created_at: daysAgo(15),
    },
    {
      dashboard_type: 'environment',
      title: 'Unusual odor and haze near Oakwood — possible industrial emission',
      description: 'Strong chemical smell noticed in the early morning hours (4-6am) for the past three weeks. Brownish haze visible from the hilltop. Direction appears to be coming from the industrial park to the northwest. No official notifications received.',
      location_label: 'Oakwood Ave / Fernwood Dr intersection',
      location_lat: 34.7614, location_lng: -86.5562,
      severity: 'serious', report_type: 'air quality',
      created_at: daysAgo(12),
    },
    {
      dashboard_type: 'infrastructure',
      title: 'Storm drain overflow backing up near Fernwood — repeated flooding',
      description: 'The storm drain at Fernwood and Oakwood overflows every rain event and sits for 3-4 days. Standing water pools near the drainage ditch next to the industrial site. City has been notified twice with no response.',
      location_label: 'Fernwood Dr storm drain, North Huntsville',
      location_lat: 34.7608, location_lng: -86.5558,
      severity: 'moderate', report_type: 'drainage',
      created_at: daysAgo(25),
    },
  ];

  // ─────────────────────────────────────────────────────────────────────────
  // CLUSTER 2: Near Huntsville Hospital / Downtown corridor
  // Health + Housing + Environment cross-dashboard
  // All within ~0.2 miles of 34.736, -86.583
  // ─────────────────────────────────────────────────────────────────────────
  const cluster2 = [
    {
      dashboard_type: 'health',
      title: 'CRITICAL: Multiple GI illness cases — Holmes Ave apartments',
      description: 'At least 6 residents in the Holmes Ave apartment complex have reported severe GI illness in the past two weeks — vomiting, diarrhea, cramping. Two required ER visits. Property manager aware but hasn\'t communicated with tenants. Source unknown — could be water or food.',
      location_label: 'Holmes Ave apartments, Huntsville',
      location_lat: 34.7365, location_lng: -86.5834,
      severity: 'critical', report_type: 'GI illness',
      created_at: daysAgo(10),
    },
    {
      dashboard_type: 'housing',
      title: 'Mold and water intrusion — entire ground floor of Holmes Ave complex',
      description: 'Visible black mold on walls of at least 4 ground-floor units at the Holmes Ave apartments. Tenant complaints go back 8 months. Landlord applies paint over mold without remediation. Several children with recurring respiratory issues. Code enforcement notified but no inspection conducted.',
      location_label: 'Holmes Ave Apartments, Huntsville',
      location_lat: 34.7358, location_lng: -86.5839,
      severity: 'serious', report_type: 'mold',
      created_at: daysAgo(8),
    },
    {
      dashboard_type: 'environment',
      title: 'CRITICAL: Discolored water and sulfur smell from tap — Holmes Ave block',
      description: 'Multiple households on Holmes Ave and the adjacent block report brown/yellow-tinged water with a sulfur smell. Issue started approximately 3 weeks ago. Residents are buying bottled water. City Utilities has not responded to multiple calls. A pregnant resident is particularly concerned.',
      location_label: 'Holmes Ave, Downtown Huntsville',
      location_lat: 34.7371, location_lng: -86.5828,
      severity: 'critical', report_type: 'water contamination',
      created_at: daysAgo(6),
    },
  ];

  // ─────────────────────────────────────────────────────────────────────────
  // CLUSTER 3: South Huntsville near Whitesburg area
  // Infrastructure + Health near sensitive location (near Whitesburg Bridge)
  // All within ~0.25 miles of 34.718, -86.563
  // ─────────────────────────────────────────────────────────────────────────
  const cluster3 = [
    {
      dashboard_type: 'infrastructure',
      title: 'Large pothole and road damage — Whitesburg Dr southbound',
      description: 'Significant pothole approximately 2.5 feet wide on Whitesburg Dr near the bridge approach. Two cars have reported tire damage this week. Pothole is in the right lane and gets worse after each rainfall. Risk of accident especially at night.',
      location_label: 'Whitesburg Dr southbound near bridge, Huntsville',
      location_lat: 34.7175, location_lng: -86.5631,
      severity: 'moderate', report_type: 'road/pothole',
      created_at: daysAgo(28),
    },
    {
      dashboard_type: 'infrastructure',
      title: 'Retaining wall cracking near Whitesburg Drive — possible slope failure',
      description: 'Retaining wall along the west side of Whitesburg Dr near the bridge approach has developed large vertical cracks over the past month. Some sections are bowing outward. This wall holds back a significant slope above the road. No cones or warnings have been placed.',
      location_label: 'Whitesburg Dr retaining wall, Huntsville',
      location_lat: 34.7168, location_lng: -86.5625,
      severity: 'serious', report_type: 'retaining wall',
      created_at: daysAgo(18),
    },
    {
      dashboard_type: 'health',
      title: 'Two cyclists injured — Whitesburg Dr road hazard',
      description: 'Two separate cyclist injuries this month on Whitesburg Dr. Both reported hitting road damage (possibly the documented pothole). One injury required stitches. The road surface in this area is deteriorating with multiple hazards within 100 yards of each other.',
      location_label: 'Whitesburg Dr, near bridge',
      location_lat: 34.7181, location_lng: -86.5638,
      severity: 'serious', report_type: 'other',
      created_at: daysAgo(22),
    },
  ];

  // ─────────────────────────────────────────────────────────────────────────
  // Scattered individual reports (across other dashboards / locations)
  // ─────────────────────────────────────────────────────────────────────────
  const scattered = [
    {
      dashboard_type: 'surveillance',
      title: 'New ALPR camera array installed — Sparkman Dr and University Dr',
      description: 'A bank of 4 Flock Safety license plate reader cameras was installed at the intersection of Sparkman Dr and University Dr this week. No public notice was given. Camera angles cover both directions of travel on both roads. Requesting information on who authorized this installation and data retention policies.',
      location_label: 'Sparkman Dr / University Dr, Huntsville',
      location_lat: 34.7299, location_lng: -86.6402,
      severity: 'monitoring', report_type: 'ALPR/Flock camera',
      created_at: daysAgo(4),
    },
    {
      dashboard_type: 'civic',
      title: 'Rezoning application for Mastin Lake Rd — residential to light industrial',
      description: 'A rezoning application (case R-2026-147) has been filed to convert a residential parcel on Mastin Lake Rd from R-1 to I-1 (light industrial). The parcel is adjacent to a neighborhood with 400+ homes. Public comment period ends in 12 days. No notice mailed to neighbors.',
      location_label: 'Mastin Lake Rd, North Huntsville',
      location_lat: 34.7501, location_lng: -86.5503,
      severity: 'serious', report_type: 'development approval',
      created_at: daysAgo(7),
    },
    {
      dashboard_type: 'watershed',
      title: 'Construction runoff entering Dry Creek — erosion visible',
      description: 'Heavy equipment has been working on a construction site off Weatherly Rd and uncontrolled runoff is visibly entering Dry Creek. Brown plume visible in the creek. Silt fences not properly installed. Several fish observed dead or stressed at the outflow point.',
      location_label: 'Dry Creek near Weatherly Rd, Madison County',
      location_lat: 34.7889, location_lng: -86.6012,
      severity: 'serious', report_type: 'erosion',
      created_at: daysAgo(13),
    },
    {
      dashboard_type: 'food',
      title: 'Pesticide spray drift from commercial operation — Harvest area',
      description: 'A commercial agricultural operation applied pesticides during windy conditions near Harvest and the spray visibly drifted over adjacent residential yards and a community garden. At least 3 families reported feeling ill after outdoor exposure. One family\'s vegetable garden completely wilted.',
      location_label: 'Jeff Rd, Harvest / North Madison County',
      location_lat: 34.8478, location_lng: -86.6267,
      severity: 'serious', report_type: 'spray drift',
      created_at: daysAgo(3),
    },
    {
      dashboard_type: 'housing',
      title: 'CRITICAL: Structural collapse risk — roof damage and foundation issues',
      description: 'A rental property on Meridian St has a visibly sagging roof and what appears to be significant foundation settling. The tenant has two children under 5 and has reported the issue to the landlord 4 times. No repairs have been made. Cracks visible from the street across the front facade. City code enforcement should inspect immediately.',
      location_label: 'Meridian St, Five Points area, Huntsville',
      location_lat: 34.7234, location_lng: -86.5821,
      severity: 'critical', report_type: 'structural',
      created_at: daysAgo(30),
    },
  ];

  const allReports = [...cluster1, ...cluster2, ...cluster3, ...scattered];
  console.log(`Inserting ${allReports.length} reports…`);

  let inserted = 0;
  for (const r of allReports) {
    await pool.query(
      `INSERT INTO watch_reports
         (user_id, dashboard_type, title, description, location_label,
          location_lat, location_lng, photo_urls, severity, report_type, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        userId,
        r.dashboard_type,
        r.title,
        r.description,
        r.location_label,
        r.location_lat,
        r.location_lng,
        [],
        r.severity,
        r.report_type,
        r.created_at,
      ]
    );
    console.log(`  ✓ [${r.dashboard_type}] [${r.severity}] ${r.title.slice(0, 60)}`);
    inserted++;
  }

  console.log(`\nSeed complete — ${inserted} reports inserted.`);
  console.log('\nSummary by severity:');
  const bySev = {};
  allReports.forEach(r => { bySev[r.severity] = (bySev[r.severity] || 0) + 1; });
  Object.entries(bySev).forEach(([s, n]) => console.log(`  ${s}: ${n}`));
  console.log('\nSummary by dashboard:');
  const byDash = {};
  allReports.forEach(r => { byDash[r.dashboard_type] = (byDash[r.dashboard_type] || 0) + 1; });
  Object.entries(byDash).forEach(([d, n]) => console.log(`  ${d}: ${n}`));

  await pool.end();
}

seed().catch(e => { console.error(e); process.exit(1); });
