const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

// 管理者用の秘密の合言葉（簡易トークン）
const ADMIN_SECRET = "THE_MARATHON_GM_SECRET_2026";
// マッチング緊急ロックフラグ
let isMatchingLocked = false;

// ==========================================
// 1. 共通スキーマ定義
// ==========================================
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
  if (rate >= 2000) return "VIP";
  else if (rate >= 1500) return "PREMIUM";
  else if (rate >= 500) return "ELITE";
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

// 個別ルーティングシステム（ソースコード露出完全防御）
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'admin.html')); });
app.get('/marathon.html', (req, res) => { res.sendFile(path.join(__dirname, 'marathon.html')); });

// ==========================================
// 3. Socket.io 通信ハブゲート
// ==========================================
io.on('connection', (socket) => {
    console.log(`[SOCKET CONNECTED] 新しい回線が確立されました (SocketID: ${socket.id})`);

    // 【管理者：認証チェック】
    socket.on('admin_auth', async (data) => {
        if (data && data.token === ADMIN_SECRET) {
            socket.join('admin_room');
            try {
                const allUsers = await User.find({}, { password: 0 });
                socket.emit('admin_init_res', {
                    success: true, users: allUsers, isMatchingLocked: isMatchingLocked, activeGamesCount: Object.keys(activeGames).length
                });
            } catch (e) {
                socket.emit('admin_init_res', { success: false, msg: "ユーザーリスト取得失敗" });
            }
        } else {
            socket.emit('admin_init_res', { success: false, msg: "不正なトークンです。" });
        }
    });

    // 【管理者特権：神のレート改変】
    socket.on('admin_change_rate', async (data) => {
        if (!socket.rooms.has('admin_room')) return;
        const { targetUser, newRate } = data;
        try {
            const user = await User.findOne({ username: targetUser });
            if (user) {
                user.rate = parseInt(newRate) || 0;
                user.rank = getRank(user.rate);
                await user.save();
                const allUsers = await User.find({}, { password: 0 });
                io.to('admin_room').emit('admin_update_list', { users: allUsers, activeGamesCount: Object.keys(activeGames).length });
            }
        } catch (e) { console.error(e); }
    });

    // 【管理者特権：走者BAN】
    socket.on('admin_ban_user', async (data) => {
        if (!socket.rooms.has('admin_room')) return;
        const { targetUser } = data;
        try {
            await User.deleteOne({ username: targetUser });
            const allUsers = await User.find({}, { password: 0 });
            io.to('admin_room').emit('admin_update_list', { users: allUsers, activeGamesCount: Object.keys(activeGames).length });
        } catch (e) { console.error(e); }
    });

    // 【管理者特権：ロック切り替え】
    socket.on('admin_toggle_lock', () => {
        if (!socket.rooms.has('admin_room')) return;
        isMatchingLocked = !isMatchingLocked;
        io.to('admin_room').emit('admin_lock_status', { isMatchingLocked: isMatchingLocked });
    });

    // 【新規登録】
    socket.on('register', async (data) => {
        const { username, password } = data;
        if (!username || !password) return socket.emit('register_res', { success: false, msg: "識別名とパスワードを入力してください" });
        if (username.toLowerCase() === 'admin') return socket.emit('register_res', { success: false, msg: "予約済みの識別名です" });
        try {
            const exists = await User.findOne({ username });
            if (exists) return socket.emit('register_res', { success: false, msg: "既に使用されています" });
            await User.create({ username, password, rate: 100, rank: "NORMAL", win: 0, lose: 0 });
            socket.emit('register_res', { success: true, msg: "中央システムへの走者登録が完了しました！" });
        } catch (err) { socket.emit('register_res', { success: false, msg: "サーバーエラー" }); }
    });

    // 【ログイン】
    socket.on('login', async (data) => {
        const { username, password, token } = data;
        if (username === 'admin') {
            if (password === 'adminpassword' || token === ADMIN_SECRET) {
                return socket.emit('login_res', { success: true, username: 'admin', isAdmin: true, token: ADMIN_SECRET });
            } else { return socket.emit('login_res', { success: false, msg: "パスワード不正" }); }
        }
        try {
            const user = await User.findOne({ username });
            if (user) {
                if ((token && user.password === token) || (password && user.password === password)) {
                    userSocketMap[username] = socket.id;
                    socketUserMap[socket.id] = username;
                    
                    for (let rId in activeGames) {
                        if (activeGames[rId].p1 === username || activeGames[rId].p2 === username) {
                            socket.join(rId);
                            let myRole = (activeGames[rId].p1 === username) ? 1 : 2;
                            socket.emit('assigned_player', myRole);
                            break;
                        }
                    }
                    return socket.emit('login_res', { 
                        success: true, username, rate: user.rate, rank: user.rank, win: user.win, lose: user.lose
                    });
                }
            }
            socket.emit('login_res', { success: false, msg: "認証に失敗しました" });
        } catch (err) { socket.emit('login_res', { success: false, msg: "サーバー接続エラー" }); }
    });

    // 【ゲストログイン】
    socket.on('login_guest', () => {
        let guestName = "Guest_" + Math.floor(1000 + Math.random() * 9000);
        userSocketMap[guestName] = socket.id;
        socketUserMap[socket.id] = guestName;
        for (let rId in activeGames) {
            if (activeGames[rId].p1 === guestName || activeGames[rId].p2 === guestName) {
                socket.join(rId);
                let myRole = (activeGames[rId].p1 === guestName) ? 1 : 2;
                socket.emit('assigned_player', myRole);
                break;
            }
        }
        socket.emit('login_res', { success: true, username: guestName, rate: "----", rank: "GUEST", isGuest: true });
    });

    // 【マッチングエントリー】
    socket.on('join_matchmaking', async (data) => {
        if (isMatchingLocked) return socket.emit('matchmaking_error', { msg: "現在マッチングはロックされています。" });
        const username = socketUserMap[socket.id];
        if (!username) return socket.emit('matchmaking_error', { msg: "セッション切れ" });

        const { gameId } = data;
        if (!gameId) return socket.emit('matchmaking_error', { msg: "ゲームID不明" });
        if (!gameQueues[gameId]) { gameQueues[gameId] = []; }

        let isAlreadyQueued = false;
        for (let gId in gameQueues) {
            if (gameQueues[gId].some(w => w.username === username)) { isAlreadyQueued = true; break; }
        }
        if (isAlreadyQueued) return socket.emit('matchmaking_error', { msg: "既に探索中です" });

        let userRate = 100; let userRank = "NORMAL";
        try {
            const user = await User.findOne({ username });
            if (user) { userRate = user.rate; userRank = user.rank; }
        } catch (e) { console.error(e); }

        gameQueues[gameId].push({ id: socket.id, username: username, rate: userRate, rank: userRank, socket: socket });
        socket.emit('matchmaking_started', { gameId });
    });

    // 【マッチングキャンセル】
    socket.on('leave_matchmaking', () => {
        for (let gameId in gameQueues) {
            gameQueues[gameId] = gameQueues[gameId].filter(w => w.id !== socket.id);
        }
        socket.emit('matchmaking_stopped');
    });

    // 【イベント発動予約】
    socket.on('reserve_event', (data) => {
        const username = socketUserMap[socket.id];
        if (!username) return;
        let roomId = null;
        for (let rId in activeGames) {
            if (activeGames[rId].p1 === username || activeGames[rId].p2 === username) { roomId = rId; break; }
        }
        if (!roomId) return;
        const game = activeGames[roomId];
        if (data.player === 1) game.state.p1Reserved = true;
        if (data.player === 2) game.state.p2Reserved = true;
    });

    // 【カード移動同期】
    socket.on('player_move_card', (data) => {
        const username = socketUserMap[socket.id];
        if (!username) return;
        let roomId = null;
        for (let rId in activeGames) {
            if (activeGames[rId].p1 === username || activeGames[rId].p2 === username) { roomId = rId; break; }
        }
        if (roomId) { socket.to(roomId).emit('opponent_moving_card', data); }
    });

    // 🌟【最核心】ターン確定 ＆ 5ターン連続停止デスルール計算
    socket.on('submit_turn', async (data) => {
        const username = socketUserMap[socket.id];
        if (!username) return;
        let roomId = null;
        for (let rId in activeGames) {
            if (activeGames[rId].p1 === username || activeGames[rId].p2 === username) { roomId = rId; break; }
        }
        if (!roomId) return;
        
        const game = activeGames[roomId];
        const s = game.state;

        if (data.player === 1) s.p1Choice = data.choice;
        if (data.player === 2) s.p2Choice = data.choice;

        if (s.p1Choice && s.p2Choice) {
            
            // 1. 廃棄スタック加算
            s.p1Choice.waste.forEach(t => s.p1.wastePile[t]++);
            s.p2Choice.waste.forEach(t => s.p2.wastePile[t]++);

            let activeEvent = null;
            let eventSender = 0;
            let evText = "";

            // 2. GMイベント処理（P1）
            if (s.p1Reserved) {
                let maxType = 'cheer'; let maxCount = -1;
                for (let t in s.p1.wastePile) {
                    if (s.p1.wastePile[t] > maxCount) { maxCount = s.p1.wastePile[t]; maxType = t; }
                }
                if (maxType === 'water') { s.p1.temp -= maxCount; activeEvent = { title: `天の涙 (-${maxCount}℃)`, color: "#3c6382" }; }
                else if (maxType === 'stone') { s.p1.debt += maxCount; activeEvent = { title: `避けれぬ現実 (+${maxCount}%壁)`, color: "#57606f" }; }
                else if (maxType === 'sun') { s.p1.temp += maxCount; activeEvent = { title: `地獄の炎のおでむかえ (+${maxCount}℃)`, color: "#b33939" }; }
                else if (maxType === 'cheer') { s.p1.progress += (maxCount * 4); activeEvent = { title: `大応援 (+${maxCount*4}%前進)`, color: "#218c74" }; }
                
                evText += `★${game.p1}のイベント発動\n`;
                s.p1.wastePile[maxType] = 0; s.lastEventP1 = s.turn; s.p1Reserved = false; eventSender = 1;
            }

            // 3. GMイベント処理（P2）
            if (s.p2Reserved) {
                let maxType = 'cheer'; let maxCount = -1;
                for (let t in s.p2.wastePile) {
                    if (s.p2.wastePile[t] > maxCount) { maxCount = s.p2.wastePile[t]; maxType = t; }
                }
                if (maxType === 'water') { s.p2.temp -= maxCount; activeEvent = { title: `天の涙 (-${maxCount}℃)`, color: "#3c6382" }; }
                else if (maxType === 'stone') { s.p2.debt += maxCount; activeEvent = { title: `避けれぬ現実 (+${maxCount}%壁)`, color: "#57606f" }; }
                else if (maxType === 'sun') { s.p2.temp += maxCount; activeEvent = { title: `地獄の炎のおでむかえ (+${maxCount}℃)`, color: "#b33939" }; }
                else if (maxType === 'cheer') { s.p2.progress += (maxCount * 4); activeEvent = { title: `大応援 (+${maxCount*4}%前進)`, color: "#218c74" }; }
                
                evText += `★${game.p2}のイベント発動\n`;
                s.p2.wastePile[maxType] = 0; s.lastEventP2 = s.turn; s.p2Reserved = false; eventSender = 2;
            }

            // 4. 通常シナジー計算
            let p1Sun = s.p1Choice.self.includes('sun') || s.p2Choice.target.includes('sun');
            let p2Sun = s.p2Choice.self.includes('sun') || s.p1Choice.target.includes('sun');
            if (p1Sun) s.p1.temp++; if (p2Sun) s.p2.temp++;

            // P1速度数理モデル
            let p1Spd = 5;
            if (s.p1.temp < 5) p1Spd = Math.max(0, 5 - (5 - s.p1.temp));
            else if (s.p1.temp === 5) p1Spd = 5;
            else if (s.p1.temp >= 6 && s.p1.temp <= 10) p1Spd = 7;
            else if (s.p1.temp >= 10 && s.p1.temp <= 15) p1Spd = 10;
            else if (s.p1.temp >= 15 && s.p1.temp <= 20) p1Spd = Math.max(5, 10 - (s.p1.temp - 15));
            else if (s.p1.temp >= 20) p1Spd = Math.max(0, 5 - (s.p1.temp - 20));

            if (s.p1Choice.self.includes('cheer')) p1Spd += 1; if (s.p2Choice.target.includes('cheer')) p1Spd += 1;
            let p1StoneNum = (s.p1Choice.self.includes('stone')?1:0) + (s.p2Choice.target.includes('stone')?1:0);
            if (p1StoneNum > 0) p1Spd -= 1;

            // P2速度数理モデル
            let p2Spd = 5;
            if (s.p2.temp < 5) p2Spd = Math.max(0, 5 - (5 - s.p2.temp));
            else if (s.p2.temp === 5) p2Spd = 5;
            else if (s.p2.temp >= 6 && s.p2.temp <= 10) p2Spd = 7;
            else if (s.p2.temp >= 10 && s.p2.temp <= 15) p2Spd = 10;
            else if (s.p2.temp >= 15 && s.p2.temp <= 20) p2Spd = Math.max(5, 10 - (s.p2.temp - 15));
            else if (s.p2.temp >= 20) p2Spd = Math.max(0, 5 - (s.p2.temp - 20));

            if (s.p2Choice.self.includes('cheer')) p2Spd += 1; if (s.p1Choice.target.includes('cheer')) p2Spd += 1;
            let p2StoneNum = (s.p2Choice.self.includes('stone')?1:0) + (s.p1Choice.target.includes('stone')?1:0);
            if (p2StoneNum > 0) p2Spd -= 1;

            // 5. 壁の相殺処理
            if (p1Spd < 0) { s.p1.debt += Math.abs(p1Spd); p1Spd = 0; }
            else if (s.p1.debt > 0) { if (p1Spd >= s.p1.debt) { p1Spd -= s.p1.debt; s.p1.debt = 0; } else { s.p1.debt -= p1Spd; p1Spd = 0; } }

            if (p2Spd < 0) { s.p2.debt += Math.abs(p2Spd); p2Spd = 0; }
            else if (s.p2.debt > 0) { if (p2Spd >= s.p2.debt) { p2Spd -= s.p2.debt; s.p2.debt = 0; } else { s.p2.debt -= p2Spd; p2Spd = 0; } }

            // 🌟🌟🌟【修正完了】5ターン連続進捗ゼロ（行動不能）カウンターの厳密処理 🌟🌟🌟
            s.p1.consecutiveNoProgress = (p1Spd === 0) ? (s.p1.consecutiveNoProgress + 1) : 0;
            s.p2.consecutiveNoProgress = (p2Spd === 0) ? (s.p2.consecutiveNoProgress + 1) : 0;

            // 6. 進捗加算
            s.p1.progress += p1Spd;
            s.p2.progress += p2Spd;

            // ソリッドログ（美学に準拠：数値と温度を完全隠蔽）
            let resultLog = `${evText}【第 ${s.turn} ターン終了】\n・${game.p1}：現在位置 [${s.p1.progress}%]\n・${game.p2}：現在位置 [${s.p2.progress}%]`;

            s.turn++;
            let nextP1CanEvent = (s.turn >= 15 && (s.turn - s.lastEventP1 >= 10));
            let nextP2CanEvent = (s.turn >= 15 && (s.turn - s.lastEventP2 >= 10));
            let keepsData = { p1: s.p1Choice.keep, p2: s.p2Choice.keep };

            // 7. 勝敗・行動不能のトリガー判定（ゴール判定 ＆ immobilize同時チェック）
            let isGameOver = false;
            let winnerName = 'DRAW';
            let endReason = 'goal';

            // 行動不能（5連続停止）によるTKO判定
            let p1Immobilized = (s.p1.consecutiveNoProgress >= 5);
            let p2Immobilized = (s.p2.consecutiveNoProgress >= 5);

            if (p1Immobilized || p2Immobilized) {
                isGameOver = true;
                endReason = 'immobilize';
                if (p1Immobilized && p2Immobilized) winnerName = 'DRAW';
                else if (p1Immobilized) winnerName = game.p2; // P1が動けなくなったのでP2の勝ち
                else winnerName = game.p1;
            } 
            // 通常のゴール判定（1000%到達）
            else if (s.p1.progress >= 1000 || s.p2.progress >= 1000) {
                isGameOver = true;
                endReason = 'goal';
                if (s.progress >= 1000 && s.p2.progress >= 1000) {
                    if (s.p1.progress > s.p2.progress) winnerName = game.p1;
                    else if (s.p2.progress > s.p1.progress) winnerName = game.p2;
                } else if (s.p1.progress >= 1000) winnerName = game.p1;
                else winnerName = game.p2;
            }

            // 判定結果のクライアント送信
            io.to(roomId).emit('round_result', {
                nextTurn: s.turn,
                p1Progress: s.p1.progress, p2Progress: s.p2.progress,
                p1Temp: s.p1.temp, p2Temp: s.p2.temp,
                p1Debt: s.p1.debt, p2Debt: s.p2.debt,
                resultLog: resultLog,
                p1CanEvent: nextP1CanEvent, p2CanEvent: nextP2CanEvent,
                activeEvent: activeEvent, eventSender: eventSender,
                p1ChoiceRaw: s.p1Choice, p2ChoiceRaw: s.p2Choice,
                keeps: keepsData
            });

            // ゲームオーバー時のDB・レート更新処理の執行
            if (isGameOver) {
                console.log(`🏁 [GAME OVER] 部屋 ${roomId} が決着。理由: ${endReason} | 勝者: ${winnerName}`);
                let p1Name = game.p1; let p2Name = game.p2;
                let p1Result = null; let p2Result = null;

                if (winnerName === 'DRAW') {
                    p1Result = await processPlatformRate(p1Name, false, 'draw');
                    p2Result = await processPlatformRate(p2Name, false, 'draw');
                } else if (winnerName === p1Name) {
                    p1Result = await processPlatformRate(p1Name, true, endReason);
                    p2Result = await processPlatformRate(p2Name, false, endReason);
                } else if (winnerName === p2Name) {
                    p1Result = await processPlatformRate(p1Name, false, endReason);
                    p2Result = await processPlatformRate(p2Name, true, endReason);
                }

                let p1SocketId = userSocketMap[p1Name];
                let p2SocketId = userSocketMap[p2Name];

                if (p1SocketId) {
                    io.to(p1SocketId).emit('platform_game_over', {
                        winner: winnerName, rateChange: (winnerName === p1Name) ? p1Result.rateChange : p2Result.rateChange,
                        newRate: p1Result.currentRate, newRank: p1Result.currentRank
                    });
                }
                if (p2SocketId) {
                    io.to(p2SocketId).emit('platform_game_over', {
                        winner: winnerName, rateChange: (winnerName === p2Name) ? p2Result.rateChange : p1Result.rateChange,
                        newRate: p2Result.currentRate, newRank: p2Result.currentRank
                    });
                }
                delete activeGames[roomId];
            }

            s.p1Choice = null;
            s.p2Choice = null;
        }
    });

    // 【ゲーム終了申告フォールバック】
    socket.on('submit_game_end', async (data) => {
        const username = socketUserMap[socket.id];
        let roomId = null;
        for (let rId in activeGames) {
            if (activeGames[rId].p1 === username || activeGames[rId].p2 === username) { roomId = rId; break; }
        }
        if (!roomId) return;
        const game = activeGames[roomId];
        if (game.isProcessingResult) return;
        game.isProcessingResult = true;

        const { winnerUsername, resultType } = data;
        let p1Name = game.p1; let p2Name = game.p2;
        let p1Result = null; let p2Result = null;

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

        let p1SocketId = userSocketMap[p1Name]; let p2SocketId = userSocketMap[p2Name];
        if (p1SocketId) { io.to(p1SocketId).emit('platform_game_over', { winner: winnerUsername, rateChange: (winnerUsername === p1Name) ? p1Result.rateChange : p2Result.rateChange, newRate: p1Result.currentRate, newRank: p1Result.currentRank }); }
        if (p2SocketId) { io.to(p2SocketId).emit('platform_game_over', { winner: winnerUsername, rateChange: (winnerUsername === p2Name) ? p2Result.rateChange : p1Result.rateChange, newRate: p2Result.currentRate, newRank: p2Result.currentRank }); }
        delete activeGames[roomId];
    });

    // 【チャット中継】
    socket.on('send_chat', (msg) => {
        let roomId = null; const username = socketUserMap[socket.id]; if (!username) return;
        for (let rId in activeGames) { if (activeGames[rId].p1 === username || activeGames[rId].p2 === username) { roomId = rId; break; } }
        if (roomId) { io.to(roomId).emit('receive_chat', msg); }
    });

    // 【不戦勝・タイムアウト用】
    socket.on('player_timeout', async (data) => {
        const username = socketUserMap[socket.id];
        let roomId = null;
        for (let rId in activeGames) { if (activeGames[rId].p1 === username || activeGames[rId].p2 === username) { roomId = rId; break; } }
        if (!roomId) return;
        const game = activeGames[roomId];
        let opponent = (data.player === 1) ? game.p2 : game.p1;
        
        let oppResult = await processPlatformRate(opponent, true, 'immobilize');
        let loserResult = await processPlatformRate(username, false, 'immobilize');

        let p1SocketId = userSocketMap[game.p1]; let p2SocketId = userSocketMap[game.p2];
        if (p1SocketId) { io.to(p1SocketId).emit('platform_game_over', { winner: opponent, rateChange: (opponent === game.p1) ? oppResult.rateChange : loserResult.rateChange, newRate: (game.p1 === opponent) ? oppResult.currentRate : loserResult.currentRate, newRank: (game.p1 === opponent) ? oppResult.currentRank : loserResult.currentRank }); }
        if (p2SocketId) { io.to(p2SocketId).emit('platform_game_over', { winner: opponent, rateChange: (opponent === game.p2) ? oppResult.rateChange : loserResult.rateChange, newRate: (game.p2 === opponent) ? oppResult.currentRate : loserResult.currentRate, newRank: (game.p2 === opponent) ? oppResult.currentRank : loserResult.currentRank }); }
        delete activeGames[roomId];
    });

    // 【切断時の処理】
    socket.on('disconnect', () => {
        const username = socketUserMap[socket.id];
        for (let gameId in gameQueues) { gameQueues[gameId] = gameQueues[gameId].filter(w => w.id !== socket.id); }
        delete socketUserMap[socket.id];

        if (username && username !== 'admin' && !username.startsWith('Guest_')) {
            let isInGame = false; let userRoomId = null;
            for (let rId in activeGames) { if (activeGames[rId].p1 === username || activeGames[rId].p2 === username) { isInGame = true; userRoomId = rId; break; } }
            if (isInGame) {
                reconnectTimers[username] = setTimeout(async () => {
                    try {
                        const user = await User.findOne({ username });
                        if (user) { user.rate = Math.max(0, user.rate - 200); user.lose += 1; user.rank = getRank(user.rate); await user.save(); }
                    } catch (e) { console.error(e); }

                    if (userRoomId && activeGames[userRoomId]) {
                        const game = activeGames[userRoomId];
                        let opponent = (game.p1 === username) ? game.p2 : game.p1;
                        let oppSocketId = userSocketMap[opponent];
                        let oppResult = await processPlatformRate(opponent, true, 'disconnect_win');
                        if (oppSocketId) { io.to(oppSocketId).emit('platform_game_over', { winner: opponent, rateChange: oppResult.rateChange, newRate: oppResult.currentRate, newRank: oppResult.currentRank }); }
                        delete activeGames[userRoomId];
                    }
                    delete reconnectTimers[username];
                }, 5 * 60 * 1000);
            }
        }
    });
});

// ==========================================
// 4. マッチングシステムループ（初期ステータス注入）
// ==========================================
setInterval(async () => {
    for (let gameId in gameQueues) {
        let queue = gameQueues[gameId];
        if (queue.length < 2) continue;

        let p1 = queue.shift();
        let p2 = queue.shift();
        let roomId = `room_${gameId}_${p1.username}_${p2.username}_${Date.now()}`;
        
        p1.socket.join(roomId);
        p2.socket.join(roomId);

        activeGames[roomId] = { 
            gameId: gameId, p1: p1.username, p2: p2.username, isProcessingResult: false, 
            state: {
                turn: 1, lastEventP1: -99, lastEventP2: -99, p1Reserved: false, p2Reserved: false,
                p1: { progress: 0, temp: 5, stoneCount: 0, cheerCount: 0, wastePile: {sun:0,stone:0,water:0,cheer:0}, debt: 0, consecutiveNoProgress: 0 },
                p2: { progress: 0, temp: 5, stoneCount: 0, cheerCount: 0, wastePile: {sun:0,stone:0,water:0,cheer:0}, debt: 0, consecutiveNoProgress: 0 },
                p1Choice: null, p2Choice: null
            } 
        };

        p1.socket.emit('assigned_player', 1);
        p2.socket.emit('assigned_player', 2);

        io.to(roomId).emit('platform_match_found', {
            roomId: roomId, gameId: gameId,
            p1: { username: p1.username, rate: p1.rate, rank: p1.rank },
            p2: { username: p2.username, rate: p2.rate, rank: p2.rank }
        });
    }
}, 1000);

// ==========================================
// 5. データベース接続 ＆ サーバー起動
// ==========================================
async function startSecurePlatform() {
  try {
    console.log('⏳ [DB CONNECT] MongoDBへのセキュア接続を開始します...');
    await mongoose.connect('mongodb+srv://gaohu1870_db_user:pe96ArnwLeCqf1S2@cluster0.4vbxzmx.mongodb.net/test?appName=Cluster0', { bufferCommands: false });
    console.log('✅ [DB SUCCESS] MongoDBとの完全同期に成功。インフラ開通！');
    server.listen(PORT, () => {
        console.log(`=======================================================`);
        console.log(` 🚀 Platform Hub Server successfully running on port ${PORT}`);
        console.log(`=======================================================`);
    });
  } catch (err) { console.error('❌ [DB CRITICAL ERROR] データベース接続失敗:', err); }
}

startSecurePlatform();
