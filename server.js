// server.js (Node.js + Socket.io を使った対戦管理サーバーの例)
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname)); // HTMLファイルを置く場所

let rooms = {
    p1: null, p2: null,
    choices: { p1: null, p2: null },
    state: {
        turn: 1,
        p1: { progress: 0, temp: 5, stoneCount: 0, cheerCount: 0, consecutiveStone: 0, noWaterCount: 0, waterHistory: [] },
        p2: { progress: 0, temp: 5, stoneCount: 0, cheerCount: 0, consecutiveStone: 0, noWaterCount: 0, waterHistory: [] }
    }
};

io.on('connection', (socket) => {
    // 空いているプレイヤー枠（1か2）に割り当て
    if (!rooms.p1) {
        rooms.p1 = socket.id;
        socket.emit('assigned_player', 1);
    } else if (!rooms.p2) {
        rooms.p2 = socket.id;
        socket.emit('assigned_player', 2);
        // 2人揃ったらゲーム開始の合図を送る
        io.emit('game_start');
    }

    // プレイヤーからカードの配置データを受け取った時
    socket.on('submit_turn', (data) => {
        if (data.player === 1) rooms.choices.p1 = data.choice;
        if (data.player === 2) rooms.choices.p2 = data.choice;

        // 両者の配置データがサーバーに揃ったら計算開始！
        if (rooms.choices.p1 && rooms.choices.p2) {
            const resultData = calculateOnlineLogic(rooms.choices.p1, rooms.choices.p2, rooms.state);
            
            // 計算結果を2人の画面へ同時に送り返す（同期）
            io.emit('round_result', resultData);
            
            // 次のターンのために選択データを初期化
            rooms.choices.p1 = null;
            rooms.choices.p2 = null;
        }
    });

    socket.on('disconnect', () => {
        if (socket.id === rooms.p1) rooms.p1 = null;
        if (socket.id === rooms.p2) rooms.p2 = null;
    });
});

// ここに手書きノートの裏計算ロジック（水・石・太陽の処理）をすべて詰め込み、サーバー側で安全に計算させる
function calculateOnlineLogic(c1, c2, state) {
    // (中略: さっきのHTML内の計算ロジックをここに移植して、改ざんできない安全な計算結果ログを作ります)
    state.turn++;
    return {
        p1Progress: state.p1.progress,
        p2Progress: state.p2.progress,
        nextTurn: state.turn,
        keeps: { p1: c1.keep, p2: c2.keep },
        resultLog: "第" + (state.turn - 1) + "ターンの結果が通信同期されました！\\n"
    };
}

http.listen(3000, () => {
    console.log('THE MARATHON 対戦サーバーがポート3000で起動したぞ！');
});