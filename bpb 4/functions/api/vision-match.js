// ═══════════════════════════════════════════════════════════════════════════
// Cloudflare Pages Function — POST /api/vision-match
//
// Accepts a JSON body with image URLs and a materials list. Forwards to
// Claude Vision with a structured matching prompt. Returns per-image match
// decisions with confidence scores and asset type classifications.
//
// Caller (materials.js backfill modal) uses the response to present approval
// rows. Writes to belgard_materials / third_party_materials happen
// client-side via Supabase only after Tim approves each match.
//
// Requires env variable: ANTHROPIC_API_KEY (same secret as /api/parse-bid-pdf).
//
// Request shape:
//   {
//     images: [
//       { id: "<proposal_image_id>", url: "https://...public-storage-url" }
//     ],
//     materials: [
//       {
//         source: "belgard" | "third_party",
//         catalog_id: "<uuid>",
//         manufacturer: "Belgard",
//         product_name: "Catalina Grana",
//         color: "Victorian",
//         size_spec: "6x9",
//         application_area: "Patio"   // optional context
//       }
//     ]
//   }
//
// Response shape:
//   {
//     success: true,
//     matches: [
//       {
//         image_index: 0,
//         is_match: true,
//         material_index: 2,
//         confidence: 0.92,
//         asset_type: "product_hero" | "color_swatch" | "scene_render" | "non_material",
//         reasoning: "Tan herringbone paver matches Catalina Grana Victorian."
//       }
//     ],
//     meta: { model, usage }
//   }
// ═══════════════════════════════════════════════════════════════════════════

const MODEL = 'claude-sonnet-4-6';
const MAX_IMAGES_PER_REQUEST = 20;

const MATCH_PROMPT = `You are analyzing images extracted from a Paver Portal bid PDF to help enrich a paver/hardscape materials catalog. For each image, decide whether it is a usable catalog asset for a specific material on the provided list.

You receive:
  1. A MATERIALS LIST (numbered 0-based) — the catalog products selected for this proposal
  2. A sequence of IMAGES (numbered 0-based in the order provided)

For EACH image, return exactly one match entry with these fields:
  - image_index: integer, 0-based
  - is_match: true only if this image clearly depicts a specific material on the list
  - material_index: if is_match is true, the 0-based index of the matching material; otherwise null
  - confidence: 0.0-1.0, how certain you are about the match
  - asset_type:
      "product_hero"  — isolated product photo on neutral background (best catalog asset)
      "color_swatch"  — pure color or texture chip showing one specific finish
      "scene_render"  — installed / in-context photo (property-specific, NOT catalog worthy)
      "non_material"  — logos, page borders, icons, decorations, architectural drawings, watermarks
  - reasoning: one concise sentence

RETURN is_match: false for:
  - Any logo (Paver Portal, Belgard, Trex, Tru-Scapes, JobNimbus, etc.)
  - Page decorations (borders, arrows, icons, section dividers)
  - Architectural renderings or 3D design mockups (these are PROPERTY-specific, not reusable catalog assets)
  - Installation photos showing the material in situ (property-specific)
  - Technical drawings, dimension diagrams
  - Generic textures with no identifiable product

RETURN is_match: true ONLY when you can confidently identify a specific catalog-worthy asset:
  - A clean product hero shot matching a listed product by color, size, pattern, manufacturer
  - A pure color swatch matching a listed material's color name

Prefer false negatives over false positives. Approved matches write to a shared catalog that affects all future proposals, so uncertainty is expensive.

Return ONLY valid JSON. No markdown code fences, no prose commentary. Schema:
{
  "matches": [
    {
      "image_index": number,
      "is_match": boolean,
      "material_index": number|null,
      "confidence": number,
      "asset_type": string,
      "reasoning": string
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

function buildMaterialsText(materials) {
  const lines = ['MATERIALS LIST:'];
  materials.forEach((m, i) => {
    const parts = [
      `${i}.`,
      m.manufacturer || '?',
      m.product_name || '?'
    ];
    if (m.color) parts.push(`· color: ${m.color}`);
    if (m.size_spec) parts.push(`· size: ${m.size_spec}`);
    if (m.application_area) parts.push(`· used for: ${m.application_area}`);
    lines.push(parts.join(' '));
  });
  return lines.join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// Main handler
// ───────────────────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.ANTHROPIC_API_KEY) {
    return jsonResponse({
      error: 'ANTHROPIC_API_KEY environment variable not configured on this Cloudflare Pages deployment. Add it in Settings → Environment variables (encrypted).'
    }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: 'Invalid JSON body', details: err.message }, 400);
  }

  const { images, materials } = body || {};

  if (!Array.isArray(images) || !Array.isArray(materials)) {
    return jsonResponse({
      error: 'Expected { images: [...], materials: [...] }'
    }, 400);
  }

  if (images.length === 0) {
    return jsonResponse({ success: true, matches: [], meta: { skipped: 'no images' } });
  }

  if (materials.length === 0) {
    return jsonResponse({
      error: 'No materials on this proposal — nothing to match against. Add materials first.'
    }, 400);
  }

  if (images.length > MAX_IMAGES_PER_REQUEST) {
    return jsonResponse({
      error: `Too many images (${images.length}). Batch into groups of ${MAX_IMAGES_PER_REQUEST} or fewer.`
    }, 400);
  }

  // Validate each image has a usable URL
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img || typeof img.url !== 'string' || !img.url.startsWith('http')) {
      return jsonResponse({
        error: `Image at index ${i} is missing a valid URL`
      }, 400);
    }
  }

  // Build the Claude request content: materials text + image blocks + prompt.
  // URL-based image sources — Claude fetches them directly. Supabase Storage
  // public URLs are publicly accessible, so this works out of the box.
  const content = [];

  content.push({
    type: 'text',
    text: buildMaterialsText(materials)
  });

  for (const img of images) {
    content.push({
      type: 'image',
      source: { type: 'url', url: img.url }
    });
  }

  content.push({
    type: 'text',
    text: MATCH_PROMPT
  });

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
        max_tokens: 2500,
        messages: [
          { role: 'user', content }
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

  // Extract text content — mirror parse-bid-pdf.js pattern exactly
  const textBlock = apiData?.content?.find?.(c => c.type === 'text');
  const textContent = textBlock?.text;
  if (!textContent) {
    return jsonResponse({
      error: 'Claude returned no text content',
      raw_response: apiData
    }, 500);
  }

  // Strip accidental markdown fences
  const cleaned = textContent
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return jsonResponse({
      error: 'Claude returned text that is not valid JSON',
      raw_response: textContent,
      parse_error: err.message
    }, 500);
  }

  const matches = Array.isArray(parsed?.matches) ? parsed.matches : [];

  // Validate each match entry. Defensive — Claude usually follows schema but
  // we don't want a bad index to crash the client.
  const validMatches = matches.filter(m => {
    if (typeof m.image_index !== 'number') return false;
    if (m.image_index < 0 || m.image_index >= images.length) return false;
    if (typeof m.is_match !== 'boolean') return false;
    if (m.is_match) {
      if (typeof m.material_index !== 'number') return false;
      if (m.material_index < 0 || m.material_index >= materials.length) return false;
    }
    return true;
  });

  return jsonResponse({
    success: true,
    matches: validMatches,
    meta: {
      model: apiData.model,
      usage: apiData.usage,
      image_count: images.length,
      material_count: materials.length,
      matches_returned: validMatches.length,
      matches_dropped: matches.length - validMatches.length
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
