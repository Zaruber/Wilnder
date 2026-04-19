const path = require("path");
const express = require("express");
const { randomInt: cryptoRandomInt } = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const WB_HOST = "https://nsk-basket-cdn-01.geobasket.ru";
const RANDOM_ARTICLE_MIN = 10000000;
const RANDOM_ARTICLE_MAX = 999999999;
const FETCH_TIMEOUT_MS = 2600;
const PRICE_TIMEOUT_MS = 1300;

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/random-cards", async (req, res) => {
  const requestedCount = Number.parseInt(req.query.count, 10);
  const count = Number.isFinite(requestedCount)
    ? Math.min(Math.max(requestedCount, 1), 15)
    : 7;
  const seed = normalizeSeed(req.query.seed);
  const requestedBatch = Number.parseInt(req.query.batch, 10);
  const batch = Number.isFinite(requestedBatch) ? Math.max(requestedBatch, 0) : 0;

  try {
    const cards = await getRandomCards(count, { seed, batch });
    if (cards.length === 0) {
      return res.status(502).json({
        error:
          "Не удалось получить карточки WB. Попробуйте обновить страницу через пару секунд."
      });
    }

    return res.json({ cards, seed, batch });
  } catch (error) {
    return res.status(502).json({
      error: "Ошибка загрузки карточек WB.",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Wilnder is running on http://localhost:${PORT}`);
});

async function getRandomCards(targetCount, options = {}) {
  const articleGenerator = createArticleGenerator(options.seed, options.batch);
  const unique = new Map();
  let attempts = 0;
  const maxAttempts = Math.max(targetCount * 90, 90);

  while (unique.size < targetCount && attempts < maxAttempts) {
    const needed = targetCount - unique.size;
    const batchSize = Math.min(Math.max(needed * 4, 6), 18);
    const candidates = generateRandomArticles(batchSize, unique, articleGenerator);
    attempts += candidates.length;

    const results = await Promise.all(candidates.map((article) => fetchCardByArticle(article)));

    for (const card of results) {
      if (card && !unique.has(card.article)) {
        unique.set(card.article, card);
      }
      if (unique.size >= targetCount) {
        break;
      }
    }
  }

  return Array.from(unique.values()).slice(0, targetCount);
}

function generateRandomArticles(batchSize, existingMap, articleGenerator) {
  const pool = new Set();

  while (pool.size < batchSize) {
    const article = articleGenerator();
    if (!existingMap.has(article)) {
      pool.add(article);
    }
  }

  return Array.from(pool);
}

async function fetchCardByArticle(article) {
  const volume = Math.floor(article / 100000);
  const part = Math.floor(article / 1000);
  const cardUrl = `${WB_HOST}/vol${volume}/part${part}/${article}/info/ru/card.json`;

  const response = await fetchWithTimeout(cardUrl, FETCH_TIMEOUT_MS);
  if (!response || !response.ok) {
    return null;
  }

  const payload = await response.json().catch(() => null);
  if (!payload) {
    return null;
  }

  const title = normalizeText(payload.imt_name);
  if (!title) {
    return null;
  }

  const brand = normalizeText(payload.selling?.brand_name) || "Без бренда";
  const category = normalizeText(payload.subj_name || payload.subj_root_name) || "Товар";

  const price = await fetchPrice(article, volume, part);

  return {
    article,
    title,
    brand,
    category,
    price,
    imageUrl: `${WB_HOST}/vol${volume}/part${part}/${article}/images/big/1.webp`,
    wbUrl: `https://www.wildberries.ru/catalog/${article}/detail.aspx`
  };
}

async function fetchPrice(article, volume, part) {
  const priceUrl = `${WB_HOST}/vol${volume}/part${part}/${article}/info/price-history.json`;
  const response = await fetchWithTimeout(priceUrl, PRICE_TIMEOUT_MS);
  if (!response || !response.ok) {
    return null;
  }

  const payload = await response.json().catch(() => null);
  if (!Array.isArray(payload) || payload.length === 0) {
    return null;
  }

  for (let i = payload.length - 1; i >= 0; i -= 1) {
    const rub = Number(payload[i]?.price?.RUB);
    if (Number.isFinite(rub) && rub > 0) {
      return rub / 100;
    }
  }

  return null;
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeSeed(value) {
  if (typeof value !== "string") {
    return "";
  }
  const prepared = value.trim().slice(0, 64);
  return /^[a-zA-Z0-9_-]+$/.test(prepared) ? prepared : "";
}

function createArticleGenerator(seed, batch) {
  const range = RANDOM_ARTICLE_MAX - RANDOM_ARTICLE_MIN + 1;

  if (seed) {
    const rng = createSeededRng(hashSeed(`${seed}:${batch}`));
    return () => RANDOM_ARTICLE_MIN + Math.floor(rng() * range);
  }

  return () => cryptoRandomInt(RANDOM_ARTICLE_MIN, RANDOM_ARTICLE_MAX + 1);
}

function hashSeed(input) {
  let hash = 2166136261;

  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function createSeededRng(seed) {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain, */*"
      }
    });
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
