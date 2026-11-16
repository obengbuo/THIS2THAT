#!/usr/bin/env node
/**
 * Builds the curated dictionary (src/words.json) from the SCOWL word lists.
 *
 *  - "basic" tier   (SCOWL size <= 20): everyday words, used for Easy puzzle endpoints.
 *  - "common" tier  (SCOWL size <= 35): familiar words. Puzzle start/target words and
 *    the guaranteed solution path are drawn only from this tier.
 *  - "extra" tier   (SCOWL size 40-60): less common but legitimate words. Players may
 *    use them, but the generator never requires them.
 *
 * SCOWL's base lists already exclude proper nouns and abbreviations; we additionally
 * drop anything not purely a-z and everything on the blocklist below.
 *
 * Run: npm run build:dictionary   (output is committed; the runtime has no dependency
 * on the source packages)
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const scowl = require('wordlist-english');
const bad1 = require('badwords-list').array;
const bad2 = require('naughty-words').en;

const BASIC_SIZES = [10, 20];
const COMMON_SIZES = [10, 20, 35];
const EXTRA_SIZES = [40, 50, 55, 60];
const VARIANTS = ['english', 'english/american', 'english/british'];

// Manual additions: vulgar, slur-adjacent, or otherwise not family-game material.
const MANUAL_BLOCK = `
anal anus arse boob bong clit cock coon crap cums cunt dago dick dike dyke fags fuck gook gays homo
jism jizz kike kink klan kunt muff nazi orgy paki piss poon poop porn pube puke rape scat sexy shag shit
slag slut smut spic tits turd twat wank whor wops nude sext
arses bitch boner boobs busty chink cocks coons cunts dicks dildo dykes fanny farts felch fucks gooks homos
horny kikes kinky labia lesbo negro nazis nudes orgys penis perve pervs porno porny pricks prick pubes pubic
pussy queer rapes raped raper rapey semen sexed sexes shite shits skank sluts spunk spick spics tards titty turds
twats vulva wanks whore wussy yobbo incel
`.trim().split(/\s+/);

const block = new Set([...bad1, ...bad2, ...MANUAL_BLOCK].map((w) => w.toLowerCase()));

function collect(sizes) {
  const out = new Set();
  for (const size of sizes)
    for (const variant of VARIANTS)
      for (const w of scowl[`${variant}/${size}`] ?? [])
        if (/^[a-z]+$/.test(w) && (w.length === 4 || w.length === 5) && !block.has(w)) out.add(w.toUpperCase());
  return out;
}

const basic = collect(BASIC_SIZES);
const common = collect(COMMON_SIZES);
const extra = new Set([...collect(EXTRA_SIZES)].filter((w) => !common.has(w)));

const pack = (set, len) => [...set].filter((w) => w.length === len).sort().join('');
const data = {
  version: '1.0.0',
  source: 'SCOWL (via wordlist-english), sizes 10-60, en-US + en-GB',
  basic4: pack(basic, 4),
  common4: pack(common, 4),
  extra4: pack(extra, 4),
  basic5: pack(basic, 5),
  common5: pack(common, 5),
  extra5: pack(extra, 5),
};

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'words.json');
writeFileSync(out, JSON.stringify(data) + '\n');
for (const k of ['basic4', 'common4', 'extra4', 'basic5', 'common5', 'extra5'])
  console.log(k.padEnd(8), data[k].length / Number(k.at(-1)), 'words');
