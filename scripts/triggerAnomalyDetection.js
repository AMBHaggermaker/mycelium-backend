/**
 * Manually trigger one AI anomaly detection run.
 * Run: node scripts/triggerAnomalyDetection.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { runAnomalyDetection } = require('../src/lib/anomalyDetector');

console.log('Triggering anomaly detection…');
console.log(`ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'SET (' + process.env.ANTHROPIC_API_KEY.slice(0, 12) + '…)' : 'NOT SET'}`);

runAnomalyDetection()
  .then(() => {
    console.log('\nDone.');
    process.exit(0);
  })
  .catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  });
