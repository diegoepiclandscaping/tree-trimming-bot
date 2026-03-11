require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const fetch = require("node-fetch");
const FormData = require("form-data");

const BOT_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_TOKEN  = process.env.NOTION_TOKEN;
const PROJECTS_DB   = process.env.NOTION_PROJECTS_DB || "9ae58454-87ec-4ac1-8460-496c51dcb323";

if (!BOT_TOKEN || !ANTHROPIC_KEY || !NOTION_TOKEN) {
  console.error("Missing env variables.");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const MANAGERS = ["Alex Collier","Andrea Trivino","Andres Collier","Andres Muneton","Carlos Telechea","Claudia Monterrosa","Diego Echeverry","Faren Alvarez","Jose Barquero","Josue Morales","Luciano Jarama","Nicole Wolmers","Ronald Ramirez","Sara Castillo","Victor Munoz"];
const CITIES = ["Boca Raton","Coral Springs","Davie","Delray Beach","Hollywood","Lauderhill","Lighthouse Point","Margate","Miami","Miami Beach","Miami Gardens","Miramar","Pembroke Pines","Plantation","Southwest Ranches","Sunrise","Tamarac","Weston"];

const sessions = {};
function getSession(id) { if (!sessions[id]) sessions[id]={step:"idle",form:{},fileBuffer:null,fileName:null,fileType:null}; return sessions[id]; }
function clearSession(id) { sessions[id]={step:"idle",form:{},fileBuffer:null,fileName:null,fileType:null}; }

async function downloadTelegramFile(fileId) {
  const fi = await bot.getFile(fileId);
  const r = await fetch("https://api.telegram.org/file/bot"+BOT_TOKEN+"/"+fi.file_path);
  return { buffer: await r.buffer(), path: fi.file_path };
}

async function extractEstimateData(buffer, mediaType, isPdf) {
  const b64 = buffer.toString("base64");
  const prompt = "Extract data from this tree trimming estimate. Return ONLY JSON: {"projectName":"","address":"","city":"","price":0,"estimateNumber":"","description":""}. City must be one of: "+CITIES.join(",")+". Address must include full street, city, state, zip. Price is a number.";
  const content = isPdf
    ? [{type:"document",source:{type:"base64",media_type:"application/pdf",data:b64}},{type:"text",text:prompt}]
    : [{type:"image",source:{type:"base64",media_type:mediaType,data:b64}},{type:"text",text:prompt}];
  const r = await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json","x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,messages:[{role:"user",content}]})});
  const d = await r.json();
  const t = (d.content||[]).map(c=>c.text||"").join("");
  return JSON.parse(t.replace(/```json|```/g,"").trim());
}

async function uploadFileToNotion(buffer, fileName, fileType) {
  try {
    const r1 = await fetch("https://api.notion.com/v1/file_uploads",{method:"POST",headers:{"Authorization":"Bearer "+NOTION_TOKEN,"Notion-Version":"2022-06-28","Content-Type":"application/json"},body:JSON.stringify({filename:fileName})});
    if (!r1.ok) return null;
    const {id,upload_url} = await r1.json();
    if (!upload_url||!id) return null;
    const fd = new FormData();
    fd.append("file",buffer,{filename:fileName,contentType:fileType});
    const r2 = await fetch(upload_url,{method:"POST",headers:Object.assign({"Authorization":"Bearer "+NOTION_TOKEN},fd.getHeaders()),body:fd});
    return r2.ok ? id : null;
  } catch(e){ console.error("Upload error:",e.message); return null; }
}

async function createNotionProject(form, fileUploadId) {
  const p = {
    "Project Name":{title:[{text:{content:form.projectName||"Untitled"}}]},
    "Address":{rich_text:[{text:{content:form.address||""}}]},
    "Estimate Number":{rich_text:[{text:{content:form.estimateNumber||""}}]},
    "Descripcion del trabajo":{rich_text:[{text:{content:form.description||""}}]},
    "Status":{status:{name:"Not started"}},
  };
  if (form.price) p["Price"]={number:parseFloat(form.price)};
  if (form.city) p["City"]={select:{name:form.city}};
  if (form.manager) p["Manager"]={select:{name:form.manager}};
  if (fileUploadId) p["Estimate"]={files:[{type:"file_upload",file_upload:{id:fileUploadId}}]};
  const r = await fetch("https://api.notion.com/v1/pages",{method:"POST",headers:{"Authorization":"Bearer "+NOTION_TOKEN,"Notion-Version":"2022-06-28","Content-Type":"application/json"},body:JSON.stringify({parent:{database_id:PROJECTS_DB},properties:p})});
  const d = await r.json();
  if (!r.ok) throw new Error(d.message||"Notion error");
  return d;
}

function fmt(form) {
  const price = form.price ? "$"+parseFloat(form.price).toLocaleString() : "—";
  return "Datos extraidos del estimado

Cliente: "+(form.projectName||"—")+"
Direccion: "+(form.address||"—")+"
Ciudad: "+(form.city||"—")+"
Precio: "+price+"
Estimado #: "+(form.estimateNumber||"—")+"
Descripcion: "+(form.description||"—")+"

Los datos son correctos?";
}

function fieldLabel(f) { return {projectName:"Cliente",address:"Direccion",city:"Ciudad",price:"Precio",estimateNumber:"# Estimado",description:"Descripcion",manager:"Manager"}[f]||f; }

const confirmKb = {inline_keyboard:[[{text:"Confirmar y guardar",callback_data:"confirm"},{text:"Editar datos",callback_data:"edit"}],[{text:"Cancelar",callback_data:"cancel"}]]};
const editKb = {inline_keyboard:[[{text:"Cliente",callback_data:"edit_projectName"},{text:"# Estimado",callback_data:"edit_estimateNumber"}],[{text:"Direccion",callback_data:"edit_address"},{text:"Ciudad",callback_data:"edit_city"}],[{text:"Precio",callback_data:"edit_price"},{text:"Manager",callback_data:"edit_manager"}],[{text:"Descripcion",callback_data:"edit_description"}],[{text:"Listo — guardar",callback_data:"confirm"}]]};

function mgrKb(){ const rows=[]; for(let i=0;i<MANAGERS.length;i+=2) rows.push(MANAGERS.slice(i,i+2).map(m=>({text:m,callback_data:"manager_"+m}))); rows.push([{text:"Volver",callback_data:"edit"}]); return {inline_keyboard:rows}; }
function cityKb(){ const rows=[]; for(let i=0;i<CITIES.length;i+=2) rows.push(CITIES.slice(i,i+2).map(c=>({text:c,callback_data:"city_"+c}))); rows.push([{text:"Volver",callback_data:"edit"}]); return {inline_keyboard:rows}; }

bot.onText(//start/,msg=>{ clearSession(msg.chat.id); bot.sendMessage(msg.chat.id,"Tree Trimming Bot

Mandame la foto o PDF del estimado para crear el proyecto en Notion automaticamente."); });
bot.onText(//cancelar/,msg=>{ clearSession(msg.chat.id); bot.sendMessage(msg.chat.id,"Cancelado."); });

async function handleFile(msg,fileId,fileName,mimeType) {
  const chatId=msg.chat.id, session=getSession(chatId);
  const isPdf=mimeType==="application/pdf";
  const isImg=(mimeType&&mimeType.startsWith("image/"))||!mimeType;
  if (!isPdf&&!isImg) return bot.sendMessage(chatId,"Solo acepto fotos o PDFs.");
  const pm=await bot.sendMessage(chatId,"Analizando el estimado...");
  try {
    const {buffer,path}=await downloadTelegramFile(fileId);
    let mt=mimeType; if (!mt||mt==="image/jpeg") mt=path.endsWith(".png")?"image/png":"image/jpeg";
    session.fileBuffer=buffer; session.fileName=fileName||(isPdf?"estimate.pdf":"estimate.jpg"); session.fileType=mt;
    const ex=await extractEstimateData(buffer,mt,isPdf);
    session.form={projectName:ex.projectName||"",address:ex.address||"",city:ex.city||"",price:ex.price?String(ex.price):"",estimateNumber:ex.estimateNumber||"",description:ex.description||"",manager:""};
    session.step="confirm";
    await bot.deleteMessage(chatId,pm.message_id).catch(()=>{});
    await bot.sendMessage(chatId,fmt(session.form),{reply_markup:confirmKb});
  } catch(err) {
    console.error("Extract error:",err);
    await bot.deleteMessage(chatId,pm.message_id).catch(()=>{});
    await bot.sendMessage(chatId,"No pude extraer los datos. Intenta con otra imagen mas clara.");
  }
}

bot.on("photo",msg=>{ const p=msg.photo[msg.photo.length-1]; handleFile(msg,p.file_id,"estimate.jpg","image/jpeg"); });
bot.on("document",msg=>{ const d=msg.document; handleFile(msg,d.file_id,d.file_name,d.mime_type); });

bot.on("message",async msg=>{
  if (msg.photo||msg.document) return;
  if (msg.text&&msg.text.startsWith("/")) return;
  const chatId=msg.chat.id, session=getSession(chatId), text=msg.text&&msg.text.trim();
  if (!text) return;
  if (session.step==="awaiting_input"&&session.editingField) {
    const f=session.editingField; session.form[f]=text; session.editingField=null; session.step="confirm";
    await bot.sendMessage(chatId,fieldLabel(f)+" actualizado.

"+fmt(session.form),{reply_markup:editKb});
  } else if (session.step==="idle") bot.sendMessage(chatId,"Mandame la foto o PDF del estimado. Usa /start para las instrucciones.");
});

bot.on("callback_query",async query=>{
  const chatId=query.message.chat.id, msgId=query.message.message_id, data=query.data, session=getSession(chatId);
  await bot.answerCallbackQuery(query.id);
  if (data==="confirm") {
    if (!session.form.projectName||!session.form.price) return bot.sendMessage(chatId,"Falta el nombre del cliente o el precio.");
    await bot.editMessageText("Subiendo archivo y creando proyecto en Notion...",{chat_id:chatId,message_id:msgId});
    try {
      let fid=null; if (session.fileBuffer) fid=await uploadFileToNotion(session.fileBuffer,session.fileName,session.fileType);
      const page=await createNotionProject(session.form,fid);
      const fs=fid?"Estimado adjuntado":"Archivo no adjuntado — agregalo manualmente";
      const link=page.url?"

Abrir en Notion: "+page.url:"";
      await bot.editMessageText("Proyecto creado en Notion!

"+session.form.projectName+"
$"+parseFloat(session.form.price).toLocaleString()+"
Estimado #"+(session.form.estimateNumber||"—")+"

"+fs+link,{chat_id:chatId,message_id:msgId,disable_web_page_preview:true});
      clearSession(chatId);
    } catch(err){ await bot.editMessageText("Error al guardar en Notion: "+err.message,{chat_id:chatId,message_id:msgId}); }
  } else if (data==="edit") { session.step="editing"; await bot.editMessageText("Que campo quieres editar?

"+fmt(session.form),{chat_id:chatId,message_id:msgId,reply_markup:editKb}); }
  else if (data==="cancel") { clearSession(chatId); await bot.editMessageText("Cancelado.",{chat_id:chatId,message_id:msgId}); }
  else if (data.startsWith("edit_")&&data!=="edit_city"&&data!=="edit_manager") { const f=data.replace("edit_",""); session.editingField=f; session.step="awaiting_input"; await bot.sendMessage(chatId,"Escribe el nuevo valor para "+fieldLabel(f)+":"); }
  else if (data==="edit_city") await bot.editMessageText("Selecciona la ciudad:",{chat_id:chatId,message_id:msgId,reply_markup:cityKb()});
  else if (data==="edit_manager") await bot.editMessageText("Selecciona el manager:",{chat_id:chatId,message_id:msgId,reply_markup:mgrKb()});
  else if (data.startsWith("city_")) { const city=data.replace("city_",""); session.form.city=city; session.step="confirm"; await bot.editMessageText("Ciudad: "+city+"

"+fmt(session.form),{chat_id:chatId,message_id:msgId,reply_markup:editKb}); }
  else if (data.startsWith("manager_")) { const mgr=data.replace("manager_",""); session.form.manager=mgr; session.step="confirm"; await bot.editMessageText("Manager: "+mgr+"

"+fmt(session.form),{chat_id:chatId,message_id:msgId,reply_markup:editKb}); }
});

bot.on("polling_error",err=>console.error("Polling error:",err.message));
console.log("Tree Trimming Bot is running...");
