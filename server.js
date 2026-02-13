const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js'); 
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- Supabase 雲端儲存配置 ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- 資料庫連線配置 ---
const connectionString = `postgresql://${process.env.DB_USER}:${process.env.DB_PASSWORD}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_DATABASE}`;

const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

// 啟動測試
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ 資料庫連線失敗:', err.message);
  } else {
    console.log('✅ 成功連接到 Supabase 資料庫');
    release();
  }
});

// --- Multer 圖片上傳設定 (記憶體模式) ---
const storage = multer.memoryStorage(); 
const upload = multer({ storage });

// --- 英文路徑映射表 (將中文店名轉為英文資料夾名) ---
const branchMap = {
  '建工店': 'Jiangong',
  '鼎山店': 'Dingshan',
  '鳳山店': 'Fengshan'
};

// --- API 路由 ---

// 1. 登入
app.post('/api/login', async (req, res) => {
  const { username, password, branch } = req.body;
  try {
    const result = await pool.query(
      'SELECT * FROM public.users WHERE username = $1 AND password = $2',
      [username, password]
    );
    if (result.rows.length > 0) {
      const user = result.rows[0];
      if (user.role === 'admin' || user.branch_name === branch) {
        return res.json({ success: true, user });
      } else {
        return res.status(401).json({ success: false, message: '分店選擇不正確' });
      }
    } else {
      res.status(401).json({ success: false, message: '帳號或密碼錯誤' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "伺服器錯誤" });
  }
});

// 2. 取得使用者列表
app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, role, branch_name, full_name FROM public.users ORDER BY id ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "無法取得使用者列表" });
  }
});

// 3. 新增使用者
app.post('/api/users', async (req, res) => {
  const { username, password, role, branch_name, full_name } = req.body;
  try {
    await pool.query(
      'INSERT INTO public.users (username, password, role, branch_name, full_name) VALUES ($1, $2, $3, $4, $5)',
      [username, password, role, branch_name, full_name]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "新增失敗" });
  }
});

// 4. 取得貨架清單
app.get('/api/shelf', async (req, res) => {
  const { branch } = req.query;
  try {
    const result = await pool.query(
      'SELECT * FROM public.shelf WHERE branch_name = $1 ORDER BY floor, location',
      [branch]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "無法取得資料" });
  }
});

// 5. 新增或更新貨架資料
app.post('/api/shelf', upload.single('image'), async (req, res) => {
  const { id, floor, location, side, item_list, branch_name } = req.body;
  let image_url = req.body.image_url;

  try {
    if (req.file) {
      if (id && id !== 'undefined' && id !== 'null') {
        const oldData = await pool.query('SELECT image_url FROM public.shelf WHERE id = $1', [id]);
        if (oldData.rows.length > 0) {
          const oldUrl = oldData.rows[0].image_url;
          if (oldUrl && oldUrl.includes('supabase.co')) {
            try {
              const urlParts = oldUrl.split('/storage/v1/object/public/shelf-images/');
              if (urlParts.length > 1) {
                const pathPart = decodeURIComponent(urlParts[1]);
                await supabase.storage.from('shelf-images').remove([pathPart]);
                console.log(`♻️ 舊圖已清理: ${pathPart}`);
              }
            } catch (e) { console.log("刪除舊圖失敗或路徑不存在"); }
          }
        }
      }
      
      const branchCode = branchMap[branch_name] || 'Other';
      const safeFileName = `${Date.now()}-${req.file.originalname.replace(/[^\w.-]/g, '_')}`;
      const filePath = `${branchCode}/floor${floor}/${location}/${safeFileName}`;
      
      console.log(`📡 準備上傳至英文路徑: ${filePath}`);

      const { data, error } = await supabase.storage
        .from('shelf-images')
        .upload(filePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: true
        });

      if (error) throw error;

      const { data: publicData } = supabase.storage.from('shelf-images').getPublicUrl(filePath);
      image_url = publicData.publicUrl;
    }

    if (id && id !== 'undefined' && id !== 'null') {
      await pool.query(
        'UPDATE public.shelf SET floor=$1, location=$2, side=$3, item_list=$4, image_url=$5 WHERE id=$6',
        [floor, location, side, item_list, image_url, id]
      );
      console.log(`✅ 更新資料成功 ID: ${id}`);
    } else {
      await pool.query(
        'INSERT INTO public.shelf (floor, location, side, item_list, image_url, branch_name) VALUES ($1, $2, $3, $4, $5, $6)',
        [floor, location, side, item_list, image_url, branch_name]
      );
      console.log(`✅ 新增資料成功`);
    }
    res.json({ success: true, url: image_url });
  } catch (err) {
    console.error('❌ API 錯誤:', err);
    res.status(500).json({ error: "儲存失敗", message: err.message });
  }
});

// 6. 刪除貨架
app.delete('/api/shelf/:id', async (req, res) => {
  try {
    const findResult = await pool.query('SELECT image_url FROM public.shelf WHERE id = $1', [req.params.id]);
    if (findResult.rows.length > 0) {
      const imageUrl = findResult.rows[0].image_url;
      if (imageUrl && imageUrl.includes('supabase.co')) {
        try {
          const urlParts = imageUrl.split('/storage/v1/object/public/shelf-images/');
          if (urlParts.length > 1) {
            const pathPart = decodeURIComponent(urlParts[1]);
            await supabase.storage.from('shelf-images').remove([pathPart]);
            console.log(`♻️ 實體檔案已刪除: ${pathPart}`);
          }
        } catch (e) {}
      }
    }
    await pool.query('DELETE FROM public.shelf WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "刪除失敗" });
  }
});

// --- 部署環境設定 ---
const PORT = process.env.PORT || 5000;
// 加上 '0.0.0.0' 以確保在雲端平台上能被正確存取
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});