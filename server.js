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

// --- レート変動ロジック (ここを試合終了時に呼ぶ) ---
async function updatePlayerResult(username, isWin, resultType) {
  const user = await User.findOne({ username });
  if (!user || username === 'admin') return;

  let change = 0;
  if (isWin) {
    if (resultType === 'goal') change = 200;
    else if (resultType === 'immobilize') change = 150;
    else change = 100;
    user.win += 1;
  } else {
    change = -50;
    user.lose += 1;
  }

  user.rate = Math.max(0, user.rate + change);
  
  // ランク再判定
  if (user.rate >= 2000) user.rank = "VIP";
  else if (user.rate >= 1500) user.rank = "PREMIUM";
  else if (user.rate >= 500) user.rank = "ELITE";
  else user.rank = "NORMAL";

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
