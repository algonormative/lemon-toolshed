// How a paid call FAILS, written down once and served with the price.
//
// Every x402 seller publishes what a call costs. Almost none publish what
// happens when the call degrades — whether an authorization is spent or
// released when the conversion 4xxs, what a retry carrying the same signed
// payload gets, whether anything is held, whether a refund exists at all. A
// buyer can read the price and still not be able to bound its downside.
//
// So the five terms below travel with the price, in the two places a machine
// already looks: `x-billing-terms` on every paid operation in openapi.json, and
// `billing_terms` on every resource in /.well-known/x402. README's "Billing
// terms" section is the third copy, for a human — and it quotes these same
// strings, which test/billing-terms.test.mjs checks verbatim.
//
// A MODULE OF ITS OWN, and importable by plain Node: build.mjs is what renders
// the machine surfaces, and it CANNOT import worker/beacon.js (that module pulls
// in the workerd built-in `cloudflare:email`, which Node's ESM loader refuses).
// So nothing here may import anything workerd-only, and nothing here may be
// duplicated in build.mjs — the point of the file is that one renderer feeds all
// three surfaces.
//
// THE PRICE RENDERERS LIVE HERE TOO, and that is the reason rather than a
// convenience: the disclosure quotes the same atomic figure the 402 envelope
// quotes, and the only way that is guaranteed is for openapi.json's
// `x-payment-info`, /.well-known/x402's `accepts` amounts and these terms to
// come out of one implementation. build.mjs imports them from here.
//
// EVERY SENTENCE BELOW DESCRIBES SHIPPED BEHAVIOUR, and each one is checkable
// against worker/beacon.js: the claim in handleConvert's `abandon`, the release
// in releasePaymentSafely, the insert in claimPaymentOnce, the replay answer in
// paymentAlreadyUsed, the header precedence in presentedPayment, and the settle
// block that runs after the response. Nothing here is a promise, a roadmap or an
// intention; where no path exists the value is the string "none" and the prose
// says so plainly. That is the only way a disclosure like this is worth more
// than silence: a buyer who acts on it has to be right.

// USDC's 6 decimals — the same base worker/beacon.js's atomicAmount() rounds to,
// so the decimal and the atomic amount published here cannot disagree with what
// the Worker actually quotes and settles.
export const USD_DECIMALS = 6;

// Decimal USD as a plain string, rendered THROUGH the atomic amount rather than
// by stringifying the float: String(0.0000012) is "1.2e-6", and a price in
// exponent notation is one no discovery parser will read.
export const usdDecimal = (usd) => {
  const digits = String(Math.round(usd * 10 ** USD_DECIMALS)).padStart(USD_DECIMALS + 1, '0');
  const frac = digits.slice(-USD_DECIMALS).replace(/0+$/, '');
  return frac ? `${digits.slice(0, -USD_DECIMALS)}.${frac}` : digits.slice(0, -USD_DECIMALS);
};

// USDC has 6 decimals on BOTH rails, so one atomic figure serves a Base entry
// and a Solana one — the same identity worker/beacon.js relies on.
export const atomicAmount = (usd) => String(Math.round(usd * 10 ** USD_DECIMALS));

// The address openapi.json's `info.contact` and /.well-known/x402's
// `service.contact` already publish. Named here so the refund term sends a buyer
// to the same place the rest of the document does — test/billing-terms.test.mjs
// asserts all three still agree.
export const SUPPORT_EMAIL = 'support@lemon-agent.dev';

// MIRRORS worker/beacon.js (PAYMENT_HEADER_V1 / PAYMENT_HEADER_V2, ~line 196),
// in the order presentedPayment() reads them: PAYMENT-SIGNATURE first, so a
// request carrying both is hashed on the v2 header. Duplicated rather than
// imported for the reason in the header comment above; the drift guard in
// test/billing-terms.test.mjs reads beacon.js as text and fails if either
// literal has moved, exactly as test/surfaces.test.mjs guards the rail
// constants. Uppercased only for the reader — HTTP header names are
// case-insensitive and the Worker matches them that way.
export const PAYMENT_HEADER_V1 = 'x-payment';
export const PAYMENT_HEADER_V2 = 'payment-signature';
const PAYMENT_HEADERS = [PAYMENT_HEADER_V2, PAYMENT_HEADER_V1].map((h) => h.toUpperCase());

/**
 * The five terms, as prose, keyed by field. SKU-INDEPENDENT ON PURPOSE.
 *
 * The price is the only thing that differs between the nineteen paid routes, and
 * it is carried in a structured field (`billable_unit.price_usd`) rather than
 * written into a sentence — so one set of sentences is true of every route, and
 * the README can quote them once instead of nineteen times.
 */
export const BILLING_TERMS = {
  billable_unit:
    'One served conversion. A single signed authorization buys exactly one response at the listed ' +
    'price; the amount settled is that whole price, and there is no partial, metered or per-byte ' +
    'billing. Settlement is queued only after the converter has returned an output, and only for a ' +
    'payment the facilitator verified — a conversion served while the facilitator was unreachable ' +
    'settles nothing at all, and says so in its x-payment-verified header.',

  hold:
    'None. Verification is a read at the facilitator, so nothing is reserved, escrowed or held: the ' +
    'signed authorization moves no funds until it is submitted at settle, which is queued behind ' +
    'the response rather than run in front of it. An authorization that never reaches settle simply ' +
    'goes unused.',

  idempotency:
    'There is no idempotency-key header. The key is the SHA-256 of the payment header exactly as ' +
    'presented — `X-PAYMENT` for x402 v1, `PAYMENT-SIGNATURE` for x402 v2, and PAYMENT-SIGNATURE is ' +
    'the one read when a request carries both — claimed single-use between verification and the ' +
    'conversion. A retry carrying the same authorization, concurrently or an hour later, is answered ' +
    '402 with invalidReason `payment_already_used` and the live terms attached; it converts nothing, ' +
    'serves no second response and settles nothing. Sign a fresh authorization, with a fresh nonce, ' +
    'to buy another conversion.',

  post_payment_error:
    'Nothing is ever settled unless a conversion was served, and every exit after the claim hands ' +
    'the claim back, so the very same authorization can be presented again. That covers the 4xx ' +
    'paths — a body that cannot be read, an empty body, a body over the 256 KB cap, input the ' +
    'converter refused, anything unexpected — and the one 5xx after payment, a 503 raised when the ' +
    'metering store is unreachable and the route fails closed. The release is best-effort, so a ' +
    'retry that is nonetheless refused as already used means signing a fresh authorization. What is ' +
    'deliberately not given back is the per-caller daily ceiling: it bounds what a request costs us, ' +
    'and the facilitator round trip was made either way.',

  refund:
    'None. There is no refund, credit or dispute endpoint, and no reversal of a settled payment. The ' +
    'mechanism is non-charge rather than refund: an authorization for a conversion that was not ' +
    'served is never submitted, so no funds move. A settlement that fails after a conversion was ' +
    'served is recorded in the ledger with settle_ok = 0 and is not retried — the caller keeps the ' +
    `conversion. Anything else is ${SUPPORT_EMAIL} and a conversation, not a guaranteed remedy.`,
};

/** The field order every surface renders, so three copies cannot disagree on shape. */
export const BILLING_TERMS_FIELDS = Object.freeze(Object.keys(BILLING_TERMS));

/**
 * The failure disclosure for one hosted, priced tool.
 *
 * `hosted` is the normalised `hosted:` block — the same object catalog.json and
 * the Worker's compiled catalog carry, so the price quoted here is read off the
 * catalog rather than typed a second time.
 *
 * The same five keys for every paid SKU, in the same order, differing only where
 * the price does. Machine-readable first — `held: false`, `path: 'none'`, a
 * status and an error code for the replay case — with the prose alongside rather
 * than instead: a router needs the field, a human reading the document needs the
 * sentence.
 */
export function billingTerms(hosted) {
  const usd = hosted.price.amount_usd;
  return {
    billable_unit: {
      unit: 'one served conversion',
      price_usd: usdDecimal(usd),
      amount_atomic: atomicAmount(usd),
      metered: false,
      note: BILLING_TERMS.billable_unit,
    },
    hold: {
      held: false,
      note: BILLING_TERMS.hold,
    },
    idempotency: {
      // The claim is keyed on the payment header as presented, so a
      // byte-identical replay is the thing that collides — see claimPaymentOnce
      // in worker/beacon.js. WHICH header that is depends on the protocol
      // version the buyer speaks, hence the list rather than one name.
      key: 'sha256(payment header, as presented)',
      headers: PAYMENT_HEADERS,
      // Named in full rather than as a bare `header`, which alongside `headers`
      // above would read as "the one that was used". This is the separate
      // idempotency-key header this service does NOT have.
      idempotency_key_header: null,
      replay: { status: 402, error: 'payment_already_used' },
      note: BILLING_TERMS.idempotency,
    },
    post_payment_error: {
      settles: false,
      on_4xx: 'authorization released',
      // Not a copy of the 4xx string by accident: on this service the single
      // post-payment 5xx goes through the same compensating release, and saying
      // so is the honest answer even though the two happen to agree.
      on_5xx: 'authorization released',
      note: BILLING_TERMS.post_payment_error,
    },
    refund: {
      path: 'none',
      dispute: 'none',
      contact: SUPPORT_EMAIL,
      note: BILLING_TERMS.refund,
    },
  };
}
