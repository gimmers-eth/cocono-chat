// rich.js — the pure parsing behind the chat's rich surfaces: @-mentions
// (composer search + receiver-side rendering) and links (with and WITHOUT
// an explicit scheme). No DOM here: these are the rules the painter, the
// popup and the Links tab all share, so they are pinned at the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  USERNAME_RE, linkHref, splitRich, extractLinks, mentionCandidates,
  packRich, unpackRich,
} from '../app/js/rich.js';

test('rich: usernames follow the server rules', () => {
  assert.ok(USERNAME_RE.test('bob-3'));
  assert.ok(USERNAME_RE.test('Ab_cd-9'));
  assert.ok(!USERNAME_RE.test('bo'), 'too short (server: 4 min)');
  assert.ok(!USERNAME_RE.test('a'.repeat(65)), 'too long (server: 64 max)');
  assert.ok(!USERNAME_RE.test('bob.3'), 'a dot is not a username char');
});

test('rich: scheme links keep every old behaviour', () => {
  const links = extractLinks('go https://co.co.no/x?a=1, and http://example.com/y. again https://co.co.no/x?a=1');
  assert.deepEqual(links.map((l) => l.url), ['https://co.co.no/x?a=1', 'http://example.com/y']);
  assert.deepEqual(links.map((l) => l.href), links.map((l) => l.url), 'explicit scheme keeps its scheme');
  assert.equal(extractLinks('nice https://example.com/a)!')[0].url, 'https://example.com/a');
  assert.deepEqual(extractLinks('javascript:alert(1)'), [], 'only http(s) is a link');
  assert.deepEqual(extractLinks('https://'), []);
});

test('rich: bare hosts count as links WITHOUT https:// (no scheme needed)', () => {
  const links = extractLinks('visit example.com/foo and dev.co.co.no today');
  assert.deepEqual(links.map((l) => l.url), ['example.com/foo', 'dev.co.co.no']);
  assert.deepEqual(links.map((l) => l.href), ['https://example.com/foo', 'https://dev.co.co.no'],
    'a bare host opens over https');
  assert.equal(extractLinks('www.foo.bar-baz.com/path?x=1')[0].host, 'www.foo.bar-baz.com');
  assert.equal(extractLinks('example.com.')[0].url, 'example.com', 'the sentence dot is prose');
  assert.equal(extractLinks('see example.com/a)!')[0].url, 'example.com/a');
});

test('rich: bare-host rules do NOT eat ordinary prose', () => {
  // the false-positive set: things a chat says all the time
  assert.deepEqual(extractLinks('photo.jpg v1.2 e.g. don.t note.txt'), []);
  assert.deepEqual(extractLinks('user@example.com is not a link'), [], 'emails stay emails');
  assert.deepEqual(extractLinks('path/to/file.md and a.b/c'), []);
  assert.deepEqual(extractLinks('version 1.2.3.beta'), []);
});

test('rich: splitRich renders KNOWN @tokens as mentions, everything else as text', () => {
  const known = (u) => u === 'bob-3' || u === 'alice_dev';
  const segs = splitRich('hey @bob-3 see example.com/x and @zedz!', known);
  assert.deepEqual(segs.map((s) => s.kind), ['text', 'mention', 'text', 'link', 'text']);
  assert.equal(segs[1].name, 'bob-3');
  assert.equal(segs[1].text, '@bob-3', 'the @ stays part of the run (Copy keeps the wire format)');
  assert.equal(segs[4].text, ' and @zedz!', 'an unknown name is NOT a person record here');
  // punctuation-glued mentions still resolve ("@bob-3," mid-sentence)
  assert.deepEqual(splitRich('@bob-3,@alice_dev ok', known).map((s) => s.kind),
    ['mention', 'text', 'mention', 'text']);
  // a mention glued to a word is prose ("mail@bob-3" nobody types that, but
  // "email@x" must not summon a user component for x)
  assert.deepEqual(splitRich('mailx@bob-3', known).map((s) => s.kind), ['text'],
    'word-glued @ is not a mention');
  // links inside the scheme form of a URL's PATH never split into a mention
  assert.deepEqual(splitRich('https://co.co.no/u/@bob-3', known)
    .filter((s) => s.kind === 'mention').length, 0, 'the URL is ONE link run');
  // whitespace/newlines around the token (the spec form " @username ")
  assert.deepEqual(splitRich('hi @bob-3 ', known).map((s) => s.kind), ['text', 'mention', 'text']);
});

test('rich: splitRich is safe on empty and odd input', () => {
  assert.deepEqual(splitRich(null, () => true), []);
  assert.deepEqual(splitRich('', () => true), []);
  assert.deepEqual(splitRich('plain text', () => true), [{ kind: 'text', text: 'plain text' }]);
});

test('rich: the @-search puts the chat first, caps at THREE', () => {
  const peers = ['alice_dev', 'bob-3', 'carol4', 'dave_5'];
  // empty query: current chat first, then known users alphabetically, 3 max
  assert.deepEqual(mentionCandidates({ query: '', currentPeer: 'zed', peers }),
    ['zed', 'alice_dev', 'bob-3']);
  // the current chat still leads when it matches the query
  assert.deepEqual(mentionCandidates({ query: 'bo', currentPeer: 'bob-3', peers }), ['bob-3']);
  assert.deepEqual(mentionCandidates({ query: 'a', currentPeer: 'zed', peers }),
    ['alice_dev', 'carol4', 'dave_5'], 'substring match (the non-matching chat peer drops out), three slots');
  // the current peer is never doubled out of the peers list
  assert.deepEqual(mentionCandidates({ query: '', currentPeer: 'alice_dev', peers }),
    ['alice_dev', 'bob-3', 'carol4']);
  assert.deepEqual(mentionCandidates({ query: 'zzz', currentPeer: 'zed', peers }), []);
});

test('rich: linkHref only ever hands back http(s)', () => {
  assert.equal(linkHref('example.com'), 'https://example.com');
  assert.equal(linkHref('http://x.y'), 'http://x.y');
  assert.equal(linkHref('https://x.y'), 'https://x.y');
});

test('rich: the men envelope asserts search-picked names to the receiver', () => {
  const wire = packRich('hi @bob-3 and @zedz!', ['bob-3']);
  assert.ok(wire.startsWith('{"men":'), 'picked mentions ride a JSON envelope');
  const back = unpackRich(wire);
  assert.equal(back.text, 'hi @bob-3 and @zedz!', 'the plain text comes back intact');
  assert.deepEqual(back.mentions, ['bob-3'], 'ONLY the picked name is asserted');
  // no picks -> plain wire (old receivers read it untouched)
  assert.equal(packRich('plain @bob-3 hello', []), 'plain @bob-3 hello');
  assert.deepEqual(unpackRich('plain text'), { text: 'plain text', mentions: [] });
  // hostile/corrupt envelopes are REFUSED, never half-believed
  assert.deepEqual(unpackRich('{"men": ["<script>"], "text": "x"}').mentions, [],
    'a name that cannot exist is dropped');
  assert.deepEqual(unpackRich('{"men": ["bob-3"], "text": 5}').mentions, [],
    'a non-string text is not an envelope at all');
  assert.deepEqual(unpackRich('{"men": broken').mentions, [], 'unparseable JSON passes through');
  assert.deepEqual(unpackRich('{"media":{"id":"a"}}').mentions, [], 'media payloads are not envelopes');
  // dedup + case-fold + cap
  const many = Array.from({ length: 40 }, (_, i) => `user-${i}`);
  assert.equal(unpackRich(packRich('x', many)).mentions.length, 20, 'a burst cannot bury the record');
  assert.deepEqual(unpackRich(packRich('x', ['Bob-3', 'bob-3'])).mentions, ['bob-3']);
});
