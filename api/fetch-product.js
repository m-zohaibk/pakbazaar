// Vercel Serverless Function: fetch product details from a supplier link.
// Admin-only helper: paste a product link -> product data with variants, images, +20% price.
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

function titleCase(s) {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// Freshen the title so it reads as our own original listing.
function freshenName(name, brand) {
  let n = cleanText(name);
  if (brand) {
    const b = String(brand.name || brand).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (b.length > 1) n = n.replace(new RegExp(b, "gi"), "");
  }
  // Drop supplier filler words
  n = n.replace(/\b(hot\s*sale|new\s*arrival|wholesale|dropship\w*)\b/gi, "");
  // Normalize ALL-CAPS shouting to Title Case (keep short codes like "4K" as-is)
  n = n
    .split(" ")
    .map((w) => (/^[A-Z]{4,}$/.test(w) ? titleCase(w) : w))
    .join(" ");
  n = n.replace(/\s{2,}/g, " ").replace(/\s*-\s*/g, " - ").replace(/^[-\s]+|[-\s]+$/g, "").trim();
  return n;
}

function suggestDescription(name) {
  const short = (name || "product").split(",")[0].trim();
  return (
    `Good quality ${short.toLowerCase()}. Checked before packing. ` +
    `Pay with Easypaisa or JazzCash. 7-day check guarantee.`
  );
}

function extractProduct(html) {
  let name = null,
    category = null,
    brand = null;
  const images = []; // default gallery
  const variants = []; // [{ name, image, images[] }] — in-stock only

  const mod = extractModuleData(html);
  if (mod) {
    const fields = (mod.data && mod.data.root && mod.data.root.fields) || {};

    // Default gallery
    const sg = fields.skuGalleries;
    if (sg && typeof sg === "object" && Array.isArray(sg["0"])) {
      for (const it of sg["0"]) {
        if (it && it.type === "img") pushUnique(images, it.src || it.poster);
      }
    }

    // Variants: skuBase properties x skus propPath x skuInfos stock flag
    try {
      const skuBase = fields.productOption && fields.productOption.skuBase;
      const skuInfos = fields.skuInfos || {};
      if (skuBase && Array.isArray(skuBase.properties) && Array.isArray(skuBase.skus)) {
        const combo2skus = {};
        for (const s of skuBase.skus) {
          if (!s.propPath || !s.skuId) continue;
          (combo2skus[s.propPath] = combo2skus[s.propPath] || []).push(String(s.skuId));
        }
        const skuInStock = (id) => {
          const info = skuInfos[String(id)] || {};
          const op = info.operation || {};
          return !op.disable;
        };
        // Use the first property with multiple values (usually "Color Family")
        const prop = skuBase.properties.find(
          (p) => Array.isArray(p.values) && p.values.length > 1
        );
        if (prop) {
          for (const v of prop.values) {
            const vname = cleanText(v.name || "");
            if (!vname || vname.length < 2) continue;
            const needle = `${prop.pid}:${v.vid}`;
            let skuIds = [];
            for (const [pp, ids] of Object.entries(combo2skus)) {
              if (pp.split(";").includes(needle)) skuIds = skuIds.concat(ids);
            }
            if (skuIds.length === 0) continue;
            const live = skuIds.filter(skuInStock);
            if (live.length === 0) continue; // out of stock -> skip this color
            const vimgs = [];
            pushUnique(vimgs, v.image || v.hoverImage);
            for (const sid of live.slice(0, 4)) {
              const gal = (sg && sg[sid]) || [];
              for (const it of gal) {
                if (it && it.type === "img") pushUnique(vimgs, it.src || it.poster);
                if (vimgs.length >= 8) break;
              }
              if (vimgs.length >= 8) break;
            }
            // also show in flat list
            for (const u of vimgs) pushUnique(images, u);
            variants.push({
              name: vname.length > 24 ? vname.slice(0, 24) : vname,
              image: vimgs[0] || "",
              images: vimgs,
            });
          }
        }
      }
    } catch (_) {}
  }

  // JSON-LD fallback (name, category, brand, extra images)
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
          brand = brand || it.brand || null;
          const imgs = Array.isArray(it.image) ? it.image : it.image ? [it.image] : [];
          for (const im of imgs) pushUnique(images, im);
        }
      }
    } catch (_) {}
  }

  // Price
  let price = null;
  const pm = html.match(/pdt_price\\?":\\"([^"\\]+)/);
  if (pm) price = parsePrice(pm[1]);

  // OG fallbacks
  if (!name) name = metaContent(html, "property", "og:title");
  if (images.length === 0) pushUnique(images, metaContent(html, "property", "og:image"));

  return { name, brand, images, variants, category: cleanText(category), price };
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

    if ((data.images.length <= 1 || !data.price) && /s\.daraz\.pk/i.test(rawUrl)) {
      const origin = html.match(/<link rel="origin" href="([^"]+)"/i);
      if (origin && origin[1]) {
        const productHtml = await getText(origin[1]);
        const full = extractProduct(productHtml);
        data = {
          name: full.name || data.name,
          brand: full.brand || data.brand,
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
    const freshName = freshenName(data.name, data.brand);

    return res.status(200).json({
      ok: true,
      name: freshName,
      darazPrice,
      price,
      images: data.images.slice(0, 20),
      variants: data.variants.slice(0, 20),
      variantLabel: data.variants.length ? "Color" : "",
      category,
      suggestedDescription: suggestDescription(freshName),
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
