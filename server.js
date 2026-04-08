// server.js
const WebSocket = require('ws');
const http = require('http');
const server = http.createServer();
const wss = new WebSocket.Server({ server });
// État du jeu
const games = new Map(); // gameCode -> { host, players, currentQuestion, answers, scores }
wss.on('connection', (ws) => {
    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        
        switch (msg.type) {
            // Le prof crée une partie
            case 'CREATE_GAME':
                const code = generateCode();
                games.set(code, {
                    host: ws,
                    players: new Map(),
                    currentQuestion: null,
                    questionStartTime: null,
                    answers: [],
                    scores: new Map()
                });
                ws.gameCode = code;
                ws.role = 'host';
                ws.send(JSON.stringify({ type: 'GAME_CREATED', code }));
                break;
            
            // Un élève rejoint
            case 'JOIN_GAME':
                const game = games.get(msg.code);
                if (game) {
                    ws.gameCode = msg.code;
                    ws.role = 'player';
                    ws.playerName = msg.name;
                    ws.playerId = generateId();
                    game.players.set(ws.playerId, { ws, name: msg.name });
                    game.scores.set(ws.playerId, 0);
                    
                    ws.send(JSON.stringify({ type: 'JOINED', playerId: ws.playerId }));
                    
                    // Notifie le prof
                    game.host.send(JSON.stringify({
                        type: 'PLAYER_JOINED',
                        playerId: ws.playerId,
                        name: msg.name,
                        playerCount: game.players.size
                    }));
                }
                break;
            
            // Le prof lance une question
            case 'START_QUESTION':
                const g = games.get(ws.gameCode);
                if (g && ws.role === 'host') {
                    g.currentQuestion = msg.questionIndex;
                    g.questionStartTime = Date.now();
                    g.answers = [];
                    g.correctAnswer = msg.correctAnswer;
                    g.timeLimit = msg.timeLimit || 20000; // 20s par défaut
                    
                    // Envoie à tous les élèves
                    g.players.forEach((player) => {
                        player.ws.send(JSON.stringify({
                            type: 'QUESTION_START',
                            questionIndex: msg.questionIndex,
                            optionCount: msg.optionCount,
                            timeLimit: g.timeLimit
                        }));
                    });
                }
                break;
            
            // Un élève répond
            case 'ANSWER':
                const gm = games.get(ws.gameCode);
                if (gm && ws.role === 'player' && gm.currentQuestion !== null) {
                    const responseTime = Date.now() - gm.questionStartTime;
                    const alreadyAnswered = gm.answers.some(a => a.playerId === ws.playerId);
                    
                    if (!alreadyAnswered && responseTime <= gm.timeLimit) {
                        const isCorrect = msg.answer === gm.correctAnswer;
                        // Points basés sur la rapidité (max 1000)
                        const points = isCorrect 
                            ? Math.round(1000 * (1 - responseTime / gm.timeLimit))
                            : 0;
                        
                        gm.answers.push({
                            playerId: ws.playerId,
                            name: ws.playerName,
                            answer: msg.answer,
                            responseTime,
                            correct: isCorrect,
                            points
                        });
                        
                        gm.scores.set(ws.playerId, (gm.scores.get(ws.playerId) || 0) + points);
                        
                        // Confirme à l'élève
                        ws.send(JSON.stringify({ type: 'ANSWER_RECEIVED' }));
                        
                        // Notifie le prof du nombre de réponses
                        gm.host.send(JSON.stringify({
                            type: 'ANSWER_COUNT',
                            count: gm.answers.length,
                            total: gm.players.size
                        }));
                    }
                }
                break;
            
            // Le prof demande les résultats
            case 'GET_RESULTS':
                const gme = games.get(ws.gameCode);
                if (gme && ws.role === 'host') {
                    // Compte par option
                    const distribution = {};
                    gme.answers.forEach(a => {
                        distribution[a.answer] = (distribution[a.answer] || 0) + 1;
                    });
                    
                    // Classement
                    const leaderboard = Array.from(gme.scores.entries())
                        .map(([id, score]) => ({
                            playerId: id,
                            name: gme.players.get(id)?.name || 'Inconnu',
                            score
                        }))
                        .sort((a, b) => b.score - a.score)
                        .slice(0, 5); // Top 5
                    
                    ws.send(JSON.stringify({
                        type: 'RESULTS',
                        distribution,
                        correctAnswer: gme.correctAnswer,
                        leaderboard,
                        answeredCount: gme.answers.length,
                        totalPlayers: gme.players.size
                    }));
                    
                    // Envoie le feedback à chaque élève
                    gme.answers.forEach(a => {
                        const playerWs = gme.players.get(a.playerId)?.ws;
                        if (playerWs) {
                            playerWs.send(JSON.stringify({
                                type: 'QUESTION_RESULT',
                                correct: a.correct,
                                points: a.points,
                                totalScore: gme.scores.get(a.playerId)
                            }));
                        }
                    });
                }
                break;
            
            // Fin de partie - podium final
            case 'END_GAME':
                const gmf = games.get(ws.gameCode);
                if (gmf && ws.role === 'host') {
                    const finalLeaderboard = Array.from(gmf.scores.entries())
                        .map(([id, score]) => ({
                            name: gmf.players.get(id)?.name || 'Inconnu',
                            score
                        }))
                        .sort((a, b) => b.score - a.score);
                    
                    // Notifie tout le monde
                    const endMsg = JSON.stringify({
                        type: 'GAME_ENDED',
                        leaderboard: finalLeaderboard
                    });
                    gmf.players.forEach(p => p.ws.send(endMsg));
                    ws.send(endMsg);
                }
                break;
        }
    });
    
    ws.on('close', () => {
        if (ws.role === 'player' && ws.gameCode) {
            const game = games.get(ws.gameCode);
            if (game) {
                game.players.delete(ws.playerId);
                game.host?.send(JSON.stringify({
                    type: 'PLAYER_LEFT',
                    playerId: ws.playerId,
                    playerCount: game.players.size
                }));
            }
        }
    });
});
function generateCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}
function generateId() {
    return Math.random().toString(36).substring(2, 12);
}
const PORT = process.env.PORT || 3000; // Utilise le port fourni par Render, sinon 3000 pour local
server.listen(PORT, () => {
    console.log(`Serveur quiz sur le port ${PORT}`);
});
