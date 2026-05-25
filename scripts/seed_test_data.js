// seed_test_data.js — creates test role accounts and 20 realistic Huntsville AL posts
const { Pool } = require('pg');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const env = fs.readFileSync('C:/mycelium/.env', 'utf8');
const vars = {};
env.split('\n').forEach(l => {
  const idx = l.indexOf('=');
  if (idx > 0) vars[l.slice(0, idx).trim()] = l.slice(idx + 1).trim();
});

const pool = new Pool({
  host: vars.DB_HOST,
  port: parseInt(vars.DB_PORT),
  database: vars.DB_NAME,
  user: vars.DB_USER,
  password: vars.DB_PASSWORD,
});

const AUTO_URGENT_TAGS = new Set([
  'hunger', 'food crisis', 'shelter', 'homeless', 'crisis',
  'mental health crisis', 'child', 'children', 'medical', 'emergency',
]);
function isAutoUrgent(tags) {
  return tags.some(t => AUTO_URGENT_TAGS.has(t.toLowerCase().trim()));
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const roleAccounts = [
      { username: 'mod_testuser1', email: 'mod1@test.local', password: 'ModTest1!', role: 'moderator' },
      { username: 'mod_testuser2', email: 'mod2@test.local', password: 'ModTest2!', role: 'moderator' },
      { username: 'admin_testuser', email: 'admin@test.local', password: 'AdminTest1!', role: 'admin' },
    ];

    const roleIds = {};
    for (const acc of roleAccounts) {
      const hash = await bcrypt.hash(acc.password, 10);
      const r = await client.query(
        `INSERT INTO users (username, email, password_hash, role, reliability_score)
         VALUES ($1, $2, $3, $4, 4.5)
         ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role
         RETURNING id`,
        [acc.username, acc.email, hash, acc.role]
      );
      roleIds[acc.username] = r.rows[0].id;
      console.log(`  ${acc.role}: ${acc.username} — ${acc.email} / ${acc.password}`);
    }

    const communityAccounts = [
      { username: 'DanielleHSV',  email: 'danielle@seed.local', password: 'Seed123!', score: 4.2 },
      { username: 'MarcosBridges', email: 'marcos@seed.local',   password: 'Seed123!', score: 3.8 },
      { username: 'TiffanyOak',   email: 'tiffany@seed.local',  password: 'Seed123!', score: 4.7 },
      { username: 'KwameNkosi',   email: 'kwame@seed.local',    password: 'Seed123!', score: 3.1 },
      { username: 'SarahJuneHSV', email: 'sarah@seed.local',    password: 'Seed123!', score: 4.9 },
    ];

    const seedIds = {};
    for (const acc of communityAccounts) {
      const hash = await bcrypt.hash(acc.password, 10);
      const r = await client.query(
        `INSERT INTO users (username, email, password_hash, role, reliability_score)
         VALUES ($1, $2, $3, 'member', $4)
         ON CONFLICT (email) DO UPDATE SET username = EXCLUDED.username
         RETURNING id`,
        [acc.username, acc.email, hash, acc.score]
      );
      seedIds[acc.username] = r.rows[0].id;
    }

    const posts = [
      {
        type: 'need', user: 'DanielleHSV',
        title: 'Need affordable childcare starting next month -- South Huntsville',
        description: 'I have a 4-year-old and just started a new job. Looking for reliable part-time childcare, ideally 3 days a week, 8am to 2pm. Can pay fair rate, open to licensed home daycare or individual caregiver with references.',
        category: 'jobs_services', subcategory: 'childcare',
        tags: ['childcare', 'child', 'south huntsville'],
        location: 'South Huntsville, AL',
      },
      {
        type: 'offer', user: 'MarcosBridges',
        title: 'Free basic phone / laptop repair -- Downtown Huntsville',
        description: 'I do tech repair as a hobby and want to help neighbors out. Cracked screens, battery swaps, slow laptops, basic diagnostics. No charge for parts under $20. Drop me a message with what is broken.',
        category: 'jobs_services', subcategory: 'tech repair',
        tags: ['tech', 'phone repair', 'laptop', 'free service', 'downtown huntsville'],
        location: 'Downtown Huntsville, AL',
      },
      {
        type: 'need', user: 'TiffanyOak',
        title: 'Looking for licensed electrician for panel swap -- Madison',
        description: 'My 1970s breaker panel needs replacing before my homeowner insurance renewal. Need a licensed electrician who can give a fair quote. I have gotten estimates of $2k to $3k but hoping to find someone local who can work with me on cost.',
        category: 'jobs_services', subcategory: 'skilled trades',
        tags: ['electrician', 'skilled trades', 'madison huntsville'],
        location: 'Madison, AL (near Huntsville)',
      },
      {
        type: 'offer', user: 'KwameNkosi',
        title: 'Offering rides to grocery / appointments -- North Huntsville',
        description: 'I have a reliable car and free time on Tuesday and Thursday afternoons. Happy to give rides to people who do not have transportation -- grocery store, doctor appointment, pharmacy. Just ask. North Huntsville area.',
        category: 'jobs_services', subcategory: 'transport',
        tags: ['rides', 'transport', 'north huntsville', 'free'],
        location: 'North Huntsville, AL',
      },
      {
        type: 'need', user: 'SarahJuneHSV',
        title: 'Seeking work: experienced housekeeper -- flexible hours',
        description: 'I am an experienced housekeeper looking for steady clients in Huntsville. Reliable, thorough, non-judgmental. References available. Can do weekly, biweekly, or one-time deep cleans. Reasonable rates.',
        category: 'jobs_services', subcategory: 'domestic services',
        tags: ['housekeeping', 'domestic', 'job seeking', 'huntsville'],
        location: 'Huntsville, AL',
      },
      {
        type: 'offer', user: 'DanielleHSV',
        title: 'Free tutoring for K-8 math -- Jones Valley area',
        description: 'I am a former teacher now staying home with my kids. Happy to tutor elementary and middle school math for free, especially for families who cannot afford private tutoring. Can meet at the library or at my house.',
        category: 'jobs_services', subcategory: 'tutoring',
        tags: ['tutoring', 'math', 'children', 'education', 'jones valley'],
        location: 'Jones Valley, Huntsville AL',
      },
      {
        type: 'need', user: 'KwameNkosi',
        title: 'Need non-perishable food for family of 5 -- immediate',
        description: 'Unexpectedly lost my job two weeks ago and we are running low on food. Have 3 kids at home. Would really appreciate canned goods, rice, pasta, anything non-perishable. Can pick up anywhere in Huntsville.',
        category: 'goods_supplies', subcategory: 'mutual aid',
        tags: ['food', 'hunger', 'mutual aid', 'children', 'emergency'],
        location: 'Huntsville, AL',
        is_urgent: true,
        expires_at: '2026-06-10T00:00:00Z',
      },
      {
        type: 'offer', user: 'TiffanyOak',
        title: "Giving away kids clothes -- sizes 4T through 8 -- Meridian Hills",
        description: 'My kids have outgrown a whole closet worth of stuff. Mostly good condition, some like new. Boys and girls items mixed. Free to anyone who needs it -- come grab a bag or I can set aside specific sizes.',
        category: 'goods_supplies', subcategory: 'clothing',
        tags: ['kids clothes', 'children', 'free', 'meridian hills'],
        location: 'Meridian Hills, Huntsville AL',
      },
      {
        type: 'need', user: 'SarahJuneHSV',
        title: 'Looking for twin mattress and bed frame -- any condition OK',
        description: 'Setting up a room for my nephew who just moved in with me. Do not need anything fancy -- just a functional mattress and frame in decent shape. Would love to keep it out of a landfill. Can pick up with truck.',
        category: 'goods_supplies', subcategory: 'furniture',
        tags: ['mattress', 'furniture', 'free or cheap', 'huntsville'],
        location: 'Huntsville, AL',
      },
      {
        type: 'offer', user: 'MarcosBridges',
        title: 'Extra garden produce available -- tomatoes, squash, herbs',
        description: 'My backyard garden is producing more than we can use. Have tomatoes, yellow squash, zucchini, basil, and some jalapenos. Come by and take what you want or I can leave a box on the porch. First come first served.',
        category: 'goods_supplies', subcategory: 'food',
        tags: ['produce', 'food', 'garden', 'free', 'five points huntsville'],
        location: 'Five Points, Huntsville AL',
      },
      {
        type: 'need', user: 'DanielleHSV',
        title: 'Need baby formula -- 6-month-old -- urgent',
        description: 'We had an unexpected shortage and I am almost out of formula for my daughter. Any brand similar to Similac Pro-Advance or Enfamil NeuroPro would help. Will reimburse cost or trade -- I have a lot of 4T clothes and books.',
        category: 'goods_supplies', subcategory: 'infant supplies',
        tags: ['baby formula', 'infant', 'medical', 'emergency', 'hunger'],
        location: 'Huntsville, AL',
        is_urgent: true,
        expires_at: '2026-05-30T00:00:00Z',
      },
      {
        type: 'offer', user: 'SarahJuneHSV',
        title: 'Bike available free to good home -- works great',
        description: 'I have a bike that I am not using. Adult medium frame, 21 speeds, tires are good, brakes work. Would love for it to go to someone who will actually ride it. Free -- just come get it from Twickenham.',
        category: 'goods_supplies', subcategory: 'transportation',
        tags: ['bike', 'free', 'twickenham huntsville'],
        location: 'Twickenham, Huntsville AL',
      },
      {
        type: 'need', user: 'KwameNkosi',
        title: 'Temporary shelter needed -- 1 adult, 3 nights',
        description: 'Going through a rough stretch after losing housing. I am clean, quiet, employed part-time. Just need somewhere safe to stay for a few nights while I sort out a new room. Any help or leads appreciated.',
        category: 'goods_supplies', subcategory: 'housing',
        tags: ['shelter', 'homeless', 'housing', 'crisis'],
        location: 'Huntsville, AL',
        is_urgent: true,
        expires_at: '2026-05-28T00:00:00Z',
      },
      {
        type: 'offer', user: 'TiffanyOak',
        title: 'Gently used school supplies -- backpacks, binders, pencils',
        description: 'Clearing out extras from last school year. Have 3 backpacks, a stack of binders and folders, pencils, a few composition notebooks. Good for any age. Free -- happy to drop off in Huntsville if you cannot get to me.',
        category: 'goods_supplies', subcategory: 'school supplies',
        tags: ['school supplies', 'children', 'free', 'huntsville'],
        location: 'Huntsville, AL',
      },
      {
        type: 'event', user: 'TiffanyOak',
        title: 'Community Garden Workday -- Big Spring Park area',
        description: 'Joining up with a few neighbors for a Saturday workday to help maintain the community garden plot near Big Spring Park. We will be weeding, planting, and building two new raised beds. All welcome -- bring gloves.',
        category: 'community', subcategory: 'gardening',
        tags: ['gardening', 'community', 'big spring park', 'volunteer'],
        location: 'Big Spring Park, Huntsville AL',
        starts_at: '2026-06-07T09:00:00Z',
        ends_at: '2026-06-07T13:00:00Z',
        capacity: 15,
      },
      {
        type: 'event', user: 'MarcosBridges',
        title: 'Free Friday: Skill Share Evening at Lowe Mill',
        description: 'Organizing an informal skill-share evening near Lowe Mill. Bring something you can teach in 10 to 15 minutes -- a recipe, a repair technique, a language phrase, a stretch routine. Potluck style for snacks.',
        category: 'community', subcategory: 'skill share',
        tags: ['skill share', 'lowe mill', 'community', 'free event'],
        location: 'Lowe Mill Arts, Huntsville AL',
        starts_at: '2026-06-13T18:00:00Z',
        ends_at: '2026-06-13T21:00:00Z',
        capacity: 30,
      },
      {
        type: 'event', user: 'SarahJuneHSV',
        title: 'Mental Health Check-In Circle -- casual, low key',
        description: 'Starting a monthly drop-in circle for people who want to talk, listen, or just sit with others. No therapist, no agenda -- just neighbors checking in on each other. Zoom option available for folks who cannot make it in person.',
        category: 'community', subcategory: 'mental health support',
        tags: ['mental health', 'mental health crisis', 'support', 'community', 'downtown huntsville'],
        location: 'Downtown Huntsville, AL',
        starts_at: '2026-06-03T19:00:00Z',
        ends_at: '2026-06-03T21:00:00Z',
        capacity: 20,
      },
      {
        type: 'event', user: 'DanielleHSV',
        title: 'Neighborhood Safety Walk -- Old Town Huntsville',
        description: 'Doing a slow walk through Old Town to identify street lighting issues, pedestrian hazards, and areas of concern to report to the city. We will document and submit a report together. Kid-friendly pace.',
        category: 'community', subcategory: 'neighborhood organizing',
        tags: ['safety', 'neighborhood', 'old town huntsville', 'civic'],
        location: 'Old Town, Huntsville AL',
        starts_at: '2026-06-21T08:30:00Z',
        ends_at: '2026-06-21T10:30:00Z',
        capacity: 25,
      },
      {
        type: 'offer', user: 'MarcosBridges',
        title: 'Free Spanish tutoring -- conversational level -- any age',
        description: 'I grew up speaking Spanish at home and want to offer free conversational tutoring. Great for kids with Spanish-speaking family who want to improve, or adults who want basic conversational fluency. Sessions in person or video call.',
        category: 'community', subcategory: 'language tutoring',
        tags: ['spanish', 'tutoring', 'language', 'free', 'huntsville'],
        location: 'Huntsville, AL',
      },
      {
        type: 'need', user: 'SarahJuneHSV',
        title: 'Looking for a reliable mechanic -- reasonable rates -- Decatur Road area',
        description: 'My car needs a brake job and possibly a new O2 sensor. I have been quoted $600 at a chain shop but that feels high. Does anyone know a trustworthy independent mechanic in the area who will not overcharge someone who does not know cars?',
        category: 'jobs_services', subcategory: 'automotive',
        tags: ['mechanic', 'automotive', 'decatur road', 'huntsville'],
        location: 'Near Decatur Rd, Huntsville AL',
      },
    ];

    let inserted = 0;
    for (const p of posts) {
      const userId = seedIds[p.user];
      const tags = p.tags || [];
      const autoUrgent = isAutoUrgent(tags);
      const userUrgent = !!p.is_urgent;

      await client.query(
        `INSERT INTO posts (type, title, description, user_id, category, subcategory,
                            tags, location, starts_at, ends_at, capacity,
                            is_urgent, auto_urgent, expires_at, status)
         VALUES ($1::post_type, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'active')`,
        [
          p.type, p.title, p.description, userId,
          p.category || null, p.subcategory || null,
          tags, p.location || null,
          p.starts_at || null, p.ends_at || null,
          p.capacity || null,
          userUrgent, autoUrgent,
          p.expires_at || null,
        ]
      );
      inserted++;
    }

    await client.query('COMMIT');
    console.log(`\nSeeded ${inserted} posts.`);
    console.log('\nRole accounts:');
    for (const acc of roleAccounts) {
      console.log(`  ${acc.role.padEnd(10)} ${acc.username.padEnd(20)} ${acc.email}  /  ${acc.password}`);
    }
    console.log('\nCommunity seed users (all password: Seed123!):');
    for (const acc of communityAccounts) {
      console.log(`  ${acc.username.padEnd(20)} ${acc.email}`);
    }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', e.message);
    console.error(e.stack);
  } finally {
    client.release();
    pool.end();
  }
}

main();
