import OpenAI from 'openai';
import * as dotenv from 'dotenv';
dotenv.config();

const client = new OpenAI({
  // SECURITY: move these to .env (AZURE_OPENAI_API_KEY) and rotate the old key.
  apiKey: process.env.AZURE_OPENAI_API_KEY!,
  baseURL:
    process.env.AZURE_OPENAI_BASE_URL ??
    'https://testingsl1.openai.azure.com/openai/deployments/gpt-4.1',
  defaultQuery: {
    'api-version':
      process.env.AZURE_OPENAI_API_VERSION ?? '2024-02-15-preview',
  },
  defaultHeaders: {
    'api-key': process.env.AZURE_OPENAI_API_KEY!,
  },
});

type AIResponse = {
  locator: string;
  confidence: number;
  reason: string;
};

/**
 * Build a single image content block for the chat message.
 * Returns null if the screenshot is missing, so callers can filter it out
 * instead of sending an empty / "Not available" block.
 *
 * @param base64  raw base64 string (NO data: prefix) or null
 * @param detail  'high' for the image the model must search within,
 *                'low'  for reference-only images (cheaper tokens)
 */
function imageBlock(
  base64: string | null | undefined,
  detail: 'high' | 'low' = 'low'
) {
  if (!base64) return null;

  // selfHealing.ts captures JPEG (quality 70); declare the matching mime.
  return {
    type: 'image_url' as const,
    image_url: {
      url: `data:image/jpeg;base64,${base64}`,
      detail,
    },
  };
}

export async function getAILocator(data: any): Promise<AIResponse> {

  // =========================================================
  // TEXT PROMPT — DOM + instructions ONLY.
  // Screenshots are sent as real image blocks below, not pasted here.
  // =========================================================
const prompt = `
You are a Playwright locator expert with visual reasoning.

Goal:
Generate a UNIQUE, STABLE, and RELIABLE locator for the target element,
using BOTH the DOM text below AND the attached screenshots.

========================
CONTEXT
========================

Element Name:
${data.elementName}

Failed Locator:
${data.failedLocator}

Previous Smart Locators:
${JSON.stringify(data.smartLocators)}

Element Metadata:
${JSON.stringify(data.meta)}

------------------------
OLD ELEMENT SNAPSHOT (outerHTML)
------------------------
${data.oldOuterHTML || 'Not available'}

------------------------
OLD PAGE DOM
------------------------
${data.oldDOM || 'Not available'}

------------------------
CURRENT PAGE DOM (SOURCE OF TRUTH)
------------------------
${data.newDOM || 'Not available'}

========================
ATTACHED IMAGES (see message)
========================
The images attached to this message, in order, are:
  1. OLD ELEMENT SCREENSHOT      — the element as it originally looked
  2. OLD FULL PAGE SCREENSHOT    — original page layout / position
  3. CURRENT FULL PAGE SCREENSHOT — the page as it is NOW (locate within this)
Some images may be omitted if they were not captured; rely on the DOM then.

========================
INSTRUCTIONS
========================

Step 1: Identify the target in the OLD element + OLD page screenshot.
Step 2: Find the visually + structurally equivalent element in the
        CURRENT page screenshot and CURRENT DOM.
Step 3: Note what changed (id, class, text, structure, position).
Step 4: Produce the best locator that exists in the CURRENT DOM.

========================
RULES (STRICT)
========================
- The locator MUST exist in the CURRENT DOM (the source of truth).
- Prefer, in order:
    1. getByRole(role, { name })
    2. getByLabel()
    3. getByPlaceholder()
    4. getByText() (exact match)
  then CSS, and XPath only if unavoidable.
- Avoid dynamic attributes (random ids, hashes, framework-generated classes).
- Prefer partial accessible names.



Example:
getByRole('link', { name: /shades of the season/i })

1. Locator changed
2. Element moved
3. Element renamed
4. Element removed completely


Avoid long text strings.
- If the element is one of several identical items (e.g. repeated cards),
  return the locator for that REPEATED element as-is; the framework will
  disambiguate which instance using a stored index. Do NOT invent a
  positional [n] selector yourself.
- Only use attributes that literally appear in the CURRENT DOM.

If the original element cannot be confidently mapped to a current element,
return:
{ "locator": "NO_MATCH", "confidence": 0, "reason": "No equivalent element found" }

========================
OUTPUT FORMAT (STRICT JSON ONLY — no markdown, no prose)
========================
{
  "locator": "...",
  "confidence": 0-1,
  "reason": "Why this locator uniquely identifies the element (OLD vs CURRENT)"
}
`.trim();

  // =========================================================
  // MULTIMODAL USER CONTENT
  // Order matters: the text references images 1/2/3 in this order.
  // Missing images are filtered out so no empty blocks are sent.
  // =========================================================
  const userContent: any[] = [
    { type: 'text', text: prompt },
  ];

  const images = [
    // reference-only images -> low detail (cheaper)
    imageBlock(data.oldElementScreenshot, 'low'),
    imageBlock(data.oldPageScreenshot, 'low'),
    // the page the model must locate within -> high detail
    imageBlock(data.currentPageScreenshot, 'high'),
  ].filter(Boolean);

  userContent.push(...images);
  console.log("blocks sent",userContent.map(b => b.type));

  const response = await client.chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT!,
    messages: [
      {
        role: 'system',
        content:
          'You generate Playwright locators using DOM text and attached screenshots. Respond with strict JSON only.',
      },
      {
        role: 'user',
        content: userContent,
      },
    ],
    temperature: 0.2,
  });

  const text = response.choices[0].message.content || '';

  const cleaned = text
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error('Invalid AI response');
  }
}
