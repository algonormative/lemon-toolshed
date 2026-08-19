// POST /convert/json-yaml — round-trip property tests.
//
// The property under test is not "the YAML looks like this". It is: for every
// document in the battery, json -> yaml -> json deep-equals the original. The
// second leg runs through the LIVE yaml-json endpoint, so the two converters
// are checked against each other rather than against a golden file, and a
// serializer change that stays faithful is allowed to change its output freely.
//
// Comparison is against `JSON.parse(original)`, not the original text: JSON
// itself does not distinguish 1 from 1.0, so the text is not the invariant —
// the parsed value is.

// The free tier is OFF by default now, so a conversion is a paid call and an
// unauthenticated POST answers 402. This suite is about the CONVERTER, not about
// payment, so it boots the env-gated free tier and gets served 200s the cheap way.

import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useWorker, client, callers, TIER_ON_VARS } from './harness.mjs';

let worker;
let api;
const ips = callers('json-yaml');

before(async () => {
  worker = await useWorker({ vars: TIER_ON_VARS });
  api = client(worker);
});
after(async () => {
  await worker.stop();
});

async function toYaml(json) {
  const res = await api.convert('json-yaml', json, { ip: ips.next() });
  assert.equal(res.status, 200, `json-yaml refused ${res.status}: ${res.text}`);
  assert.match(res.contentType, /^application\/yaml/);
  return res.text;
}

async function backToJson(yamlText) {
  const res = await api.convert('yaml-json', yamlText, { ip: ips.next() });
  assert.equal(res.status, 200, `yaml-json refused ${res.status}: ${res.text}`);
  assert.match(res.contentType, /^application\/json/);
  return res.text;
}

/** json -> yaml -> json, asserting the value survives the trip. */
async function roundTrip(name, json) {
  const yamlText = await toYaml(json);
  const returned = await backToJson(yamlText);
  assert.deepEqual(
    JSON.parse(returned),
    JSON.parse(json),
    `${name} did not survive the round trip.\n  yaml: ${JSON.stringify(yamlText)}\n  back: ${returned}`
  );
  return yamlText;
}

// Ten levels of nesting, built rather than typed so the depth is unambiguous.
const deepDocument = (() => {
  let node = { leaf: 'bottom', n: 10 };
  for (let i = 9; i >= 0; i--) node = { [`level_${i}`]: node, index: i };
  return JSON.stringify(node);
})();

const BATTERY = {
  'deep nesting, 10 levels': deepDocument,
  'array of mixed types': '[1,"two",null,true,false,{"k":[1,2]},[[3]],"",0]',
  'null, true and false': '{"n":null,"t":true,"f":false,"arr":[null,true,false]}',
  // -0 is deliberately absent: JSON has no way to express it distinctly and
  // deepStrictEqual separates -0 from 0, so it would test JS float identity
  // rather than the converter.
  'integers versus floats': '{"int":1,"float":1.0,"neg":-0.5,"exp":2.5e3,"zero":0,"round":2.0,"long":3.141592653589793}',
  'large numbers': '{"big":9007199254740991,"beyond":9007199254740993,"huge":1e30,"tiny":1e-30,"neg":-12345678901234567890}',
  'unicode keys and values': '{"🍋":"lemon","日本語":"テキスト","مرحبا":"rtl","ключ":"значение"}',
  'empty object and empty array': '{"o":{},"a":[],"s":"","nested":{"o":{},"a":[]}}',
  'keys that look like YAML booleans': '{"yes":1,"no":2,"on":3,"off":4,"y":5,"n":6,"true":7,"null":8,"~":9}',
  'values that look like YAML booleans': '{"a":"yes","b":"no","c":"on","d":"off","e":"true","f":"null","g":"~"}',
  'strings that look like numbers': '{"a":"007","b":"1e5","c":"1.0","d":"0x1f","e":"0o17","f":"+1","g":".5","h":"1_000"}',
  'multiline strings': '{"a":"one\\ntwo\\n","b":"trailing\\n\\n","c":"no trailing","d":"\\n leading","e":"a\\r\\nb"}',
  'strings with YAML-significant leading characters': '{"a":"- not a list","b":"#not a comment","c":"@at","d":"*alias","e":"&anchor","f":"%directive","g":": colon","h":"? question"}',
  'strings with surrounding whitespace': '{"lead":"  two spaces","trail":"two spaces  ","tab":"\\tt","only":"   "}',
  'the empty-key case': '{"":"empty key","a":""}',
  'a document that is a bare array': '[[],[[]],{"a":[]}]',
  'long string': `{"s":"${'x'.repeat(5000)}"}`,
  'many keys': JSON.stringify(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i]))),
};

describe('json-yaml round trip', () => {
  for (const [name, json] of Object.entries(BATTERY)) {
    test(name, async () => {
      await roundTrip(name, json);
    });
  }

  test('the round trip is stable across a second pass', async () => {
    // yaml -> json -> yaml should reach a fixed point; if it does not, one of
    // the two converters is losing something that only shows on the second lap.
    const original = '{"a":[1,"2",null],"b":{"c":"007","d":"yes"},"e":"line\\nline\\n"}';
    const yaml1 = await toYaml(original);
    const json1 = await backToJson(yaml1);
    const yaml2 = await toYaml(json1);
    assert.equal(yaml2, yaml1, 'the second pass produced different YAML');
  });

  test('scalar documents at the root round-trip', async () => {
    for (const doc of ['42', '"text"', 'true', 'false', 'null', '-0.5', '"yes"', '"007"']) {
      const yamlText = await toYaml(doc);
      const returned = await backToJson(yamlText);
      assert.deepEqual(JSON.parse(returned), JSON.parse(doc), `root scalar ${doc} -> ${yamlText} -> ${returned}`);
    }
  });

  test('a key colliding with Object.prototype survives', async () => {
    // `__proto__` is the classic silent-loss key. json-yaml has to keep it.
    await roundTrip('__proto__ key', '{"__proto__":"kept","constructor":"kept","toString":"kept"}');
  });
});

describe('json-yaml refusals', () => {
  const bad = {
    'truncated object': '{not json',
    'trailing comma': '{"a":1,}',
    'single quotes': "{'a':1}",
    'bare word': 'undefined',
    'unquoted key': '{a:1}',
    'JS comment': '{"a":1} // note',
    'two documents': '{"a":1}{"b":2}',
  };

  for (const [name, input] of Object.entries(bad)) {
    test(`${name} is a 400 with a one-line JSON error`, async () => {
      const res = await api.convert('json-yaml', input, { ip: ips.next() });
      assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.text}`);
      assert.match(res.contentType, /application\/json/);
      const body = res.json();
      assert.equal(typeof body.error, 'string');
      assert.ok(body.error.length > 0, 'empty error message');
      assert.ok(!body.error.includes('\n'), `the error message is not one line: ${body.error}`);
      assert.match(body.error, /not valid JSON/, body.error);
      // Never a stack trace.
      assert.ok(!/\bat\s+\w+\s+\(/.test(body.error), `a stack trace leaked: ${body.error}`);
    });
  }

  test('an empty body is a 400 before the converter runs', async () => {
    const res = await api.convert('json-yaml', '', { ip: ips.next() });
    assert.equal(res.status, 400);
    assert.equal(res.json().error, 'the request body is empty');
  });
});
