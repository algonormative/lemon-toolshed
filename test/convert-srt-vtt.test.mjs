// POST /convert/srt-vtt — SubRip to WebVTT.
//
// The difference between the formats is small and entirely mechanical, so the
// test that matters is the one a global find-and-replace fails: a COMMA INSIDE
// THE CAPTION TEXT is dialogue, not a timestamp separator, and it has to come
// back untouched.
//
// PHASE: the env-gated free tier, so conversions are actually served.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useWorker, client, callers, TIER_ON_VARS } from './harness.mjs';

let worker;
let api;
const ips = callers('srt-vtt');

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

const raw = (input) => api.convert('srt-vtt', input, { ip: ips.next() });

async function vtt(input) {
  const res = await raw(input);
  assert.equal(res.status, 200, `srt-vtt refused ${res.status}: ${res.text}`);
  assert.match(res.contentType, /^text\/vtt/);
  return res.text;
}

const TWO_CUES = '1\n00:00:01,000 --> 00:00:02,000\nHello, there.\n\n2\n00:00:03,500 --> 00:00:04,250\nBye.\n';

describe('srt-vtt', () => {
  test('the file opens with the WEBVTT header and a blank line', async () => {
    const out = await vtt(TWO_CUES);
    assert.ok(out.startsWith('WEBVTT\n\n'), `no WEBVTT header: ${JSON.stringify(out.slice(0, 20))}`);
  });

  test('timestamps take a decimal point instead of a comma', async () => {
    const out = await vtt(TWO_CUES);
    assert.ok(out.includes('00:00:01.000 --> 00:00:02.000'), out);
    assert.ok(out.includes('00:00:03.500 --> 00:00:04.250'), out);
    assert.ok(!/\d,\d{3} -->/.test(out), `a comma survived in a timestamp: ${out}`);
  });

  test('a comma in the caption text is NOT touched', async () => {
    // The find-and-replace failure mode, pinned.
    const out = await vtt(TWO_CUES);
    assert.ok(out.includes('Hello, there.'), `the dialogue lost its comma: ${out}`);
  });

  test('cue numbers are kept as WebVTT cue identifiers', async () => {
    const out = await vtt(TWO_CUES);
    assert.match(out, /\n1\n00:00:01\.000/, out);
    assert.match(out, /\n2\n00:00:03\.500/, out);
  });

  test('the whole file converts to the expected text', async () => {
    assert.equal(
      await vtt(TWO_CUES),
      'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nHello, there.\n\n2\n00:00:03.500 --> 00:00:04.250\nBye.\n'
    );
  });

  test('CRLF input converts to LF output', async () => {
    const out = await vtt('1\r\n00:00:01,000 --> 00:00:02,000\r\nHi.\r\n');
    assert.ok(!out.includes('\r'), `a CR survived: ${JSON.stringify(out)}`);
    assert.ok(out.includes('00:00:01.000 --> 00:00:02.000'), out);
  });

  test("SubRip's coordinate extension is dropped, not emitted as a cue setting", async () => {
    // `X1:… Y1:…` is SubRip positioning. It is not WebVTT cue-setting syntax, so
    // passing it through would produce a line a player reads as positioning it
    // never asked for.
    const out = await vtt('1\n00:00:01,000 --> 00:00:02,000  X1:1 X2:2 Y1:3 Y2:4\nHi.\n');
    assert.ok(out.includes('00:00:01.000 --> 00:00:02.000\n'), out);
    assert.ok(!out.includes('X1:'), `the coordinate extension survived: ${out}`);
  });

  test('multi-line captions keep their line breaks', async () => {
    const out = await vtt('1\n00:00:01,000 --> 00:00:02,000\nline one\nline two\n');
    assert.ok(out.includes('line one\nline two'), out);
  });

  test('markup inside a caption is passed through untouched', async () => {
    const out = await vtt('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<i>Up here.</i>\n');
    assert.ok(out.includes('{\\an8}<i>Up here.</i>'), out);
  });

  test('a single-digit hour field is accepted', async () => {
    const out = await vtt('1\n1:02:03,004 --> 1:02:04,005\nHi.\n');
    assert.ok(out.includes('1:02:03.004 --> 1:02:04.005'), out);
  });

  test('a BOM is stripped rather than landing before WEBVTT', async () => {
    const out = await vtt('﻿1\n00:00:01,000 --> 00:00:02,000\nHi.\n');
    assert.ok(out.startsWith('WEBVTT'), `a BOM survived: ${JSON.stringify(out.slice(0, 12))}`);
  });

  test('a file already using dots converts idempotently', async () => {
    const out = await vtt('1\n00:00:01.000 --> 00:00:02.000\nHi.\n');
    assert.ok(out.includes('00:00:01.000 --> 00:00:02.000'), out);
  });
});

describe('srt-vtt refusals', () => {
  test('a file with no timestamp line is a 400', async () => {
    const res = await raw('just some text\nand more\n');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /no SubRip timestamp line/, res.text);
  });

  test('a nearly-right timestamp is still no timestamp', async () => {
    const res = await raw('1\n00:00:01 --> 00:00:02\nHi.\n');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /no SubRip timestamp line/, res.text);
  });

  test('an empty body is a 400', async () => {
    const res = await raw('');
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'the request body is empty');
  });

  test('every refusal is a one-line JSON error with no stack trace', async () => {
    for (const input of ['nope\n', '1\n00:00:01 --> 00:00:02\nHi.\n']) {
      const res = await raw(input);
      assert.equal(res.status, 400);
      assert.match(res.contentType, /application\/json/);
      const { error } = res.json();
      assert.ok(!error.includes('\n'), `not one line: ${error}`);
      assert.ok(!/\bat\s+\w+\s+\(/.test(error), `a stack trace leaked: ${error}`);
    }
  });
});
