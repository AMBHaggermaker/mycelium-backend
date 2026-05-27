const https = require('https');

function nominatimGeocode(query) {
  return new Promise((resolve, reject) => {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=us`;
    const opts = {
      headers: { 'User-Agent': 'MyceliumPlatform/1.0 (admin@unprecedentedtimes.org)' },
    };
    https.get(url, opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const results = JSON.parse(data);
          if (results.length) resolve({ lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) });
          else resolve(null);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

module.exports = { nominatimGeocode };
