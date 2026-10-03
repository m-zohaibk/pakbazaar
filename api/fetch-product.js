// Vercel Serverless Function: fetch product details from a supplier link.
// Admin-only helper: paste a product link -> returns { name, darazPrice, price (+20%), images[], category }.
// Usage: GET /api/fetch-product?url=<encoded product URL>

const UA =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

async function getText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function metaContent(html, attr, name) {
  const m = html.match(
    new RegExp(
      `<meta\\s+${attr}=(?:"${name}"|'${name}')\\s+content=(?:"([^"]*)"|'([^']*)')`,
      "i"
    )
  );
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

function decodeEntities(s) {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// Remove any supplier-brand mentions from customer-facing text.
function cleanText(s) {
  return decodeEntities(s || "")
    .replace(/daraz/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parsePrice(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^0-9]/g, "");
  const n = parseInt(digits, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractProduct(html) {
  // 1) JSON-LD Product block
  let name = null,
    images = [],
    category = null;
  const ldBlocks = [
    ...html.matchAll(
      /<script type="application\/ld\+json">(.*?)<\/script>/gis
    ),
  ];
  for (const b of ldBlocks) {
    try {
      const d = JSON.parse(b[1].trim());
      const items = Array.isArray(d) ? d : [d];
      for (const it of items) {
        if (it && it["@type"] === "Product") {
          name = name || it.name;
          category = category || it.category || null;
          const imgs = Array.isArray(it.image) ? it.image : it.image ? [it.image] : [];
          for (const im of imgs) {
            if (typeof im === "string" && im.startsWith("http") && !im.includes("youtube.com") && !im.includes("youtu.be")) {
              images.push(im);
            }
          }
        }
      }
    } catch (_) {}
  }

  // 2) Price from embedded pdt_price ("Rs. 1,299")
  let price = null;
  const pm = html.match(/pdt_price\\?":\\"([^"\\]+)/);
  if (pm) price = parsePrice(pm[1]);

  // 3) Fallbacks from Open Graph tags
  if (!name) name = metaContent(html, "property", "og:title");
  if (images.length === 0) {
    const ogImg = metaContent(html, "property", "og:image");
    if (ogImg) images.push(ogImg);
  }

  return { name: cleanText(name), images, category: cleanText(category), price };
}

export default async function handler(req, res) {
  // Same-origin admin tool; allow the shop's own frontend.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const rawUrl = (req.query.url || "").trim();
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
    return res.status(400).json({ ok: false, error: "Provide a valid product link." });
  }

  try {
    let html = await getText(rawUrl);
    let data = extractProduct(html);

    // Short share links: follow to the real product page for full data.
    if ((!data.price || data.images.length <= 1) && /s\.daraz\.pk/i.test(rawUrl)) {
      const origin = html.match(/<link rel="origin" href="([^"]+)"/i);
      if (origin && origin[1]) {
        const productHtml = await getText(origin[1]);
        const full = extractProduct(productHtml);
        data = {
          name: full.name || data.name,
          images: full.images.length ? full.images : data.images,
          category: full.category || data.category,
          price: full.price || data.price,
        };
      }
    }

    if (!data.name) {
      return res.status(422).json({ ok: false, error: "Could not read this link. Check the link and try again." });
    }

    const darazPrice = data.price; // may be null if page hides it
    const price = darazPrice ? Math.round(darazPrice * 1.2) : null;

    // Map supplier category to a simple shop category
    const category = mapCategory(data.category);

    return res.status(200).json({
      ok: true,
      name: data.name,
      darazPrice,
      price, // +20% profit, rounded
      images: data.images.slice(0, 8),
      category,
      needsPrice: !darazPrice, // true -> admin types price manually
    });
  } catch (e) {
    return res.status(502).json({
      ok: false,
      error: "Could not open this link. Check the link and try again.",
    });
  }
}

function mapCategory(raw) {
  if (!raw) return "";
  const c = raw.toLowerCase();
  if (/fashion|cloth|apparel|shoe|beauty|health/.test(c)) return "Fashion";
  if (/home|kitchen|living|furniture/.test(c)) return "Home & Living";
  if (/electronic|mobile|gadget|appliance/.test(c)) return "Electronics";
  if (/kid|baby|toy/.test(c)) return "Kids";
  if (/book|stationery|office/.test(c)) return "Stationery";
  if (/sport|outdoor|travel/.test(c)) return "Sports & Travel";
  if (/tool|diy|auto/.test(c)) return "Tools";
  return "";
}
