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

// ランク判定用共通関数（タイポによる桁のミスを修正: 2000, 1500, 500 に直しました）
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

// --- ゲームロジックの状態管理 ---
let activeGames = {};
let waitingQueue = [];
let reconnectTimers = {};

app.use(express.static(__dirname));

io.on('connection', (socket) => {
    let currentUsername = null;
    socket.currentRoomId = null; // 各接続ソケットに現在の部屋IDを持たせる

    // アカウント登録
    socket.on('register', async (data) => {
        const { username, password } = data;
        const exists = await User.findOne({ username });
        if (exists) return socket.emit('register_res', { success: false, msg: "使用済み" });
        
        await User.create({ username, password, rate: 100, rank: "NORMAL" });
        socket.emit('register_res', { success: true });
    });

    // ログイン
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

    // 【新規実装】オンライン対戦へのエントリーイベント
    socket.on('join_matchmaking', async () => {
        if (!currentUsername) return;

        // 待機列への重複登録を防ぐ
        const isAlreadyQueued = waitingQueue.some(w => w.username === currentUsername);
        if (isAlreadyQueued) return;

        const user = await User.findOne({ username: currentUsername });
        const rate = user ? user.rate : 100;
        const rank = user ? user.rank : "NORMAL";

        waitingQueue.push({
            id: socket.id,
            username: currentUsername,
            rate: rate,
            rank: rank,
            socket: socket
        });

        socket.emit('matchmaking_started');
    });

    // 【新規実装】対戦中のリアルタイムデータ同期（位置情報やアクションの同期）
    socket.on('game_packet', (data) => {
        if (socket.currentRoomId) {
            // 同じ部屋の対戦相手にデータをそのまま横流し（転送）する
            socket.to(socket.currentRoomId).emit('game_packet_render', data);
        }
    });

    // 【新規実装】クライアント側から試合終了の合図を受け取った時の処理
    socket.on('game_end', async (data) => {
        if (!socket.currentRoomId) return;
        const game = activeGames[socket.currentRoomId];
        if (!game) return;

        const { winner, resultType } = data; // winnerには勝った方のusernameが入る

        // 両者の勝敗に応じてDBのレートを変動させる
        if (game.p1 === winner) {
            await updatePlayerResult(game.p1, true, resultType);
            await updatePlayerResult(game.p2, false, resultType);
        } else if (game.p2 === winner) {
            await updatePlayerResult(game.p2, true, resultType);
            await updatePlayerResult(game.p1, false, resultType);
        }

        // 変動後の最新データを取得してクライアントに返す
        const p1User = await User.findOne({ username: game.p1 });
        const p2User = await User.findOne({ username: game.p2 });

        io.to(socket.currentRoomId).emit('game_finished', {
            winner,
            p1: game.p1,
            p1Rate: p1User ? p1User.rate : 100,
            p1Rank: p1User ? p1User.rank : "NORMAL",
            p2: game.p2,
            p2Rate: p2User ? p2User.rate : 100,
            p2Rank: p2User ? p2User.rank : "NORMAL"
        });

        // 部屋データの削除と部屋IDのリセット
        delete activeGames[socket.currentRoomId];
        socket.currentRoomId = null;
    });

    // 切断時のペナルティ処理
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

                // もし対戦中に切断して5分戻らなかった場合、残された相手を不戦勝にする処理
                if (socket.currentRoomId && activeGames[socket.currentRoomId]) {
                    const game = activeGames[socket.currentRoomId];
                    const opponent = (game.p1 === currentUsername) ? game.p2 : game.p1;
                    await updatePlayerResult(opponent, true, 'disconnect_win');
                    io.to(socket.currentRoomId).emit('opponent_forfeited', { winner: opponent });
                    delete activeGames[socket.currentRoomId];
                }

                delete reconnectTimers[currentUsername];
            }, 5 * 60 * 1000);
        }
    });
});

// 【新規実装】マッチングロジックの完全な中身
setInterval(async () => {
    if (waitingQueue.length < 2) return;

    // 待機列の先頭から2人を取り出す
    let p1 = waitingQueue.shift();
    let p2 = waitingQueue.shift();

    let roomId = `room_${p1.username}_${p2.username}_${Date.now()}`;
    
    p1.socket.join(roomId);
    p2.socket.join(roomId);

    // それぞれのソケット変数に部屋IDを記憶させる
    p1.socket.currentRoomId = roomId;
    p2.socket.currentRoomId = roomId;

    activeGames[roomId] = {
        p1: p1.username,
        p2: p2.username
    };

    // クライアント側に対戦相手が見つかったことを通知する（画面遷移のトリガー）
    io.to(roomId).emit('match_found', {
        roomId: roomId,
        p1: { username: p1.username, rate: p1.rate, rank: p1.rank },
        p2: { username: p2.username, rate: p2.rate, rank: p2.rank }
    });
}, 1000);

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
