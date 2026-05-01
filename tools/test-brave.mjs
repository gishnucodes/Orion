import process from 'node:process';

const key = process.env.BRAVE_API_KEY;
if (!key) {
  console.error('Missing BRAVE_API_KEY env var');
  process.exit(1);
}

const q = process.argv.slice(2).join(' ') || 'site:boards.greenhouse.io "Applied AI Engineer"';
const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=5`;

try {
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': key
    }
  });
  const text = await res.text();
  console.log('status', res.status);
  console.log(text.slice(0, 2000));
} catch (err) {
  console.error('fetch error', err?.message || err);
  process.exit(1);
}
