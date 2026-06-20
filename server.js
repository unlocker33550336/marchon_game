const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

// --- MongoDB接続とスキーマ定義 ---
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('DB connection error:', err));

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  rate: { type: Number, default: 100 },
  rank: { type: String, default: "NORMAL" },
  win: { type: Number, default: 0 },
  lose: { type: Number, default: 0 },
  lastPlayedWith: String,
  lastPlayedTime: Number
});

const User = mongoose.model('User', userSchema);

// ランク判定用共通関数
function getRank(rate) {
  if (rate >= 20000) return "VIP";
  else if (rate >= 15000) return "PREMIUM";
  else if (rate >= 5000) return "ELITE";
  else return "NORMAL";
}

// 負けた時のペナルティ計算（君のノートのオリジナル設計）
function getLosePenalty(rank) {
  if (rank === "VIP") return 250;
  if (rank === "PREMIUM") return 180;
  if (rank === "ELITE") return 100;
  return 30; // NORMAL
}

// --- レート変動ロジック (ここを試合終了時に呼ぶ) ---
async function updatePlayerResult(username, isWin, resultType) {
  const user = await User.findOne({ username });
  if (!user || username === 'admin') return;

  if (isWin) {
    let change = 0;
    if (resultType === 'goal') change = 300;
    else if (resultType === 'immobilize') change = 150;
    else change = 50;
    
    user.win += 1;
    user.rate = user.rate + change;
  } else {
    // 君の設計したランク別ペナルティ関数をここで正確に適用
    let penalty = getLosePenalty(user.rank);
    
    user.lose += 1;
    user.rate = Math.max(0, user.rate - penalty);
  }

  // ランク再判定
  user.rank = getRank(user.rate);

  await user.save();
}

// --- 以下、元のゲームロジック ---
let activeGames = {};
let waitingQueue = [];
let reconnectTimers = {};

app.use(express.static(__dirname));

io.on('connection', (socket) => {
    let currentUsername = null;

    socket.on('register', async (data) => {
        const { username, password } = data;
        const exists = await User.findOne({ username });
        if (exists) return socket.emit('register_res', { success: false, msg: "使用済み" });
        
        await User.create({ username, password, rate: 100, rank: "NORMAL" });
        socket.emit('register_res', { success: true });
    });

    socket.on('login', async (data) => {
        const { username, password } = data;
        const user = await User.findOne({ username, password });
        if (user) {
            currentUsername = username;
            socket.emit('login_res', { success: true, username, rate: user.rate, rank: user.rank });
        } else {
            socket.emit('login_res', { success: false });
        }
    });

    // ※切断時のペナルティ処理など、他も同様に User.findOne 経由で更新する
    socket.on('disconnect', () => {
        waitingQueue = waitingQueue.filter(w => w.id !== socket.id);
        if (currentUsername) {
            reconnectTimers[currentUsername] = setTimeout(async () => {
                const user = await User.findOne({ username: currentUsername });
                if (user && currentUsername !== 'admin') {
                    user.rate = Math.max(0, user.rate - 200);
                    user.lose += 1;
                    user.rank = getRank(user.rate); // ランクの再判定を同期
                    await user.save();
                }
                delete reconnectTimers[currentUsername];
            }, 5 * 60 * 1000);
        }
    });

    // ... その他のSocket処理も同様に async/await を使用してDB操作を行う
});

setInterval(async () => {
    if (waitingQueue.length < 2) return;
    // (マッチングロジック内でも User を findOne して最新レートを参照する)
}, 1000);

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
