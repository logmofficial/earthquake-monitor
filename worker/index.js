/**
 * Cloudflare Worker - 地震情報API（修正版）
 *
 * 気象庁 防災情報XML（PULL型）の高頻度・長期フィードを取得し、
 * 「震源・震度に関する情報」(VXSE53) を中心にパースして JSON で返す。
 *
 * 注意:
 * - 公開XMLはリアルタイム性が保証されない
 * - 緊急地震速報の受信機能ではない
 * - 1日10GB超のダウンロードでIP遮断される可能性あり。キャッシュを活用すること
 */

const HIGH_FREQ_FEED_URL = "https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml";
const LONG_FEED_URL = "https://www.data.jma.go.jp/developer/xml/feed/eqvol_l.xml";
const MAX_ITEMS = 30;
const MAX_DETAIL_FETCH = 12;
const CACHE_TTL_SECONDS = 60;
const FETCH_TIMEOUT_MS = 12000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return corsResponse(null, 204);
    if (path === "/api/earthquakes") return handleEarthquakes(request, env, ctx);
    if (path === "/api/health") {
      return corsResponse(JSON.stringify({
        status: "ok", service: "earthquake-monitor", time: new Date().toISOString(),
        pushConfigured: Boolean(env && env.PUSH_KV),
        note: "公開XMLベースの試作API。緊急地震速報の受信機能はありません。"
      }), 200, { "Content-Type": "application/json; charset=utf-8" });
    }
    if (path === "/api/push/public-key" && request.method === "GET") return getPushPublicKey(env);
    if (path === "/api/push/subscribe" && request.method === "POST") return savePushSubscription(request, env);
    if (path === "/api/push/unsubscribe" && request.method === "POST") return removePushSubscription(request, env);

    if (env && env.ASSETS) {
      try { return await env.ASSETS.fetch(request); }
      catch (e) { console.warn("ASSETS.fetch failed", e); }
    }
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    if (!env || !env.PUSH_KV) {
      console.error("PUSH_KV binding is missing; scheduled push check skipped.");
      return;
    }
    try {
      const response = await handleEarthquakes(
        new Request("https://internal.invalid/api/earthquakes"), env, ctx
      );
      if (!response.ok) throw new Error(`Earthquake API returned ${response.status}`);
      const payload = await response.json();
      await notifyForNewEarthquakes(payload, env);
    } catch (error) {
      console.error("Scheduled earthquake check failed:", error);
    }
  }
};

async function handleEarthquakes(request, env, ctx) {
  const cacheKeyUrl = new URL(request.url);
  cacheKeyUrl.pathname = "/api/earthquakes";
  cacheKeyUrl.search = "";
  const cacheRequest = new Request(cacheKeyUrl.toString(), { method: "GET" });

  // 1) Cache API（標準）
  try {
    const cache = caches.default;
    const cachedResponse = await cache.match(cacheRequest);
    if (cachedResponse) {
      const headers = new Headers(cachedResponse.headers);
      headers.set("X-Cache", "HIT");
      return new Response(cachedResponse.body, {
        status: cachedResponse.status,
        headers
      });
    }
  } catch (e) {
    console.warn("Cache API unavailable", e);
  }

  // 2) KV（任意）
  const kvKey = "earthquakes:latest";
  if (env && env.EQ_CACHE) {
    try {
      const cached = await env.EQ_CACHE.get(kvKey, { type: "json" });
      if (cached && cached.fetchedAt && cached.payload) {
        const age = (Date.now() - new Date(cached.fetchedAt).getTime()) / 1000;
        if (age < CACHE_TTL_SECONDS) {
          return corsResponse(JSON.stringify(cached.payload), 200, {
            "Content-Type": "application/json; charset=utf-8",
            "X-Cache": "KV-HIT",
            "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`
          });
        }
      }
    } catch (e) {
      console.warn("KV read failed", e);
    }
  }

  try {
    const { entries, feedErrors } = await collectFeedEntries();

    if (entries.length === 0) {
      const msg =
        feedErrors.length > 0
          ? "フィードの取得に失敗しました: " + feedErrors.join("; ")
          : "地震情報エントリが見つかりませんでした";
      return corsResponse(
        JSON.stringify({
          error: true,
          message: msg,
          updatedAt: new Date().toISOString(),
          earthquakes: []
        }),
        502,
        { "Content-Type": "application/json; charset=utf-8" }
      );
    }

    // 震源・震度関連のみ
    const quakeEntries = entries
      .filter((e) => isHypocenterIntensityEntry(e))
      .slice(0, MAX_ITEMS);

    const earthquakes = [];
    let detailAttempts = 0;

    for (const entry of quakeEntries) {
      // 上限到達後はフィード情報のみ
      if (detailAttempts >= MAX_DETAIL_FETCH || !entry.link) {
        earthquakes.push(buildFromFeedOnly(entry));
        continue;
      }

      // 試行時点でカウント（成功・失敗を問わず上限を守る）
      detailAttempts++;

      try {
        const detailXml = await fetchText(entry.link);
        const parsed = parseEarthquakeReport(detailXml);
        if (parsed) {
          if (!parsed.epicenter) {
            parsed.epicenter =
              extractEpicenterFromContent(entry.content) || "不明";
          }
          earthquakes.push({
            ...parsed,
            sourceUrl: entry.link
          });
        } else {
          earthquakes.push(buildFromFeedOnly(entry, "詳細解析失敗"));
        }
      } catch (err) {
        console.warn("detail fetch/parse failed", entry.link, err);
        earthquakes.push(buildFromFeedOnly(entry, "詳細取得失敗"));
      }
    }

    // 発生時刻の新しい順
    earthquakes.sort((a, b) => {
      const ta = a.originTime ? new Date(a.originTime).getTime() : 0;
      const tb = b.originTime ? new Date(b.originTime).getTime() : 0;
      return tb - ta;
    });

    const payload = {
      updatedAt: new Date().toISOString(),
      source: "気象庁 防災情報XML（PULL型）",
      note: "本データは公開フィードに基づく試作用途です。緊急地震速報ではありません。",
      count: earthquakes.length,
      feedErrors: feedErrors.length ? feedErrors : undefined,
      earthquakes
    };

    const responseBody = JSON.stringify(payload);
    const responseHeaders = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
      "X-Cache": "MISS"
    };

    // Cache API へ保存
    try {
      const cache = caches.default;
      const toCache = corsResponse(responseBody, 200, responseHeaders);
      ctx.waitUntil(cache.put(cacheRequest, toCache.clone()));
    } catch (e) {
      console.warn("Cache put failed", e);
    }

    // KV へ保存（任意）
    if (env && env.EQ_CACHE) {
      ctx.waitUntil(
        env.EQ_CACHE.put(
          kvKey,
          JSON.stringify({ fetchedAt: new Date().toISOString(), payload }),
          { expirationTtl: CACHE_TTL_SECONDS + 30 }
        ).catch((e) => console.warn("KV put failed", e))
      );
    }

    return corsResponse(responseBody, 200, responseHeaders);
  } catch (err) {
    console.error(err);
    return corsResponse(
      JSON.stringify({
        error: true,
        message: "地震情報の取得に失敗しました",
        detail: String(err && err.message ? err.message : err)
      }),
      502,
      { "Content-Type": "application/json; charset=utf-8" }
    );
  }
}

// -----------------------------------------------------------------------------
// Web Push (RFC 8030 / RFC 8291 / VAPID)
// PUSH_KV stores subscriptions, VAPID key material and deduplication state.
// -----------------------------------------------------------------------------
const PUSH_PREFIX = "push:subscription:";
const VAPID_CONFIG_KEY = "push:config:vapid";
const PUSH_STATE_KEY = "push:state:seen";
const PUSH_SUBJECT = "https://earthquake-monitor.logm-official.workers.dev/";

async function getPushPublicKey(env) {
  if (!env || !env.PUSH_KV) return jsonResponse({ error: "PUSH_KV binding is not configured" }, 503);
  try {
    const keys = await ensureVapidKeys(env);
    return jsonResponse({ publicKey: keys.publicKey });
  } catch (e) {
    console.error("VAPID key initialization failed", e);
    return jsonResponse({ error: "Push configuration failed" }, 500);
  }
}

async function savePushSubscription(request, env) {
  if (!env || !env.PUSH_KV) return jsonResponse({ error: "PUSH_KV binding is not configured" }, 503);
  try {
    const sub = await request.json();
    if (!sub || typeof sub.endpoint !== "string" || !sub.endpoint.startsWith("https://") ||
        !sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") {
      return jsonResponse({ error: "Invalid PushSubscription" }, 400);
    }
    const hash = await sha256Base64Url(sub.endpoint);
    await env.PUSH_KV.put(PUSH_PREFIX + hash, JSON.stringify(sub));
    return jsonResponse({ ok: true });
  } catch (e) {
    console.error("Subscription save failed", e);
    return jsonResponse({ error: "Could not save subscription" }, 500);
  }
}

async function removePushSubscription(request, env) {
  if (!env || !env.PUSH_KV) return jsonResponse({ error: "PUSH_KV binding is not configured" }, 503);
  try {
    const body = await request.json();
    if (!body || typeof body.endpoint !== "string") return jsonResponse({ error: "Invalid endpoint" }, 400);
    const hash = await sha256Base64Url(body.endpoint);
    await env.PUSH_KV.delete(PUSH_PREFIX + hash);
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: "Could not remove subscription" }, 500);
  }
}

async function ensureVapidKeys(env) {
  let saved = await env.PUSH_KV.get(VAPID_CONFIG_KEY, "json");
  if (saved && saved.privateJwk && saved.publicKey) return saved;
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicBytes = new Uint8Array(65);
  publicBytes[0] = 4;
  publicBytes.set(base64UrlDecode(jwk.x), 1);
  publicBytes.set(base64UrlDecode(jwk.y), 33);
  const config = { privateJwk: jwk, publicKey: base64UrlEncode(publicBytes) };
  await env.PUSH_KV.put(VAPID_CONFIG_KEY, JSON.stringify(config));
  return config;
}

async function notifyForNewEarthquakes(payload, env) {
  const list = Array.isArray(payload.earthquakes) ? payload.earthquakes : [];
  const records = list.map((eq) => ({
    key: `${eq.eventId || eq.sourceUrl || eq.originTime || "unknown"}|${eq.reportTime || ""}`,
    eq
  })).filter((x) => x.key !== "unknown|");
  if (!records.length) return;

  const previous = await env.PUSH_KV.get(PUSH_STATE_KEY, "json");
  const seen = new Set(previous && Array.isArray(previous.keys) ? previous.keys : []);
  // First scheduled run establishes a baseline and intentionally sends no backlog.
  if (!previous) {
    await env.PUSH_KV.put(PUSH_STATE_KEY, JSON.stringify({ keys: records.map(x => x.key).slice(0, 200) }));
    return;
  }

  const fresh = records.filter(x => !seen.has(x.key));
  if (!fresh.length) return;
  const subscriptions = await env.PUSH_KV.list({ prefix: PUSH_PREFIX, limit: 1000 });
  for (const item of fresh.slice(0, 10).reverse()) {
    const eq = item.eq;
    const title = `地震情報：${eq.epicenter || "震源地不明"}`;
    const body = `最大震度 ${eq.maxIntensity || "不明"} ／ M${eq.magnitude ?? "不明"}。公開XMLに基づく情報です。`;
    const data = { title, body, url: "/", tag: item.key };
    for (const key of subscriptions.keys) {
      const sub = await env.PUSH_KV.get(key.name, "json");
      if (!sub) continue;
      try {
        const result = await sendWebPush(sub, data, env);
        if (result.status === 404 || result.status === 410) await env.PUSH_KV.delete(key.name);
        else if (!result.ok) console.warn("Push service response", result.status, await result.text().catch(() => ""));
      } catch (e) {
        console.warn("Push send failed", e);
      }
    }
  }
  const merged = [...fresh.map(x => x.key), ...Array.from(seen)].slice(0, 200);
  await env.PUSH_KV.put(PUSH_STATE_KEY, JSON.stringify({ keys: merged }));
}

async function sendWebPush(subscription, message, env) {
  const endpoint = new URL(subscription.endpoint);
  const vapid = await ensureVapidKeys(env);
  const token = await createVapidToken(endpoint.origin, vapid.privateJwk, vapid.publicKey);
  const encrypted = await encryptPushPayload(subscription, JSON.stringify(message));
  return fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Authorization": `vapid t=${token}, k=${vapid.publicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "300",
      "Urgency": "high"
    },
    body: encrypted
  });
}

async function createVapidToken(audience, privateJwk, publicKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ aud: audience, exp: now + 12 * 60 * 60, sub: PUSH_SUBJECT })));
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function encryptPushPayload(subscription, text) {
  const uaPublic = base64UrlDecode(subscription.keys.p256dh);
  const authSecret = base64UrlDecode(subscription.keys.auth);
  const receiverKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const serverPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", serverPair.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: receiverKey }, serverPair.privateKey, 256));
  const authPrk = await hmacSha256(authSecret, shared);
  const info = concatBytes(new TextEncoder().encode("WebPush: info\0"), uaPublic, serverPublic);
  const ikm = await hkdfExpand(authPrk, info, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmacSha256(salt, ikm);
  const cek = await hkdfExpand(prk, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(prk, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const plaintext = concatBytes(new TextEncoder().encode(text), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, plaintext));
  const header = new Uint8Array(21 + serverPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);
  header[20] = serverPublic.length;
  header.set(serverPublic, 21);
  return concatBytes(header, ciphertext);
}

async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}
async function hkdfExpand(prk, info, length) {
  const blocks = [];
  let previous = new Uint8Array(0);
  let counter = 1;
  let total = 0;
  while (total < length) {
    previous = await hmacSha256(prk, concatBytes(previous, info, new Uint8Array([counter++])));
    blocks.push(previous);
    total += previous.length;
  }
  return concatBytes(...blocks).slice(0, length);
}
function concatBytes(...arrays) {
  const size = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}
function base64UrlEncode(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64UrlDecode(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
async function sha256Base64Url(value) {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
function jsonResponse(value, status = 200) {
  return corsResponse(JSON.stringify(value), status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
}

/**
 * 高頻度・長期の両フィードを取得し、重複排除してマージ
 */
async function collectFeedEntries() {
  const feedErrors = [];
  const byKey = new Map();

  const results = await Promise.allSettled([
    fetchText(HIGH_FREQ_FEED_URL),
    fetchText(LONG_FEED_URL)
  ]);

  const labels = ["high-freq", "long"];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      try {
        const list = parseAtomEntries(r.value);
        for (const e of list) {
          const key = e.id || e.link;
          if (!key) continue;
          const existing = byKey.get(key);
          if (!existing) {
            byKey.set(key, e);
          } else {
            // より新しい updated を優先
            const tNew = e.updated ? new Date(e.updated).getTime() : 0;
            const tOld = existing.updated ? new Date(existing.updated).getTime() : 0;
            if (tNew >= tOld) byKey.set(key, e);
          }
        }
      } catch (parseErr) {
        feedErrors.push(`${labels[i]} parse: ${String(parseErr.message || parseErr)}`);
      }
    } else {
      feedErrors.push(`${labels[i]}: ${String(r.reason && r.reason.message ? r.reason.message : r.reason)}`);
    }
  }

  const entries = Array.from(byKey.values());
  entries.sort((a, b) => {
    const ta = a.updated ? new Date(a.updated).getTime() : 0;
    const tb = b.updated ? new Date(b.updated).getTime() : 0;
    return tb - ta;
  });

  return { entries, feedErrors };
}

function isHypocenterIntensityEntry(e) {
  const t = e.title || "";
  const link = e.link || "";
  return (
    t.includes("震源・震度に関する情報") ||
    t.includes("震源・震度情報") ||
    link.includes("VXSE53")
  );
}

function buildFromFeedOnly(entry, errorNote) {
  const epi =
    extractEpicenterFromContent(entry.content) ||
    extractEpicenterFromTitle(entry.title) ||
    "不明";
  return {
    eventId: entry.id || null,
    originTime: entry.updated || null,
    reportTime: entry.updated || null,
    epicenter: epi,
    magnitude: null,
    depth: null,
    maxIntensity: null,
    prefectures: [],
    headline: entry.content || entry.title || "",
    sourceUrl: entry.link || null,
    error: errorNote || undefined
  };
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "EarthquakeMonitorPrototype/1.1 (Cloudflare Workers; educational)",
        Accept: "application/xml, text/xml, */*"
      },
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseAtomEntries(xml) {
  const entries = [];
  const entryRegex = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = entryRegex.exec(xml)) !== null) {
    const block = m[1];
    const title = textOfLocal(block, "title");
    const id = textOfLocal(block, "id");
    const updated = textOfLocal(block, "updated");
    const content = textOfLocal(block, "content");
    let link = null;
    const linkMatch = block.match(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i);
    if (linkMatch) link = linkMatch[1];
    entries.push({ title, id, updated, content, link });
  }
  return entries;
}

/** 名前空間プレフィックス有無両対応でタグ本文を取得 */
function textOfLocal(block, localName) {
  const re = new RegExp(
    `<(?:[\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${localName}>`,
    "i"
  );
  const m = block.match(re);
  if (!m) return null;
  return decodeXml(m[1].trim());
}

function decodeXml(s) {
  if (s == null) return s;
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * フィード content / title から震源地名を可能な範囲で抽出
 * 例: 「【震源・震度情報】１０日１２時２７分ころ、島根県西部で地震がありました。」は稀
 * 多くの content は「地震がありました。」のみのため、取れなければ null
 */
function extractEpicenterFromContent(content) {
  if (!content) return null;
  const text = decodeXml(content);

  // 「〇〇で地震がありました」
  let m = text.match(/([^\s、。]{2,30}?)で地震がありました/);
  if (m) return m[1].trim();

  // 「震源地は〇〇」
  m = text.match(/震源地[は：:]\s*([^\s、。]+)/);
  if (m) return m[1].trim();

  return null;
}

function extractEpicenterFromTitle(title) {
  if (!title) return null;
  // タイトルは通常「震源・震度に関する情報」のみ
  return null;
}

/**
 * VXSE53 等の震源・震度XMLをパース
 * 名前空間プレフィックスの有無に対応
 */
function parseEarthquakeReport(xml) {
  try {
    const originTime =
      extractTagLocal(xml, "OriginTime") || extractTagLocal(xml, "ArrivalTime");
    const eventId = extractTagLocal(xml, "EventID");
    const reportTime = extractTagLocal(xml, "ReportDateTime");

    // 震央地名: Hypocenter > Area > Name
    let epicenter = null;
    const hypoBlock = extractBlock(xml, "Hypocenter");
    if (hypoBlock) {
      const areaBlock = extractBlock(hypoBlock, "Area");
      if (areaBlock) {
        epicenter = extractTagLocal(areaBlock, "Name");
      }
    }
    if (!epicenter) {
      // フォールバック: 最初の Area/Name が震央のことが多い
      const areaNameMatch = xml.match(
        /<(?:[\w.-]+:)?Hypocenter\b[\s\S]*?<(?:[\w.-]+:)?Area\b[\s\S]*?<(?:[\w.-]+:)?Name\b[^>]*>([^<]+)</i
      );
      if (areaNameMatch) epicenter = decodeXml(areaNameMatch[1].trim());
    }

    // マグニチュード
    let magnitude = null;
    const magMatch = xml.match(
      /<(?:[\w.-]+:)?Magnitude\b[^>]*>([^<]+)<\/(?:[\w.-]+:)?Magnitude>/i
    );
    if (magMatch) {
      const raw = magMatch[1].trim();
      const num = parseFloat(raw);
      magnitude = !isNaN(num) ? num : raw;
    }

    // 深さ
    let depth = null;
    const coordDescMatch = xml.match(
      /<(?:[\w.-]+:)?Coordinate\b[^>]*\bdescription\s*=\s*["']([^"']+)["']/i
    );
    if (coordDescMatch) {
      const desc = coordDescMatch[1];
      const dMatch = desc.match(/深さ\s*([0-9０-９.．]+)\s*(?:k?m|ｋｍ)?/i);
      if (dMatch) {
        const normalized = normalizeFullWidthNumber(dMatch[1]);
        depth = normalized + "km";
      } else {
        depth = desc;
      }
    } else {
      // Coordinate 本文: +34.7+132.0-10000/ → 深さ 10km
      const coordBody = extractTagLocal(xml, "Coordinate");
      if (coordBody) {
        const depthMatch = coordBody.match(/-(\d+)\s*\/?\s*$/);
        if (depthMatch) {
          const meters = parseInt(depthMatch[1], 10);
          if (!isNaN(meters)) depth = meters / 1000 + "km";
        }
      }
    }

    // 最大震度（Observation 直下の MaxInt を優先）
    let maxIntensity = null;
    const obsBlock = extractBlock(xml, "Observation");
    if (obsBlock) {
      maxIntensity = extractTagLocal(obsBlock, "MaxInt");
    }
    if (!maxIntensity) {
      maxIntensity = extractTagLocal(xml, "MaxInt");
    }
    if (maxIntensity) maxIntensity = maxIntensity.trim();

    // 都道府県別震度（各 Pref ブロックを個別解析）
    const prefectures = parsePrefectures(xml);

    // Headline Text
    let headline = null;
    const headBlock = extractBlock(xml, "Headline");
    if (headBlock) {
      headline = extractTagLocal(headBlock, "Text");
    }
    if (!headline) {
      headline = extractTagLocal(xml, "Text");
    }

    return {
      eventId: eventId || null,
      originTime: originTime || null,
      reportTime: reportTime || null,
      epicenter: epicenter || null,
      magnitude,
      depth,
      maxIntensity: maxIntensity || null,
      prefectures,
      headline: headline ? decodeXml(headline) : null
    };
  } catch (e) {
    console.warn("parseEarthquakeReport error", e);
    return null;
  }
}

/**
 * Pref ブロックを個別に切り出して Name / Code / MaxInt を対応付け
 * 重複都道府県は最初のものを採用
 */
function parsePrefectures(xml) {
  const result = [];
  const seen = new Set();
  const prefRegex = /<(?:[\w.-]+:)?Pref\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Pref>/gi;
  let m;
  while ((m = prefRegex.exec(xml)) !== null) {
    const block = m[1];
    const name = extractTagLocal(block, "Name");
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const code = extractTagLocal(block, "Code") || "";
    const maxInt = extractTagLocal(block, "MaxInt") || "";
    result.push({
      name: name.trim(),
      code: code.trim(),
      maxIntensity: maxInt.trim()
    });
  }
  return result;
}

function extractBlock(xml, localName) {
  const re = new RegExp(
    `<(?:[\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${localName}>`,
    "i"
  );
  const m = xml.match(re);
  return m ? m[1] : null;
}

function extractTagLocal(xml, localName) {
  if (!xml) return null;
  const re = new RegExp(
    `<(?:[\\w.-]+:)?${localName}\\b[^>]*>([^<]*)<\\/(?:[\\w.-]+:)?${localName}>`,
    "i"
  );
  const m = xml.match(re);
  return m ? decodeXml(m[1].trim()) : null;
}

function normalizeFullWidthNumber(s) {
  const map = {
    "０": "0", "１": "1", "２": "2", "３": "3", "４": "4",
    "５": "5", "６": "6", "７": "7", "８": "8", "９": "9", "．": "."
  };
  return String(s).replace(/[０-９．]/g, (c) => map[c] || c);
}

function corsResponse(body, status = 200, extraHeaders = {}) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
    ...extraHeaders
  };
  return new Response(body, { status, headers });
}
