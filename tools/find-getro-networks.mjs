#!/usr/bin/env node
/**
 * Discover Getro-powered VC portfolio job boards and keep the productive ones.
 *
 *   node tools/find-getro-networks.mjs [--floor 3] [--concurrency 12]
 *
 * Getro serves portfolio boards for many funds (Accel, General Catalyst,
 * Khosla…), each backed by one search API keyed by a network id. A network
 * aggregates hundreds of portfolio companies, many on Workday or their own
 * career sites that Orion cannot reach any other way.
 *
 * Candidates: Getro-hosted subdomains (from Common Crawl) plus a list of fund
 * domains probed at the usual board subdomains. A board is Getro when its page
 * embeds `"network":{"id":"…"}`. Each network's yield is then measured: US,
 * title-relevant postings created in the last 48h, per day. Only networks at or
 * above --floor are kept.
 *
 * Writes portals.getro.yml (merged by src/config.mjs). Networks already listed
 * in portals.yml are skipped. Re-run occasionally; it replaces the file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { repoRoot } from '../src/config.mjs';
import { titleAllowed, pooled } from '../src/utils.mjs';
import { gate } from '../src/scoring/formula.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const FLOOR = Number(arg('floor', 3));
const CONCURRENCY = Number(arg('concurrency', 12));
const UA = 'Mozilla/5.0 (orion job scanner)';

// Funds and accelerators known to publish portfolio job boards. Probed at the
// subdomains below; only those that turn out to be Getro are used.
const FUND_DOMAINS = [
  'accel.com', 'generalcatalyst.com', 'khoslaventures.com', 'indexventures.com', 'radical.vc', 'greylock.com',
  'kleinerperkins.com', 'gv.com', 'foundersfund.com', 'insightpartners.com', 'felicis.com', 'redpoint.com',
  'sparkcapital.com', 'firstround.com', 'usv.com', 'luxcapital.com', '8vc.com', 'thrivecap.com', 'ivp.com',
  'battery.com', 'menlovc.com', 'nea.com', 'crv.com', 'emcap.com', 'boldstart.vc', 'amplifypartners.com',
  'mayfield.com', 'learncapital.com', 'cowboy.vc', 'floodgate.com', 'homebrew.co', 'initialized.com',
  'lererhippeau.com', 'primary.vc', 'forerunnerventures.com', 'craftventures.com', 'costanoa.vc',
  'iconiqcapital.com', 'coatue.com', 'dragoneer.com', 'madrona.com', 'upfront.com', 'wing.vc', 'zetta.vc',
  'playground.global', 'obvious.com', 'dcvc.com', 'fifthwall.com', 'pear.vc', 'sutterhill.com',
  'baincapitalventures.com', 'tcv.com', 'meritechcapital.com', 'greycroft.com', 'betaworks.com', 'nextview.vc',
  'founderscollective.com', 'techstars.com', '500.co', 'antler.co', 'southparkcommons.com', 'neo.com',
  'contrary.com', 'hustlefund.vc', 'precursorvc.com', 'notation.vc', 'xyz.vc', 'basisset.com', 'abstract.vc',
  'bloombergbeta.com', 'susaventures.com', 'uncorkcapital.com', 'crosslinkcapital.com', 'canaan.com',
  'foundrygroup.com', 'eniac.vc', 'work-bench.com', 'mucker.com', 'stripes.com', 'flybridge.com', 'glasswing.vc',
  'hyperplane.vc', 'lsvp.com', 'bvp.com', 'sequoiacap.com', 'a16z.com', 'gradient.com', 'conviction.com',
  'benchmark.com', 'matrix.vc', 'northzone.com', 'balderton.com', 'atomico.com', 'alumniventures.com',
  'trinityventures.com', 'emergentventures.com', 'slow.co', 'boxgroup.com', 'svangel.com', 'khosla.com',
  'ggvc.com', 'lightspeedvp.com', 'battery.vc', 'aspectventures.com', 'unusual.vc', 'essencevc.fund',
  'bowcap.com', 'decibel.vc', 'lux.vc', 'sozo.vc', 'socialcapital.com', 'fin.vc', 'pathvc.com', 'amplify.la'
];
const SUBDOMAINS = ['jobs', 'talent', 'careers', 'portfoliojobs'];

/** Getro-hosted *.getro.com boards from the latest Common Crawl index. */
async function crawlGetroHosts() {
  try {
    const res = await fetch('https://index.commoncrawl.org/CC-MAIN-2026-34-index?url=*.getro.com&output=json&fl=url&limit=5000');
    if (!res.ok) return [];
    const hosts = new Set();
    for (const line of (await res.text()).split('\n')) {
      try {
        const host = new URL(JSON.parse(line).url).hostname;
        if (!/^(www|cdn|api|assets|app|static|images|help|blog)\./.test(host)) hosts.add(host);
      } catch { /* skip malformed line */ }
    }
    return [...hosts];
  } catch {
    return [];
  }
}

/**
 * The Getro network a board page embeds, or null. Read from the page's
 * __NEXT_DATA__ JSON: pattern-matching "name" picked up nested fields (a
 * fund's legal entity name, a logo alt text) instead of the network's own.
 */
async function probe(url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const html = await res.text();
    const raw = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
    let network = null;
    if (raw) {
      try {
        // Some boards embed raw newlines inside JSON strings; JSON.parse rejects those.
        network = JSON.parse(raw.replace(/[\u0000-\u001f]+/g, ' ')).props?.pageProps?.network ?? null;
      } catch { /* fall through to the regex below */ }
    }
    const id = network?.id ?? html.match(/"network":\{"id":"(\d+)"/)?.[1];
    if (!id) return null;
    const boardUrl = network?.url ? `https://${String(network.url).replace(/^https?:\/\//, '').replace(/\/+$/, '')}/jobs` : (res.url || url);
    return { id: String(id), name: network?.name || new URL(boardUrl).hostname, boardUrl };
  } catch {
    return null;
  }
}

/** US, title-relevant postings per day, from the network's last 48 hours. */
async function measure(networkId, rules) {
  const now = Date.now() / 1000;
  const windowSec = 48 * 3600;
  let relevant = 0;
  let total = 0;
  for (let page = 0; page < 30; page += 1) {
    const res = await fetch(`https://api.getro.com/api/v2/collections/${networkId}/search/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UA },
      body: JSON.stringify({ hitsPerPage: 20, page, filters: '', query: '' })
    }).catch(() => null);
    if (!res?.ok) break;
    const jobs = (await res.json()).results?.jobs || [];
    if (!jobs.length) break;
    for (const j of jobs) {
      if (now - (j.created_at ?? 0) > windowSec) continue;
      total += 1;
      const location = [...new Set(j.searchable_locations || [])].join('; ');
      if (titleAllowed(j.title, rules.positive, rules.negative)
        && !gate({ title: j.title, jobLocation: location, extraction: null, allowed: rules.allowed, excluded: rules.excluded }).gated) {
        relevant += 1;
      }
    }
    if (now - Math.min(...jobs.map((j) => j.created_at ?? 0)) > windowSec) break;
  }
  return { perDay: relevant / 2, totalPerDay: total / 2 };
}

async function main() {
  const config = yaml.load(readFileSync(path.join(repoRoot, 'config.yml'), 'utf8'));
  const portals = yaml.load(readFileSync(path.join(repoRoot, 'portals.yml'), 'utf8'));
  const rules = {
    positive: portals.title_filter?.positive || [],
    negative: portals.title_filter?.negative || [],
    allowed: config.location?.allowed || [],
    excluded: config.location?.excluded || []
  };
  const configured = new Set((portals.tracked_companies || []).filter((c) => c.platform === 'getro').map((c) => String(c.network_id)));

  const crawled = await crawlGetroHosts();
  const candidates = [
    ...crawled.map((h) => `https://${h}/jobs`),
    ...FUND_DOMAINS.flatMap((d) => SUBDOMAINS.map((sub) => `https://${sub}.${d}/jobs`))
  ];
  console.log(`probing ${candidates.length} candidate boards (${crawled.length} from Common Crawl)...`);
  const probed = await pooled(candidates.map((url) => ({ url })), ({ url }) => probe(url), { limit: CONCURRENCY, perHost: 1 });

  const networks = new Map();
  for (const r of probed) {
    const hit = r?.ok ? r.value : null;
    if (hit && !networks.has(hit.id)) networks.set(hit.id, hit);
  }
  console.log(`Getro networks found: ${networks.size} (${[...networks.keys()].filter((id) => configured.has(id)).length} already in portals.yml)`);

  const fresh = [...networks.values()].filter((n) => !configured.has(n.id));
  // `url` only groups these calls under one host for pooled's per-host cap;
  // the board's own address stays in boardUrl.
  const measured = await pooled(fresh.map((n) => ({ ...n, url: 'https://api.getro.com/' })), async (n) => ({ ...n, ...(await measure(n.id, rules)) }), { limit: 4, perHost: 4 });
  const rows = measured.filter((r) => r?.ok).map((r) => r.value).sort((a, b) => b.perDay - a.perDay);
  for (const n of rows) console.log(`  ${String(n.perDay).padStart(5)}/day relevant  (${n.totalPerDay}/day total)  #${n.id}  ${n.name}  ${n.boardUrl}`);
  const keep = rows.filter((n) => n.perDay >= FLOOR);
  console.log(`keeping ${keep.length} networks at >= ${FLOOR} relevant jobs/day: ~${keep.reduce((a, n) => a + n.perDay, 0)} jobs/day before dedup`);

  const header = [
    '# Getro VC-network boards found by tools/find-getro-networks.mjs — do not edit by',
    `# hand; re-run the tool. Generated ${new Date().toISOString().slice(0, 10)}. Each produced >= ${FLOOR} US,`,
    '# title-relevant postings/day when measured. Merged after portals.yml by src/config.mjs.',
    ''
  ].join('\n');
  const doc = {
    tracked_companies: keep.map((n) => ({
      name: n.name,
      careers_url: n.boardUrl,
      platform: 'getro',
      network_id: Number(n.id),
      enabled: true
    }))
  };
  writeFileSync(path.join(repoRoot, 'portals.getro.yml'), header + yaml.dump(doc, { lineWidth: 200 }));
  console.log('wrote portals.getro.yml');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
