// POST /convert/vtt-srt — WebVTT to SubRip.
//
// The harder direction, because WebVTT is the larger format. Everything it has
// that SubRip does not — the header, NOTE/STYLE/REGION blocks, cue identifiers,
// per-cue settings, hour-less timestamps — has to land somewhere, and this suite
// pins WHERE: dropped, renumbered, or expanded. Dropping loudly here is better
// than a player ignoring the same thing silently later.
//
// PHASE: the env-gated free tier, so conversions are actually served.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useWorker, client, callers, TIER_ON_VARS } from './harness.mjs';

let worker;
let api;
const ips = callers('vtt-srt');

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

const raw = (input) => api.convert('vtt-srt', input, { ip: ips.next() });

async function srt(input) {
  const res = await raw(input);
  assert.equal(res.status, 200, `vtt-srt refused ${res.status}: ${res.text}`);
  assert.match(res.contentType, /^application\/x-subrip/);
  return res.text;
}

describe('vtt-srt', () => {
  test('a plain two-cue file converts whole', async () => {
    assert.equal(
      await srt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello.\n\n00:00:03.000 --> 00:00:04.000\nBye.\n'),
      '1\n00:00:01,000 --> 00:00:02,000\nHello.\n\n2\n00:00:03,000 --> 00:00:04,000\nBye.\n'
    );
  });

  test('the WEBVTT header does not survive into the SubRip file', async () => {
    const out = await srt('WEBVTT - with a title\n\n00:00:01.000 --> 00:00:02.000\nHi.\n');
    assert.ok(!out.includes('WEBVTT'), `the header survived: ${out}`);
  });

  test('timestamps take a comma instead of a decimal point', async () => {
    const out = await srt('WEBVTT\n\n00:00:01.250 --> 00:00:02.500\nHi.\n');
    assert.ok(out.includes('00:00:01,250 --> 00:00:02,500'), out);
    assert.ok(!/\d\.\d{3} -->/.test(out), `a decimal point survived: ${out}`);
  });

  test('an hour-less timestamp is expanded to hh:mm:ss,mmm', async () => {
    // WebVTT allows mm:ss.mmm. SubRip does not, and a player fed one shows
    // nothing rather than complaining.
    const out = await srt('WEBVTT\n\n01:02.500 --> 01:03.000\nHi.\n');
    assert.ok(out.includes('00:01:02,500 --> 00:01:03,000'), out);
  });

  test('cues are renumbered from 1, in order', async () => {
    const out = await srt(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA\n\n00:00:03.000 --> 00:00:04.000\nB\n\n00:00:05.000 --> 00:00:06.000\nC\n'
    );
    assert.deepEqual(
      out.trimEnd().split('\n\n').map((cue) => cue.split('\n')[0]),
      ['1', '2', '3']
    );
  });

  test('a cue identifier is replaced by the sequence number, not kept', async () => {
    const out = await srt('WEBVTT\n\nintro-cue\n00:00:01.000 --> 00:00:02.000\nHi.\n');
    assert.ok(!out.includes('intro-cue'), `the cue identifier survived: ${out}`);
    assert.ok(out.startsWith('1\n'), out);
  });

  test('cue settings after the end timestamp are dropped', async () => {
    const out = await srt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:start line:90% position:10%\nHi.\n');
    assert.ok(out.includes('00:00:01,000 --> 00:00:02,000\nHi.'), out);
    for (const setting of ['align', 'line:', 'position']) {
      assert.ok(!out.includes(setting), `${setting} survived into SubRip: ${out}`);
    }
  });

  test('NOTE, STYLE and REGION blocks are dropped', async () => {
    const out = await srt(
      'WEBVTT\n\nNOTE this is a comment\n\nSTYLE\n::cue { color: red }\n\nREGION\nid:r1\n\n00:00:01.000 --> 00:00:02.000\nHi.\n'
    );
    assert.equal(out, '1\n00:00:01,000 --> 00:00:02,000\nHi.\n');
  });

  test('multi-line captions keep their line breaks', async () => {
    const out = await srt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nline one\nline two\n');
    assert.ok(out.includes('line one\nline two'), out);
  });

  test('inline caption markup is passed through', async () => {
    const out = await srt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Roger>Hi <b>there</b>.\n');
    assert.ok(out.includes('<v Roger>Hi <b>there</b>.'), out);
  });

  test('CRLF input converts to LF output', async () => {
    const out = await srt('WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nHi.\r\n');
    assert.ok(!out.includes('\r'), `a CR survived: ${JSON.stringify(out)}`);
  });

  test('a BOM before WEBVTT does not defeat the header check', async () => {
    const out = await srt('﻿WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi.\n');
    assert.equal(out, '1\n00:00:01,000 --> 00:00:02,000\nHi.\n');
  });
});

describe('vtt-srt refusals', () => {
  test('input that does not begin with WEBVTT is a 400', async () => {
    // Refused rather than parsed hopefully: a SubRip file posted here would
    // otherwise be renumbered and handed back looking converted.
    const res = await raw('1\n00:00:01,000 --> 00:00:02,000\nHi.\n');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /does not begin with WEBVTT/, res.text);
  });

  test('a header with no cues at all is a 400', async () => {
    const res = await raw('WEBVTT\n\nNOTE nothing here\n');
    assert.equal(res.status, 400, res.text);
    assert.match(res.json().error, /no WebVTT cue with a timestamp/, res.text);
  });

  test('an empty body is a 400', async () => {
    const res = await raw('');
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'the request body is empty');
  });

  test('every refusal is a one-line JSON error with no stack trace', async () => {
    for (const input of ['not a vtt\n', 'WEBVTT\n', 'WEBVTT\n\nNOTE only\n']) {
      const res = await raw(input);
      assert.equal(res.status, 400);
      assert.match(res.contentType, /application\/json/);
      const { error } = res.json();
      assert.ok(!error.includes('\n'), `not one line: ${error}`);
      assert.ok(!/\bat\s+\w+\s+\(/.test(error), `a stack trace leaked: ${error}`);
    }
  });
});
