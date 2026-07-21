// ═══════════════════════════════════════════════════════════════════════════
// Cloudflare Pages Function — POST /api/sync-belgard-catalog
//
// Fetches a Belgard category index page (e.g. /products/pavers/), hands the
// HTML to Claude with a structured extraction prompt, and returns an array
// of every product shown on that page: product_name, url, collection,
// hero_image_url, description.
//
// One POST per category. The client (admin/belgard-sync.js) calls this for
// each category in sequence and accumulates results before matching against
// the local belgard_materials catalog.
//
// Requires env variable: ANTHROPIC_API_KEY (same secret as other functions).
//
// Request shape:
//   { url: "https://www.belgard.com/products/pavers/" }
//
// Response shape:
//   {
//     success: true,
//     category_url: "...",
//     products: [
//       {
//         product_name: "Catalina Grana",       // normalized, no ® or "Paver"
//         raw_title:    "Catalina Grana® Paver",
//         url:          "https://www.belgard.com/products/pavers/catalina-grana/",
//         collection:   "Metropolitan",
//         hero_image_url: "https://...LifeStyleImage_01_2024.jpg",  // full size, suffix stripped
//         description:  "The Catalina collection's crisp..."
//       }
//     ],
//     meta: { model, usage, product_count }
//   }
// ═══════════════════════════════════════════════════════════════════════════

const MODEL = 'claude-sonnet-4-6';
const ALLOWED_HOST = 'www.belgard.com';
const FETCH_TIMEOUT_MS = 20000;

const EXTRACTION_PROMPT = `You are parsing a Belgard product category index page. Extract EVERY product shown in the product grid as structured JSON.

For each product, identify:
  - raw_title: the product name exactly as shown on the page (e.g., "Catalina Grana® Paver")
  - product_name: the clean base name with trademark symbols and generic type words stripped. Remove ®, ™, ©, and strip trailing " Paver", " Pavers", " Slab", " Slabs", " Kit", " Step", " Wall" when present. Examples:
      "Catalina Grana® Paver" → "Catalina Grana"
      "Mega-Arbel® Paver" → "Mega-Arbel"
      "Belair Wall®" → "Belair"
      "Weston Stone™ Fire Pit Kit" → "Weston Stone"
      "Origins 12®" → "Origins 12"
  - url: the full "View Full Product Details" link URL (starts with https://www.belgard.com/products/)
  - collection: the collection name shown under the title (Metropolitan, Heritage, Natural, Artisan, Environmental, Porcelain). If no collection shown, return null.
  - hero_image_url: the main product image URL. It appears as a Markdown image link inside a product card link, like ![](https://www.belgard.com/wp-content/uploads/YYYY/MM/ProductName_LifeStyleImage_XX-360x360.jpg). Strip the WordPress thumbnail suffix pattern "-NNNxNNN" immediately before the file extension to get the full-size original. Example:
      "Catalina-Grana_LifeStyleImage_01_2024-360x360.jpg" → "Catalina-Grana_LifeStyleImage_01_2024.jpg"
      "AppianStone_beauty005-360x360.png" → "AppianStone_beauty005.png"
    If no thumbnail suffix is present, return the URL as-is.
  - description: the short product description text below the title. Keep it concise (first sentence or two). If none shown, return null.

SKIP non-product items: navigation links, blog post cards, footer content, newsletter forms, "Find a Contractor" CTAs, collection summary cards (e.g., a card that just links to /collections/heritage/), related-product suggestions in sidebars.

Return ONLY valid JSON. No markdown fences, no prose commentary. Schema:
{
  "products": [
    {
      "raw_title": string,
      "product_name": string,
      "url": string,
      "collection": string|null,
      "hero_image_url": string|null,
      "description": string|null
    }
  ]
}`;

// ───────────────────────────────────────────────────────────────────────────
// Utilities
// ───────────────────────────────────────────────────────────────────────────
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  // CF Workers support AbortSignal.timeout but the shim is simpler.
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    fetch(url, { ...options, signal: controller.signal })
      .then(res => { clearTimeout(timer); resolve(res); })
      .catch(err => { clearTimeout(timer); reject(err); });
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Main handler
// ───────────────────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({
      error: 'ANTHROPIC_API_KEY environment variable not configured.'
    }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: 'Invalid JSON body', details: err.message }, 400);
  }

  const { url } = body || {};

  if (typeof url !== 'string' || !url.startsWith('https://')) {
    return jsonResponse({ error: 'Missing or invalid url field' }, 400);
  }

  // Domain allowlist — only scrape belgard.com. Prevents this function from
  // being turned into a generic open proxy.
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return jsonResponse({ error: 'Malformed URL' }, 400);
  }

  if (parsed.hostname !== ALLOWED_HOST) {
    return jsonResponse({
      error: `Only ${ALLOWED_HOST} URLs are allowed. Got: ${parsed.hostname}`
    }, 400);
  }

  if (!parsed.pathname.startsWith('/products/')) {
    return jsonResponse({
      error: 'URL must be under /products/ (a category index page)'
    }, 400);
  }

  // Fetch Belgard HTML
  let html;
  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; Paver PortalProposalBuilder/1.0; +https://bayside-proposals.pages.dev)',
        'accept': 'text/html,application/xhtml+xml'
      }
    });
    if (!res.ok) {
      return jsonResponse({
        error: `Belgard responded ${res.status} ${res.statusText}`
      }, 502);
    }
    html = await res.text();
  } catch (err) {
    return jsonResponse({
      error: `Could not fetch from Belgard: ${err.message}`
    }, 502);
  }

  // Call Anthropic API
  let apiResponse;
  try {
    apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: EXTRACTION_PROMPT },
              {
                type: 'text',
                text: `CATEGORY URL: ${url}\n\nPAGE HTML:\n\n${html}`
              }
            ]
          }
        ]
      })
    });
  } catch (err) {
    return jsonResponse({
      error: 'Network error calling Anthropic API',
      details: err.message
    }, 502);
  }

  const apiData = await apiResponse.json().catch(() => null);

  if (!apiResponse.ok) {
    return jsonResponse({
      error: `Anthropic API returned ${apiResponse.status}`,
      details: apiData
    }, 502);
  }

  const textBlock = apiData?.content?.find?.(c => c.type === 'text');
  const textContent = textBlock?.text;
  if (!textContent) {
    return jsonResponse({
      error: 'Claude returned no text content',
      raw_response: apiData
    }, 500);
  }

  const cleaned = textContent
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsedResult;
  try {
    parsedResult = JSON.parse(cleaned);
  } catch (err) {
    return jsonResponse({
      error: 'Claude returned text that is not valid JSON',
      raw_response: textContent,
      parse_error: err.message
    }, 500);
  }

  const products = Array.isArray(parsedResult?.products) ? parsedResult.products : [];

  // Defensive validation — drop any entries that are obviously malformed.
  // A product is "good enough" if it has at least a product_name and url.
  const validProducts = products.filter(p =>
    p &&
    typeof p.product_name === 'string' && p.product_name.trim().length > 0 &&
    typeof p.url === 'string' && p.url.startsWith('https://www.belgard.com/products/')
  );

  return jsonResponse({
    success: true,
    category_url: url,
    products: validProducts,
    meta: {
      model: apiData.model,
      usage: apiData.usage,
      product_count: validProducts.length,
      dropped: products.length - validProducts.length
    }
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type'
    }
  });
}
