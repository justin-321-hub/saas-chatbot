# SaaS Chatbot Platform

上傳活動 PDF，自動生成專屬 Chatbot。
使用者只需登入、上傳 PDF，系統即全自動完成向量化建索引，並提供可對外分享的對話頁面。

---

## 目錄

- [系統架構](#系統架構)
- [技術堆疊](#技術堆疊)
- [專案結構](#專案結構)
- [本機開發](#本機開發)
- [環境變數說明](#環境變數說明)
- [部署（Render）](#部署render)
- [n8n Workflow 設定](#n8n-workflow-設定)
- [API 文件](#api-文件)
- [安全性設計](#安全性設計)

---

## 系統架構

```
使用者瀏覽器
    │
    ├─ 登入 / 管理後台 / Chatbot 頁面（靜態 HTML，由 Express 提供）
    │
    ▼
Express 後端（Render）
    │
    ├─ Supabase Auth    ← JWT 驗證
    ├─ Supabase DB      ← 儲存 Chatbot 清單、對話記錄
    ├─ Supabase Storage ← 儲存上傳的 PDF
    │
    └─ n8n（Render）
           ├─ PDF Processing Webhook
           │    PDF 下載 → 文字擷取 → 分塊 → Embedding → Pinecone
           │    完成後回呼 /complete 更新狀態
           │
           └─ Chat Query Webhook
                Query Embedding → Pinecone 相似搜尋 → LLM 回答
```

---

## 技術堆疊

| 層級 | 技術 |
|------|------|
| 後端 | Node.js 18+、Express 4、express-rate-limit、helmet、multer |
| 資料庫 | Supabase（PostgreSQL + Row Level Security） |
| 檔案儲存 | Supabase Storage（saas-pdfs bucket） |
| 向量資料庫 | Pinecone（每個 Chatbot 獨立 namespace） |
| AI 模型 | OpenAI text-embedding-3-small（向量化）、GPT-4o-mini（對話） |
| 自動化流程 | n8n（PDF 處理管線 + Chat 查詢管線） |
| 部署 | Render（後端 Web Service） |
| 前端 | 原生 HTML / CSS / JavaScript、Supabase JS SDK |

---

## 專案結構

```
SaaS/
├── render.yaml                    # Render 部署設定
├── .gitignore
├── README.md
│
├── server/                        # Express 後端
│   ├── server.js                  # 主程式（helmet、CORS、rate limit、靜態服務）
│   ├── saas-routes.js             # 所有 API 路由
│   ├── package.json
│   ├── .env                       # 本機環境變數（不 commit）
│   └── .env.example               # 環境變數範本
│
├── web/                           # 前端靜態頁面（由 Express 提供）
│   ├── config.js                  # Supabase 設定（API_BASE 自動偵測 origin）
│   ├── index.html                 # 登入 / 註冊
│   ├── dashboard.html             # 管理後台（上傳 PDF、管理 Chatbot）
│   └── chat.html                  # 公開 Chatbot 對話頁面
│
└── n8n/                           # n8n Workflow JSON（可直接匯入）
    ├── workflow_pdf_processing.json   # PDF 處理管線
    └── workflow_chat.json             # Chat 查詢管線
```

---

## 本機開發

### 前置需求

- Node.js 18 以上
- Supabase 帳號與專案（已建立三張資料表及 Storage bucket）
- n8n 執行中（本機或雲端）
- Pinecone 帳號與 Index（dimension: 1536，metric: cosine）
- OpenAI API Key

### 安裝與啟動

```bash
# 1. 複製專案
git clone https://github.com/justin-321-hub/saas-chatbot.git
cd saas-chatbot

# 2. 安裝後端相依套件
cd server
npm install

# 3. 建立 .env（參考 .env.example 填入所有值）
cp .env.example .env

# 4. 啟動後端（含 hot reload）
npm run dev
```

瀏覽器開啟 `http://localhost:3000` 即可看到登入頁面。

### Supabase 資料表

在 Supabase SQL Editor 執行以下 DDL：

```sql
-- Chatbot 清單
CREATE TABLE saas_chatbots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text,
  namespace    text NOT NULL,
  pdf_url      text,
  pdf_filename text,
  status       text NOT NULL DEFAULT 'processing',
  chunk_count  integer DEFAULT 0,
  error_msg    text,
  settings     jsonb DEFAULT '{}',
  created_at   timestamptz DEFAULT now()
);
ALTER TABLE saas_chatbots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner only" ON saas_chatbots
  USING (auth.uid() = user_id);

-- 對話記錄
CREATE TABLE saas_chat_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chatbot_id  uuid NOT NULL REFERENCES saas_chatbots(id) ON DELETE CASCADE,
  session_id  uuid NOT NULL,
  role        text NOT NULL CHECK (role IN ('user', 'assistant')),
  content     text NOT NULL,
  created_at  timestamptz DEFAULT now()
);
ALTER TABLE saas_chat_messages ENABLE ROW LEVEL SECURITY;

-- 使用量記錄（選用）
CREATE TABLE saas_usage_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES auth.users(id),
  chatbot_id  uuid REFERENCES saas_chatbots(id),
  action      text,
  created_at  timestamptz DEFAULT now()
);
ALTER TABLE saas_usage_logs ENABLE ROW LEVEL SECURITY;
```

Storage bucket：`saas-pdfs`（Private，路徑格式：`{user_id}/{chatbot_id}.pdf`）

---

## 環境變數說明

檔案位置：`server/.env`（本機）或 Render Dashboard → Environment（雲端）

```env
# Supabase
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...

# n8n Webhooks
N8N_SAAS_WEBHOOK_URL=https://your-n8n.onrender.com/webhook/PDF_processing
N8N_SAAS_CHAT_WEBHOOK_URL=https://your-n8n.onrender.com/webhook/Chat_test

# 回呼安全金鑰（n8n 呼叫 /complete 時需附上，自行設定任意強密碼）
SAAS_CALLBACK_SECRET=your-strong-secret-here

# CORS 允許的前端來源（Render 部署後填入實際 URL）
ALLOWED_ORIGINS=https://saas-chatbot-server.onrender.com

# 伺服器 Port（Render 自動注入，本機保持 3000）
PORT=3000
```

---

## 部署（Render）

### 1. 連結 GitHub

Render Dashboard → **New + → Web Service → Connect Repository**

選擇 `justin-321-hub/saas-chatbot`

### 2. 服務設定

| 欄位 | 值 |
|------|-----|
| Root Directory | `server` |
| Build Command | `npm install` |
| Start Command | `node server.js` |
| Node Version | `20` |
| Instance Type | Starter 以上（Free 會休眠） |

### 3. 環境變數

Render → **Environment** → 逐一填入上方所有環境變數。
`ALLOWED_ORIGINS` 填入 Render 給你的 URL（如 `https://saas-chatbot-server.onrender.com`）。

### 4. 部署

按下 **Deploy** 即自動完成。之後每次 `git push`，Render 會自動重新部署。

---

## n8n Workflow 設定

`n8n/` 資料夾內有兩個可直接匯入的 workflow JSON。

### 匯入方式

n8n → 右上角選單 → **Import from file** → 分別匯入兩個 JSON。

### 必填的 n8n Variables

在 n8n → **Settings → Variables** 新增：

| Variable | 說明 |
|----------|------|
| `SAAS_BACKEND_URL` | Render 後端 URL，如 `https://saas-chatbot-server.onrender.com` |
| `SAAS_CALLBACK_SECRET` | 與 `.env` 中 `SAAS_CALLBACK_SECRET` 相同 |
| `PINECONE_HOST` | Pinecone Index 的 Host，如 `xxx.svc.us-east-1.pinecone.io` |

### Credential 設定

| Credential 名稱 | 類型 | 說明 |
|-----------------|------|------|
| `OpenAI API` | OpenAI API | 填入 OpenAI API Key |
| `Pinecone API Key` | HTTP Header Auth | Header Name: `Api-Key`，Value: Pinecone API Key |

### Workflow 說明

**PDF Processing**（`webhook/PDF_processing`）
1. 接收後端傳來的 `pdf_url`、`chatbot_id`、`namespace`
2. 下載 PDF → 擷取文字 → 分塊（約 500 字/塊，50 字重疊）
3. 呼叫 OpenAI `text-embedding-3-small` 產生 embedding
4. 寫入 Pinecone（以 `namespace = chatbot_id` 隔離各 Chatbot 資料）
5. 呼叫後端 `/complete` 回呼，更新狀態為 `ready`

**Chat Query**（`webhook/Chat_test`）
1. 接收 `message`、`chatbot_id`、`namespace`、`session_id`
2. 對 message 產生 embedding
3. 查詢 Pinecone 取得最相關的 5 個段落（score > 0.5）
4. 組合 System Prompt + 相關段落，呼叫 GPT-4o-mini
5. 回傳 `{ "text": "..." }` 給後端

---

## API 文件

所有 API 路徑前綴：`/api/saas`

### 認證端點

| 方法 | 路徑 | 說明 | 認證 |
|------|------|------|------|
| `POST` | `/chatbots` | 上傳 PDF，建立 Chatbot | JWT Bearer |
| `GET` | `/chatbots` | 列出自己的所有 Chatbot | JWT Bearer |
| `DELETE` | `/chatbots/:id` | 刪除指定 Chatbot | JWT Bearer |

### 公開端點

| 方法 | 路徑 | 說明 | 認證 |
|------|------|------|------|
| `GET` | `/chatbots/:id/status` | 查詢 Chatbot 狀態 | 無 |
| `POST` | `/chatbots/:id/chat` | 發送訊息、取得回覆 | 無 |

### 系統端點

| 方法 | 路徑 | 說明 | 認證 |
|------|------|------|------|
| `POST` | `/chatbots/:id/complete` | n8n 處理完成回呼 | `X-Callback-Secret` header |
| `GET` | `/health` | 健康檢查 | 無 |

### POST `/chatbots` — 建立 Chatbot

Request（multipart/form-data）：

| 欄位 | 類型 | 必填 | 說明 |
|------|------|------|------|
| `name` | string | ✅ | 活動名稱，最長 100 字元 |
| `description` | string | — | 活動簡介，最長 300 字元 |
| `pdf` | file | ✅ | PDF 檔案，最大 50 MB |

Response `201`：
```json
{ "chatbot_id": "uuid" }
```

### POST `/chatbots/:id/chat` — 對話

Request（JSON）：

| 欄位 | 類型 | 必填 | 說明 |
|------|------|------|------|
| `message` | string | ✅ | 使用者訊息，最長 2000 字元 |
| `session_id` | string | ✅ | UUID v4 格式的 session 識別碼 |

Response `200`：
```json
{ "text": "AI 回覆內容" }
```

---

## 安全性設計

| 類別 | 實作 |
|------|------|
| **認證** | Supabase JWT，`requireAuth` middleware 驗證每個需要登入的請求 |
| **授權** | service_role 操作時手動附加 `user_id` 過濾，不依賴 RLS（service_role 繞過 RLS） |
| **輸入驗證** | UUID 格式正則、字串型別檢查、長度限制、`name.trim()` 空值防護 |
| **PDF 驗證** | MIME type 過濾（multer）+ 魔術位元組驗證（`%PDF-` 前 5 bytes） |
| **檔名安全** | `sanitizeFilename()` 移除路徑分隔符、null byte、`../` 序列 |
| **CORS** | 僅允許 `ALLOWED_ORIGINS` 白名單，preflight 與正式請求使用相同設定 |
| **Rate Limiting** | 所有 `/api/saas`：100 次/15 分鐘；`/chat`：額外 20 次/分鐘 |
| **安全 Headers** | helmet（X-Frame-Options、CSP 等） |
| **計時攻擊** | callback secret 驗證使用 `crypto.timingSafeEqual()` |
| **XSS 防護** | 前端全面使用 `textContent`、DOM API；`escapeHtml()` 處理訊息文字 |
| **CSS Injection** | `safeCssColor()` 僅允許 hex 格式色碼 |
| **供應鏈** | CDN 腳本固定版本號（supabase-js@2.49.4）+ SRI sha384 hash |
| **資料洩漏** | 錯誤訊息使用映射表，不回傳原始 error.message；`error_msg` 不在公開端點回傳 |
| **逾時保護** | n8n /chat fetch：30 秒；PDF trigger fetch：60 秒（AbortController） |
| **資料庫炸彈** | n8n 回覆 `replyText` 強制轉字串並限制 10,000 字元 |
| **環境變數** | `.env` 在 `.gitignore`，不進入版本控制 |

---

## 版本記錄

| 日期 | 說明 |
|------|------|
| 2026-04-14 | 架構設計、Supabase 資料表建立 |
| 2026-04-14 | 後端 API 完成（server.js + saas-routes.js） |
| 2026-04-14 | 前端頁面完成（index.html、dashboard.html、chat.html） |
| 2026-04-14～17 | 六輪安全性審查與修正（共修正 21 個安全性問題） |
| 2026-04-17 | Render 部署設定（render.yaml）、n8n workflow JSON 輸出 |
