require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const fetch = require("node-fetch");
const FormData = require("form-data");

// ── Config ─────────────────────────────────────────────────────────────────
const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const NOTION_TOKEN   = process.env.NOTION_TOKEN;
const PROJECTS_DB    = process.env.NOTION_PROJECTS_DB || "9ae58454-87ec-4ac1-8460-496c51dcb323";

if (!BOT_TOKEN || !ANTHROPIC_KEY || !NOTION_TOKEN) {
  console.error("❌  Missing env variables. Check your .env file.");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ── Constants ──────────────────────────────────────────────────────────────
const MANAGERS = [
  "Alex Collier","Andrea Trivino","Andres Collier","Andres Muneton",
  "Carlos Telechea","Claudia Monterrosa","Diego Echeverry","Faren Alvarez",
  "Jose Barquero","Josué Morales","Luciano Jarama","Nicole Wolmers",
  "Ronald Ramirez","Sara Castillo","Victor Muñoz"
];

const CITIES = [
  "Boca Raton","Coral Springs","Davie","Delray Beach","Hollywood",
  "Lauderhill","Lighthouse Point","Margate","Miami","Miami Beach",
  "Miami Gardens","Miramar","Pembroke Pines","Plantation",
  "Southwest Ranches","Sunrise","Tamarac","Weston"
];

// ── Session store (in-memory) ──────────────────────────────────────────────
// Maps chatId → session data
const sessions = {};

function getSession(chatId) {
  if (!sessions[chatId]) sessions[chatId] = { step: "idle", form: {}, fileBuffer: null, fileName: null, fileType: null };
  return sessions[chatId];
}

function clearSession(chatId) {
  sessions[chatId] = { step: "idle", form: {}, fileBuffer: null, fileName: null, fileType: null };
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function downloadTelegramFile(fileId) {
  const fileInfo = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
  const resp = await fetch(fileUrl);
  const buffer = await resp.buffer();
  return { buffer, path: fileInfo.file_path };
}

async function extractEstimateData(buffer, mediaType, isPdf) {
  const base64 = buffer.toString("base64");

  const prompt = `You are a data extraction assistant for a tree trimming landscaping company.
Analyze this estimate document and extract the following fields. Return ONLY valid JSON, nothing else.

{
  "projectName": "client name / property name",
  "address": "full street address including city, state and zip — e.g. '1234 Oak St, Coral Springs, FL 33065'",
  "city": "city name only — must be one of: ${CITIES.join(", ")} — pick closest match or empty string",
  "price": 0,
  "estimateNumber": "estimate or quote number as string",
  "description": "brief 1-2 sentence description of the tree trimming work"
}

Rules:
- address MUST include full address WITH city and state/zip
- price must be a number (no dollar signs)
- If a field is not found use empty string or 0 for price`;

  const content = isPdf
    ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }, { type: "text", text: prompt }]
    : [{ type: "image",    source: { type: "base64", media_type: mediaType, data: base64 } },          { type: "text", text: prompt }];

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1000, messages: [{ role: "user", content }] }),
  });

  const data = await resp.json();
  const text = data.content?.map(c => c.text || "").join("") || "";
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

async function uploadFileToNotion(buffer, fileName, fileType) {
  try {
    // Step 1: Create upload session
    const initResp = await fetch("https://api.notion.com/v1/file_uploads", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ filename: fileName }),
    });

    if (!initResp.ok) return null;
    const initData = await initResp.json();
    const { id: fileUploadId, upload_url: uploadUrl } = initData;

    if (!uploadUrl || !fileUploadId) return null;

    // Step 2: Upload the file
    const formData = new FormData();
    formData.append("file", buffer, { filename: fileName, contentType: fileType });

    const uploadResp = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${NOTION_TOKEN}`, ...formData.getHeaders() },
      body: formData,
    });

    return uploadResp.ok ? fileUploadId : null;
  } catch (e) {
    console.error("Notion file upload error:", e.message);
    return null;
  }
}

async function createNotionProject(form, fileUploadId, fileName) {
  const properties = {
    "Project Name": { title: [{ text: { content: form.projectName || "Untitled" } }] },
    "Address":      { rich_text: [{ text: { content: form.address || "" } }] },
    "Estimate Number": { rich_text: [{ text: { content: form.estimateNumber || "" } }] },
    "Descripción del trabajo": { rich_text: [{ text: { content: form.description || "" } }] },
    "Status": { status: { name: "Not started" } },
  };

  if (form.price)   properties["Price"]   = { number: parseFloat(form.price) };
  if (form.city)    properties["City"]    = { select: { name: form.city } };
  if (form.manager) properties["Manager"] = { select: { name: form.manager } };
  if (fileUploadId) properties["Estimate"] = { files: [{ type: "file_upload", file_upload: { id: fileUploadId } }] };

  const resp = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ parent: { database_id: PROJECTS_DB }, properties }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.message || "Notion error");
  return data;
}

function formatConfirmationMessage(form) {
  const price = form.price ? `$${parseFloat(form.price).toLocaleString()}` : "—";
  return [
    `📋 *Datos extraídos del estimado*`,
    ``,
    `👤 *Cliente:* ${form.projectName || "—"}`,
    `📍 *Dirección:* ${form.address || "—"}`,
    `🏙 *Ciudad:* ${form.city || "—"}`,
    `💰 *Precio:* ${price}`,
    `🔢 *Estimado #:* ${form.estimateNumber || "—"}`,
    `📝 *Descripción:* ${form.description || "—"}`,
    ``,
    `¿Los datos son correctos?`,
  ].join("\n");
}

// ── Keyboard builders ──────────────────────────────────────────────────────

const confirmKeyboard = {
  inline_keyboard: [
    [
      { text: "✅ Confirmar y guardar", callback_data: "confirm" },
      { text: "✏️ Editar datos",        callback_data: "edit"    },
    ],
    [{ text: "❌ Cancelar", callback_data: "cancel" }],
  ],
};

const editFieldKeyboard = {
  inline_keyboard: [
    [{ text: "👤 Cliente",      callback_data: "edit_projectName"    }, { text: "🔢 # Estimado", callback_data: "edit_estimateNumber" }],
    [{ text: "📍 Dirección",    callback_data: "edit_address"        }, { text: "🏙 Ciudad",     callback_data: "edit_city"           }],
    [{ text: "💰 Precio",       callback_data: "edit_price"         }, { text: "👨‍💼 Manager",   callback_data: "edit_manager"        }],
    [{ text: "📝 Descripción",  callback_data: "edit_description"   }],
    [{ text: "✅ Listo — guardar", callback_data: "confirm" }],
  ],
};

function managerKeyboard() {
  const rows = [];
  for (let i = 0; i < MANAGERS.length; i += 2) {
    rows.push(MANAGERS.slice(i, i + 2).map(m => ({ text: m, callback_data: `manager_${m}` })));
  }
  rows.push([{ text: "⬅️ Volver", callback_data: "edit" }]);
  return { inline_keyboard: rows };
}

function cityKeyboard() {
  const rows = [];
  for (let i = 0; i < CITIES.length; i += 2) {
    rows.push(CITIES.slice(i, i + 2).map(c => ({ text: c, callback_data: `city_${c}` })));
  }
  rows.push([{ text: "⬅️ Volver", callback_data: "edit" }]);
  return { inline_keyboard: rows };
}

// ── Bot commands ───────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  clearSession(msg.chat.id);
  bot.sendMessage(msg.chat.id,
    `🌳 *Epic Landscaping — Tree Trimming*\n\nHola! Mándame la *foto* o el *PDF* del estimado y extraigo los datos automáticamente para crear el proyecto en Notion.\n\n📎 Solo arrastra o adjunta el archivo aquí.`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/cancelar/, (msg) => {
  clearSession(msg.chat.id);
  bot.sendMessage(msg.chat.id, "❌ Operación cancelada. Manda un nuevo estimado cuando quieras.");
});

// ── File handler (photos and documents) ───────────────────────────────────

async function handleFile(msg, fileId, fileName, mimeType) {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  const isPdf = mimeType === "application/pdf";
  const isImage = mimeType?.startsWith("image/") || !mimeType; // photos have no mime

  if (!isPdf && !isImage) {
    return bot.sendMessage(chatId, "⚠️ Solo acepto fotos (JPG, PNG) o archivos PDF. Intenta de nuevo.");
  }

  const processingMsg = await bot.sendMessage(chatId, "⚙️ Analizando el estimado...", { parse_mode: "Markdown" });

  try {
    const { buffer, path } = await downloadTelegramFile(fileId);

    // Determine actual media type
    let mediaType = mimeType;
    if (!mediaType || mediaType === "image/jpeg") {
      // Telegram photos are always JPEG
      mediaType = path.endsWith(".png") ? "image/png" : "image/jpeg";
    }

    session.fileBuffer = buffer;
    session.fileName   = fileName || (isPdf ? "estimate.pdf" : "estimate.jpg");
    session.fileType   = mediaType;

    const extracted = await extractEstimateData(buffer, mediaType, isPdf);

    session.form = {
      projectName:    extracted.projectName    || "",
      address:        extracted.address        || "",
      city:           extracted.city           || "",
      price:          extracted.price ? String(extracted.price) : "",
      estimateNumber: extracted.estimateNumber || "",
      description:    extracted.description    || "",
      manager:        "",
    };
    session.step = "confirm";

    await bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId, formatConfirmationMessage(session.form), {
      parse_mode: "Markdown",
      reply_markup: confirmKeyboard,
    });

  } catch (err) {
    console.error("Extract error:", err);
    await bot.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
    await bot.sendMessage(chatId,
      "⚠️ No pude extraer los datos automáticamente. Intenta con otra imagen más clara, o escribe /manual para llenar los datos a mano."
    );
  }
}

// Photos
bot.on("photo", (msg) => {
  const photo = msg.photo[msg.photo.length - 1]; // highest resolution
  handleFile(msg, photo.file_id, "estimate.jpg", "image/jpeg");
});

// Documents (PDFs and image files)
bot.on("document", (msg) => {
  const doc = msg.document;
  handleFile(msg, doc.file_id, doc.file_name, doc.mime_type);
});

// ── Text input handler (for editing fields) ────────────────────────────────

bot.on("message", async (msg) => {
  if (msg.photo || msg.document) return; // handled above
  if (msg.text?.startsWith("/")) return; // commands handled separately

  const chatId = msg.chat.id;
  const session = getSession(chatId);
  const text = msg.text?.trim();

  if (!text) return;

  if (session.step === "awaiting_input" && session.editingField) {
    const field = session.editingField;
    session.form[field] = text;
    session.editingField = null;
    session.step = "confirm";

    await bot.sendMessage(chatId, `✅ *${fieldLabel(field)}* actualizado.\n\n${formatConfirmationMessage(session.form)}`, {
      parse_mode: "Markdown",
      reply_markup: editFieldKeyboard,
    });
  } else if (session.step === "idle") {
    bot.sendMessage(chatId, "👋 Mándame la foto o PDF del estimado para empezar. O usa /start para ver las instrucciones.");
  }
});

function fieldLabel(field) {
  const labels = {
    projectName: "Cliente", address: "Dirección", city: "Ciudad",
    price: "Precio", estimateNumber: "# Estimado", description: "Descripción", manager: "Manager",
  };
  return labels[field] || field;
}

// ── Callback query handler (inline keyboard buttons) ──────────────────────

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const data   = query.data;
  const session = getSession(chatId);

  await bot.answerCallbackQuery(query.id);

  // ── Confirm → save to Notion
  if (data === "confirm") {
    if (!session.form.projectName || !session.form.price) {
      return bot.sendMessage(chatId, "⚠️ Falta el nombre del cliente o el precio. Edítalos primero.");
    }

    await bot.editMessageText("⏳ Subiendo archivo y creando proyecto en Notion...", {
      chat_id: chatId, message_id: msgId,
    });

    try {
      // Upload file to Notion
      let fileUploadId = null;
      if (session.fileBuffer) {
        fileUploadId = await uploadFileToNotion(session.fileBuffer, session.fileName, session.fileType);
      }

      // Create Notion page
      const page = await createNotionProject(session.form, fileUploadId, session.fileName);

      const fileStatus = fileUploadId ? "📎 Estimado adjuntado en campo *Estimate* ✓" : "⚠️ El archivo no pudo adjuntarse — adjúntalo manualmente en Notion";
      const notionLink = page.url ? `\n\n[📂 Abrir en Notion](${page.url})` : "";

      await bot.editMessageText(
        `✅ *¡Proyecto creado en Notion!*\n\n👤 *${session.form.projectName}*\n💰 $${parseFloat(session.form.price).toLocaleString()}\n🔢 Estimado #${session.form.estimateNumber || "—"}\n\n${fileStatus}${notionLink}`,
        { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", disable_web_page_preview: true }
      );

      clearSession(chatId);

    } catch (err) {
      console.error("Notion error:", err);
      await bot.editMessageText(
        `❌ Error al guardar en Notion: ${err.message}\n\nIntenta de nuevo o revisa la conexión.`,
        { chat_id: chatId, message_id: msgId }
      );
    }
  }

  // ── Edit → show field selector
  else if (data === "edit") {
    session.step = "editing";
    await bot.editMessageText(
      `✏️ *¿Qué campo quieres editar?*\n\n${formatConfirmationMessage(session.form)}`,
      { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: editFieldKeyboard }
    );
  }

  // ── Cancel
  else if (data === "cancel") {
    clearSession(chatId);
    await bot.editMessageText("❌ Cancelado. Manda un nuevo estimado cuando quieras.", {
      chat_id: chatId, message_id: msgId,
    });
  }

  // ── Edit specific field (text fields)
  else if (data.startsWith("edit_") && data !== "edit_city" && data !== "edit_manager") {
    const field = data.replace("edit_", "");
    session.editingField = field;
    session.step = "awaiting_input";
    await bot.sendMessage(chatId, `✏️ Escribe el nuevo valor para *${fieldLabel(field)}*:`, { parse_mode: "Markdown" });
  }

  // ── Edit city → show city picker
  else if (data === "edit_city") {
    await bot.editMessageText("🏙 *Selecciona la ciudad:*", {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
      reply_markup: cityKeyboard(),
    });
  }

  // ── Edit manager → show manager picker
  else if (data === "edit_manager") {
    await bot.editMessageText("👨‍💼 *Selecciona el manager:*", {
      chat_id: chatId, message_id: msgId, parse_mode: "Markdown",
      reply_markup: managerKeyboard(),
    });
  }

  // ── City selected
  else if (data.startsWith("city_")) {
    const city = data.replace("city_", "");
    session.form.city = city;
    session.step = "confirm";
    await bot.editMessageText(
      `✅ Ciudad actualizada a *${city}*.\n\n${formatConfirmationMessage(session.form)}`,
      { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: editFieldKeyboard }
    );
  }

  // ── Manager selected
  else if (data.startsWith("manager_")) {
    const manager = data.replace("manager_", "");
    session.form.manager = manager;
    session.step = "confirm";
    await bot.editMessageText(
      `✅ Manager actualizado a *${manager}*.\n\n${formatConfirmationMessage(session.form)}`,
      { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: editFieldKeyboard }
    );
  }
});

// ── Error handling ─────────────────────────────────────────────────────────
bot.on("polling_error", (err) => console.error("Polling error:", err.message));

console.log("🌳 Tree Trimming Bot is running...");
