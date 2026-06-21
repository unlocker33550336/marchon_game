const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

// ==========================================
// 1. データベース（MongoDB）接続と共通スキーマ
// ==========================================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Platform Hub DB connected successfully'))
  .catch(err => console.error('Platform Hub DB connection error:', err));

// すべてのゲームで一元化して共有される、唯一無二のユーザーデータ設計図
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  rate: { type: Number, default: 100 }, // 初期レートは確実に「100」からスタート
  rank: { type: String, default: "NORMAL" },
  win: { type: Number, default: 0 },
  lose: { type: Number, default: 0 },
  lastPlayedWith: { type: String, default: "" },
  lastPlayedTime: { type: Number, default: 0 }
});

const User = mongoose.model('User', userSchema);

// 🌐 ネットの瞬きや再接続によるパケット迷子を完全に防ぐ不変のセッションマップ
let userSocketMap = {}; // username -> 最新のsocket.id
let socketUserMap = {}; // socket.id -> username

// ゲームごとの待機列を格納する多重配列オブジェクト (例: { marathon: [], othello: [] })
let gameQueues = {};

// サイト内で現在進行しているすべての対戦部屋データ
let activeGames = {};

// プレイヤーの安否を待つ切断復帰タイマー
let reconnectTimers = {};

// ==========================================
// 2. 共通レート計算システム ＆ ランク判定
// ==========================================

// 共通ランク再判定ロジック
function getRank(rate) {
  if (rate >= 2000) return "VIP";
  else if (rate >= 1500) return "PREMIUM";
  else if (rate >= 500) return "ELITE";
  else return "NORMAL";
}

// 君のノートのオリジナル設計：ランク帯が上がるほど負けた時のペナルティが激重になる数式
function getLosePenalty(rank) {
  if (rank === "VIP") return 250;
  if (rank === "PREMIUM") return 180;
  if (rank === "ELITE") return 100;
  return 30; // NORMAL帯の敗北は軽めの30
}

// 共通レート更新の受付窓口（どのゲームの決着でもここを通す）
async function processPlatformRate(username, isWin, resultType) {
  const user = await User.findOne({ username });
  if (!user || username === 'admin') return { rateChange: 0, currentRate: 100, currentRank: "NORMAL" };

  let oldRate = user.rate;

  if (isWin) {
    let change = 0;
    // ゲームの勝ち方ボーナス種別、あるいはデフォルトの加算判定
    if (resultType === 'goal') change = 300;
    else if (resultType === 'immobilize') change = 150;
    else change = 50; // 通常の勝利や軽いミニゲームの基本値
    
    user.win += 1;
    user.rate = user.rate + change;
  } else {
    // 敗北時は現在のランクに応じたオリジナルペナルティを厳格に適用
    let penalty = getLosePenalty(user.rank);
    user.lose += 1;
    user.rate = Math.max(0, user.rate - penalty);
  }

  user.rank = getRank(user.rate);
  await user.save();

  return {
    rateChange: Math.abs(user.rate - oldRate),
    currentRate: user.rate,
    currentRank: user.rank
  };
}

app.use(express.static(__dirname));

// ==========================================
// 3. Socket.io 通信ハブゲート（受け皿）
// ==========================================
io.on('connection', (socket) => {

    // 【認証システム】新規アカウント登録
    socket.on('register', async (data) => {
        const { username, password } = data;
        if (!username || !password) {
            return socket.emit('register_res', { success: false, msg: "識別名とパスワードを入力してください" });
        }
        try {
            const exists = await User.findOne({ username });
            if (exists) return socket.emit('register_res', { success: false, msg: "その識別名は既に使用されています" });
            
            await User.create({ username, password, rate: 100, rank: "NORMAL", win: 0, lose: 0 });
            socket.emit('register_res', { success: true, msg: "中央システムへの走者登録が完了しました！" });
        } catch (err) {
            socket.emit('register_res', { success: false, msg: "サーバーエラー" });
        }
    });

    // 【認証システム】ログイン ＆ 【ロビーポータル画面情報返却】
    socket.on('login', async (data) => {
        const { username, password, token } = data;
        try {
            const user = await User.findOne({ username });
            if (user) {
                if ((token && user.password === token) || (password && user.password === password)) {
                    // 回線セッションの古いゴミデータを上書き修復
                    userSocketMap[username] = socket.id;
                    socketUserMap[socket.id] = username;
                    
                    // 認証成功と同時に、共通ロビー画面に必要な最新ステータスをすべてまとめて叩き返す
                    return socket.emit('login_res', { 
                        success: true, 
                        username, 
                        rate: user.rate, 
                        rank: user.rank,
                        win: user.win,
                        lose: user.lose
                    });
                }
            }
            socket.emit('login_res', { success: false, msg: "走者識別名またはパスワードが不正です" });
        } catch (err) {
            socket.emit('login_res', { success: false, msg: "サーバー接続エラー" });
        }
    });

    // 【認証システム】ゲストモード入場
    socket.on('login_guest', () => {
        let guestName = "Guest_" + Math.floor(1000 + Math.random() * 9000);
        userSocketMap[guestName] = socket.id;
        socketUserMap[socket.id] = guestName;
        socket.emit('login_res', { success: true, username: guestName, rate: "----", rank: "GUEST", isGuest: true });
    });

    // 【汎用マッチングシステム】エントリー窓口
    socket.on('join_matchmaking', async (data) => {
        const username = socketUserMap[socket.id];
        if (!username) return socket.emit('matchmaking_error', { msg: "セッションが切断されています。再ログインしてください" });

        const { gameId } = data; // 画面側から「どのゲームの列に並びたいか」を文字列でもらう (例: 'marathon', 'cards')
        if (!gameId) return socket.emit('matchmaking_error', { msg: "対象のゲーム種別IDが不明です" });

        if (!gameQueues[gameId]) { gameQueues[gameId] = []; }

        // 多重エントリー（他のゲームの列との重複並び）を完全にブロックする
        let isAlreadyQueued = false;
        for (let gId in gameQueues) {
            if (gameQueues[gId].some(w => w.username === username)) { isAlreadyQueued = true; break; }
        }
        if (isAlreadyQueued) return socket.emit('matchmaking_error', { msg: "既にいずれかのゲームでマッチング探索中です" });

        let userRate = 100;
        let userRank = "NORMAL";

        const user = await User.findOne({ username });
        if (user) { userRate = user.rate; userRank = user.rank; }

        // 各ゲーム個別のカゴ（キュー）へ選別して整列させる
        gameQueues[gameId].push({
            id: socket.id,
            username: username,
            rate: userRate,
            rank: userRank,
            socket: socket
        });

        socket.emit('matchmaking_started', { gameId });
    });

    // 【汎用マッチングシステム】キャンセル窓口
    socket.on('leave_matchmaking', () => {
        for (let gameId in gameQueues) {
            gameQueues[gameId] = gameQueues[gameId].filter(w => w.id !== socket.id);
        }
        socket.emit('matchmaking_stopped');
    });

    // 【ゲーム間完全分離型・中継転送窓口】
    // どんなゲームを追加しても、対戦中のアクションやパケットはすべてこのイベントを中継して相手に横流しされる
    socket.on('game_packet', (data) => {
        const username = socketUserMap[socket.id];
        if (!username) return;

        let roomId = null;
        for (let rId in activeGames) {
            if (activeGames[rId].p1 === username || activeGames[rId].p2 === username) { roomId = rId; break; }
        }
        
        if (roomId) {
            // 同じ部屋にいる対戦相手の画面だけにデータを転送
            socket.to(roomId).emit('game_packet_receive', data);
        }
    });

    // 💬 プラットフォーム共通：チャット転送窓口
    socket.on('send_chat', (msg) => {
        let roomId = null;
        const username = socketUserMap[socket.id];
        if (!username) return;

        for (let rId in activeGames) {
            if (activeGames[rId].p1 === username || activeGames[rId].p2 === username) { roomId = rId; break; }
        }
        if (roomId) {
            io.to(roomId).emit('receive_chat', msg);
        }
    });

    // 【共通レート更新受付イベント窓口】
    // 各ゲームモジュールが終了を検知した瞬間に、この窓口を呼び出して共通レートを書き換える
    socket.on('submit_game_end', async (data) => {
        const username = socketUserMap[socket.id];
        if (!username) return;

        let roomId = null;
        for (let rId in activeGames) {
            if (activeGames[rId].p1 === username || activeGames[rId].p2 === username) { roomId = rId; break; }
        }
        if (!roomId) return;
        const game = activeGames[roomId];

        // 2人の画面から同時にリクエストが届いても、二重計算が起きないようにガッチリ防壁ロック
        if (game.isProcessingResult) return;
        game.isProcessingResult = true;

        const { winnerUsername, resultType } = data;

        let p1Name = game.p1;
        let p2Name = game.p2;
        let p1Result = null;
        let p2Result = null;

        if (winnerUsername === 'DRAW') {
            p1Result = await processPlatformRate(p1Name, false, 'draw');
            p2Result = await processPlatformRate(p2Name, false, 'draw');
        } else if (winnerUsername === p1Name) {
            p1Result = await processPlatformRate(p1Name, true, resultType);
            p2Result = await processPlatformRate(p2Name, false, resultType);
        } else if (winnerUsername === p2Name) {
            p1Result = await processPlatformRate(p1Name, false, resultType);
            p2Result = await processPlatformRate(p2Name, true, resultType);
        }

        let p1SocketId = userSocketMap[p1Name];
        let p2SocketId = userSocketMap[p2Name];

        // 最新の共通レートと変動幅をそれぞれのプレイヤーへダイレクトに配信
        if (p1SocketId) {
            io.to(p1SocketId).emit('platform_game_over', {
                winner: winnerUsername,
                rateChange: (winnerUsername === p1Name) ? p1Result.rateChange : p2Result.rateChange,
                newRate: p1Result.currentRate,
                newRank: p1Result.currentRank
            });
        }
        if (p2SocketId) {
            io.to(p2SocketId).emit('platform_game_over', {
                winner: winnerUsername,
                rateChange: (winnerUsername === p2Name) ? p2Result.rateChange : p1Result.rateChange,
                newRate: p2Result.currentRate,
                newRank: p2Result.currentRank
            });
        }

        delete activeGames[roomId];
    });

    // 回線切断・5分ペナルティ処理
    socket.on('disconnect', () => {
        const username = socketUserMap[socket.id];
        // 全待機キューから抹殺
        for (let gameId in gameQueues) {
            gameQueues[gameId] = gameQueues[gameId].filter(w => w.id !== socket.id);
        }
        delete socketUserMap[socket.id];

        if (username && username !== 'admin' && !username.startsWith('Guest_')) {
            reconnectTimers[username] = setTimeout(async () => {
                const user = await User.findOne({ username });
                if (user) {
                    user.rate = Math.max(0, user.rate - 200); // 共通の切断ペナルティ
                    user.lose += 1;
                    user.rank = getRank(user.rate);
                    await user.save();
                }

                let roomId = null;
                for (let rId in activeGames) {
                    if (activeGames[rId].p1 === username || activeGames[rId].p2 === username) { roomId = rId; break; }
                }

                if (roomId && activeGames[roomId]) {
                    const game = activeGames[roomId];
                    let opponent = (game.p1 === username) ? game.p2 : game.p1;
                    let oppSocketId = userSocketMap[opponent];

                    let oppResult = await processPlatformRate(opponent, true, 'disconnect_win');
                    if (oppSocketId) {
                        io.to(oppSocketId).emit('platform_game_over', {
                            winner: opponent,
                            rateChange: oppResult.rateChange,
                            newRate: oppResult.currentRate,
                            newRank: oppResult.currentRank
                        });
                    }
                    delete activeGames[roomId];
                }
                delete reconnectTimers[username];
            }, 5 * 60 * 1000);
        }
    });
});

// ==========================================
// 4. ゲーム別・独立型汎用マッチングシステムループ
// ==========================================
setInterval(async () => {
    // 待機列が存在するゲーム種別を1つずつ順番に走査
    for (let gameId in gameQueues) {
        let queue = gameQueues[gameId];
        if (queue.length < 2) continue;

        // そのゲームの待機列の先頭から2人を取り出す
        let p1 = queue.shift();
        let p2 = queue.shift();

        let roomId = `room_${gameId}_${p1.username}_${p2.username}_${Date.now()}`;
        
        p1.socket.join(roomId);
        p2.socket.join(roomId);

        activeGames[roomId] = {
            gameId: gameId, // なんのゲームの部屋かを記録
            p1: p1.username,
            p2: p2.username,
            isProcessingResult: false,
            state: {} // 各ゲームが自由に変数を置いていい空枠のステータス領域
        };

        // 最初からお互いの実名・共通レート・共通ランクをフルオープンにしてゲーム起動信号を放つ
        p1.socket.emit('platform_match_found', {
            roomId: roomId,
            gameId: gameId,
            myRole: 1,
            p1: { username: p1.username, rate: p1.rate, rank: p1.rank },
            p2: { username: p2.username, rate: p2.rate, rank: p2.rank }
        });

        p2.socket.emit('platform_match_found', {
            roomId: roomId,
            gameId: gameId,
            myRole: 2,
            p1: { username: p1.username, rate: p1.rate, rank: p1.rank },
            p2: { username: p2.username, rate: p2.rate, rank: p2.rank }
        });
    }
}, 1000);

server.listen(PORT, () => {
    console.log(`Platform Hub Server successfully running on port ${PORT}`);
});