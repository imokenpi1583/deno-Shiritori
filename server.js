// server.js
import { serveDir } from "jsr:@std/http/file-server";

const kv = await Deno.openKv();

//部屋ごとにプレイヤーと観戦者をメモリ管理する格納庫
const rooms = {};

// ロビー接続を管理するオブジェクト
const lobbyRooms = {};

// 対戦に必要なプレイヤー数（3人目以降は観戦者になる）
const MAX_PLAYERS = 2;

const toHiragana = (str) => {
    return str.replace(/[\u30a1-\u30f6]/g, (match) => {
        return String.fromCharCode(match.charCodeAt(0) - 0x60);
    });
};

// 2回以上連続する伸ばし棒「ー」を1回に圧縮する（サーバー内の複数箇所で使う共通処理）
const compressChouon = (str) => {
    return str.replace(/ー+/g, "ー");
};

const getNextChar = (word) => {
    if (!word) return "";

    // 1. 伸ばし棒の連続を圧縮
    const cleaned = compressChouon(word);

    // 2. 末尾の文字を取得
    let lastChar = cleaned.slice(-1);

    // 3. 末尾が伸ばし棒なら、その1つ前の文字を取得
    if (lastChar === "ー" && cleaned.length > 1) {
        lastChar = cleaned.slice(-2, -1);
    }

    // 4. 平仮名に変換
    let nextChar = toHiragana(lastChar);

    // 5. 小文字（ぁ、ゃ 等）を大文字（あ、や 等）に変換
    const smallToLarge = {
        "ぁ": "あ",
        "ぃ": "い",
        "ぅ": "う",
        "ぇ": "え",
        "ぉ": "お",
        "ゃ": "や",
        "ゅ": "ゆ",
        "ょ": "よ",
        "っ": "つ",
    };
    if (smallToLarge[nextChar]) {
        nextChar = smallToLarge[nextChar];
    }

    return nextChar;
};

// 全員にJSONデータを送るヘルパー関数（roomNameをしっかり受け取って処理）
function broadcast(data, roomData, roomName) {
    const room = rooms[roomName];
    if (!room) return;

    room.connectedClients.forEach((client, index) => {
        if (client.readyState === WebSocket.OPEN) {
            const isYourTurn = index === roomData.turnIndex;
            client.send(JSON.stringify({
                ...data,
                isYourTurn: isYourTurn,
                role: "player",
            }));
        }
    });

    room.spectators.forEach((spectator) => {
        if (spectator.readyState === WebSocket.OPEN) {
            spectator.send(JSON.stringify({
                ...data,
                isYourTurn: false,
                role: "spectator",
            }));
        }
    });
}

// ロビーにいる全員に現在の人数を伝える関数
function broadcastLobbyStatus(roomName) {
    const clients = lobbyRooms[roomName];
    if (!clients) return;

    const message = JSON.stringify({
        type: "lobby_status",
        count: clients.length,
    });

    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// ロビーにいる全員ゲーム開始を伝えてplay.htmlに遷移させる関数
function broadcastLobbyStart(roomName) {
    const clients = lobbyRooms[roomName];
    if (!clients) return;

    const message = JSON.stringify({
        type: "start_game",
    });

    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function broadcastGameOver(
    loserSocket,
    loserMessage,
    winnerMessage,
    wordCount,
    roomName,
) {
    const room = rooms[roomName];
    if (!room) return;

    //敗者に送信
    loserSocket.send(JSON.stringify({
        "type": "gameover",
        "result": "lose",
        "role": "player",
        "errorMessage": loserMessage,
        "wordCount": wordCount,
    }));

    //勝者に送信
    room.connectedClients.forEach((client) => {
        if (
            client !== loserSocket &&
            client.readyState === WebSocket.OPEN
        ) {
            client.send(JSON.stringify({
                "type": "gameover",
                "result": "win",
                "role": "player",
                "errorMessage": winnerMessage,
                "wordCount": wordCount,
            }));
        }
    });

    //観戦者に送信
    room.spectators.forEach((spectator) => {
        if (spectator.readyState === WebSocket.OPEN) {
            spectator.send(JSON.stringify({
                "type": "gameover",
                "role": "spectator",
                "errorMessage": "試合が終了しました！",
                "wordCount": wordCount,
            }));
        }
    });
}

function logRoomStatus(roomName) {
    const room = rooms[roomName];
    if (!room) {
        console.log(
            `[ ROOM STATUS] 部屋 [${roomName}] は現在メモリ上に存在しません（0人）。`,
        );
        return;
    }
    const playerCount = room.connectedClients.length;
    const spectatorCount = room.spectators.length;

    console.log(`========================================`);
    console.log(`[ ROOM STATUS] 部屋: [${roomName}]`);
    console.log(`  プレイヤー: ${playerCount} / ${MAX_PLAYERS} 人`);
    console.log(`  観 戦 者   : ${spectatorCount} 人`);
    console.log(`========================================`);
}

// localhostにDenoのHTTPサーバーを展開
Deno.serve(async (_req) => {
    const { pathname, searchParams } = new URL(_req.url);
    const roomName = searchParams.get("room") || "default";
    const ROOM_KEY = ["shiritori_room_data", roomName]; // その部屋専用のKVキー

    // しりとり関連のWebSocket通信が来た時の処理
    if (pathname === "/shiritori-ws") {
        // 安全対策: WebSocketリクエストかチェック
        if (_req.headers.get("upgrade") !== "websocket") {
            return new Response("Upgrade header is required", { status: 400 });
        }

        const { response, socket } = Deno.upgradeWebSocket(_req);

        // メモリ上に該当の部屋オブジェクトがなければ生成
        if (!rooms[roomName]) {
            rooms[roomName] = {
                connectedClients: [],
                spectators: [],
            };
        }
        const currentRoomMemory = rooms[roomName];

        socket.onopen = async () => {
            console.log(`プレイヤーが部屋 [${roomName}] に参戦！`);

            // KVデータベースをチェック＆初期化
            const existing = await kv.get(ROOM_KEY);
            if (!existing.value) {
                await kv.set(ROOM_KEY, {
                    wordHistory: ["しりとり"],
                    turnIndex: 0,
                    gameStarted: false,
                });
            }

            const entry = await kv.get(ROOM_KEY);
            let roomData = entry.value;

            // 3人目以降は観戦者モードになります。
            if (currentRoomMemory.connectedClients.length >= MAX_PLAYERS) {
                currentRoomMemory.spectators.push(socket);

                const lastWord =
                    roomData.wordHistory[roomData.wordHistory.length - 1] ||
                    "しりとり";
                const initialNextChar = getNextChar(lastWord);

                socket.send(JSON.stringify({
                    "type": "spectate_start",
                    "role": "spectator",
                    "word": lastWord,
                    "recentWords": roomData.wordHistory.slice(-5),
                    "nextChar": initialNextChar,
                    "message":
                        `満員のため部屋 [${roomName}] を観戦モードで参加中`,
                }));
                return;
            }

            currentRoomMemory.connectedClients.push(socket);

            if (currentRoomMemory.connectedClients.length === 1) {
                roomData.gameStarted = false;
                await kv.set(ROOM_KEY, roomData);
                console.log(`[GAME] 1人目の接続完了。2人目の接続を待機中...`);
            } else if (
                currentRoomMemory.connectedClients.length === MAX_PLAYERS
            ) {
                // 定員に達したらゲーム開始！
                roomData.gameStarted = true;

                // 先攻後攻をランダムで決めてDBに書き込む
                roomData.turnIndex = Math.floor(Math.random() * MAX_PLAYERS);
                await kv.set(ROOM_KEY, roomData);

                console.log(
                    `部屋 [${roomName}] ゲーム開始！先攻プレイヤーのインデックス: ${roomData.turnIndex}`,
                );

                const currentWord =
                    roomData.wordHistory[roomData.wordHistory.length - 1];
                const recentWordsList = roomData.wordHistory.slice(-5);
                const startNextChar = getNextChar(currentWord);

                // 両方のプレイヤーに手番情報を送信
                currentRoomMemory.connectedClients.forEach((client, index) => {
                    if (client.readyState === WebSocket.OPEN) {
                        const isYourTurn = index === roomData.turnIndex;
                        client.send(JSON.stringify({
                            "type": "game_start",
                            "word": currentWord,
                            "recentWords": recentWordsList,
                            "nextChar": startNextChar,
                            "isYourTurn": isYourTurn,
                            "role": "player",
                        }));
                    }
                });

                // 観戦者へ送信
                currentRoomMemory.spectators.forEach((spectator) => {
                    if (spectator.readyState === WebSocket.OPEN) {
                        spectator.send(JSON.stringify({
                            "type": "game_start",
                            "word": currentWord,
                            "recentWords": recentWordsList,
                            "nextChar": startNextChar,
                            "isYourTurn": false,
                            "role": "spectator",
                        }));
                    }
                });
            }
            logRoomStatus(roomName);
        };

        socket.onclose = async () => {
            console.log(`部屋 [${roomName}] からプレイヤー退場。`);
            currentRoomMemory.connectedClients = currentRoomMemory
                .connectedClients.filter((client) => client !== socket);
            currentRoomMemory.spectators = currentRoomMemory.spectators.filter((
                client,
            ) => client !== socket);

            logRoomStatus(roomName);

            if (currentRoomMemory.connectedClients.length < MAX_PLAYERS) {
                if (
                    currentRoomMemory.connectedClients.length === 0 &&
                    currentRoomMemory.spectators.length === 0
                ) {
                    await kv.set(ROOM_KEY, {
                        wordHistory: ["しりとり"],
                        turnIndex: 0,
                        gameStarted: false,
                    });
                    delete rooms[roomName]; // 誰もいない部屋のメモリを解放
                    console.log(
                        `全員退場したため部屋 [${roomName}] データをリセットしました。`,
                    );
                    return;
                }
                // もし1人残されたら、その人を再び待機状態にする
                if (currentRoomMemory.connectedClients.length === 1) {
                    const entry = await kv.get(ROOM_KEY);
                    if (entry.value) {
                        const data = entry.value;
                        data.turnIndex = 0; // 残ったプレイヤーのインデックスを0にする
                        data.gameStarted = false;
                        await kv.set(ROOM_KEY, data);
                    }

                    // 1人目が確実に存在することを確認してから送る
                    const remainingPlayer =
                        currentRoomMemory.connectedClients[0];
                    if (
                        remainingPlayer &&
                        remainingPlayer.readyState === WebSocket.OPEN
                    ) {
                        remainingPlayer.send(JSON.stringify({
                            "type": "waiting",
                            "message":
                                "対戦相手が切断しました；；新たな相手を待っています...",
                        }));
                    }
                }
            }
        };

        socket.onmessage = async (event) => {
            const nextWord = event.data.trim();
            const entry = await kv.get(ROOM_KEY);
            let roomData = entry.value;
            let wordHistoryFromDB = roomData.wordHistory;

            //手番プレイヤーからの送信かチェック
            const currentPlayerSocket =
                currentRoomMemory.connectedClients[roomData.turnIndex];
            if (socket !== currentPlayerSocket) return;

            const previousWord =
                wordHistoryFromDB[wordHistoryFromDB.length - 1];
            const cleanedNextWord = compressChouon(nextWord);
            const nextWordHiragana = toHiragana(cleanedNextWord);

            const hiraganaHistory = wordHistoryFromDB.map((word) =>
                toHiragana(compressChouon(word))
            );

            const nextStart = toHiragana(cleanedNextWord.slice(0, 1));
            const previousEnd = getNextChar(previousWord);

            // しりとり接続チェック
            if (previousEnd !== nextStart) {
                socket.send(JSON.stringify({
                    "type": "input_error",
                    "message":
                        `「${nextWord}」は「${previousEnd}」に続いていません！`,
                }));
                return;
            } // 重複チェック
            else if (hiraganaHistory.includes(nextWordHiragana)) {
                broadcastGameOver(
                    socket,
                    `「${nextWord}」はすでに使われている単語です！`,
                    `相手が「${nextWord}」という重複した単語を使いました！`,
                    wordHistoryFromDB.length,
                    roomName,
                );
                return;
            } // 「ん」チェック
            else if (getNextChar(nextWord) === "ん") {
                broadcastGameOver(
                    socket,
                    `末尾が「ん」で終わっています！`,
                    `相手が「ん」のつく単語を入力しました！`,
                    wordHistoryFromDB.length,
                    roomName,
                );
                return;
            }

            // 全てのチェックをクリアしたら履歴に追加
            wordHistoryFromDB.push(nextWord);
            const recentWords = wordHistoryFromDB.slice(-5);

            roomData.turnIndex = (roomData.turnIndex + 1) % MAX_PLAYERS;
            roomData.wordHistory = wordHistoryFromDB;

            await kv.set(ROOM_KEY, roomData);

            const calculatedNextChar = getNextChar(nextWord);

            broadcast(
                {
                    "type": "success",
                    "word": nextWord,
                    "recentWords": recentWords,
                    "nextChar": calculatedNextChar,
                },
                roomData,
                roomName,
            );
        };

        return response;
    }

    // ロビー用WebSocketのエンドポイント
    if (pathname === "/lobby-ws") {
        const { socket, response } = Deno.upgradeWebSocket(_req);

        socket.onopen = async () => {
            const roomMemory = rooms[roomName];
            const entry = await kv.get(ROOM_KEY);
            const roomData = entry.value;

            if (roomMemory && roomData && roomData.gameStarted) {
                console.log(
                    `[LOBBY] 部屋 [${roomName}] は既にゲーム中のため、直接プレイ画面（観戦）へ誘導します。`,
                );
                // クライアントへ直接ゲーム画面（play.html）へ進むよう指示を送る
                socket.send(JSON.stringify({
                    type: "start_game",
                }));
                socket.close();
                return;
            }

            if (!lobbyRooms[roomName]) {
                lobbyRooms[roomName] = [];
            }

            // 接続してきたクライアントをロビーの配列に追加
            lobbyRooms[roomName].push(socket);
            console.log(
                `[LOBBY] 部屋 [${roomName}] に誰かが入室しました。現在: ${
                    lobbyRooms[roomName].length
                }人`,
            );

            // ロビーにいる全員に現在の人数を送信
            broadcastLobbyStatus(roomName);

            // 2人揃ったら、即座に全員をplay.htmlへ遷移させる指示を出す
            if (lobbyRooms[roomName].length >= 2) {
                console.log(
                    `[LOBBY] 部屋 [${roomName}] に2人揃ったため、ゲームスタート指示を送ります。`,
                );
                broadcastLobbyStart(roomName);
            }
        };

        socket.onclose = async () => {
            if (lobbyRooms[roomName]) {
                // 退場したソケットを除外
                lobbyRooms[roomName] = lobbyRooms[roomName].filter((client) =>
                    client !== socket
                );
                console.log(
                    `[LOBBY] 部屋 [${roomName}] から誰かが退場しました。現在: ${
                        lobbyRooms[roomName].length
                    }人`,
                );

                broadcastLobbyStatus(roomName);

                // 誰もいなくなったらメモリ解放
                if (lobbyRooms[roomName].length === 0) {
                    delete lobbyRooms[roomName];
                }
            }
        };

        return response;
    }

    // GET /shiritori: 部屋ごとの直前の単語を返す
    if (_req.method === "GET" && pathname === "/shiritori") {
        const entry = await kv.get(ROOM_KEY);
        const roomData = entry.value || { wordHistory: ["しりとり"] };
        const nextWord = roomData.wordHistory[roomData.wordHistory.length - 1];
        const recentWords = roomData.wordHistory.slice(-5);

        const initialNextChar = getNextChar(nextWord);

        return new Response(
            JSON.stringify({
                "type": "success",
                "word": nextWord,
                "recentWords": recentWords,
                "nextChar": initialNextChar,
            }),
            { headers: { "Content-Type": "application/json; charset=utf-8" } },
        );
    }

    if (_req.method === "POST" && pathname === "/reset") {
        await kv.set(ROOM_KEY, {
            wordHistory: ["しりとり"],
            turnIndex: 0,
            gameStarted: false,
        });

        console.log(`部屋 [${roomName}] の履歴がリセットされました`);
        return new Response(
            JSON.stringify({ "message": `部屋 [${roomName}] のリセット完了` }),
            {
                status: 200,
                headers: { "Content-Type": "application/json; charset=utf-8" },
            },
        );
    }

    // 静的ファイルの返却
    return serveDir(_req, {
        fsRoot: "./public/",
        urlRoot: "",
        enableCors: true,
    });
});
