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
      // 🌟【マージ】フラワーゲームの『kill（殺害）』もゴールと同等の+300ptとする
      if (resultType === 'goal' || resultType === 'kill') change = 300;
      else if (resultType === 'immobilize') change = 150;
      else if (resultType === 'timeout') change = 30; // 【タイムアップ報酬調整】5分放置タイムアップ勝ちは30pt
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

// ==========================================
// 【鉄壁のセキュリティ】ソースコードの露出を防ぐ完全個別ルーティング
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/marathon.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'marathon.html'));
});

// 🌟【マージ】フラワーゲームのルーティング追加
app.get('/flower.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'flower.html'));
});

// ==========================================
// 3. Socket.io 通信ハブゲート
// ==========================================
io.on('connection', (socket) => {
    console.log(`[SOCKET CONNECTED] 新しい回線が確立されました (SocketID: ${socket.id})`);

    // 【管理者：認証チェック ＆ 情報送出】
    socket.on('admin_auth', async (data) => {
        if (data && data.token === ADMIN_SECRET) {
            socket.join('admin_room');
            console.log(`⚡ [GM CONNECTED] 管理者がコントロールパネルに同期しました。`);
            
            try {
                const allUsers = await User.find({}, { password: 0 });
                socket.emit('admin_init_res', {
                    success: true, users: allUsers, isMatchingLocked: isMatchingLocked, activeGamesCount: Object.keys(activeGames).length
                });
            } catch (e) {
                socket.emit('admin_init_res', { success: false, msg: "ユーザーリストの取得に失敗" });
            }
        } else {
            socket.emit('admin_init_res', { success: false, msg: "不正なトークンです。閲覧権限がありません。" });
        }
    });

    // 【管理者特権：神のレート改変】
    socket.on('admin_change_rate', async (data) => {
        if (!socket.rooms.has('admin_room')) return;
        const { targetUser, newRate } = data;
        try {
            const user = await User.findOne({ username: targetUser });
            if (user) {
                user.rate = parseInt(newRate) || 0; user.rank = getRank(user.rate); await user.save();
                console.log(`⚡ [GM ACTION] ${targetUser} のレートを ${newRate}pt に書き換えました。`);
                const allUsers = await User.find({}, { password: 0 });
                io.to('admin_room').emit('admin_update_list', { users: allUsers, activeGamesCount: Object.keys(activeGames).length });
            }
        } catch (e) { console.error("レート神改変エラー:", e); }
    });

    // 【管理者特権：走者BAN（データ物理削除）】
    socket.on('admin_ban_user', async (data) => {
        if (!socket.rooms.has('admin_room')) return;
        const { targetUser } = data;
        try {
            await User.deleteOne({ username: targetUser });
            console.log(`🚨 [GM ACTION] ユーザー [${targetUser}] をプラットフォームから永久追放しました。`);
            const allUsers = await User.find({}, { password: 0 });
            io.to('admin_room').emit('admin_update_list', { users: allUsers, activeGamesCount: Object.keys(activeGames).length });
        } catch (e) { console.error("BAN執行エラー:", e); }
    });

    // 【管理者特権：マッチング緊急ロック切り替え】
    socket.on('admin_toggle_lock', () => {
        if (!socket.rooms.has('admin_room')) return;
        isMatchingLocked = !isMatchingLocked;
        console.log(`⚡ [GM ACTION] マッチングロック状態を切り替えました: ${isMatchingLocked}`);
        io.to('admin_room').emit('admin_lock_status', { isMatchingLocked: isMatchingLocked });
    });

    // 【新規登録】
    socket.on('register', async (data) => {
        console.log('[SIGNAL RECEIVED] register イベントを受信しました:', data);
        const { username, password } = data;
        
        if (!username || !password) return socket.emit('register_res', { success: false, msg: "識別名とパスワードを入力してください" });
        if (username.toLowerCase() === 'admin') return socket.emit('register_res', { success: false, msg: "その識別名はシステム予約済みです" });
        
        try {
            console.log(`-> [DB QUERY] 既存のユーザー [${username}] を検索中...`);
            const exists = await User.findOne({ username });
            if (exists) return socket.emit('register_res', { success: false, msg: "その識別名は既に使用されています" });
            
            console.log(`-> [DB INSERT] 新しいユーザー [${username}] を書き込み中...`);
            await User.create({ username, password, rate: 100, rank: "NORMAL", win: 0, lose: 0 });
            console.log(`✅ [REGISTER SUCCESS] ユーザー [${username}] の作成が完了しました`);
            socket.emit('register_res', { success: true, msg: "中央システムへの走者登録が完了しました！" });
        } catch (err) {
            console.error('❌ [REGISTER CRASH] 新規登録処理中にエラーが発生しました:', err);
            socket.emit('register_res', { success: false, msg: "サーバーエラー（DB書き込み失敗）" });
        }
    });

    // 【ログイン】
    socket.on('login', async (data) => {
        console.log('[SIGNAL RECEIVED] login イベントを受信しました:', data ? data.username : "データなし");
        const { username, password, token } = data;
        
        if (username === 'admin') {
            if (password === 'adminpassword' || token === ADMIN_SECRET) {
                console.log(`⚡ [ADMIN LOGIN SUCCESS] 管理者権限を識別。裏口トークンを発行します。`);
                return socket.emit('login_res', { success: true, username: 'admin', isAdmin: true, token: ADMIN_SECRET });
            } else return socket.emit('login_res', { success: false, msg: "管理者パスワードが不正です" });
        }

        try {
            console.log(`-> [DB QUERY] ユーザー [${username}] の認証情報を検索中...`);
            const user = await User.findOne({ username });
            if (user) {
                if ((token && user.password === token) || (password && user.password === password)) {
                    userSocketMap[username] = socket.id; socketUserMap[socket.id] = username;
                    console.log(`✅ [LOGIN SUCCESS] ユーザー [${username}] の認証に成功しました`);
                    
                    // 🔄【自動再入場システム】画面遷移後に部屋(Room)に自動復帰させる
                    for (let rId in activeGames) {
                        if (activeGames[rId].p1 === username || activeGames[rId].p2 === username) {
                            socket.join(rId);
                            let myRole = (activeGames[rId].p1 === username) ? 1 : 2;
                            socket.emit('assigned_player', myRole);
                            console.log(`🔄 [ROOM REJOIN] 試合中の走者 [${username}] が新しい回線で部屋 [${rId}] に自動復帰しました。`);
                            break;
                        }
                    }
                    return socket.emit('login_res', { success: true, username, rate: user.rate, rank: user.rank, win: user.win, lose: user.lose, token: user.password });
                }
            }
            console.log(`-> [LOGIN FAILED] ユーザー [${username}] の認証に失敗しました`);
            socket.emit('login_res', { success: false, msg: "走者識別名またはパスワードが不正です" });
        } catch (err) {
            console.error('❌ [LOGIN CRASH] ログイン処理中にエラーが発生しました:', err);
            socket.emit('login_res', { success: false, msg: "サーバー接続エラー" });
        }
    });

    // 【ゲストログイン】
    socket.on('login_guest', () => {
        let guestName = "Guest_" + Math.floor(1000 + Math.random() * 9000);
        userSocketMap[guestName] = socket.id; socketUserMap[socket.id] = guestName;
        console.log(`👤 [GUEST ENTER] ゲスト [${guestName}] が入場しました`);
        
        for (let rId in activeGames) {
            if (activeGames[rId].p1 === guestName || activeGames[rId].p2 === guestName) {
                socket.join(rId);
                let myRole = (activeGames[rId].p1 === guestName) ? 1 : 2;
                socket.emit('assigned_player', myRole);
                break;
            }
        }
        socket.emit('login_res', { success: true, username: guestName, rate: "----", rank: "GUEST", isGuest: true, token: guestName });
    });

    // 【マッチングエントリー】
    socket.on('join_matchmaking', async (data) => {
        if (isMatchingLocked) {
            return socket.emit('matchmaking_error', { msg: "現在サーバーメンテナンスのため、公式マッチングの受付は一時的にロックされています。" });
        }
        const username = socketUserMap[socket.id];
        if (!username) return socket.emit('matchmaking_error', { msg: "セッションが切断されています。再ログインしてください" });

        const { gameId } = data;
        console.log(`[QUEUE ATTEMPT] ${username} がゲーム [${gameId}] の待機列にエントリーを要求`);
        if (!gameId) return socket.emit('matchmaking_error', { msg: "対象 of ゲーム種別IDが不明です" });
        if (!gameQueues[gameId]) { gameQueues[gameId] = []; }

        let isAlreadyQueued = false;
        for (let gId in gameQueues) {
            if (gameQueues[gId].some(w => w.username === username)) { isAlreadyQueued = true; break; }
        }
        if (isAlreadyQueued) return socket.emit('matchmaking_error', { msg: "既にいずれかのゲームでマッチング探索中です" });

        let userRate = 100; let userRank = "NORMAL";
        try {
            const user = await User.findOne({ username });
            if (user) { userRate = user.rate; userRank = user.rank; }
        } catch (e) { console.error("[QUEUE DB WARNING] マッチング時のレート取得に失敗:", e); }

        gameQueues[gameId].push({ id: socket.id, username: username, rate: userRate, rank: userRank, socket: socket });
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

    // 【チャット通信ハブ】
    socket.on('send_chat', (msg) => {
        let roomId = null; const username = socketUserMap[socket.id]; if (!username) return;
        for (let rId in activeGames) { if (activeGames[rId].p1 === username || activeGames[rId].p2 === username) { roomId = rId; break; } }
        if (roomId) { io.to(roomId).emit('receive_chat', msg); }
    });


    // ==========================================
    // 🪻 FLOWER GAME 専用イベントシステム
    // ==========================================
    socket.on('flower_submit_placement', (data) => {
        const username = socketUserMap[socket.id]; if (!username) return;
        let roomId = null; for (let rId in activeGames) { if (activeGames[rId].gameId === 'flower' && (activeGames[rId].p1 === username || activeGames[rId].p2 === username)) { roomId = rId; break; } }
        if (!roomId) return;
        const game = activeGames[roomId]; const s = game.state;
        
        if (s.florist !== data.player) return; // 権限チェック
        
        s.currentPlacement = { cards: data.cards, labels: data.labels };
        // チョイス側へラベル情報のみを送信
        socket.to(roomId).emit('flower_opponent_placed', { labels: data.labels });
    });

    socket.on('flower_submit_choice', async (data) => {
        const username = socketUserMap[socket.id]; if (!username) return;
        let roomId = null; for (let rId in activeGames) { if (activeGames[rId].gameId === 'flower' && (activeGames[rId].p1 === username || activeGames[rId].p2 === username)) { roomId = rId; break; } }
        if (!roomId) return;
        const game = activeGames[roomId]; const s = game.state;

        if (s.choice !== data.player) return; // 権限チェック
        
        const idx = data.choiceIndex;
        const selectedCard = s.currentPlacement.cards[idx];
        let targetPlayerState = (s.choice === 1) ? s.p1 : s.p2;
        let pName = (s.choice === 1) ? game.p1 : game.p2;

        let logMsg = ``;
        // カードの効果適用（環境支配・相殺ルール）
        if (selectedCard === 'sun') {
            targetPlayerState.love += 5;
            logMsg = `★${pName} は [愛の花] を選んだ。（愛の花 +5輪）`;
        } else if (selectedCard === 'stone') {
            targetPlayerState.dead += 1;
            let killedLove = Math.min(2, targetPlayerState.love);
            targetPlayerState.love -= killedLove;
            logMsg = `💀${pName} は [死の花] を引いてしまった！（死の花 +1輪 / 愛の花 -${killedLove}輪）`;
        } else if (selectedCard === 'seed') {
            if (targetPlayerState.love > targetPlayerState.dead) {
                targetPlayerState.love += 15;
                logMsg = `🌱${pName} の部屋は愛に満ちていた。種は [15輪の愛の花] として咲き誇った！`;
            } else {
                targetPlayerState.dead += 15;
                logMsg = `☠️${pName} の部屋は毒に侵されていた。種は [15輪の死の花] として狂い咲いた...！`;
            }
        }

        io.to(roomId).emit('flower_phase_result', {
            selectedIndex: idx, cardType: selectedCard, p1: s.p1, p2: s.p2, log: logMsg
        });

        // ターンとフェーズの進行処理
        setTimeout(async () => {
            if (s.phase === 1) {
                s.phase = 2; s.florist = 2; s.choice = 1;
                io.to(roomId).emit('flower_start_phase', { florist: s.florist, choice: s.choice, turn: s.turn, phase: s.phase });
            } else {
                // 1ターン完了！スリップダメージと生死判定
                let d1 = s.p1.dead; let d2 = s.p2.dead;
                if(d1 > 0) s.p1.life -= Math.pow(1.2, d1);
                if(d2 > 0) s.p2.life -= Math.pow(1.2, d2);

                let p1DeathCause = null; let p2DeathCause = null;
                if (s.p1.love >= 100) p1DeathCause = "窒息中毒死"; else if (s.p1.life <= 0) p1DeathCause = "猛毒ショック死";
                if (s.p2.love >= 100) p2DeathCause = "窒息中毒死"; else if (s.p2.life <= 0) p2DeathCause = "猛毒ショック死";

                let turnLog = `【第 ${s.turn} ターン終了】\n`;
                if(d1 > 0) turnLog += `・${game.p1} は毒に蝕まれている。(残命: ${Math.max(0, s.p1.life).toFixed(1)}%)\n`;
                if(d2 > 0) turnLog += `・${game.p2} は毒に蝕まれている。(残命: ${Math.max(0, s.p2.life).toFixed(1)}%)\n`;

                io.to(roomId).emit('flower_turn_end_result', { p1: s.p1, p2: s.p2, log: turnLog });

                let isGameOver = false; let winner = 'DRAW'; let reason = 'kill';

                if (p1DeathCause || p2DeathCause) {
                    isGameOver = true;
                    if (p1DeathCause && p2DeathCause) winner = 'DRAW';
                    else if (p1DeathCause) winner = game.p2;
                    else winner = game.p1;
                } else if (s.turn >= 10) {
                    isGameOver = true; reason = 'goal';
                    if (s.p1.love > s.p2.love) winner = game.p1;
                    else if (s.p2.love > s.p1.love) winner = game.p2;
                }

                if (isGameOver) {
                    let r1 = await processPlatformRate(game.p1, winner===game.p1, reason);
                    let r2 = await processPlatformRate(game.p2, winner===game.p2, reason);
                    if(userSocketMap[game.p1]) io.to(userSocketMap[game.p1]).emit('platform_game_over', { winner, rateChange: (winner===game.p1)?r1.rateChange:r2.rateChange, newRate: r1.currentRate, newRank: r1.currentRank });
                    if(userSocketMap[game.p2]) io.to(userSocketMap[game.p2]).emit('platform_game_over', { winner, rateChange: (winner===game.p2)?r2.rateChange:r1.rateChange, newRate: r2.currentRate, newRank: r2.currentRank });
                    delete activeGames[roomId];
                } else {
                    s.turn++; s.phase = 1; s.florist = 1; s.choice = 2;
                    io.to(roomId).emit('flower_start_phase', { florist: s.florist, choice: s.choice, turn: s.turn, phase: s.phase });
                }
            }
        }, 2000);
    });

    socket.on('flower_player_timeout', async (data) => {
        const username = socketUserMap[socket.id]; let roomId = null;
        for (let rId in activeGames) { if (activeGames[rId].p1 === username || activeGames[rId].p2 === username) { roomId = rId; break; } }
        if (!roomId) return; const game = activeGames[roomId];
        let opponent = (data.player === 1) ? game.p2 : game.p1; let loserName = (data.player === 1) ? game.p1 : game.p2;
        let oppResult = await processPlatformRate(opponent, true, 'timeout'); let loserResult = await processPlatformRate(loserName, false, 'timeout');
        if (userSocketMap[game.p1]) io.to(userSocketMap[game.p1]).emit('platform_game_over', { winner: opponent, rateChange: (opponent === game.p1) ? oppResult.rateChange : loserResult.rateChange, newRate: (game.p1 === opponent) ? oppResult.currentRate : loserResult.currentRate, newRank: (game.p1 === opponent) ? oppResult.currentRank : loserResult.currentRank });
        if (userSocketMap[game.p2]) io.to(userSocketMap[game.p2]).emit('platform_game_over', { winner: opponent, rateChange: (opponent === game.p2) ? oppResult.rateChange : loserResult.rateChange, newRate: (game.p2 === opponent) ? oppResult.currentRate : loserResult.currentRate, newRank: (game.p2 === opponent) ? oppResult.currentRank : loserResult.currentRank });
        delete activeGames[roomId];
    });


    // ==========================================
    // 🏃 THE MARATHON 専用イベントシステム（完全復元）
    // ==========================================
    
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
        console.log(`⚡ [EVENT RESERVED] 部屋 ${roomId} | プレイヤー ${data.player} がイベントを発動予約しました`);
    });

    // 【カード移動同期パケット中継】
    socket.on('player_move_card', (data) => {
        const username = socketUserMap[socket.id];
        if (!username) return;
        let roomId = null;
        for (let rId in activeGames) {
            if (activeGames[rId].p1 === username || activeGames[rId].p2 === username) { roomId = rId; break; }
        }
        if (roomId) { socket.to(roomId).emit('opponent_moving_card', data); }
    });

    // 🌟【最核心】ターン確定同期集計 ＆ 5連続停止デスルール計算
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

        console.log(`📥 [TURN SUBMITTED] 部屋 ${roomId} | 走者 ${data.player} (${username}) が配置確定パケットを送信`);

        if (s.p1Choice && s.p2Choice) {
            console.log(`⚔️ [ROUND CALCULATION] 両走者の配置データが完全同期。数理エンジンの計算フェーズを開始します。`);
            
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

            // 4. 通常カード配置・シナジー計算
            let p1Sun = s.p1Choice.self.includes('sun') || s.p2Choice.target.includes('sun');
            let p2Sun = s.p2Choice.self.includes('sun') || s.p1Choice.target.includes('sun');
            if (p1Sun) s.p1.temp++; if (p2Sun) s.p2.temp++;

            // P1基本速度
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

            // P2基本速度
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

            // 5. 壁の相殺・デバフ累積処理
            if (p1Spd < 0) { s.p1.debt += Math.abs(p1Spd); p1Spd = 0; }
            else if (s.p1.debt > 0) { if (p1Spd >= s.p1.debt) { p1Spd -= s.p1.debt; s.p1.debt = 0; } else { s.p1.debt -= p1Spd; p1Spd = 0; } }

            if (p2Spd < 0) { s.p2.debt += Math.abs(p2Spd); p2Spd = 0; }
            else if (s.p2.debt > 0) { if (p2Spd >= s.p2.debt) { p2Spd -= s.p2.debt; s.p2.debt = 0; } else { s.p2.debt -= p2Spd; p2Spd = 0; } }

            // 🌟【連続停止カウンター】5連続進捗ゼロ（行動不能ルール）の厳密判定
            s.p1.consecutiveNoProgress = (p1Spd === 0) ? (s.p1.consecutiveNoProgress + 1) : 0;
            s.p2.consecutiveNoProgress = (p2Spd === 0) ? (s.p2.consecutiveNoProgress + 1) : 0;

            // 6. 進捗加算
            s.p1.progress += p1Spd;
            s.p2.progress += p2Spd;

            // 🌟【美学の執行】数値・温度ネタバレ完全隠蔽ソリッドログ
            let resultLog = `${evText}【第 ${s.turn} ターン終了】\n・${game.p1}：現在位置 [${s.p1.progress}%]\n・${game.p2}：現在位置 [${s.p2.progress}%]`;

            s.turn++;
            let nextP1CanEvent = (s.turn >= 15 && (s.turn - s.lastEventP1 >= 10));
            let nextP2CanEvent = (s.turn >= 15 && (s.turn - s.lastEventP2 >= 10));
            let keepsData = { p1: s.p1Choice.keep, p2: s.p2Choice.keep };

            let isGameOver = false;
            let winnerName = 'DRAW';
            let endReason = 'goal';

            // 行動不能（immobilize：5ターン連続停止）による決着トリガー
            let p1Immobilized = (s.p1.consecutiveNoProgress >= 5);
            let p2Immobilized = (s.p2.consecutiveNoProgress >= 5);

            if (p1Immobilized || p2Immobilized) {
                isGameOver = true;
                endReason = 'immobilize';
                if (p1Immobilized && p2Immobilized) winnerName = 'DRAW';
                else if (p1Immobilized) winnerName = game.p2;
                else winnerName = game.p1;
            } 
            // 通常ゴール（goal：1000%到達）による決着トリガー
            else if (s.p1.progress >= 1000 || s.p2.progress >= 1000) {
                isGameOver = true;
                endReason = 'goal';
                if (s.p1.progress >= 1000 && s.p2.progress >= 1000) {
                    if (s.p1.progress > s.p2.progress) winnerName = game.p1;
                    else if (s.p2.progress > s.p1.progress) winnerName = game.p2;
                } else if (s.p1.progress >= 1000) winnerName = game.p1;
                else winnerName = game.p2;
            }

            // クライアント側へ結果データをパケット送信して画面ロックを解除
            io.to(roomId).emit('round_result', {
                nextTurn: s.turn, p1Progress: s.p1.progress, p2Progress: s.p2.progress,
                p1Temp: s.p1.temp, p2Temp: s.p2.temp, p1Debt: s.p1.debt, p2Debt: s.p2.debt,
                resultLog: resultLog, p1CanEvent: nextP1CanEvent, p2CanEvent: nextP2CanEvent,
                activeEvent: activeEvent, eventSender: eventSender, p1ChoiceRaw: s.p1Choice, p2ChoiceRaw: s.p2Choice, keeps: keepsData
            });

            // 決着時のインフラDB・プラットフォーム共通レート一斉更新
            if (isGameOver) {
                console.log(`🏁 [GAME OVER] 部屋 ${roomId} の数理決着を検知。理由: ${endReason} | 勝者: ${winnerName}`);
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

                let p1SocketId = userSocketMap[p1Name]; let p2SocketId = userSocketMap[p2Name];
                if (p1SocketId) { io.to(p1SocketId).emit('platform_game_over', { winner: winnerName, rateChange: (winnerName === p1Name) ? p1Result.rateChange : p2Result.rateChange, newRate: p1Result.currentRate, newRank: p1Result.currentRank }); }
                if (p2SocketId) { io.to(p2SocketId).emit('platform_game_over', { winner: winnerName, rateChange: (winnerName === p2Name) ? p2Result.rateChange : p1Result.rateChange, newRate: p2Result.currentRate, newRank: p2Result.currentRank }); }
                delete activeGames[roomId];
            }

            s.p1Choice = null;
            s.p2Choice = null;
        }
    });

    // 【ゲーム終了申告フォールバックゲート】
    socket.on('submit_game_end', async (data) => {
        const username = socketUserMap[socket.id];
        console.log(`[GAME END SIGNAL] ${username} から勝敗確定要求を受信:`, data);
        let roomId = null; for (let rId in activeGames) { if (activeGames[rId].p1 === username || activeGames[rId].p2 === username) { roomId = rId; break; } }
        if (!roomId) return console.log('-> [ERROR] 該当するアクティブな部屋が見つかりません'); 
        
        const game = activeGames[roomId]; if (game.isProcessingResult) return console.log('-> [WARNING] 既にリザルト計算が実行中です'); 
        game.isProcessingResult = true;

        const { winnerUsername, resultType } = data;
        let p1Name = game.p1; let p2Name = game.p2; let p1Result = null; let p2Result = null;

        if (winnerUsername === 'DRAW') {
            p1Result = await processPlatformRate(p1Name, false, 'draw'); p2Result = await processPlatformRate(p2Name, false, 'draw');
        } else if (winnerUsername === p1Name) {
            p1Result = await processPlatformRate(p1Name, true, resultType); p2Result = await processPlatformRate(p2Name, false, resultType);
        } else if (winnerUsername === p2Name) {
            p1Result = await processPlatformRate(p1Name, false, resultType); p2Result = await processPlatformRate(p2Name, true, resultType);
        }

        let p1SocketId = userSocketMap[p1Name]; let p2SocketId = userSocketMap[p2Name];
        if (p1SocketId) { io.to(p1SocketId).emit('platform_game_over', { winner: winnerUsername, rateChange: (winnerUsername === p1Name) ? p1Result.rateChange : p2Result.rateChange, newRate: p1Result.currentRate, newRank: p1Result.currentRank }); }
        if (p2SocketId) { io.to(p2SocketId).emit('platform_game_over', { winner: winnerUsername, rateChange: (winnerUsername === p2Name) ? p2Result.rateChange : p1Result.rateChange, newRate: p2Result.currentRate, newRank: p2Result.currentRank }); }
        console.log(`[ROOM DELETED] 部屋 ${roomId} のゲーム結果処理が完了したため削除します`);
        delete activeGames[roomId];
    });

    // 🌟【タイムアップ専用窓口】5分時間切れ時、勝者に正確に 30ポイントだけを配給する専用インフラ処理
    socket.on('player_timeout', async (data) => {
        const username = socketUserMap[socket.id];
        console.log(`🚨 [TIME OUT DETECTION] 走者 ${username} が制限時間内に配置を確定できませんでした。`);
        let roomId = null;
        for (let rId in activeGames) { if (activeGames[rId].p1 === username || activeGames[rId].p2 === username) { roomId = rId; break; } }
        if (!roomId) return;
        
        const game = activeGames[roomId];
        let opponent = (data.player === 1) ? game.p2 : game.p1;
        let loserName = (data.player === 1) ? game.p1 : game.p2;
        
        // 勝者側・敗者側に 'timeout' 専用シグナルを飛ばしてDBを書き換え
        let oppResult = await processPlatformRate(opponent, true, 'timeout');
        let loserResult = await processPlatformRate(loserName, false, 'timeout');

        let p1SocketId = userSocketMap[game.p1]; let p2SocketId = userSocketMap[game.p2];
        if (p1SocketId) {
            io.to(p1SocketId).emit('platform_game_over', {
                winner: opponent, rateChange: (opponent === game.p1) ? oppResult.rateChange : loserResult.rateChange,
                newRate: (game.p1 === opponent) ? oppResult.currentRate : loserResult.currentRate,
                newRank: (game.p1 === opponent) ? oppResult.currentRank : loserResult.currentRank
            });
        }
        if (p2SocketId) {
            io.to(p2SocketId).emit('platform_game_over', {
                winner: opponent, rateChange: (opponent === game.p2) ? oppResult.rateChange : loserResult.rateChange,
                newRate: (game.p2 === opponent) ? oppResult.currentRate : loserResult.currentRate,
                newRank: (game.p2 === opponent) ? oppResult.currentRank : loserResult.currentRank
            });
        }
        delete activeGames[roomId];
    });


    // ==========================================
    // 🌐 共通切断処理ゲート
    // ==========================================
    socket.on('disconnect', () => {
        const username = socketUserMap[socket.id];
        console.log(`[SOCKET DISCONNECTED] 回線が切断されました: ${username || "未ログインの接続"}`);
        for (let gameId in gameQueues) { gameQueues[gameId] = gameQueues[gameId].filter(w => w.id !== socket.id); }
        delete socketUserMap[socket.id];

        if (username && username !== 'admin' && !username.startsWith('Guest_')) {
            let isInGame = false; let userRoomId = null;
            for (let rId in activeGames) { if (activeGames[rId].p1 === username || activeGames[rId].p2 === username) { isInGame = true; userRoomId = rId; break; } }
            
            if (isInGame) {
                console.log(`⚠️ [RECONNECT TIMER] 試合中走者 [${username}] の回線切断を検知。5分間の復帰待機タイマーを始動します。`);
                reconnectTimers[username] = setTimeout(async () => {
                    console.log(`🚨 [TIMEOUT PENALTY] ${username} が5分以内に復帰しなかったため脱走・失格処理を執行します`);
                    try {
                        const user = await User.findOne({ username });
                        if (user) { user.rate = Math.max(0, user.rate - 200); user.lose += 1; user.rank = getRank(user.rate); await user.save(); }
                    } catch (e) { console.error("ペナルティDB更新エラー:", e); }

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
            } else {
                console.log(`-> [LOGOUT CLEARED] ${username} は非戦闘状態のため、安全に切断処理を行いました。`);
            }
        }
    });
});

// ==========================================
// 4. マッチングシステムループ（初期ステータスの完全注入）
// ==========================================
setInterval(async () => {
    for (let gameId in gameQueues) {
        let queue = gameQueues[gameId];
        if (queue.length < 2) continue;

        let p1 = queue.shift();
        let p2 = queue.shift();
        let roomId = `room_${gameId}_${p1.username}_${p2.username}_${Date.now()}`;
        console.log(`⚔️ [MATCH FOUND] 試合成立しました！部屋ID: ${roomId} (${p1.username} vs ${p2.username})`);
        
        p1.socket.join(roomId);
        p2.socket.join(roomId);

        // ゲーム種別に応じた初期ステートの注入
        if (gameId === 'flower') {
            activeGames[roomId] = { 
                gameId: 'flower', p1: p1.username, p2: p2.username, isProcessingResult: false,
                state: {
                    turn: 1, phase: 1, florist: 1, choice: 2,
                    p1: { love: 0, dead: 0, life: 100 }, p2: { love: 0, dead: 0, life: 100 },
                    currentPlacement: { cards: [], labels: [] }
                } 
            };
        } else if (gameId === 'marathon') {
            activeGames[roomId] = { 
                gameId: 'marathon', p1: p1.username, p2: p2.username, isProcessingResult: false, 
                state: {
                    turn: 1, lastEventP1: -99, lastEventP2: -99, p1Reserved: false, p2Reserved: false,
                    p1: { progress: 0, temp: 5, stoneCount: 0, cheerCount: 0, wastePile: {sun:0,stone:0,water:0,cheer:0}, debt: 0, consecutiveNoProgress: 0 },
                    p2: { progress: 0, temp: 5, stoneCount: 0, cheerCount: 0, wastePile: {sun:0,stone:0,water:0,cheer:0}, debt: 0, consecutiveNoProgress: 0 },
                    p1Choice: null, p2Choice: null
                } 
            };
        }

        p1.socket.emit('assigned_player', 1);
        p2.socket.emit('assigned_player', 2);

        io.to(roomId).emit('platform_match_found', {
            roomId: roomId, gameId: gameId,
            p1: { username: p1.username, rate: p1.rate, rank: p1.rank },
            p2: { username: p2.username, rate: p2.rate, rank: p2.rank }
        });

        // FLOWER GAME の場合は少し遅延させて第1フェーズ開始シグナルを送信
        if (gameId === 'flower') {
            setTimeout(() => {
                io.to(roomId).emit('flower_start_phase', { florist: 1, choice: 2, turn: 1, phase: 1 });
            }, 1000);
        }
    }
}, 1000);

// ==========================================
// 5. 同期型・データベース接続＆サーバー起動システム
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
  } catch (err) { 
    console.error('❌ [DB CRITICAL ERROR] データベース接続に失敗したため、サーバーの起動を非常停止しました:');
    console.error(err); 
  }
}

startSecurePlatform();
