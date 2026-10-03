// Vercel Serverless Function: fetch product details from a supplier link.
// Admin-only helper: paste a product link -> returns { name, darazPrice, price (+20%), images[], variants[], category }.
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

// Remove supplier-brand mentions from customer-facing text.
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

function isProductImage(url) {
  return (
    typeof url === "string" &&
    url.startsWith("http") &&
    !url.includes("youtube.com") &&
    !url.includes("youtu.be")
  );
}

function pushUnique(arr, url) {
  if (isProductImage(url) && !arr.includes(url)) arr.push(url);
}

function extractModuleData(html) {
  const m = html.match(/var __moduleData__ = (\{.*?\});\s*(?:var|<\/script>)/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (_) {
    return null;
  }
}

function extractProduct(html) {
  let name = null,
    category = null;
  const images = []; // ordered: default gallery first, then variants
  const variants = []; // [{ label, image }]

  // 1) __moduleData__: skuGalleries (per-SKU galleries) + productOption (color variants)
  const mod = extractModuleData(html);
  if (mod) {
    const fields =
      (mod.data && mod.data.root && mod.data.root.fields) || {};

    // Default gallery: skuGalleries["0"], type=img items.
    // Then one representative image per color/size variant (not every SKU gallery).
    const sg = fields.skuGalleries;
    if (sg && typeof sg === "object" && Array.isArray(sg["0"])) {
      for (const it of sg["0"]) {
        if (it && it.type === "img") pushUnique(images, it.src || it.poster);
      }
    }

    // Color/size variants with their own images (keep readable labels only)
    const po = fields.productOption;
    if (po && Array.isArray(po.options)) {
      for (const o of po.options) {
        if (o && o.image) {
          pushUnique(images, o.image);
          const label = String(o.path || "").split(":").pop().trim();
          if (label && /[a-zA-Z]{2,}/.test(label)) variants.push({ label, image: o.image });
        }
      }
    }
  }

  // 2) JSON-LD Product block (name, category, extra images)
  const ldBlocks = [
    ...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gis),
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
          for (const im of imgs) pushUnique(images, im);
        }
      }
    } catch (_) {}
  }

  // 3) Price from embedded pdt_price ("Rs. 1,299")
  let price = null;
  const pm = html.match(/pdt_price\\?":\\"([^"\\]+)/);
  if (pm) price = parsePrice(pm[1]);

  // 4) Open Graph fallbacks
  if (!name) name = metaContent(html, "property", "og:title");
  if (images.length === 0) pushUnique(images, metaContent(html, "property", "og:image"));

  return {
    name: cleanText(name),
    images,
    variants,
    category: cleanText(category),
    price,
  };
}

// Lightly freshen the name so it reads as our own listing.
function freshenName(name, brand) {
  let n = cleanText(name);
  if (brand) {
    const b = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    n = n.replace(new RegExp(b, "gi"), "").replace(/\s{2,}/g, " ").trim();
  }
  // Tidy common filler
  n = n.replace(/\s*-\s*$/g, "").trim();
  return n;
}

// Short fresh description in simple English (not copied).
function suggestDescription(name, category) {
  const short = (name || "product").split(",")[0].trim();
  return (
    `Good quality ${short.toLowerCase()}. Checked before packing. ` +
    `Pay with Easypaisa or JazzCash. 7-day check guarantee.`
  );
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const rawUrl = (req.query.url || "").trim();
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
    return res.status(400).json({ ok: false, error: "Provide a valid product link." });
  }

  try {
    const html = await getText(rawUrl);
    let data = extractProduct(html);

    // Short share links: follow to the real product page for full data.
    if ((data.images.length <= 1 || !data.price) && /s\.daraz\.pk/i.test(rawUrl)) {
      const origin = html.match(/<link rel="origin" href="([^"]+)"/i);
      if (origin && origin[1]) {
        const productHtml = await getText(origin[1]);
        const full = extractProduct(productHtml);
        data = {
          name: full.name || data.name,
          images: full.images.length ? full.images : data.images,
          variants: full.variants.length ? full.variants : data.variants,
          category: full.category || data.category,
          price: full.price || data.price,
        };
      }
    }

    if (!data.name) {
      return res.status(422).json({ ok: false, error: "Could not read this link. Check the link and try again." });
    }

    const darazPrice = data.price;
    const price = darazPrice ? Math.round(darazPrice * 1.2) : null;
    const category = mapCategory(data.category);
    const freshName = freshenName(data.name);

    return res.status(200).json({
      ok: true,
      name: freshName,
      darazPrice,
      price, // +20% profit, rounded
      images: data.images.slice(0, 20),
      variants: data.variants.slice(0, 20),
      category,
      suggestedDescription: suggestDescription(freshName, category),
      needsPrice: !darazPrice,
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
