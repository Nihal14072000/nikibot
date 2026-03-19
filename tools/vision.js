/**
 * tools/vision.js
 * Image understanding via vision-capable models on OpenRouter.
 *
 * Flow:
 *   Telegram photo → download → base64 → vision model → text answer
 *
 * Works with:
 *   - Photos sent directly
 *   - Screenshots
 *   - Documents that are images (jpg, png, webp, gif)
 *   - Optional caption becomes the question
 */

import fs   from "fs";
import path from "path";

const VISION_MODEL   = process.env.VISION_MODEL   || "google/gemini-flash-1.5";
const VISION_MAX_TOKENS = parseInt(process.env.VISION_MAX_TOKENS || "1024", 10);
const TEMP_DIR       = path.resolve("tmp");

// ─── Supported formats ─────────────────────────────────────────────────────

const MIME_MAP = {
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png":  "image/png",
  ".webp": "image/webp",
  ".gif":  "image/gif",
};

// ─── Download helper ───────────────────────────────────────────────────────

/**
 * Download a Telegram file by file_id.
 * Returns { localPath, mimeType }
 */
export async function downloadTelegramFile(bot, fileId) {
  // Ensure temp dir exists
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

  // Get file path from Telegram
  const file     = await bot.getFile(fileId);
  const filePath = file.file_path;                          // e.g. "photos/file_123.jpg"
  const ext      = path.extname(filePath).toLowerCase() || ".jpg";
  const localPath= path.join(TEMP_DIR, `img_${fileId}${ext}`);

  // Download file
  const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(localPath, buffer);

  const mimeType = MIME_MAP[ext] || "image/jpeg";
  return { localPath, mimeType, sizeBytes: buffer.length };
}

/**
 * Convert local image file to base64 data URL.
 */
export function imageToBase64(localPath, mimeType) {
  const data = fs.readFileSync(localPath);
  return {
    base64: data.toString("base64"),
    mimeType,
  };
}

/**
 * Clean up temp image file after processing.
 */
export function cleanupImage(localPath) {
  try {
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
  } catch {
    // Non-fatal
  }
}

// ─── Vision API call ───────────────────────────────────────────────────────

/**
 * Send an image + question to a vision model via OpenAI-compatible API.
 * Returns the model's text response.
 */
export async function analyzeImage({ openaiClient, base64, mimeType, question, systemPrompt }) {
  const prompt = question?.trim() || "Describe this image in detail. If it contains text, transcribe it. If it shows an error or code, explain it.";

  const messages = [
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: {
            url:    `data:${mimeType};base64,${base64}`,
            detail: "auto",
          },
        },
        {
          type: "text",
          text: prompt,
        },
      ],
    },
  ];

  const reqMessages = systemPrompt
    ? [{ role: "system", content: systemPrompt }, ...messages]
    : messages;

  const res = await openaiClient.chat.completions.create({
    model:      VISION_MODEL,
    max_tokens: VISION_MAX_TOKENS,
    messages:   reqMessages,
  });

  return res.choices[0].message.content;
}

// ─── Main handler ──────────────────────────────────────────────────────────

/**
 * Full pipeline: fileId → download → analyze → cleanup → return text
 */
export async function handleImage({ bot, openaiClient, fileId, caption, systemPrompt }) {
  let localPath = null;

  try {
    // Download
    const { localPath: lp, mimeType, sizeBytes } = await downloadTelegramFile(bot, fileId);
    localPath = lp;

    console.log(`🖼️  Image: ${path.basename(lp)} (${(sizeBytes / 1024).toFixed(1)} KB)`);

    // Convert to base64
    const { base64 } = imageToBase64(localPath, mimeType);

    // Analyze
    const answer = await analyzeImage({
      openaiClient,
      base64,
      mimeType,
      question:     caption,
      systemPrompt,
    });

    return answer;

  } finally {
    // Always clean up temp file
    if (localPath) cleanupImage(localPath);
  }
}

// ─── Document image check ──────────────────────────────────────────────────

/**
 * Check if a Telegram document message is an image we can process.
 */
export function isImageDocument(doc) {
  if (!doc) return false;
  const mime = doc.mime_type || "";
  return mime.startsWith("image/");
}
