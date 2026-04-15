// saas-routes.js
// SaaS Chatbot 平台 API 路由
// 環境變數需求：
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   N8N_SAAS_WEBHOOK_URL      （PDF 處理管線）
//   N8N_SAAS_CHAT_WEBHOOK_URL （對話查詢）

const crypto  = require('crypto');   // 必須明確 require，全域 Web Crypto API 不含 timingSafeEqual
const express = require('express');
const multer  = require('multer');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

// multer：PDF 暫存記憶體，最大 50MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('只接受 PDF 檔案'));
    }
    cb(null, true);
  }
});

// 輸入長度限制常數
const LIMITS = {
  NAME:       100,
  DESCRIPTION: 300,
  MESSAGE:    2000,
  SESSION_ID:   80
};

// UUID v4 格式驗證
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PDF 魔術位元組：%PDF-（前 5 bytes）
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D]);

// 檔名清洗：移除路徑分隔符、null byte，限制長度
function sanitizeFilename(name) {
  return (name || '')
    .replace(/[\\/\0]/g, '_')   // 路徑分隔符和 null byte 換成底線
    .replace(/\.{2,}/g, '.')    // 防止 ../
    .slice(0, 200)              // 最長 200 字元
    .trim() || 'upload.pdf';
}

// Supabase 管理員 client（共用單一 instance，避免每次 request 重建）
let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY');
  _supabase = createClient(url, key, { auth: { persistSession: false } });
  return _supabase;
}

/* =========================
   Auth 中介層
   驗證 Supabase JWT，將 user 寫入 req.user
   ========================= */
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  // 大小寫不敏感地移除 Bearer 前綴
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ error: '未授權：缺少 token' });

  try {
    const supabase = getSupabase();
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: '無效的 token' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(500).json({ error: '認證服務異常' });
  }
}

/* =========================
   POST /api/saas/chatbots
   建立新 chatbot（需登入，上傳 PDF）
   Body（multipart/form-data）：
     name        活動名稱（必填）
     description 活動簡介（選填）
     pdf         PDF 檔案（必填）
   ========================= */
router.post('/chatbots', requireAuth, upload.single('pdf'), async (req, res) => {
  try {
    const { name, description } = req.body;
    // 先 trim 再判空：防止純空白字串通過驗證後存入 DB 成為空名稱
    if (!name?.trim()) return res.status(400).json({ error: '缺少活動名稱 (name)' });
    if (!req.file)     return res.status(400).json({ error: '缺少 PDF 檔案' });

    // 輸入長度驗證（對 trim 後的值檢查，防止空白填充）
    if (name.trim().length > LIMITS.NAME) {
      return res.status(400).json({ error: `活動名稱不得超過 ${LIMITS.NAME} 字元` });
    }
    if (description && description.length > LIMITS.DESCRIPTION) {
      return res.status(400).json({ error: `活動簡介不得超過 ${LIMITS.DESCRIPTION} 字元` });
    }

    // 魔術位元組驗證：確認真的是 PDF（防止偽造 MIME type）
    if (req.file.buffer.subarray(0, 5).compare(PDF_MAGIC) !== 0) {
      return res.status(400).json({ error: '檔案內容不是有效的 PDF' });
    }

    // 清洗檔名
    const safeFilename = sanitizeFilename(req.file.originalname);

    const supabase    = getSupabase();
    const userId      = req.user.id;
    const chatbotId   = crypto.randomUUID();
    const storagePath = `${userId}/${chatbotId}.pdf`;

    // 1. 上傳 PDF 到 Supabase Storage
    const { error: uploadError } = await supabase.storage
      .from('saas-pdfs')
      .upload(storagePath, req.file.buffer, {
        contentType: 'application/pdf',
        upsert: false
      });

    if (uploadError) {
      console.error('[saas/create] storage error:', uploadError.message);
      return res.status(500).json({ error: 'PDF 上傳失敗' });
    }

    // 2. 產生 Signed URL（供 n8n 下載，1 小時有效）
    const { data: signedData, error: signedError } = await supabase.storage
      .from('saas-pdfs')
      .createSignedUrl(storagePath, 3600);

    if (signedError) {
      console.error('[saas/create] signed url error:', signedError.message);
      return res.status(500).json({ error: '無法產生下載連結' });
    }

    // 3. 寫入 saas_chatbots（使用清洗後的檔名）
    const { error: dbError } = await supabase
      .from('saas_chatbots')
      .insert({
        id:           chatbotId,
        user_id:      userId,
        name:         name.trim(),
        description:  description?.trim() || null,
        namespace:    chatbotId,
        pdf_url:      storagePath,
        pdf_filename: safeFilename,
        status:       'processing'
      });

    if (dbError) {
      console.error('[saas/create] db error:', dbError.message);
      await supabase.storage.from('saas-pdfs').remove([storagePath]);
      return res.status(500).json({ error: '資料庫寫入失敗' });
    }

    // 4. 非同步觸發 n8n PDF 處理 webhook（fire-and-forget，60 秒逾時）
    const n8nUrl = process.env.N8N_SAAS_WEBHOOK_URL;
    if (n8nUrl) {
      const pdfCtrl = new AbortController();
      setTimeout(() => pdfCtrl.abort(), 60_000);  // 60 秒後放棄，避免懸掛連線累積
      fetch(n8nUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'saas-proxy/1.0' },
        body: JSON.stringify({
          chatbot_id:   chatbotId,
          namespace:    chatbotId,
          pdf_url:      signedData.signedUrl,
          pdf_filename: safeFilename,
          user_id:      userId
        }),
        signal: pdfCtrl.signal
      }).catch(err => console.error('[saas/create] n8n trigger error:', err.message));
    } else {
      console.warn('[saas/create] 缺少 N8N_SAAS_WEBHOOK_URL，未觸發處理管線');
    }

    return res.status(201).json({ chatbot_id: chatbotId });
  } catch (err) {
    console.error('[saas/create] unexpected error:', err.message);
    return res.status(500).json({ error: '伺服器錯誤' });
  }
});

/* =========================
   GET /api/saas/chatbots
   列出登入用戶的所有 chatbots
   ========================= */
router.get('/chatbots', requireAuth, async (req, res) => {
  try {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('saas_chatbots')
      .select('id, name, description, status, chunk_count, pdf_filename, created_at, settings')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[saas/list] db error:', error.message);
      return res.status(500).json({ error: '查詢失敗' });
    }

    return res.json(data);
  } catch (err) {
    console.error('[saas/list] unexpected error:', err.message);
    return res.status(500).json({ error: '伺服器錯誤' });
  }
});

/* =========================
   GET /api/saas/chatbots/:id/status
   查詢 chatbot 狀態（公開，不需登入）
   供前端輪詢處理進度
   ========================= */
router.get('/chatbots/:id/status', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: '無效的 chatbot ID' });
  try {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('saas_chatbots')
      // 不回傳 error_msg（可能含 n8n 內部訊息），改用通用狀態供前端判斷
      .select('id, name, status, chunk_count, settings')
      .eq('id', req.params.id)
      .single();

    if (error || !data) return res.status(404).json({ error: '找不到此 chatbot' });

    return res.json(data);
  } catch (err) {
    console.error('[saas/status] unexpected error:', err.message);
    return res.status(500).json({ error: '伺服器錯誤' });
  }
});

/* =========================
   POST /api/saas/chatbots/:id/chat
   對話端點（公開，不需登入）
   Body（JSON）：
     message    用戶訊息（必填）
     session_id 前端隨機產生的 UUID（必填）
   ========================= */
router.post('/chatbots/:id/chat', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: '無效的 chatbot ID' });

  const { message, session_id } = req.body;
  if (!message || typeof message !== 'string')    return res.status(400).json({ error: '缺少 message 或格式錯誤' });
  if (!session_id || typeof session_id !== 'string') return res.status(400).json({ error: '缺少 session_id 或格式錯誤' });
  if (message.length > LIMITS.MESSAGE) return res.status(400).json({ error: `訊息不得超過 ${LIMITS.MESSAGE} 字元` });
  if (!UUID_RE.test(session_id))       return res.status(400).json({ error: '無效的 session_id 格式' });

  try {
    const supabase = getSupabase();

    // 確認 chatbot 存在且狀態為 ready
    const { data: chatbot, error: chatbotError } = await supabase
      .from('saas_chatbots')
      .select('id, status, namespace')
      .eq('id', req.params.id)
      .single();

    if (chatbotError || !chatbot) return res.status(404).json({ error: '找不到此 chatbot' });
    if (chatbot.status !== 'ready') {
      return res.status(400).json({ error: `Chatbot 尚未就緒（目前狀態：${chatbot.status}）` });
    }

    // 儲存用戶訊息
    await supabase.from('saas_chat_messages').insert({
      chatbot_id: req.params.id,
      session_id,
      role:       'user',
      content:    message
    });

    // 轉發到 n8n 對話 webhook（30 秒逾時，防止懸掛連線耗盡資源）
    const n8nChatUrl = process.env.N8N_SAAS_CHAT_WEBHOOK_URL;
    if (!n8nChatUrl) return res.status(500).json({ error: '查詢服務未設定' });

    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 30_000);
    let r;
    try {
      r = await fetch(n8nChatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'saas-proxy/1.0' },
        body: JSON.stringify({
          chatbot_id: req.params.id,
          namespace:  chatbot.namespace,
          session_id,
          message
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const ct  = r.headers.get('content-type') || '';
    const raw = await r.text();

    if (!r.ok) {
      console.error('[saas/chat] upstream error:', r.status, raw);
      return res.status(502).json({ error: '查詢服務暫時無法使用，請稍後再試' });
    }

    const reply = ct.includes('application/json') ? JSON.parse(raw) : { text: raw };
    // 確保 replyText 為字串（防止 n8n 回傳非字串型別），並限制長度防止資料庫炸彈
    const replyText = String(reply.text ?? reply.answer ?? reply.output ?? raw).slice(0, 10_000);

    // 儲存 assistant 回覆
    await supabase.from('saas_chat_messages').insert({
      chatbot_id: req.params.id,
      session_id,
      role:       'assistant',
      content:    replyText
    });

    return res.json({ text: replyText });

  } catch (err) {
    console.error('[saas/chat] error:', err.message);
    return res.status(502).json({ error: '查詢服務連線失敗，請稍後再試' });
  }
});

/* =========================
   DELETE /api/saas/chatbots/:id
   刪除 chatbot（需登入，只能刪自己的）
   ========================= */
router.delete('/chatbots/:id', requireAuth, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: '無效的 chatbot ID' });
  try {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('saas_chatbots')
      .select('id, pdf_url')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .single();

    if (error || !data) return res.status(404).json({ error: '找不到此 chatbot 或無權限' });

    if (data.pdf_url) {
      await supabase.storage.from('saas-pdfs').remove([data.pdf_url]).catch(e =>
        console.warn('[saas/delete] storage remove warning:', e.message)
      );
    }

    // 同時附上 user_id 防止 TOCTOU 競態：
    // 使用 service_role 繞過 RLS，必須在 DELETE 層自行重複權限驗證
    const { error: deleteError } = await supabase
      .from('saas_chatbots')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    if (deleteError) {
      console.error('[saas/delete] db error:', deleteError.message);
      return res.status(500).json({ error: '刪除失敗' });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[saas/delete] unexpected error:', err.message);
    return res.status(500).json({ error: '伺服器錯誤' });
  }
});

/* =========================
   n8n Callback：更新處理狀態
   POST /api/saas/chatbots/:id/complete
   Body（JSON）：
     status      'ready' | 'error'
     chunk_count 成功建立的向量數（ready 時提供）
     error_msg   錯誤訊息（error 時提供）
   使用 SAAS_CALLBACK_SECRET 驗證來源
   ========================= */
router.post('/chatbots/:id/complete', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: '無效的 chatbot ID' });

  const secret = process.env.SAAS_CALLBACK_SECRET;
  const provided = req.headers['x-callback-secret'] || '';

  // secret 未設定時直接拒絕；使用 timingSafeEqual 防止計時攻擊
  if (!secret) return res.status(403).json({ error: '禁止存取' });
  const secretBuf   = Buffer.from(secret);
  const providedBuf = Buffer.alloc(secretBuf.length);
  Buffer.from(provided).copy(providedBuf);
  if (!crypto.timingSafeEqual(secretBuf, providedBuf)) {
    return res.status(403).json({ error: '禁止存取' });
  }

  try {
    const { status, chunk_count, error_msg } = req.body;
    if (!['ready', 'error'].includes(status)) {
      return res.status(400).json({ error: 'status 必須為 ready 或 error' });
    }
    const safeChunkCount = Number.isInteger(chunk_count) && chunk_count >= 0 ? chunk_count : 0;
    const safeErrorMsg   = typeof error_msg === 'string' ? error_msg.slice(0, 500) : null;

    const supabase = getSupabase();
    const { error } = await supabase
      .from('saas_chatbots')
      .update({ status, chunk_count: safeChunkCount, error_msg: safeErrorMsg })
      .eq('id', req.params.id);

    if (error) {
      console.error('[saas/complete] db error:', error.message);
      return res.status(500).json({ error: '更新失敗' });
    }

    console.log(`[saas/complete] chatbot ${req.params.id} → ${status} (chunks: ${safeChunkCount})`);
    return res.json({ success: true });
  } catch (err) {
    console.error('[saas/complete] unexpected error:', err.message);
    return res.status(500).json({ error: '伺服器錯誤' });
  }
});

/* =========================
   multer 錯誤處理
   ========================= */
router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError || err.message === '只接受 PDF 檔案') {
    return res.status(400).json({ error: err.message });
  }
  console.error('[saas] unhandled error:', err);
  return res.status(500).json({ error: '伺服器錯誤' });
});

module.exports = router;
