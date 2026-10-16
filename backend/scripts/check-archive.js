import assert from 'node:assert/strict';
import { createArchiveService } from '../src/books/archive.js';

// Opt-in, read-only live check. No database or model API keys are needed.
const archive = createArchiveService();
const results = await archive.search('A Byte Of Python', 1);
assert(results.items.some(item => item.archiveIdentifier === 'ByteOfPython'), 'Test edition missing from live search');
assert(results.items.every(item => item.eligibility?.validation?.scope === 'full'), 'Search exposed an edition without full validation');
const eligible = await archive.eligibility('ByteOfPython');
assert.equal(eligible.eligible, true, `Test edition failed: ${eligible.reasonCode}`);
const secondEdition = await archive.eligibility('alicesadventures19033gut');
assert.equal(secondEdition.eligible, true);
assert.equal(secondEdition.reasonCode, null);
const empty = await archive.search('noteway-no-match-784bc09a2f614da0', 1);
assert.equal(empty.items.length, 0);
console.info(JSON.stringify({ search: 'passed', eligible, secondAccessibleEdition: { archiveIdentifier: secondEdition.archiveIdentifier, reasonCode: secondEdition.reasonCode }, emptySearch: 'passed' }, null, 2));
