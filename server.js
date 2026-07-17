// server.js
import { serveDir } from "jsr:@std/http/file-server";

const kv = await Deno.openKv();

//部屋ごとにプレイヤーと観戦者をメモリ管理する格納庫
const rooms = {};

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
    const url = new URL(_req.url);
    const pathname = url.pathname;
    const roomName = url.searchParams.get("room") || "default"; // 部屋名を取得
    const ROOM_KEY = ["shiritori_room_data", roomName]; // その部屋専用のKVキー

    // メモリ上に該当の部屋オブジェクトがなければ生成
    if (!rooms[roomName]) {
        rooms[roomName] = {
            connectedClients: [],
            spectators: [],
        };
    }

    const currentRoomMemory = rooms[roomName];

    const existing = await kv.get(ROOM_KEY);
    if (!existing.value) {
        await kv.set(ROOM_KEY, {
            wordHistory: ["しりとり"],
            turnIndex: 0,
            gameStarted: false,
        });
    }

    if (pathname === "/shiritori-ws") {
        const { response, socket } = Deno.upgradeWebSocket(_req);

        socket.onopen = async () => {
            console.log(`プレイヤーが部屋 [${roomName}] に参戦！`);
            const entry = await kv.get(ROOM_KEY);
            let roomData = entry.value;

            // 3人目以降の接続は観戦者モード
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
                socket.send(JSON.stringify({
                    "type": "waiting",
                    "role": "player",
                    "message": "対戦相手を待っています...",
                }));
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

                // 定員に達したので、それぞれのプレイヤーに手番を送る
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
                    currentRoomMemory.connectedClients[0].send(JSON.stringify({
                        "type": "waiting",
                        "message":
                            "対戦相手が切断しました;;新たな相手を待っています...",
                    }));
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
            } // 重複チェック（※前の要件に合わせゲームオーバーの判定にしてあります）
            else if (hiraganaHistory.includes(nextWordHiragana)) {
                broadcastGameOver(
                    socket,
                    `「${nextWord}」はすでに使われている単語です！`,
                    `相手が「${nextWord}」という重複した単語を使いました！`,
                    wordHistoryFromDB.length,
                    roomName, // ⭕ ルーム指定を追加
                );
                return;
            } // 「ん」チェック
            else if (getNextChar(nextWord) === "ん") {
                broadcastGameOver(
                    socket,
                    `末尾が「ん」で終わっています！`,
                    `相手が「ん」のつく単語を入力しました！`,
                    wordHistoryFromDB.length,
                    roomName, // ⭕ ルーム指定を追加
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

            // ⭕ broadcast に roomName をしっかり付与
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

    return serveDir(_req, {
        fsRoot: "./public/",
        urlRoot: "",
        enableCors: true,
    });
});
