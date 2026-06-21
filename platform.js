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
console.log('[DB CONNECT ATTEMPT] MongoDBへの接続を開始します...');
console.log('-> 接続URIの有無:', process.env.MONGODB_URI ? "設定あり(OK)" : "設定なし(⚠️空っぽです)");

mongoose.connect('mongodb+srv://gaohu1870_db_user:db_9logZ3FdhBWow37K@cluster0.4vbxzmx.mongodb.net/test?appName=Cluster0')
  .then(() => console.log('✅ [DB SUCCESS] Platform Hub DB connected successfully'))
  .catch(err => console.error('❌ [DB CRITICAL ERROR] Platform Hub DB connection error:', err));

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  rate: { type: Number, default: 100 },
  rank: { type: String, default: "NORMAL" },
  win: { type: Number, default: 0 },
  lose: { type: Number, default: 0 },
  lastPlayedWith: { type: String, default: "" },
  lastPlayedTime: { type: Number, default: 0 }
});

const User = mongoose.model('User', userSchema);

let userSocketMap = {}; 
let socketUserMap = {}; 
let gameQueues = {};
let activeGames = {};
let reconnectTimers = {};

// ==========================================
// 2. 共通レート計算システム ＆ ランク判定
// ==========================================
function getRank(rate) {
  if (rate >= 20000) return "VIP";
  else if (rate >= 15000) return "PREMIUM";
  else if (rate >= 5000) return "ELITE";
  else return "NORMAL";
}

function getLosePenalty(rank) {
  if (rank === "VIP") return 250;
  if (rank === "PREMIUM") return 180;
  if (rank === "ELITE") return 100;
  return 30;
}

async function processPlatformRate(username, isWin, resultType) {
  console.log(`[RATE UPDATE] レート計算開始: ${username} | 勝利フラグ: ${isWin} | 終了タイプ: ${resultType}`);
  try {
    const user = await User.findOne({ username });
    if (!user || username === 'admin') return { rateChange: 0, currentRate: 100, currentRank: "NORMAL" };

    let oldRate = user.rate;

    if (isWin) {
      let change = 0;
      if (resultType === 'goal') change = 300;
      else if (resultType === 'immobilize') change = 150;
      else change = 50;
      
      user.win += 1;
      user.rate = user.rate + change;
    } else {
      let penalty = getLosePenalty(user.rank);
      user.lose += 1;
      user.rate = Math.max(0, user.rate - penalty);
    }

    user.rank = getRank(user.rate);
    await user.save();
    console.log(`-> レート計算完了: ${username} [新レート: ${user.rate} pt / 新ランク: ${user.rank}]`);

    return {
      rateChange: Math.abs(user.rate - oldRate),
      currentRate: user.rate,
      currentRank: user.rank
    };
  } catch (err) {
    console.error(`❌ [RATE UPDATE CRASH] ${username} のレート更新中に深刻なエラー:`, err);
    return { rateChange: 0, currentRate: 100, currentRank: "NORMAL" };
  }
}

app.use(express.static(__dirname));

// ==========================================
// 3. Socket.io 通信ハブゲート（受け皿）
// ==========================================
io.on('connection', (socket) => {
    console.log(`[SOCKET CONNECTED] 新しい回線が確立されました (SocketID: ${socket.id})`);

    // 【新規登録】
    socket.on('register', async (data) => {
        console.log('[SIGNAL RECEIVED] register イベントを受信しました:', data);
        const { username, password } = data;
        
        if (!username || !password) {
            console.log('-> [REGISTER REJECTED] ユーザー名またはパスワードが空です');
            return socket.emit('register_res', { success: false, msg: "識別名とパスワードを入力してください" });
        }
        
        try {
            console.log(`-> [DB QUERY] 既存のユーザー [${username}] を検索中...`);
            const exists = await User.findOne({ username });
            if (exists) {
                console.log(`-> [REGISTER REJECTED] ユーザー名 [${username}] は既に使用されています`);
                return socket.emit('register_res', { success: false, msg: "その識別名は既に使用されています" });
            }
            
            console.log(`-> [DB INSERT] 新しいユーザー [${username}] を書き込み中...`);
            await User.create({ username, password, rate: 100, rank: "NORMAL", win: 0, lose: 0 });
            console.log(`✅ [REGISTER SUCCESS] ユーザー [${username}] の作成が完了しました`);
            socket.emit('register_res', { success: true, msg: "中央システムへの走者登録が完了しました！" });
        } catch (err) {
            // ❌ ここがハッキリログに出るようになる！
            console.error('❌ [REGISTER CRASH] 新規登録処理中にエラーが発生しました:', err);
            socket.emit('register_res', { success: false, msg: "サーバーエラー（DB書き込み失敗）" });
        }
    });

    // 【ログイン】
    socket.on('login', async (data) => {
        console.log('[SIGNAL RECEIVED] login イベントを受信しました:', data ? data.username : "データなし");
        const { username, password, token } = data;
        
        try {
            console.log(`-> [DB QUERY] ユーザー [${username}] の認証情報を検索中...`);
            const user = await User.findOne({ username });
            if (user) {
                if ((token && user.password === token) || (password && user.password === password)) {
                    userSocketMap[username] = socket.id;
                    socketUserMap[socket.id] = username;
                    
                    console.log(`✅ [LOGIN SUCCESS] ユーザー [${username}] の認証に成功しました`);
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
            console.log(`-> [LOGIN FAILED] ユーザー [${username}] の認証に失敗しました（パスワード不一致またはユーザーなし）`);
            socket.emit('login_res', { success: false, msg: "走者識別名またはパスワードが不正です" });
        } catch (err) {
            console.error('❌ [LOGIN CRASH] ログイン処理中にエラーが発生しました:', err);
            socket.emit('login_res', { success: false, msg: "サーバー接続エラー" });
        }
    });

    // 【ゲストログイン】
    socket.on('login_guest', () => {
        let guestName = "Guest_" + Math.floor(1000 + Math.random() * 9000);
        userSocketMap[guestName] = socket.id;
        socketUserMap[socket.id] = guestName;
        console.log(`👤 [GUEST ENTER] ゲスト [${guestName}] が入場しました`);
        socket.emit('login_res', { success: true, username: guestName, rate: "----", rank: "GUEST", isGuest: true });
    });

    // 【マッチングエントリー】
    socket.on('join_matchmaking', async (data) => {
        const username = socketUserMap[socket.id];
        if (!username) return socket.emit('matchmaking_error', { msg: "セッションが切断されています。再ログインしてください" });

        const { gameId } = data;
        console.log(`[QUEUE ATTEMPT] ${username} がゲーム [${gameId}] の待機列にエントリーを要求`);

        if (!gameId) return socket.emit('matchmaking_error', { msg: "対象のゲーム種別IDが不明です" });
        if (!gameQueues[gameId]) { gameQueues[gameId] = []; }

        let isAlreadyQueued = false;
        for (let gId in gameQueues) {
            if (gameQueues[gId].some(w => w.username === username)) { isAlreadyQueued = true; break; }
        }
        if (isAlreadyQueued) return socket.emit('matchmaking_error', { msg: "既にいずれかのゲームでマッチング探索中です" });

        let userRate = 100;
        let userRank = "NORMAL";

        try {
            const user = await User.findOne({ username });
            if (user) { userRate = user.rate; userRank = user.rank; }
        } catch (e) {
            console.error("[QUEUE DB WARNING] マッチング時のレート取得に失敗、初期値で並びます:", e);
        }

        gameQueues[gameId].push({
            id: socket.id,
            username: username,
            rate: userRate,
            rank: userRank,
            socket: socket
        });

        console.log(`-> [QUEUE SUCCESS] ${username} が [${gameId}] のカゴに入りました (現在の待機人数: ${gameQueues[gameId].length}人)`);
        socket.emit('matchmaking_started', { gameId });
    });

    // 【マッチングキャンセル】
    socket.on('leave_matchmaking', () => {
        const username = socketUserMap[socket.id] || "未知のユーザー";
        console.log(`[QUEUE CANCEL] ${username} が待機列から離脱しました`);
        for (let gameId in gameQueues) {
            gameQueues[gameId] = gameQueues[gameId].filter(w => w.id !== socket.id);
        }
        socket.emit('matchmaking_stopped');
    });

    // 【ゲームデータパケット中継】
    socket.on('game_packet', (data) => {
        const username = socketUserMap[socket.id];
        if (!username) return;

        let roomId = null;
        for (let rId in activeGames) {
            if (activeGames[rId].p1 === username || activeGames[rId].p2 === username) { roomId = rId; break; }
        }
        
        if (roomId) {
            socket.to(roomId).emit('game_packet_receive', data);
        }
    });

    // 【チャット】
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

    // 【ゲーム終了申告】
    socket.on('submit_game_end', async (data) => {
        const username = socketUserMap[socket.id];
        console.log(`[GAME END SIGNAL] ${username} から勝敗確定要求を受信:`, data);

        let roomId = null;
        for (let rId in activeGames) {
            if (activeGames[rId].p1 === username || activeGames[rId].p2 === username) { roomId = rId; break; }
        }
        if (!roomId) return console.log('-> [ERROR] 該当するアクティブな部屋が見つかりません');
        const game = activeGames[roomId];

        if (game.isProcessingResult) return console.log('-> [WARNING] 既にリザルト計算が実行中です。重複処理を回避します');
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

        console.log(`[ROOM DELETED] 部屋 ${roomId} のゲーム結果処理が完了したため削除します`);
        delete activeGames[roomId];
    });

    // 【切断】
    socket.on('disconnect', () => {
        const username = socketUserMap[socket.id];
        console.log(`[SOCKET DISCONNECTED] 回線が切断されました: ${username || "未ログインの接続"} (ID: ${socket.id})`);
        
        for (let gameId in gameQueues) {
            gameQueues[gameId] = gameQueues[gameId].filter(w => w.id !== socket.id);
        }
        delete socketUserMap[socket.id];

        if (username && username !== 'admin' && !username.startsWith('Guest_')) {
            console.log(`-> [RECONNECT TIMER] ${username} の5分間復帰待機タイマーを始動します`);
            reconnectTimers[username] = setTimeout(async () => {
                console.log(`🚨 [TIMEOUT PENALTY] ${username} が5分以内に復帰しなかったため失格処理を執行します`);
                try {
                    const user = await User.findOne({ username });
                    if (user) {
                        user.rate = Math.max(0, user.rate - 200);
                        user.lose += 1;
                        user.rank = getRank(user.rate);
                        await user.save();
                        console.log(`-> ペナルティ完了: ${username} 新レート ${user.rate} pt`);
                    }
                } catch (e) {
                    console.error("ペナルティDB更新中にエラー:", e);
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
    for (let gameId in gameQueues) {
        let queue = gameQueues[gameId];
        if (queue.length < 2) continue;

        let p1 = queue.shift();
        let p2 = queue.shift();

        let roomId = `room_${gameId}_${p1.username}_${p2.username}_${Date.now()}`;
        console.log(`⚔️ [MATCH FOUND] ゲーム [${gameId}] で試合が成立しました！部屋ID: ${roomId} (${p1.username} vs ${p2.username})`);
        
        p1.socket.join(roomId);
        p2.socket.join(roomId);

        activeGames[roomId] = {
            gameId: gameId,
            p1: p1.username,
            p2: p2.username,
            isProcessingResult: false,
            state: {}
        };

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
    console.log(`=======================================================`);
    console.log(` 🚀 Platform Hub Server successfully running on port ${PORT}`);
    console.log(`=======================================================`);
});
