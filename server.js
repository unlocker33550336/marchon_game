// server.js (クリア判定・寒冷ペナルティ完全網羅版)
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });
app.use(express.static(__dirname));

let rooms = {
    p1: null, p2: null,
    choices: { p1: null, p2: null },
    eventsReserved: { p1: false, p2: false },
    lastEventTurn: { p1: -99, p2: -99 },
    state: {
        turn: 1,
        p1: { progress: 0, temp: 5, stoneCount: 0, cheerCount: 0, consecutiveStone: 0, noWaterCount: 0, waterHistory: [], wastePile: {sun:0,stone:0,water:0,cheer:0} },
        p2: { progress: 0, temp: 5, stoneCount: 0, cheerCount: 0, consecutiveStone: 0, noWaterCount: 0, waterHistory: [], wastePile: {sun:0,stone:0,water:0,cheer:0} }
    }
};

io.on('connection', (socket) => {
    if (!rooms.p1) { rooms.p1 = socket.id; socket.emit('assigned_player', 1); }
    else if (!rooms.p2) { rooms.p2 = socket.id; socket.emit('assigned_player', 2); io.emit('game_start'); }

    socket.on('player_move_card', (data) => {
        socket.broadcast.emit('opponent_moving_card', { player: data.player, targetZone: data.targetZone });
    });

    socket.on('send_chat', (msg) => { io.emit('receive_chat', msg); });
    socket.on('player_timeout', (data) => { io.emit('game_over_timeout', { foulPlayer: data.player }); });

    // イベント発動ボタンの電波
    socket.on('reserve_event', (data) => {
        if(data.player === 1) rooms.eventsReserved.p1 = true;
        if(data.player === 2) rooms.eventsReserved.p2 = true;
    });

    socket.on('submit_turn', (data) => {
        if (data.player === 1) rooms.choices.p1 = data.choice;
        if (data.player === 2) rooms.choices.p2 = data.choice;

        if (rooms.choices.p1 && rooms.choices.p2) {
            const nextResult = calculateOfficialLogic(rooms.choices.p1, rooms.choices.p2, rooms.state, rooms.eventsReserved, rooms.lastEventTurn);
            
            // 🌟 ゴール判定のチェック
            if(rooms.state.p1.progress >= 100 || rooms.state.p2.progress >= 100) {
                let winner = rooms.state.p1.progress >= rooms.state.p2.progress ? 1 : 2;
                io.emit('game_clear', { winner: winner });
                return;
            }

            io.emit('round_result', nextResult);
            rooms.choices.p1 = null; rooms.choices.p2 = null;
        }
    });

    socket.on('disconnect', () => {
        if (socket.id === rooms.p1) rooms.p1 = null;
        if (socket.id === rooms.p2) rooms.p2 = null;
    });
});

function calculateOfficialLogic(c1, c2, state, evReserved, lastEv) {
    // 廃棄のストック
    c1.waste.forEach(t => state.p1.wastePile[t]++);
    c2.waste.forEach(t => state.p2.wastePile[t]++);

    // 大技イベントの発動処理
    let evText = "";
    ['p1', 'p2'].forEach(pKey => {
        if(evReserved[pKey]) {
            let pData = state[pKey];
            let oppData = pKey === 'p1' ? state.p2 : state.p1;
            let maxType = 'cheer'; let maxCount = -1;
            for(let t in pData.wastePile) {
                if(pData.wastePile[t] > maxCount) { maxCount = pData.wastePile[t]; maxType = t; }
            }
            if(maxType === 'water') { pData.temp -= maxCount; evText += `★プレイヤー ${pKey==='p1'?1:2}が【天の涙】を発動！温度が ${maxCount}℃ 低下した！\\n`; }
            else if(maxType === 'stone') { oppData.progress -= maxCount; evText += `★プレイヤー ${pKey==='p1'?1:2}が【避けられぬ現実】を発動！相手を ${maxCount}% 後退させた！\\n`; }
            else if(maxType === 'sun') { pData.temp += maxCount; evText += `★プレイヤー ${pKey==='p1'?1:2}が【地獄の炎のおでむかえ】を発動！温度が ${maxCount}℃ 上昇した！\\n`; }
            else if(maxType === 'cheer') { pData.progress += (maxCount * 4); evText += `★プレイヤー ${pKey==='p1'?1:2}が【大応援】を発動！ ${maxCount * 4}% 爆速前進！\\n`; }
            
            pData.wastePile[maxType] = 0;
            lastEv[pKey] = state.turn;
            evReserved[pKey] = false;
        }
    });

    let p1Sun = c1.self.includes('sun') || c2.target.includes('sun');
    let p2Sun = c2.self.includes('sun') || c1.target.includes('sun');
    if (p1Sun) state.p1.temp += 1;
    if (p2Sun) state.p2.temp += 1;

    if (c1.self.includes('cheer')) state.p1.cheerCount++;
    if (c2.target.includes('cheer')) state.p1.cheerCount++;
    if (c2.self.includes('cheer')) state.p2.cheerCount++;
    if (c1.target.includes('cheer')) state.p2.cheerCount++;

    let p1Stone = (c1.self.includes('stone') ? 1 : 0) + (c2.target.includes('stone') ? 1 : 0);
    let p2Stone = (c2.self.includes('stone') ? 1 : 0) + (c1.target.includes('stone') ? 1 : 0);
    state.p1.stoneCount += p1Stone; state.p2.stoneCount += p2Stone;
    state.p1.consecutiveStone = p1Stone > 0 ? state.p1.consecutiveStone + 1 : 0;
    state.p2.consecutiveStone = p2Stone > 0 ? state.p2.consecutiveStone + 1 : 0;

    let p1Water = (c1.self.includes('water') ? 1 : 0) + (c2.target.includes('water') ? 1 : 0);
    let p2Water = (c2.self.includes('water') ? 1 : 0) + (c1.target.includes('water') ? 1 : 0);
    state.p1.waterHistory.push(p1Water); if(state.p1.waterHistory.length > 4) state.p1.waterHistory.shift();
    state.p2.waterHistory.push(p2Water); if(state.p2.waterHistory.length > 4) state.p2.waterHistory.shift();
    state.p1.noWaterCount = p1Water === 0 ? state.p1.noWaterCount + 1 : 0;
    state.p2.noWaterCount = p2Water === 0 ? state.p2.noWaterCount + 1 : 0;

    // P1の速度算出 (🌟 5℃未満の減速補正を追加)
    let p1Spd = 5;
    if (state.p1.temp < 5) p1Spd = Math.max(0, 5 - (5 - state.p1.temp));
    else if (state.p1.temp >= 6 && state.p1.temp <= 10) p1Spd = 7;
    else if (state.p1.temp >= 10 && state.p1.temp <= 15) p1Spd = 10;
    else if (state.p1.temp >= 15 && state.p1.temp <= 20) p1Spd = Math.max(5, 10 - (state.p1.temp - 15));
    else if (state.p1.temp >= 20) p1Spd = Math.max(0, 5 - (state.p1.temp - 20));

    if (c1.self.includes('cheer')) p1Spd += 1;
    if (c2.target.includes('cheer')) p1Spd += 1;
    if (state.p1.cheerCount > 0 && state.p1.cheerCount % 10 === 0) p1Spd += (state.p1.cheerCount * 0.5);
    if (p1Stone > 0) p1Spd -= (state.p1.consecutiveStone > 1) ? (1 + (state.p1.consecutiveStone * 0.25)) : 1;
    if (state.p1.stoneCount > 0 && state.p1.stoneCount % 10 === 0) p1Spd -= (state.p1.stoneCount * 0.5);
    if (state.p1.waterHistory.reduce((a,b)=>a+b,0) >= 3) p1Spd -= (state.p1.progress >= 80) ? 3 : 2;
    if (state.p1.noWaterCount >= 4) p1Spd -= (0.5 * (state.p1.noWaterCount - 3));

    // P2の速度算出
    let p2Spd = 5;
    if (state.p2.temp < 5) p2Spd = Math.max(0, 5 - (5 - state.p2.temp));
    else if (state.p2.temp >= 6 && state.p2.temp <= 10) p2Spd = 7;
    else if (state.p2.temp >= 10 && state.p2.temp <= 15) p2Spd = 10;
    else if (state.p2.temp >= 15 && state.p2.temp <= 20) p2Spd = Math.max(5, 10 - (state.p2.temp - 15));
    else if (state.p2.temp >= 20) p2Spd = Math.max(0, 5 - (state.p2.temp - 20));

    if (c2.self.includes('cheer')) p2Spd += 1;
    if (c1.target.includes('cheer')) p2Spd += 1;
    if (state.p2.cheerCount > 0 && state.p2.cheerCount % 10 === 0) p2Spd += (state.p2.cheerCount * 0.5);
    if (p2Stone > 0) p2Spd -= (state.p2.consecutiveStone > 1) ? (1 + (state.p2.consecutiveStone * 0.25)) : 1;
    if (state.p2.stoneCount > 0 && state.p2.stoneCount % 10 === 0) p2Spd -= (state.p2.stoneCount * 0.5);
    if (state.p2.waterHistory.reduce((a,b)=>a+b,0) >= 3) p2Spd -= (state.p2.progress >= 80) ? 3 : 2;
    if (state.p2.noWaterCount >= 4) p2Spd -= (0.5 * (state.p2.noWaterCount - 3));

    state.p1.progress += p1Spd;
    state.p2.progress += p2Spd;

    // 🌟 答え合わせ用開示ログテキストの自動生成
    let resLog = `----------------------------------------\\n` +
                 `【第 ${state.turn} ターン 結果発表】\\n` +
                 (evText ? evText : "") +
                 `■ プレイヤー1の配置:\\n  自分:[${c1.self}] 相手:[${c1.target}] 廃棄:[${c1.waste}] 保留:[${c1.keep}]\\n` +
                 `■ プレイヤー2の配置:\\n  自分:[${c2.self}] 相手:[${c2.target}] 廃棄:[${c2.waste}] 保留:[${c2.keep}]\\n` +
                 `----------------------------------------`;

    state.turn++;

    return {
        p1Progress: state.p1.progress, p2Progress: state.p2.progress,
        p1Temp: state.p1.temp, p2Temp: state.p2.temp,
        nextTurn: state.turn, keeps: { p1: c1.keep, p2: c2.keep },
        resultLog: resLog,
        p1CanEvent: (state.turn >= 15 && (state.turn - lastEv.p1 >= 10)),
        p2CanEvent: (state.turn >= 15 && (state.turn - lastEv.p2 >= 10))
    };
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {});
