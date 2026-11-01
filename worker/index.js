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

    if (request.method === "OPTIONS") {
      return corsResponse(null, 204);
    }

    if (path === "/api/earthquakes") {
      return handleEarthquakes(request, env, ctx);
    }

    if (path === "/api/health") {
      return corsResponse(
        JSON.stringify({
          status: "ok",
          service: "earthquake-monitor",
          time: new Date().toISOString(),
          note: "公開XMLベースの試作API。緊急地震速報の受信機能はありません。"
        }),
        200,
        { "Content-Type": "application/json; charset=utf-8" }
      );
    }

    // 静的アセット（Workers Assets）へ委譲
    if (env && env.ASSETS) {
      try {
        return await env.ASSETS.fetch(request);
      } catch (e) {
        console.warn("ASSETS.fetch failed", e);
      }
    }

    if (path === "/" || path === "/index.html") {
      return new Response(
        "Earthquake Monitor API is running. Configure Workers Assets (public/) to serve the frontend.",
        { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    return new Response("Not Found", { status: 404 });
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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
    ...extraHeaders
  };
  return new Response(body, { status, headers });
}
