// server.js
import { serveDir } from "jsr:@std/http/file-server";

const kv = await Deno.openKv();

// クラウド環境で全サーバーが共通して使う「部屋のID」
const ROOM_KEY = ["shiritori_room_data"];

// サーバー起動時にデータベースの初期状態をセット
const existing = await kv.get(ROOM_KEY);
if (!existing.value) {
    await kv.set(ROOM_KEY, {
        wordHistory: ["しりとり"],
        turnIndex: 0,
        gameStarted: false,
    });
}

//直前の単語を保持しておく
let wordHistory = ["しりとり"];
let connectedClients = [];
let turnIndex = 0; // 現在何番目のプレイヤーのターンか（0または1）
let gameStarted = false;
let spectators = [];

// 全員にJSONデータを送るヘルパー関数
function broadcast(data, roomData) {
    connectedClients.forEach((client, index) => {
        if (client.readyState === WebSocket.OPEN) {
            // サーバー上部の変数ではなく、引数で受け取った最新のDBデータを基準に手番判定
            const isYourTurn = index === roomData.turnIndex;
            client.send(JSON.stringify({
                ...data,
                isYourTurn: isYourTurn,
                role: "player",
            }));
        }
    });

    spectators.forEach((spectator) => {
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
) {
    //歯医者に送信
    loserSocket.send(JSON.stringify({
        "type": "gameover",
        "result": "lose",
        "role": "player",
        "errorMessage": loserMessage,
        "wordCount": wordCount,
    }));
    //勝者に送信
    connectedClients.forEach((client) => {
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
    spectators.forEach((spectator) => {
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

// localhostにDenoのHTTPサーバーを展開
Deno.serve(async (_req) => {
    // パス名を取得する
    // http://localhost:8000/hoge に接続した場合"/hoge"が取得できる
    const pathname = new URL(_req.url).pathname;

    if (pathname === "/shiritori-ws") {
        const { response, socket } = Deno.upgradeWebSocket(_req);

        socket.onopen = async () => {
            console.log("プレイヤー参戦！");
            const entry = await kv.get(ROOM_KEY);
            let roomData = entry.value;
            let currentWordHistory = roomData.wordHistory;
            // 3人目以降の接続は一旦拒否
            if (connectedClients.length >= 2) {
                spectators.push(socket);
                console.log(
                    `観戦者が増えました。現在の観戦者数: ${spectators.length}`,
                );

                socket.send(JSON.stringify({
                    "type": "spectate_start",
                    "role": "spectator",
                    "word": wordHistory[wordHistory.length - 1],
                    "recentWords": wordHistory.slice(-5),
                    "message": "満員のため観戦モードで参加中",
                }));
                return;
            }

            connectedClients.push(socket);

            if (connectedClients.length === 1) {
                roomData.gameStarted = false;
                await kv.set(ROOM_KEY, roomData);
                socket.send(JSON.stringify({
                    "type": "waiting",
                    "role": "player",
                    "message": "対戦相手を待っています...",
                }));
            } else if (connectedClients.length === 2) {
                // 2人揃ったらゲーム開始！
                roomData.gameStarted = true;

                // 先攻後攻をランダムで決めてDBに書き込む
                roomData.turnIndex = Math.floor(Math.random() * 2);
                await kv.set(ROOM_KEY, roomData);

                console.log(
                    `ゲーム開始！先攻プレイヤーのインデックス: ${roomData.turnIndex}`,
                );

                // ✨【重要】ここでしっかりとデータベース（roomData）から変数を作ります！
                const currentWord =
                    roomData.wordHistory[roomData.wordHistory.length - 1];
                const recentWordsList = roomData.wordHistory.slice(-5);

                // 2人揃ったので、それぞれのプレイヤーに手番を送る
                connectedClients.forEach((client, index) => {
                    if (client.readyState === WebSocket.OPEN) {
                        const isYourTurn = index === roomData.turnIndex;
                        client.send(JSON.stringify({
                            "type": "game_start",
                            "word": currentWord,
                            "recentWords": recentWordsList,
                            "isYourTurn": isYourTurn,
                            "role": "player",
                        }));
                    }
                });

                // 観戦者へ送信
                spectators.forEach((spectator) => {
                    if (spectator.readyState === WebSocket.OPEN) {
                        spectator.send(JSON.stringify({
                            "type": "game_start",
                            "word": currentWord,
                            "recentWords": recentWordsList,
                            "isYourTurn": false,
                            "role": "spectator",
                        }));
                    }
                });
            }
        };

        socket.onclose = async () => {
            console.log("プレイヤー退場ッ！");
            connectedClients = connectedClients.filter((client) =>
                client !== socket
            );
            if (connectedClients.length < 2) {
                // もし1人残されたら、その人を再び待機状態にする
                if (connectedClients.length === 1) {
                    connectedClients[0].send(JSON.stringify({
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

            const previousWord =
                wordHistoryFromDB[wordHistoryFromDB.length - 1];

            //手番プレイヤーからの送信かチェック
            const currentPlayerSocket = connectedClients[roomData.turnIndex];
            if (socket !== currentPlayerSocket) {
                // 自分のターンじゃない奴からのメッセージは無視する
                return;
            }

            // 重複チェック
            if (wordHistoryFromDB.includes(nextWord)) {
                broadcastGameOver(
                    socket,
                    `「${nextWord}」はすでに使われています！`,
                    `相手が「${nextWord}」という重複した単語を使いました！`,
                    wordHistoryFromDB.length,
                );
                return;
            }

            // 文字の正規化（標準化）処理
            const rawPreviousWord =
                wordHistoryFromDB[wordHistoryFromDB.length - 1];
            const toHiragana = (str) => {
                return str.replace(/[\u30a1-\u30f6]/g, (match) => {
                    return String.fromCharCode(match.charCodeAt(0) - 0x60);
                });
            };

            const nextStart = toHiragana(nextWord.slice(0, 1));
            let lastChar = rawPreviousWord.slice(-1);

            if (lastChar === "ー" && rawPreviousWord.length > 1) {
                lastChar = rawPreviousWord.slice(-2, -1);
            }

            let previousEnd = toHiragana(lastChar);

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
            if (smallToLarge[previousEnd]) {
                previousEnd = smallToLarge[previousEnd];
            }

            // しりとり接続チェック
            if (previousEnd !== nextStart) {
                broadcastGameOver(
                    socket,
                    `「${nextWord}」は「${previousEnd}」に続いていません！`,
                    `相手が「${previousEnd}」に続かない単語を入力しました！`,
                    wordHistoryFromDB.length,
                );
                return;
            }

            // 「ん」チェック
            if (toHiragana(nextWord.slice(-1)) === "ん") {
                broadcastGameOver(
                    socket,
                    `末尾が「ん」で終わっています！`,
                    `相手が「ん」のつく単語を入力しました！`,
                    wordHistoryFromDB.length,
                );
                return;
            }

            // 全てのチェックをクリアしたら履歴に追加
            wordHistoryFromDB.push(nextWord);
            const recentWords = wordHistoryFromDB.slice(-5);

            roomData.turnIndex = (roomData.turnIndex + 1) % 2;
            roomData.wordHistory = wordHistoryFromDB;

            //更新した最新状態をデータベースに保存（これで他のサーバーにも一瞬で同期される）
            await kv.set(ROOM_KEY, roomData);

            //正しいJSONデータ形式で全員に一斉送信
            broadcast({
                "type": "success",
                "word": nextWord,
                "recentWords": recentWords,
            }, roomData);
        };

        return response;
    }

    console.log(`pathname: ${pathname}`);

    // GET /shiritori: 直前の単語を返す
    if (_req.method === "GET" && pathname === "/shiritori") {
        const entry = await kv.get(ROOM_KEY);
        const roomData = entry.value;
        const nextWord = roomData.wordHistory[roomData.wordHistory.length - 1];
        const recentWords = roomData.wordHistory.slice(-5); // 最初も過去5件を切り出す

        // WebSocketの成功時と同じ形のJSONデータを返すようにする
        return new Response(
            JSON.stringify({
                "type": "success",
                "word": nextWord,
                "recentWords": recentWords,
            }),
            {
                headers: { "Content-Type": "application/json; charset=utf-8" },
            },
        );
    }

    if (_req.method === "POST" && pathname === "/reset") {
        // 履歴を最初の「しりとり」だけの状態に戻す
        await kv.set(ROOM_KEY, {
            wordHistory: ["しりとり"],
            turnIndex: 0,
            gameStarted: false,
        });

        console.log("履歴がリセットされました");
        return new Response(JSON.stringify({ "message": "リセット完了" }), {
            status: 200,
            headers: { "Content-Type": "application/json; charset=utf-8" },
        });
    }

    // ./public以下のファイルを公開
    return serveDir(
        _req,
        {
            /*
            - fsRoot: 公開するフォルダを指定
            - urlRoot: フォルダを展開するURLを指定。今回はlocalhost:8000/に直に展開する
            - enableCors: CORSの設定を付加するか
            */
            fsRoot: "./public/",
            urlRoot: "",
            enableCors: true,
        },
    );
});
