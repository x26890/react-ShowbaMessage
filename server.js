const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js'); 
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// --- Supabase 雲端配置 (包含資料庫與儲存) ---
const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const supabaseKey = (process.env.SUPABASE_KEY || '').trim();
const supabase = createClient(supabaseUrl, supabaseKey);

// --- Multer 圖片上傳設定 (記憶體模式) ---
const storage = multer.memoryStorage(); 
const upload = multer({ storage });

// --- 英文路徑映射表 ---
const branchMap = {
  '建工店': 'Jiangong',
  '鳥松店': 'Niaosong' // 補上你之前提到的鳥松店
};

// --- API 路由 ---

// 1. 登入
app.post('/api/login', async (req, res) => {
  const { username, password, branch } = req.body;
  try {
    const { data: users, error } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .eq('password', password);

    if (error) throw error;

    if (users && users.length > 0) {
      const user = users[0];
      if (user.role === 'admin' || user.branch_name === branch) {
        return res.json({ success: true, user });
      } else {
        return res.status(401).json({ success: false, message: '分店選擇不正確' });
      }
    } else {
      res.status(401).json({ success: false, message: '帳號或密碼錯誤' });
    }
  } catch (err) {
    console.error('Login Error:', err.message);
    res.status(500).json({ error: "伺服器錯誤" });
  }
});

// 2. 取得使用者列表
app.get('/api/users', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, username, role, branch_name, full_name')
      .order('id', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Get Users Error:', err.message);
    res.status(500).json({ error: "無法取得使用者列表" });
  }
});

// 3. 新增使用者
app.post('/api/users', async (req, res) => {
  const { username, password, role, branch_name, full_name } = req.body;
  try {
    const { error } = await supabase
      .from('users')
      .insert([{ username, password, role, branch_name, full_name }]);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('Insert User Error:', err.message);
    res.status(500).json({ error: "新增失敗" });
  }
});

// 4. 取得貨架清單
app.get('/api/shelf', async (req, res) => {
  const { branch } = req.query;
  try {
    const { data, error } = await supabase
      .from('shelf')
      .select('*')
      .eq('branch_name', branch)
      .order('floor', { ascending: true })
      .order('location', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('Get Shelf Error:', err.message);
    res.status(500).json({ error: "無法取得資料" });
  }
});

// 5. 新增或更新貨架資料 (優化：支援圖片刪除邏輯)
app.post('/api/shelf', upload.single('image'), async (req, res) => {
  const { id, floor, location, side, item_list, branch_name, imageDeleted } = req.body;
  let image_url = req.body.image_url;

  try {
    // A. 抓取舊資料確認原本是否有圖片
    let existingImageUrl = null;
    if (id && id !== 'undefined' && id !== 'null') {
      const { data: oldData } = await supabase.from('shelf').select('image_url').eq('id', id).single();
      if (oldData) existingImageUrl = oldData.image_url;
    }

    // B. 圖片處理邏輯
    if (req.file) {
      // 情況 1：上傳新圖，先準備清理舊圖
      const branchCode = branchMap[branch_name] || 'Other';
      const safeFileName = `${Date.now()}-${req.file.originalname.replace(/[^\w.-]/g, '_')}`;
      const filePath = `${branchCode}/floor${floor}/${location}/${safeFileName}`;
      
      const { error: uploadError } = await supabase.storage
        .from('shelf-images')
        .upload(filePath, req.file.buffer, { contentType: req.file.mimetype, upsert: true });

      if (uploadError) throw uploadError;

      const { data: publicData } = supabase.storage.from('shelf-images').getPublicUrl(filePath);
      image_url = publicData.publicUrl;
    } else if (imageDeleted === 'true') {
      // 情況 2：前端標記刪除圖片 (按了 ✕)
      image_url = null;
    } else {
      // 情況 3：沒動圖片，沿用原本的 URL
      image_url = existingImageUrl;
    }

    // C. 如果圖片發生變動（換新圖或刪除），清理雲端 Storage 舊實體檔案
    if ((req.file || imageDeleted === 'true') && existingImageUrl && existingImageUrl.includes('supabase.co')) {
      try {
        const urlParts = existingImageUrl.split('/storage/v1/object/public/shelf-images/');
        if (urlParts.length > 1) {
          const pathPart = decodeURIComponent(urlParts[1]);
          await supabase.storage.from('shelf-images').remove([pathPart]);
          console.log(`♻️ 舊實體檔案已清理: ${pathPart}`);
        }
      } catch (e) { console.log("清理舊圖失敗 (不影響存檔)"); }
    }

    // D. 更新或新增資料庫
    if (id && id !== 'undefined' && id !== 'null') {
      const { error } = await supabase
        .from('shelf')
        .update({ floor, location, side, item_list, image_url })
        .eq('id', id);
      if (error) throw error;
      console.log(`✅ 更新資料成功 ID: ${id}`);
    } else {
      const { error } = await supabase
        .from('shelf')
        .insert([{ floor, location, side, item_list, image_url, branch_name }]);
      if (error) throw error;
      console.log(`✅ 新增資料成功`);
    }
    res.json({ success: true, url: image_url });
  } catch (err) {
    console.error('❌ API 錯誤:', err.message);
    res.status(500).json({ error: "儲存失敗", message: err.message });
  }
});

// 6. 刪除貨架
app.delete('/api/shelf/:id', async (req, res) => {
  try {
    const { data: findResult } = await supabase
      .from('shelf')
      .select('image_url')
      .eq('id', req.params.id)
      .single();

    if (findResult && findResult.image_url && findResult.image_url.includes('supabase.co')) {
      try {
        const urlParts = findResult.image_url.split('/storage/v1/object/public/shelf-images/');
        if (urlParts.length > 1) {
          const pathPart = decodeURIComponent(urlParts[1]);
          await supabase.storage.from('shelf-images').remove([pathPart]);
          console.log(`♻️ 實體檔案已刪除: ${pathPart}`);
        }
      } catch (e) {}
    }

    const { error } = await supabase.from('shelf').delete().eq('id', req.params.id);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error('Delete Error:', err.message);
    res.status(500).json({ error: "刪除失敗" });
  }
});

// --- 部署環境設定 ---
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});