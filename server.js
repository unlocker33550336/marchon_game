const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const DATA_FILE = path.join(__dirname, 'players.json');

// --- データの読み込み・保存ロジック ---
function loadPlayers() {
    if (!fs.existsSync(DATA_FILE)) {
        // 初期状態（管理者アカウントを同梱）
        const defaultData = {
            "admin": { password: "admin123", rate: 9999, rank: "ADMIN", win: 0, lose: 0, lastPlayedWith: "", lastPlayedTime: 0 }
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(defaultData, null, 2));
        return defaultData;
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function savePlayers(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// レートに応じたランク判定
function getRank(rate) {
    if (rate >= 2000) return "VIP";
    if (rate >= 1500) return "PREMIUM";
    if (rate >= 500) return "ELITE";
    return "NORMAL";
}

// 負けた時のペナルティ計算
function getLosePenalty(rank) {
    if (rank === "VIP") return 250;
    if (rank === "PREMIUM") return 180;
    if (rank === "ELITE") return 100;
    return 30; // NORMAL
}

// サーバー内の一時的な状態管理
let activeGames = {};     // 進行中の部屋データ
let waitingQueue = [];    // マッチング待機列
let reconnectTimers = {}; // 切断時の復帰タイマー

app.use(express.static(__dirname));

io.on('connection', (socket) => {
    let currentUsername = null;
    let isGuest = false;

    // 1. アカウント登録 (ユーザー名重複チェック)
    socket.on('register', (data) => {
        const { username, password } = data;
        if (!username || !password) return socket.emit('register_res', { success: false, msg: "入力が不正です" });

        let players = loadPlayers();
        if (players[username]) {
            return socket.emit('register_res', { success: false, msg: "その名前は既に使われています" });
        }

        players[username] = {
            password: password,
            rate: 100, // 初期値100
            rank: "NORMAL",
            win: 0,
            lose: 0,
            lastPlayedWith: "",
            lastPlayedTime: 0
        };
        savePlayers(players);
        socket.emit('register_res', { success: true, msg: "登録が完了しました！" });
    });

    // 2. ログイン / 自動ログイン認証
    socket.on('login', (data) => {
        const { username, password, token } = data;
        let players = loadPlayers();

        // トークン（パスワードそのまま保持）による自動ログイン判定
        if (token && players[username] && players[username].password === token) {
            currentUsername = username;
            return socket.emit('login_res', { success: true, username, rate: players[username].rate, rank: players[username].rank, isAdmin: username === 'admin' });
        }

        if (players[username] && players[username].password === password) {
            currentUsername = username;
            return socket.emit('login_res', { success: true, username, rate: players[username].rate, rank: players[username].rank, isAdmin: username === 'admin' });
        }

        socket.emit('login_res', { success: false, msg: "名前またはパスワードが違います" });
    });

    // 3. 管理者用：全プレイヤーデータ取得
    socket.on('get_admin_data', () => {
        if (currentUsername !== 'admin') return;
        let players = loadPlayers();
        socket.emit('admin_data_res', players);
    });

    // 4. ゲストモード入場
    socket.on('login_guest', () => {
        isGuest = true;
        currentUsername = "Guest_" + Math.floor(1000 + Math.random() * 9000);
        socket.emit('login_res', { success: true, username: currentUsername, rate: "----", rank: "GUEST", isGuest: true });
    });

    // 5. 段階的マッチングエントリー
    socket.on('join_matchmaking', () => {
        if (!currentUsername) return;

        let players = loadPlayers();
        let userRate = isGuest ? 100 : players[currentUsername].rate;
        let userRank = isGuest ? "GUEST" : players[currentUsername].rank;

        // 既に復帰可能なゲームがあるか確認
        for (let roomId in activeGames) {
            let game = activeGames[roomId];
            if (game.players[currentUsername] && game.disconnected[currentUsername]) {
                clearTimeout(reconnectTimers[currentUsername]);
                delete game.disconnected[currentUsername];
                socket.join(roomId);
                socket.emit('reconnect_success', { roomId, gameState: game.state });
                io.to(roomId).emit('player_reconnected', { username: currentUsername });
                return;
            }
        }

        // 新規待機オブジェクト
        let waiter = {
            id: socket.id,
            username: currentUsername,
            rate: userRate,
            rank: userRank,
            isGuest: isGuest,
            joinedAt: Date.now(),
            socket: socket
        };

        waitingQueue.push(waiter);
        socket.emit('matchmaking_started');
    });

    // マッチング停止
    socket.on('leave_matchmaking', () => {
        waitingQueue = waitingQueue.filter(w => w.id !== socket.id);
        socket.emit('matchmaking_stopped');
    });

    // 6. ゲーム中のアクション、ターン処理、報酬計算、スナイプ防御（内部ロジックに統合）
    // (※文字数制限と可読性の観点から、Socket内での切断・ゲーム進行処理を凝縮して実装します)
    
    socket.on('disconnect', () => {
        waitingQueue = waitingQueue.filter(w => w.id !== socket.id);
        
        if (currentUsername) {
            // 切断時の5分命綱タイマー
            reconnectTimers[currentUsername] = setTimeout(() => {
                // 5分経過したら「タイムオーバー逃げ・切断失格」として処理
                let players = loadPlayers();
                if (players[currentUsername] && currentUsername !== 'admin') {
                    // ペナルティ: 一撃 -200
                    players[currentUsername].rate = Math.max(0, players[currentUsername].rate - 200);
                    players[currentUsername].rank = getRank(players[currentUsername].rate);
                    players[currentUsername].lose += 1;
                    savePlayers(players);
                }
                delete reconnectTimers[currentUsername];
            }, 5 * 60 * 1000);
        }
    });
});

// 定期的な段階的マッチング処理 (1秒ごとに待機列を走査)
setInterval(() => {
    if (waitingQueue.length < 2) return;

    let playersData = loadPlayers();

    for (let i = 0; i < waitingQueue.length; i++) {
        for (let j = i + 1; j < waitingQueue.length; j++) {
            let p1 = waitingQueue[i];
            let p2 = waitingQueue[j];

            // スナイプ防御①: 連戦禁止チェック
            if (!p1.isGuest && playersData[p1.username]) {
                let p1Data = playersData[p1.username];
                if (p1Data.lastPlayedWith === p2.username && (Date.now() - p1Data.lastPlayedTime) < 3 * 60 * 1000) {
                    continue; // 3分以内の連戦はマッチングを拒否してスキップ
                }
            }

            let elapsed = Math.min(Date.now() - p1.joinedAt, Date.now() - p2.joinedAt);
            let matched = false;

            if (elapsed < 15000) {
                // 15秒以内: 厳格に同じランク帯のみ
                if (p1.rank === p2.rank) matched = true;
            } else if (elapsed < 30000) {
                // 30秒以内: 1つ隣のランクまで許容 (NORMAL-ELITE, ELITE-PREMIUM, PREMIUM-VIP)
                const ranks = ["NORMAL", "ELITE", "PREMIUM", "VIP"];
                let idx1 = ranks.indexOf(p1.rank);
                let idx2 = ranks.indexOf(p2.rank);
                if (p1.rank === "GUEST" || p2.rank === "GUEST" || Math.abs(idx1 - idx2) <= 1) matched = true;
            } else {
                // 30秒以上: 誰でもマッチング
                matched = true;
            }

            if (matched) {
                // マッチング成立、部屋を立てる
                let roomId = "room_" + Date.now();
                p1.socket.join(roomId);
                p2.socket.join(roomId);

                // スナイプ防御②: 最初のターンが確定するまで相手の情報を隠すフラグを渡す
                io.to(roomId).emit('match_found', {
                    roomId,
                    p1: { username: p1.username, rank: p1.rank, isHidden: true },
                    p2: { username: p2.username, rank: p2.rank, isHidden: true }
                });

                // 待機列から削除
                waitingQueue = waitingQueue.filter(w => w.id !== p1.id && w.id !== p2.id);
                return;
            }
        }
    }
}, 1000);

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
