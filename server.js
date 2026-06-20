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
  .then(() => console.log('MongoDB connected successfully'))
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

// --- レート変動ロジック ---
async function updatePlayerResult(username, isWin, resultType) {
  const user = await User.findOne({ username });
  if (!user || username === 'admin') return 0;

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

  return Math.abs(user.rate - oldRate);
}

// --- ゲームロジックの状態管理用オブジェクト ---
let activeGames = {};
let waitingQueue = [];
let reconnectTimers = {};

app.use(express.static(__dirname));

io.on('connection', (socket) => {
    let currentUsername = null;
    let isGuestUser = false;

    // アカウント登録
    socket.on('register', async (data) => {
        const { username, password } = data;
        const exists = await User.findOne({ username });
        if (exists) return socket.emit('register_res', { success: false, msg: "使用済み" });
        
        await User.create({ username, password, rate: 100, rank: "NORMAL" });
        socket.emit('register_res', { success: true, msg: "走者登録が完了しました！" });
    });

    // ログイン
    socket.on('login', async (data) => {
        const { username, password, token } = data;
        const user = await User.findOne({ username });
        if (user) {
            if ((token && user.password === token) || (password && user.password === password)) {
                currentUsername = username;
                console.log(`[LOGIN SUCCESS] ${username}`);
                return socket.emit('login_res', { success: true, username, rate: user.rate, rank: user.rank });
            }
        }
        socket.emit('login_res', { success: false, msg: "認証に失敗しました" });
    });

    // ゲストモードログイン
    socket.on('login_guest', () => {
        isGuestUser = true;
        currentUsername = "Guest_" + Math.floor(1000 + Math.random() * 9000);
        console.log(`[GUEST LOGIN] ${currentUsername}`);
        socket.emit('login_res', { success: true, username: currentUsername, rate: "----", rank: "GUEST", isGuest: true });
    });

    // マッチングのエントリー
    socket.on('join_matchmaking', async () => {
        if (!currentUsername) return;
        const isQueued = waitingQueue.some(w => w.username === currentUsername);
        if (isQueued) return;

        let userRate = 100;
        let userRank = "NORMAL";

        if (!isGuestUser) {
            const user = await User.findOne({ username: currentUsername });
            if (user) { userRate = user.rate; userRank = user.rank; }
        }

        waitingQueue.push({
            id: socket.id,
            username: currentUsername,
            rate: userRate,
            rank: userRank,
            socket: socket
        });
        console.log(`[QUEUE JOIN] ${currentUsername} が待機列に入りました`);
        socket.emit('matchmaking_started');
    });

    // マッチングのキャンセル
    socket.on('leave_matchmaking', () => {
        waitingQueue = waitingQueue.filter(w => w.id !== socket.id);
        socket.emit('matchmaking_stopped');
    });

    // カード移動のリアルタイム裏同期
    socket.on('player_move_card', (data) => {
        if (socket.currentRoomId) {
            socket.to(socket.currentRoomId).emit('opponent_moving_card', data);
        }
    });

    // 【最強修正】イベント発動の予約（ユーザー名で確実に仕分け）
    socket.on('reserve_event', () => {
        if (!socket.currentRoomId || !currentUsername) return;
        const game = activeGames[socket.currentRoomId];
        if (game) {
            if (currentUsername === game.p1) game.p1Reserved = true;
            if (currentUsername === game.p2) game.p2Reserved = true;
            console.log(`[EVENT RESERVED] ${currentUsername} がイベントを予約しました`);
        }
    });

    // 【最強修正】配置確定ボタン（ユーザー名ベースで100%確実に仕分ける）
    socket.on('submit_turn', async (data) => {
        if (!socket.currentRoomId) {
            console.log(`[SUBMIT ERROR] ${currentUsername} の部屋IDが見つかりません`);
            return;
        }
        const game = activeGames[socket.currentRoomId];
        if (!game) {
            console.log(`[SUBMIT ERROR] 部屋 ${socket.currentRoomId} が存在しません`);
            return;
        }

        const { choice } = data;
        console.log(`[TURN SUBMIT] ${currentUsername} から配置データを受信しました`);

        // ソケットIDではなく、ログインしている「ユーザー名」でP1とP2を完全に識別
        if (currentUsername === game.p1) {
            game.p1Choice = choice;
            console.log(`-> P1 (${game.p1}) の配置をロックしました`);
        } else if (currentUsername === game.p2) {
            game.p2Choice = choice;
            console.log(`-> P2 (${game.p2}) の配置をロックしました`);
        } else {
            console.log(`[SUBMIT WARNING] 登録外のユーザー名です: ${currentUsername}`);
        }

        // 両者の配置データがサーバーに揃ったかログで追跡
        console.log(`[STATUS CHECK] Room: ${socket.currentRoomId} | P1確定: ${!!game.p1Choice} | P2確定: ${!!game.p2Choice}`);

        if (game.p1Choice && game.p2Choice) {
            console.log(`[LOGIC START] 両者の配置が揃いました。ターン計算エンジンを起動します。`);
            await executeOnlineTurnLogic(socket.currentRoomId);
        }
    });

    // チャットパケットの部屋内転送
    socket.on('send_chat', (msg) => {
        if (socket.currentRoomId) {
            io.to(socket.currentRoomId).emit('receive_chat', msg);
        }
    });

    // 5分制限時間切れによる遅延失格処理
    socket.on('player_timeout', async () => {
        if (!socket.currentRoomId || !currentUsername) return;
        const game = activeGames[socket.currentRoomId];
        if (!game) return;

        let isP1 = (currentUsername === game.p1);
        let foulPlayer = isP1 ? game.p1 : game.p2;
        let winner = isP1 ? game.p2 : game.p1;

        io.to(socket.currentRoomId).emit('game_over_timeout', { foulPlayer: foulPlayer });

        setTimeout(async () => {
            let winChange = await updatePlayerResult(winner, true, 'timeout_win');
            let loseChange = await updatePlayerResult(foulPlayer, false, 'timeout_lose');

            game.p1Socket.emit('game_over', { winner: winner, rateChange: (winner === game.p1) ? winChange : loseChange });
            game.p2Socket.emit('game_over', { winner: winner, rateChange: (winner === game.p2) ? winChange : loseChange });

            delete activeGames[socket.currentRoomId];
        }, 2000);
    });

    // 切断時のペナルティ処理
    socket.on('disconnect', () => {
        waitingQueue = waitingQueue.filter(w => w.id !== socket.id);
        if (currentUsername && !isGuestUser && currentUsername !== 'admin') {
            reconnectTimers[currentUsername] = setTimeout(async () => {
                const user = await User.findOne({ username: currentUsername });
                if (user) {
                    user.rate = Math.max(0, user.rate - 200);
                    user.lose += 1;
                    user.rank = getRank(user.rate);
                    await user.save();
                }

                if (socket.currentRoomId && activeGames[socket.currentRoomId]) {
                    const game = activeGames[socket.currentRoomId];
                    let opponent = (game.p1 === currentUsername) ? game.p2 : game.p1;
                    let oppSocket = (game.p1 === currentUsername) ? game.p2Socket : game.p1Socket;

                    let winChange = await updatePlayerResult(opponent, true, 'disconnect_win');
                    oppSocket.emit('game_over', { winner: opponent, rateChange: winChange });

                    delete activeGames[socket.currentRoomId];
                }
                delete reconnectTimers[currentUsername];
            }, 5 * 60 * 1000);
        }
    });
});

// 2人の入力カードを元に、ゲーム展開をシミュレートするメイン計算エンジン
async function executeOnlineTurnLogic(roomId) {
    const game = activeGames[roomId];
    if (!game) return;

    let s = game.state;
    let p1Choice = game.p1Choice;
    let p2Choice = game.p2Choice;

    p1Choice.waste.forEach(t => s.p1.wastePile[t]++);
    p2Choice.waste.forEach(t => s.p2.wastePile[t]++);

    let evText = "";
    let activeEvent = null;
    let eventSender = 0;

    if (game.p1Reserved) {
        let pData = s.p1;
        let maxType = 'cheer'; let maxCount = -1;
        for(let t in pData.wastePile) { if(pData.wastePile[t] > maxCount) { maxCount = pData.wastePile[t]; maxType = t; } }
        if(maxType === 'water') { pData.temp -= maxCount; activeEvent = { title: "天の涙 (HEAVENLY TEARS)", color: "linear-gradient(to right, #2980b9, #6dd5fa)" }; evText += `★${game.p1}：【天の涙】温度が ${maxCount}℃ 下がった！\n`; }
        else if(maxType === 'stone') { pData.debt += maxCount; activeEvent = { title: "避けられぬ現実 (CRUEL REALITY)", color: "linear-gradient(to right, #bdc3c7, #2c3e50)" }; evText += `★${game.p1}：【避けられぬ現実】自分に ${maxCount}% の進めない壁が出現！\n`; }
        else if(maxType === 'sun') { pData.temp += maxCount; activeEvent = { title: "地獄の炎のおでむかえ", color: "linear-gradient(to right, #e65c00, #f9d423)" }; evText += `★${game.p1}：【地獄の炎のおでむかえ】温度が ${maxCount}℃ 上がった！\n`; }
        else if(maxType === 'cheer') { pData.progress += (maxCount * 4); activeEvent = { title: "大応援 (ULTIMATE CHEER)", color: "linear-gradient(to right, #11998e, #38ef7d)" }; evText += `★${game.p1}：【大応援】 ${maxCount * 4}% 爆速前進！\n`; }
        pData.wastePile[maxType] = 0; game.lastEventP1 = game.turn; game.p1Reserved = false;
        eventSender = 1;
    }

    if (game.p2Reserved) {
        let pData = s.p2;
        let maxType = 'cheer'; let maxCount = -1;
        for(let t in pData.wastePile) { if(pData.wastePile[t] > maxCount) { maxCount = pData.wastePile[t]; maxType = t; } }
        let currentEvent = null;
        if(maxType === 'water') { pData.temp -= maxCount; currentEvent = { title: "天の涙 (HEAVENLY TEARS)", color: "linear-gradient(to right, #2980b9, #6dd5fa)" }; evText += `★${game.p2}：【天の涙】温度が ${maxCount}℃ 下がった！\n`; }
        else if(maxType === 'stone') { pData.debt += maxCount; currentEvent = { title: "避けられぬ現実 (CRUEL REALITY)", color: "linear-gradient(to right, #bdc3c7, #2c3e50)" }; evText += `★${game.p2}：【避けられぬ現実】自分に ${maxCount}% の進めない壁が出現！\n`; }
        else if(maxType === 'sun') { pData.temp += maxCount; currentEvent = { title: "地獄の炎のおでむかえ", color: "linear-gradient(to right, #e65c00, #f9d423)" }; evText += `★${game.p2}：【地獄の炎のおでむかえ】温度が ${maxCount}℃ 上がった！\n`; }
        else if(maxType === 'cheer') { pData.progress += (maxCount * 4); currentEvent = { title: "大応援 (ULTIMATE CHEER)", color: "linear-gradient(to right, #11998e, #38ef7d)" }; evText += `★${game.p2}：【大応援】 ${maxCount * 4}% 爆速前進！\n`; }
        pData.wastePile[maxType] = 0; game.lastEventP2 = game.turn; game.p2Reserved = false;
        if (!activeEvent) { activeEvent = currentEvent; eventSender = 2; }
    }

    let p1Sun = p1Choice.self.includes('sun') || p2Choice.target.includes('sun');
    let p2Sun = p2Choice.self.includes('sun') || p1Choice.target.includes('sun');
    if (p1Sun) s.p1.temp++; if (p2Sun) s.p2.temp++;

    if (p1Choice.self.includes('cheer')) s.p1.cheerCount++; if (p2Choice.target.includes('cheer')) s.p1.cheerCount++;
    if (p2Choice.self.includes('cheer')) s.p2.cheerCount++; if (p1Choice.target.includes('cheer')) s.p2.cheerCount++;

    // P1 スピード演算
    let p1Spd = 5;
    if (s.p1.temp < 5) p1Spd = Math.max(0, 5 - (5 - s.p1.temp));
    else if (s.p1.temp >= 6 && s.p1.temp <= 10) p1Spd = 7;
    else if (s.p1.temp >= 10 && s.p1.temp <= 15) p1Spd = 10;
    else if (s.p1.temp >= 15 && s.p1.temp <= 20) p1Spd = Math.max(5, 10 - (s.p1.temp - 15));
    else if (s.p1.temp >= 20) p1Spd = Math.max(0, 5 - (s.p1.temp - 20));

    if (p1Choice.self.includes('cheer')) p1Spd += 1; if (p2Choice.target.includes('cheer')) p1Spd += 1;
    if (s.p1.cheerCount > 0 && s.p1.cheerCount % 10 === 0) p1Spd += (s.p1.cheerCount * 0.5);

    let p1StoneNum = (p1Choice.self.includes('stone')?1:0) + (p2Choice.target.includes('stone')?1:0);
    s.p1.stoneCount += p1StoneNum; s.p1.consecutiveStone = p1StoneNum > 0 ? s.p1.consecutiveStone + 1 : 0;
    if (p1StoneNum > 0) p1Spd -= (s.p1.consecutiveStone > 1) ? (1 + (s.p1.consecutiveStone * 0.25)) : 1;
    if (s.p1.stoneCount > 0 && s.p1.stoneCount % 10 === 0) p1Spd -= (s.p1.stoneCount * 0.5);

    let p1WaterNum = (p1Choice.self.includes('water')?1:0) + (p2Choice.target.includes('water')?1:0);
    s.p1.waterHistory.push(p1WaterNum); if(s.p1.waterHistory.length > 4) s.p1.waterHistory.shift();
    s.p1.noWaterCount = p1WaterNum === 0 ? s.p1.noWaterCount + 1 : 0;
    if (s.p1.waterHistory.reduce((a,b)=>a+b,0) >= 3) p1Spd -= (s.p1.progress >= 800) ? 3 : 2;
    if (s.p1.noWaterCount >= 4) p1Spd -= (0.5 * (s.p1.noWaterCount - 3));

    // P2 スピード演算
    let p2Spd = 5;
    if (s.p2.temp < 5) p2Spd = Math.max(0, 5 - (5 - s.p2.temp));
    else if (s.p2.temp >= 6 && s.p2.temp <= 10) p2Spd = 7;
    else if (s.p2.temp >= 10 && s.p2.temp <= 15) p2Spd = 10;
    else if (s.p2.temp >= 15 && s.p2.temp <= 20) p2Spd = Math.max(5, 10 - (s.p2.temp - 15));
    else if (s.p2.temp >= 20) p2Spd = Math.max(0, 5 - (s.p2.temp - 20));

    if (p2Choice.self.includes('cheer')) p2Spd += 1; if (p1Choice.target.includes('cheer')) p2Spd += 1;
    if (s.p2.cheerCount > 0 && s.p2.cheerCount % 10 === 0) p2Spd += (s.p2.cheerCount * 0.5);

    let p2StoneNum = (p2Choice.self.includes('stone')?1:0) + (p1Choice.target.includes('stone')?1:0);
    s.p2.stoneCount += p2StoneNum; s.p2.consecutiveStone = p2StoneNum > 0 ? s.p2.consecutiveStone + 1 : 0;
    if (p2StoneNum > 0) p2Spd -= (s.p2.consecutiveStone > 1) ? (1 + (s.p2.consecutiveStone * 0.25)) : 1;
    if (s.p2.stoneCount > 0 && s.p2.stoneCount % 10 === 0) p2Spd -= (s.p2.stoneCount * 0.5);

    let p2WaterNum = (p2Choice.self.includes('water')?1:0) + (p1Choice.target.includes('water')?1:0);
    s.p2.waterHistory.push(p2WaterNum); if(s.p2.waterHistory.length > 4) s.p2.waterHistory.shift();
    s.p2.noWaterCount = p2WaterNum === 0 ? s.p2.noWaterCount + 1 : 0;
    if (s.p2.waterHistory.reduce((a,b)=>a+b,0) >= 3) p2Spd -= (s.p2.progress >= 800) ? 3 : 2;
    if (s.p2.noWaterCount >= 4) p2Spd -= (0.5 * (s.p2.noWaterCount - 3));

    if(p1Spd < 0) { s.p1.debt += Math.abs(p1Spd); p1Spd = 0; }
    else if(s.p1.debt > 0) { if(p1Spd >= s.p1.debt) { p1Spd -= s.p1.debt; s.p1.debt = 0; } else { s.p1.debt -= p1Spd; p1Spd = 0; } }

    if(p2Spd < 0) { s.p2.debt += Math.abs(p2Spd); p2Spd = 0; }
    else if(s.p2.debt > 0) { if(p2Spd >= s.p2.debt) { p2Spd -= s.p2.debt; s.p2.debt = 0; } else { s.p2.debt -= p2Spd; p2Spd = 0; } }

    s.p1.consecutiveNoProgress = (p1Spd === 0) ? s.p1.consecutiveNoProgress + 1 : 0;
    s.p2.consecutiveNoProgress = (p2Spd === 0) ? s.p2.consecutiveNoProgress + 1 : 0;

    s.p1.progress += p1Spd;
    s.p2.progress += p2Spd;

    let resultLog = `========================================\n` +
                 `   【第 ${game.turn} ターン 結果発表】\n` +
                 (evText ? evText : "") +
                 `👤 ${game.p1}(P1) -> [自分:${p1Choice.self}] [相手:${p1Choice.target}] [進捗:${s.p1.progress}%] [壁:${s.p1.debt}%]\n` +
                 `👥 ${game.p2}(P2) -> [自分:${p2Choice.self}] [相手:${p2Choice.target}] [進捗:${s.p2.progress}%] [壁:${s.p2.debt}%]\n` +
                 `========================================`;

    game.turn++;

    const p1User = await User.findOne({ username: game.p1 });
    const p2User = await User.findOne({ username: game.p2 });

    let p1CanEvent = (game.turn >= 15 && (game.turn - game.lastEventP1 >= 10));
    let p2CanEvent = (game.turn >= 15 && (game.turn - game.lastEventP2 >= 10));

    console.log(`[EMIT ROUND RESULT] 部屋 ${roomId} にターン結果をブロードキャストします`);
    io.to(roomId).emit('round_result', {
        p1ChoiceRaw: p1Choice,
        p2ChoiceRaw: p2Choice,
        p1Name: game.p1,
        p2Name: game.p2,
        p1Rate: p1User ? p1User.rate : 100,
        p2Rate: p2User ? p2User.rate : 100,
        nextTurn: game.turn,
        p1Progress: s.p1.progress,
        p2Progress: s.p2.progress,
        p1Temp: s.p1.temp,
        p2Temp: s.p2.temp,
        p1Debt: s.p1.debt,
        p2Debt: s.p2.debt,
        resultLog: resultLog,
        p1CanEvent,
        p2CanEvent,
        keeps: { p1: p1Choice.keep, p2: p2Choice.keep },
        activeEvent,
        eventSender
    });

    game.p1Choice = null;
    game.p2Choice = null;

    let isEnded = false;
    let winner = null;
    let resultType = 'normal';

    if (s.p1.consecutiveNoProgress >= 5 && s.p2.consecutiveNoProgress >= 5) {
        winner = 'DRAW'; isEnded = true;
    } else if (s.p1.consecutiveNoProgress >= 5) {
        winner = game.p2; resultType = 'immobilize'; isEnded = true;
    } else if (s.p2.consecutiveNoProgress >= 5) {
        winner = game.p1; resultType = 'immobilize'; isEnded = true;
    }

    if (!isEnded) {
        if (s.p1.progress >= 1000 && s.p2.progress >= 1000) {
            if (s.p1.progress > s.p2.progress) { winner = game.p1; resultType = 'goal'; }
            else if (s.p2.progress > s.p1.progress) { winner = game.p2; resultType = 'goal'; }
            else { winner = 'DRAW'; }
            isEnded = true;
        } else if (s.p1.progress >= 1000) {
            winner = game.p1; resultType = 'goal'; isEnded = true;
        } else if (s.p2.progress >= 1000) {
            winner = game.p2; resultType = 'goal'; isEnded = true;
        }
    }

    if (isEnded) {
        console.log(`[GAME OVER DETECTED] 勝者: ${winner} | 決着タイプ: ${resultType}`);
        setTimeout(async () => {
            if (winner === 'DRAW') {
                io.to(roomId).emit('game_over', { winner: 'DRAW', rateChange: 0 });
            } else {
                let loser = (winner === game.p1) ? game.p2 : game.p1;
                let winChange = await updatePlayerResult(winner, true, resultType);
                let loseChange = await updatePlayerResult(loser, false, resultType);

                game.p1Socket.emit('game_over', { winner: winner, rateChange: (winner === game.p1) ? winChange : loseChange });
                game.p2Socket.emit('game_over', { winner: winner, rateChange: (winner === game.p1) ? winChange : loseChange });
            }
            delete activeGames[roomId];
        }, 2600);
    }
}

// 段階的マッチング処理 (1秒ごとに待機列を走査)
setInterval(async () => {
    if (waitingQueue.length < 2) return;

    let p1 = waitingQueue.shift();
    let p2 = waitingQueue.shift();

    let roomId = `room_${p1.username}_${p2.username}_${Date.now()}`;
    console.log(`[MATCH FOUND] ${p1.username} vs ${p2.username} -> 部屋ID: ${roomId}`);
    
    p1.socket.join(roomId);
    p2.socket.join(roomId);

    p1.socket.currentRoomId = roomId;
    p2.socket.currentRoomId = roomId;

    activeGames[roomId] = {
        p1: p1.username,
        p2: p2.username,
        p1Socket: p1.socket,
        p2Socket: p2.socket,
        p1Choice: null,
        p2Choice: null,
        turn: 1,
        p1Reserved: false,
        p2Reserved: false,
        lastEventP1: -99,
        lastEventP2: -99,
        state: {
            p1: { progress: 0, temp: 5, stoneCount: 0, cheerCount: 0, consecutiveStone: 0, noWaterCount: 0, waterHistory: [], wastePile: {sun:0,stone:0,water:0,cheer:0}, debt: 0, consecutiveNoProgress: 0 },
            p2: { progress: 0, temp: 5, stoneCount: 0, cheerCount: 0, consecutiveStone: 0, noWaterCount: 0, waterHistory: [], wastePile: {sun:0,stone:0,water:0,cheer:0}, debt: 0, consecutiveNoProgress: 0 }
        }
    };

    p1.socket.emit('assigned_player', 1);
    p1.socket.emit('match_found', {
        roomId: roomId,
        myRole: 1,
        p1: { username: p1.username, rate: p1.rate, rank: p1.rank, isHidden: true },
        p2: { username: p2.username, rate: p2.rate, rank: p2.rank, isHidden: true }
    });

    p2.socket.emit('assigned_player', 2);
    p2.socket.emit('match_found', {
        roomId: roomId,
        myRole: 2,
        p1: { username: p1.username, rate: p1.rate, rank: p1.rank, isHidden: true },
        p2: { username: p2.username, rate: p2.rate, rank: p2.rank, isHidden: true }
    });
}, 1000);

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
