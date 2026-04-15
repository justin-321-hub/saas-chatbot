// server.js
// SaaS Chatbot 平台後端
// 需求：Node 18+、dotenv、express、cors、multer、@supabase/supabase-js

require('dotenv').config();
const express    = require('express');
const path       = require('path');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const saasRoutes = require('./saas-routes');

const app = express();

// Render / 反向代理環境必須設定，Rate Limiting 才能正確識別真實客戶端 IP
app.set('trust proxy', 1);

/* =========================
   安全 Headers（helmet）
   ========================= */
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }  // 允許跨域讀取靜態檔
}));

/* =========================
   Rate Limiting
   ========================= */
// 一般 API：每 IP 每 15 分鐘最多 100 次
app.use('/api/saas', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '請求過於頻繁，請稍後再試' }
}));

// 對話端點：每 IP 每分鐘最多 20 次（防止刷 LLM 費用）
app.use('/api/saas/chatbots/:id/chat', rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '對話請求過於頻繁，請稍後再試' }
}));

/* =========================
   CORS
   ========================= */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

if (!allowedOrigins.length) {
  console.warn('[server] 警告：ALLOWED_ORIGINS 未設定，CORS 將拒絕所有跨域請求');
}

const corsOptions = {
  // 未設定時鎖死（回傳 false 代表拒絕），不預設開放 *
  origin: allowedOrigins.length ? allowedOrigins : false,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Callback-Secret'],
  maxAge: 86400
};

// preflight 必須使用相同的 corsOptions，否則 app.options('*', cors()) 會允許所有來源
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));

/* =========================
   通用中介層
   ========================= */
app.use(express.json({ limit: '1mb' }));
// 靜態前端檔案：開發與 Render 部署時皆位於 ../web/
app.use(express.static(path.join(__dirname, '..', 'web')));

/* =========================
   健康檢查
   ========================= */
app.get('/health', (_req, res) => res.status(200).send('ok'));

/* =========================
   SaaS API 路由
   掛載於 /api/saas
   包含：
     POST   /api/saas/chatbots              建立 chatbot
     GET    /api/saas/chatbots              列出用戶的 chatbots
     GET    /api/saas/chatbots/:id/status   查詢處理狀態
     POST   /api/saas/chatbots/:id/chat     對話
     DELETE /api/saas/chatbots/:id          刪除 chatbot
     POST   /api/saas/chatbots/:id/complete n8n 處理完成回呼
   ========================= */
app.use('/api/saas', saasRoutes);

/* =========================
   啟動服務
   ========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SaaS Server running: http://localhost:${PORT}`);
});
