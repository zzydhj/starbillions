/**
 * Is the live site reachable, and does it render?
 *
 *   node tools/ingest/wp/probe-live.mjs
 *
 * Decides whether a local WordPress is needed at all: crawling a working origin
 * is less work than recreating one, and produces the same markup. When the live
 * host ran out of PHP memory this was returning a fatal error rather than a page,
 * so "reachable" is not the test — a page that renders Woodmart markup is.
 */
const TARGETS = [
  'https://tftstar.com/',
  'https://tftstar.com/en/',
  'https://tftstar.com/sitemap_index.xml',
  'https://tftstar.com/sitemap.xml',
];

for (const target of TARGETS) {
  const started = Date.now();

  try {
    const response = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(25000) });
    const body = await response.text();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    console.log(`\n  ${response.status} ${body.length} bytes ${seconds}s  ${target}`);
    console.log(`    final url: ${response.url}`);

    const fatal = /(Fatal error|Allowed memory size|WordPress database error)[^<]*/i.exec(body);
    if (fatal) console.log(`    BROKEN: ${fatal[1].slice(0, 120)}`);

    if (/class="[^"]*\bwd-/.test(body)) console.log('    renders Woodmart markup: yes');
    if (/id="elementor-wrapper|data-id="[^"]*"/.test(body)) console.log('    renders Elementor markup: yes');

    const links = [...body.matchAll(/href="(https?:\/\/[^"]*tftstar\.com[^"]*)"/g)].map(([, href]) => href);
    console.log(`    internal links found: ${links.length}`);
    for (const link of links.slice(0, 6)) console.log(`      ${link}`);
  } catch (error) {
    console.log(`\n  FAILED ${target}\n    ${error.message}`);
  }
}
